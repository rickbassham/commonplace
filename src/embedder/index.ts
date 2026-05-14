/**
 * Embedder wrapper around `@huggingface/transformers` (DAR-912).
 *
 * A thin, single-string wrapper that isolates the rest of the codebase from
 * `transformers.js`'s pipeline machinery. Exposes:
 *
 *   - `constructor(modelId)` -- records the model id; does NOT load weights.
 *   - `embed(text)`          -- returns the L2-normalised CLS-pooled
 *                               embedding as a `Float32Array`.
 *   - `readonly modelId`     -- the configured model id.
 *   - `readonly dim`         -- vector dimensionality. Populated synchronously
 *                               from a static known-models map for known
 *                               ids (e.g. `Xenova/bge-base-en-v1.5` -> 768);
 *                               otherwise reports `0` until the first
 *                               successful `embed()` call.
 *
 * # Behaviour contract
 *
 * - **Lazy init.** Constructing an Embedder does NOT touch `pipeline()`.
 *   The first `embed()` call kicks off model load (~6s for bge-base on a
 *   warm cache); all subsequent calls reuse the same pipeline instance.
 *
 * - **Single shared pipeline per instance.** Concurrent first-call
 *   `embed()`s share one initialisation -- the `pipeline()` factory is
 *   awaited exactly once even if many callers race on a fresh Embedder.
 *   Different Embedder instances do NOT share pipelines (no global cache;
 *   that's deliberate scope per the contract envelope).
 *
 * - **CLS pooling, L2-normalised output.** Per BGE convention, we forward
 *   `{ pooling: 'cls', normalize: true }` to the underlying feature-
 *   extraction pipeline. With normalisation on, cosine similarity reduces
 *   to a dot product downstream, which is what `src/store/` expects.
 *
 * # Out of scope
 *
 * - Batched embed APIs (single-string is enough today; revisit if a
 *   downstream issue needs throughput).
 * - Environment-variable model selection (DAR-913 owns `COMMONPLACE_MODEL`).
 * - Disk-cache control, tokenizer/truncation knobs, abort signals.
 *
 * See the contract envelope on DAR-912 for the full list of explicit
 * non-goals and their reasons.
 */

