/**
 * Unit tests for the Embedder wrapper around `@huggingface/transformers`.
 *
 * The pipeline factory is mocked so these tests run hermetically without
 * pulling real model weights from the HF hub. The integration counterparts
 * (real model load + embed) live in `tests/embedder.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// `vi.mock` is hoisted, so the factory runs before any `import` from the
// embedder module under test. We expose the spy via the module namespace and
// retrieve it inside the test setup -- that way a single mock controls every
// importer.
vi.mock('@huggingface/transformers', () => {
  const pipeline = vi.fn();
  return { pipeline };
});

// Narrow signature for the only `pipeline()` overload the embedder uses --
// see the matching note in `src/embedder/index.ts`. Using the upstream
// generic overload here triggers TS2590 because `vi.mocked(...)` has to
// expand the indexed conditional return type across every supported task.
type FeatureExtractionFactory = (task: 'feature-extraction', model: string) => Promise<unknown>;

import { pipeline as _rawPipeline } from '@huggingface/transformers';

import { Embedder } from '../src/embedder/index.js';

const pipelineMock = _rawPipeline as unknown as Mock<FeatureExtractionFactory>;

/**
 * Build a fake feature-extraction pipeline callable. It returns a fake Tensor
 * whose `data` is a Float32Array of the requested length, optionally normalised.
 *
 * Tests don't care about the actual values, only the shape and that the
 * options were forwarded -- the wrapper just unwraps `tensor.data` into a
 * Float32Array.
 */
const makeFakePipeline = (dim = 768) => {
  const call = vi.fn(async (text: string | string[], options?: unknown) => {
    // We intentionally accept and ignore the args at the runtime level --
    // their values are inspected via the spy's `mock.calls` in ac-4. The
    // void below quiets the unused-binding lint.
    void text;
    void options;
    const data = new Float32Array(dim);
    // populate with arbitrary deterministic values; the wrapper does not
    // re-normalise so the integration test is what asserts L2 norm ≈ 1.
    for (let i = 0; i < dim; i++) data[i] = (i + 1) / 1000;
    return { data, dims: [1, dim] };
  });
  return call;
};

