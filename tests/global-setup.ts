/**
 * Vitest globalSetup: serially warm the transformers.js model cache for the
 * embedder used by the spawned-bin and embedder integration tests.
 *
 * # Why this exists
 *
 * The spawned-bin integration test was flaky on cold-cache `make test`
 * runs. Surface symptoms varied:
 *
 *   - `MCP error -32000: Connection closed`, and
 *   - a non-error CallToolResult with isError: true whose payload read
 *     `Load model from .../onnx/model.onnx failed:Protobuf parsing failed.`
 *
 * Both symptoms have the same cause: vitest defaults to running test
 * **files** in parallel forked workers. Two integration tests
 * (`embedder.integration.test.ts` and `server-bin.integration.test.ts`)
 * each load `Xenova/bge-base-en-v1.5` via the real `@huggingface/transformers`
 * pipeline. transformers.js writes its on-disk model cache to a single
 * shared directory (`<pkg>/.cache/Xenova/<modelId>/`) and does NOT lock
 * around its downloads. When the cache is cold, both workers start
 * downloading `model.onnx` (and other artefacts) at the same time; one
 * worker reads a partial `model.onnx` while another is still streaming it,
 * and the ONNX runtime fails to parse the protobuf. Depending on whether
 * the failure surfaces in `pipeline()` factory init or later, the child
 * process either dies (Connection closed) or returns the parse error in
 * the CallToolResult payload.
 *
 * # Fix shape
 *
 * `globalSetup` runs once in the vitest main process before any worker is
 * forked. By constructing one Embedder and awaiting `embed()` here, we
 * synchronously establish the precondition the race violates: the cache
 * files are complete on disk before any concurrent reader exists. This is
 * not a sleep, retry, or jitter band-aid -- it sequences the download into
 * a single writer, then lets parallel readers proceed safely.
 *
 * # Skip switch
 *
 * `COMMONPLACE_SKIP_MODEL_PRELOAD=1` bypasses the warm-up. This exists for
 * the deterministic-reproduction test: clearing the cache and setting this
 * env var lets you re-trigger the original race in a controlled way
 * without manual intervention in the test runner.
 *
 * # Scope
 *
 * Only this test infrastructure changes. The bin (`src/bin/commonplace-mcp.ts`)
 * and the production embedder/store are untouched. The fix is the minimum
 * needed to eliminate the race in the test environment (minimal
 * harness/bin changes needed to fix the race).
 */

import { Embedder } from '../src/embedder/index.js';

const DEFAULT_MODEL_ID = 'Xenova/bge-base-en-v1.5';

export default async function globalSetup(): Promise<void> {
  if (process.env.COMMONPLACE_SKIP_MODEL_PRELOAD === '1') {
    // Reproduction switch: leave the cache untouched / cold so the
    // server-bin-cold-start.integration.test.ts ac-1 reproduction can
    // observe the real race when run with COMMONPLACE_REPRODUCE_RACE=1.
    return;
  }

  // Construct one Embedder and embed a short string. This loads the
  // pipeline (which downloads / verifies / parses every cache artefact),
  // ensuring `model.onnx`, `tokenizer.json`, `config.json`, and the
  // tokenizer config are all complete on disk before any vitest worker
  // forks. Subsequent in-process loads in workers re-read the cached
  // files (no network, no concurrent writer), so the race window
  // disappears.
  const e = new Embedder(DEFAULT_MODEL_ID);
  await e.embed('globalSetup model cache warm-up');
}
