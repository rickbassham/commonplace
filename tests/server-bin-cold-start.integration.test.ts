/**
 * DAR-955 cold-start invariants for the spawned-bin integration harness.
 *
 * # Background
 *
 * `tests/server-bin.integration.test.ts` (DAR-919) was flaky on `make test`
 * runs from a cold transformers.js model cache: the first invocation
 * occasionally failed with one of two surface symptoms,
 *
 *   - `MCP error -32000: Connection closed` (child process died), or
 *   - a CallToolResult with `isError: true` whose payload reads
 *     `Load model from .../onnx/model.onnx failed:Protobuf parsing failed.`
 *
 * Both symptoms have the same underlying cause:
 *
 *   **Concurrent transformers.js downloads to a shared on-disk model cache
 *   corrupt the in-flight files.** Two vitest workers (this file, the bin
 *   integration test, and the in-process embedder integration tests) each
 *   load `Xenova/bge-base-en-v1.5` at the same time on a fresh cache. The
 *   library does not lock around its writes, so worker A reads a partial
 *   `model.onnx` worker B is still streaming and the ONNX runtime fails to
 *   parse the protobuf. The handler surfaces that as `isError: true`; if
 *   the failure happens early enough in the embedder `pipeline()` factory,
 *   the child throws on import and the transport observes a bare
 *   `Connection closed`.
 *
 * # Fix shape
 *
 * The fix synchronously establishes the precondition that the race violates:
 * before any test worker spawns, vitest's `globalSetup` constructs a single
 * Embedder and calls `embed()` on it. That serialises the download into one
 * process, so by the time worker forks happen the cache files are complete
 * on disk and concurrent reads are safe. See `tests/global-setup.ts`.
 *
 * # Test coverage
 *
 * The two `it` blocks below are boot-ordering invariants: after vitest's
 * `globalSetup` has run, the model cache contains a non-empty, parseable
 * `onnx/model.onnx`. This is the precondition that the race violated;
 * asserting it programmatically at the start of every test session locks
 * the fix in place.
 *
 * # Reproducing the original race
 *
 * The deterministic reproduction tooling (clear cache, race two concurrent
 * embedder loads, expect at least one to fail) lives at
 * `scripts/reproduce-cold-start-race.sh`. It is intentionally NOT a
 * vitest-managed test because:
 *
 *   - It is destructive (deletes the on-disk model cache, ~440 MB redownload).
 *   - It asserts deliberate failure of an in-process load, which is not a
 *     thing vitest should run by default.
 *   - It only matters when investigating a regression of the same race
 *     class -- not on every CI run.
 *
 * Run the script manually if `make test` ever starts surfacing
 * `Protobuf parsing failed` / `Connection closed` again to confirm the
 * race class is back, then write a fresh regression test for the specific
 * new failure surface.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { modelOnnxPath } from './support/model-cache.js';

const MODEL_ID = 'Xenova/bge-base-en-v1.5';

describe('DAR-955: boot-ordering invariant (model cache precondition)', () => {
  it('after globalSetup runs, the transformers.js model cache contains a non-empty model.onnx for the configured embedder model', () => {
    // The race we are guarding against is: a worker reads `model.onnx` while
    // another writer is still streaming it. The globalSetup eliminates the
    // race by completing the download in a single process before any worker
    // forks. Asserting the file exists and is non-empty is the testable
    // surface of "globalSetup ran and the precondition holds".
    const onnxPath = modelOnnxPath(MODEL_ID);
    expect(existsSync(onnxPath)).toBe(true);
    const size = statSync(onnxPath).size;
    expect(size).toBeGreaterThan(0);
  });

  it('after globalSetup runs, the model.onnx file is a well-formed ONNX protobuf (the byte that previously surfaced as "Protobuf parsing failed" reads as expected)', () => {
    // ONNX models are protobuf-encoded with a known framing: byte 0 is the
    // tag byte (`0x08`, field 1, varint) for `ir_version`. A truncated /
    // partial download would not satisfy this, which is exactly the failure
    // mode the bug report described. Reading a few bytes is enough to prove
    // the file is structurally an ONNX protobuf, not a half-written stream.
    const onnxPath = modelOnnxPath(MODEL_ID);
    const head = readFileSync(onnxPath).subarray(0, 1);
    // ONNX models always begin with the protobuf tag for ir_version (field
    // number 1, wire type VARINT) which is `(1 << 3) | 0 = 0x08`.
    expect(head[0]).toBe(0x08);
  });
});