beforeEach(() => {
  pipelineMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// -------------------------------------------------------------------------
// ac-1: class shape and TypeScript surface
// -------------------------------------------------------------------------

describe('ac-1: class shape', () => {
  it('Embedder is a class exported from src/embedder whose constructor accepts a modelId string and stores it on the readonly modelId property', () => {
    const e = new Embedder('Xenova/bge-base-en-v1.5');
    expect(e).toBeInstanceOf(Embedder);
    expect(e.modelId).toBe('Xenova/bge-base-en-v1.5');
  });

  it('embed(text) returns a Promise that resolves to a Float32Array (not a plain array, not a typed array of another kind)', async () => {
    pipelineMock.mockResolvedValue(makeFakePipeline(768));
    const e = new Embedder('Xenova/bge-base-en-v1.5');
    const result = e.embed('hello');
    expect(result).toBeInstanceOf(Promise);
    const v = await result;
    expect(v).toBeInstanceOf(Float32Array);
    expect(v).not.toBeInstanceOf(Array);
    // Float64Array is a different typed-array kind; reject it.
    expect(v).not.toBeInstanceOf(Float64Array);
    expect(v.length).toBe(768);
  });

  it('dim and modelId are declared readonly in the TypeScript surface (assignment to either fails typecheck)', () => {
    const e = new Embedder('Xenova/bge-base-en-v1.5');
    // The assertions below are runtime guards; the actual `readonly`
    // enforcement is verified by `make typecheck` over the
    // `tests/embedder.readonly-types.ts` companion file in this directory,
    // which uses `// @ts-expect-error` markers to fail the build if either
    // property becomes writable.
    expect(typeof e.modelId).toBe('string');
    expect(typeof e.dim).toBe('number');
  });
});

// -------------------------------------------------------------------------
// ac-2: lazy initialization
// -------------------------------------------------------------------------

describe('ac-2: lazy init', () => {
  it('constructing an Embedder does not call the transformers.js pipeline factory (verified by spying on the pipeline import)', () => {
    new Embedder('Xenova/bge-base-en-v1.5');
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('the pipeline factory is invoked exactly once on the first embed() call and not again on subsequent embed() calls', async () => {
    pipelineMock.mockResolvedValue(makeFakePipeline(768));
    const e = new Embedder('Xenova/bge-base-en-v1.5');
    await e.embed('one');
    await e.embed('two');
    await e.embed('three');
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });
});

// -------------------------------------------------------------------------
// ac-3: single shared pipeline instance per Embedder
// -------------------------------------------------------------------------

describe('ac-3: single shared pipeline', () => {
  it('two concurrent embed() calls on a fresh Embedder share a single pipeline initialization (the pipeline factory is awaited only once even when embed() is called in parallel before init completes)', async () => {
    // Build a deferred promise so we can observe how many factory calls
    // occur while the first one is still in flight.
    let resolveFactory!: (fn: ReturnType<typeof makeFakePipeline>) => void;
    pipelineMock.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          resolveFactory = (fn) => resolve(fn);
        }),
    );

    const e = new Embedder('Xenova/bge-base-en-v1.5');
    const p1 = e.embed('a');
    const p2 = e.embed('b');

    // While the factory is still pending, only one factory call should have
    // been issued -- both embed() callers must wait on the same promise.
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    resolveFactory(makeFakePipeline(768));
    const [v1, v2] = await Promise.all([p1, p2]);

    expect(v1).toBeInstanceOf(Float32Array);
    expect(v2).toBeInstanceOf(Float32Array);
    // Even after both resolve, the factory was still only called once.
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('two separate Embedder instances each create their own pipeline (the factory is called once per instance, not shared across instances)', async () => {
    pipelineMock.mockResolvedValue(makeFakePipeline(768));
    const e1 = new Embedder('Xenova/bge-base-en-v1.5');
    const e2 = new Embedder('Xenova/bge-base-en-v1.5');
    await e1.embed('x');
    await e2.embed('y');
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });
});

// -------------------------------------------------------------------------
// ac-4: pooling and normalize options forwarded to the pipeline
// -------------------------------------------------------------------------

describe('ac-4: pooling cls + normalize true', () => {
  it("embed() invokes the underlying pipeline with options { pooling: 'cls', normalize: true } (verified by spying on the pipeline call arguments)", async () => {
    const fake = makeFakePipeline(768);
    pipelineMock.mockResolvedValue(fake as never);
    const e = new Embedder('Xenova/bge-base-en-v1.5');
    await e.embed('hello world');
    expect(fake).toHaveBeenCalledTimes(1);
    const [text, options] = fake.mock.calls[0] ?? [];
    expect(text).toBe('hello world');
    expect(options).toEqual({ pooling: 'cls', normalize: true });
  });
});

// -------------------------------------------------------------------------
// Clear cached pipeline promise on init failure
//
// The Embedder caches the in-flight pipeline *promise* to give the
// "single shared init" guarantee. That cache must be cleared when the
// promise rejects, otherwise every subsequent embed() on the same Embedder
// replays the same rejection forever. These tests cover the failure-then-
// retry path; the success-path contract tests above already cover the
// "unchanged on success" half of the contract.
// -------------------------------------------------------------------------

describe('init failure clears cached pipeline promise', () => {
  it('after a successful first embed(), a second embed() on the same Embedder does not call the pipeline factory again (factory invoked exactly once across multiple successful embed() calls)', async () => {
    pipelineMock.mockResolvedValue(makeFakePipeline(768));
    const e = new Embedder('Xenova/bge-base-en-v1.5');
    await e.embed('one');
    await e.embed('two');
    await e.embed('three');
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('after a successful first embed(), the resolved pipeline callable from the first load is the same callable used to produce the vector on subsequent embed() calls (no re-init occurs)', async () => {
    const fake = makeFakePipeline(768);
    pipelineMock.mockResolvedValue(fake as never);
    const e = new Embedder('Xenova/bge-base-en-v1.5');
    await e.embed('one');
    await e.embed('two');
    // The same fake callable was used for both embed() calls -- proves the
    // pipeline instance is reused rather than re-initialised.
    expect(fake).toHaveBeenCalledTimes(2);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('when the pipeline factory rejects on the first embed() call, the second embed() call invokes the pipeline factory again (factory call count goes from 1 to 2) rather than re-yielding the prior rejection without calling the factory', async () => {
    pipelineMock.mockRejectedValueOnce(new Error('transient hub failure'));
    pipelineMock.mockResolvedValueOnce(makeFakePipeline(768) as never);

    const e = new Embedder('Xenova/bge-base-en-v1.5');
    await expect(e.embed('first')).rejects.toThrow('transient hub failure');
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    await e.embed('second');
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('when the pipeline factory rejects on the first embed() call and a second embed() call succeeds, that second call resolves to a Float32Array using the freshly-loaded pipeline (recovery is observable end-to-end, not just via the spy)', async () => {
    pipelineMock.mockRejectedValueOnce(new Error('transient hub failure'));
    pipelineMock.mockResolvedValueOnce(makeFakePipeline(768) as never);

    const e = new Embedder('Xenova/bge-base-en-v1.5');
    await expect(e.embed('first')).rejects.toThrow();
    const v = await e.embed('second');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(768);
  });

  it('embed() rejects with the exact error thrown by the pipeline factory on a failing first load (error identity/message preserved, not wrapped into a different error)', async () => {
    const original = new Error('boom: hub unreachable');
    pipelineMock.mockRejectedValueOnce(original);

    const e = new Embedder('Xenova/bge-base-en-v1.5');
    // Identity preserved: the rejected value is the same Error object the
    // factory threw, not a wrapped/replaced error.
    await expect(e.embed('first')).rejects.toBe(original);
  });

  it('after a failing first embed(), a subsequent embed() invokes the pipeline factory exactly one additional time (total factory invocations = 2 across the failure + retry sequence)', async () => {
    pipelineMock.mockRejectedValueOnce(new Error('boom'));
    pipelineMock.mockResolvedValueOnce(makeFakePipeline(768) as never);

    const e = new Embedder('Xenova/bge-base-en-v1.5');
    await expect(e.embed('first')).rejects.toThrow('boom');
    await e.embed('second');
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });
});

// -------------------------------------------------------------------------
// ac-5: dim populated from known-models map or after first embed
// -------------------------------------------------------------------------

describe('ac-5: dim population', () => {
  it('for a known model id (Xenova/bge-base-en-v1.5), Embedder.dim returns 768 before the first embed() call via a static known-models map', () => {
    const e = new Embedder('Xenova/bge-base-en-v1.5');
    // dim is known statically; no embed() needed.
    expect(e.dim).toBe(768);
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('for an unknown model id, accessing dim before the first embed() call returns 0 (or otherwise indicates not-yet-known) and reading it after a successful embed() returns the actual vector length', async () => {
    pipelineMock.mockResolvedValue(makeFakePipeline(384) as never);
    const e = new Embedder('Xenova/some-unknown-model');
    expect(e.dim).toBe(0);
    await e.embed('hi');
    expect(e.dim).toBe(384);
  });
});