import {
  pipeline as _rawPipeline,
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';

/**
 * Local re-typing of `pipeline()` for the only call signature this module
 * uses: `(task: 'feature-extraction', model: string) -> Promise<FeatureExtractionPipeline>`.
 *
 * The upstream signature is `pipeline<T extends PipelineType>(task: T, model?: string, ...) -> Promise<AllTasks[T]>`.
 * When TypeScript tries to resolve the awaited form of that indexed
 * conditional type at our call site, it produces TS2590 ("union type too
 * complex to represent") because every supported task class participates
 * in the union before the literal narrows it. Pinning the signature to
 * the single overload we actually use sidesteps that without altering
 * runtime behaviour -- `pipeline` is the same function value either way.
 */
type FeatureExtractionFactory = (
  task: 'feature-extraction',
  model: string,
) => Promise<FeatureExtractionPipeline>;
const pipeline: FeatureExtractionFactory = _rawPipeline as FeatureExtractionFactory;

/**
 * Static map of `modelId -> dim` for embedding models we ship with built-in
 * knowledge. Looking up a known id lets `dim` be populated synchronously
 * from the constructor, so callers (e.g. the sidecar encoder) don't have
 * to wait on a model load just to learn the vector size.
 *
 * Adding entries here is fine -- it's append-only configuration data.
 * Models not in this map fall back to post-embed dim discovery, which is
 * also part of the contract.
 */
const KNOWN_MODEL_DIMS: Readonly<Record<string, number>> = {
  'Xenova/bge-base-en-v1.5': 768,
};

/**
 * A locally-shaped view of the result transformers.js returns for a
 * feature-extraction call. The official type is `Tensor`, but `Tensor.data`
 * is typed as `DataArray` (a wide union of every typed-array kind). For
 * `feature-extraction` with `pooling: 'cls'` and `normalize: true`, the
 * data is always a `Float32Array`. We narrow once at the boundary so the
 * rest of the file can speak in `Float32Array` directly.
 */
interface EmbeddingTensor {
  data: Float32Array;
}

const isFloat32Tensor = (t: unknown): t is EmbeddingTensor =>
  t !== null && typeof t === 'object' && 'data' in t && t.data instanceof Float32Array;

/**
 * Embedder: lazy, per-instance wrapper around a transformers.js
 * feature-extraction pipeline.
 *
 * Construct with the model id; call `embed()` to get a Float32Array. Read
 * `dim` synchronously when the model is in the known-models map, or after
 * the first successful `embed()` otherwise.
 */
export class Embedder {
  /** The model id this Embedder was constructed with. Readonly per AC-1. */
  public readonly modelId: string;

  /**
   * Vector dimensionality.
   *
   * Backed by a private `#dim` field. The class never re-assigns to a
   * caller-visible binding -- updates flow through `#dim`, and `dim` is
   * exposed as a TS-level readonly getter.
   */
  public get dim(): number {
    return this.#dim;
  }

  #dim: number;

  /**
   * Cached pipeline-loading promise. The first `embed()` populates this;
   * concurrent first-callers `await` the same promise rather than racing
   * to initialise multiple pipelines (AC-3).
   */
  #pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  public constructor(modelId: string) {
    this.modelId = modelId;
    this.#dim = KNOWN_MODEL_DIMS[modelId] ?? 0;
  }

  /**
   * Embed a single string into a CLS-pooled, L2-normalised vector.
   *
   * On the first call, lazily loads the model via `pipeline()` and caches
   * the resulting pipeline instance for subsequent calls. Concurrent first
   * calls share that load -- the factory is invoked exactly once.
   *
   * Updates `dim` to the returned vector's length when the constructor
   * could not populate it from the known-models map.
   */
  public async embed(text: string): Promise<Float32Array> {
    const fe = await this.#getPipeline();
    const tensor: unknown = await fe(text, { pooling: 'cls', normalize: true });

    if (!isFloat32Tensor(tensor)) {
      throw new Error(
        `Embedder.embed: feature-extraction pipeline returned a tensor whose data is not a Float32Array (modelId=${JSON.stringify(this.modelId)})`,
      );
    }

    // The tensor's `.data` is the underlying buffer view. Copying into a
    // freshly-allocated Float32Array decouples the caller's lifetime from
    // the pipeline's internal storage and makes the return value safe to
    // hold across subsequent embed() calls.
    const out = new Float32Array(tensor.data);

    if (this.#dim === 0) {
      this.#dim = out.length;
    }

    return out;
  }

  /**
   * Return the cached pipeline-loading promise, creating it on first call.
   *
   * Crucially, we cache the *promise*, not the resolved pipeline. That is
   * what gives us the AC-3 guarantee: two concurrent `embed()` calls on a
   * fresh Embedder both observe the same in-flight promise, so the
   * underlying `pipeline()` factory is invoked exactly once.
   *
   * If the in-flight promise rejects (e.g. a transient HuggingFace hub
   * failure on the very first load), we clear `#pipelinePromise` so the
   * next `embed()` call retries the load instead of replaying the cached
   * rejection forever (DAR-935). The clearing is attached via a `.catch()`
   * side-effect on a local reference rather than reassigning the field
   * before returning, so concurrent callers that already grabbed the same
   * promise still observe the same rejection -- they share one failed
   * init, then the next *new* embed() call gets a fresh attempt.
   */
  #getPipeline(): Promise<FeatureExtractionPipeline> {
    if (this.#pipelinePromise === null) {
      const p = pipeline('feature-extraction', this.modelId);
      this.#pipelinePromise = p;
      // On rejection, drop the cached promise so the next embed() retries.
      // Only clear if the field still points at *this* promise, in case a
      // future code path ever races a reset. The `.catch()` swallows the
      // rejection only on this internal handler -- callers awaiting the
      // returned promise still observe the original error.
      p.catch(() => {
        if (this.#pipelinePromise === p) {
          this.#pipelinePromise = null;
        }
      });
    }
    return this.#pipelinePromise;
  }
}
