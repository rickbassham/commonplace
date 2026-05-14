/**
 * Helpers for locating the on-disk transformers.js model cache that the
 * cold-start tests need to inspect (existence, size, parseability).
 *
 * transformers.js resolves its `cacheDir` to `<pkg>/.cache/` where `<pkg>`
 * is the install root of `@huggingface/transformers`. Under pnpm that path
 * lives in the `.pnpm` virtual store; we resolve it via the runtime module
 * lookup rather than hard-coding so a transformers version bump (which
 * changes the `.pnpm/...` segment) does not silently break tests.
 *
 * Used by:
 *   - `tests/server-bin-cold-start.integration.test.ts` (ac-2 boot-ordering
 *     invariant: assert the cache file exists after globalSetup runs)
 *   - `tests/global-setup.ts` (the actual preload that writes the cache)
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Absolute path to the directory transformers.js writes its model cache
 * into for our environment, scoped to `<modelId>` (e.g.
 * `<pkg>/.cache/Xenova/bge-base-en-v1.5/`).
 *
 * Resolution mirrors transformers.js's own `DEFAULT_CACHE_DIR` computation:
 *   `path.join(path.dirname(path.dirname(transformersEntryFile)), '.cache')`
 * (the entry file is `<pkg>/src/transformers.js` in dev or `<pkg>/dist/...`
 * in published builds; either way, two `dirname` calls land on `<pkg>`).
 */
export function modelCacheRoot(modelId: string): string {
  // Resolve via createRequire so we get the same package transformers.js
  // imports at runtime, regardless of pnpm's nested `.pnpm/...` layout.
  const here = dirname(fileURLToPath(import.meta.url));
  const req = createRequire(join(here, 'noop.js'));
  const entry = req.resolve('@huggingface/transformers');
  const pkgDir = dirname(dirname(entry));
  return join(pkgDir, '.cache', modelId);
}

/**
 * Absolute path to the ONNX model weights file that the embedder loads at
 * the first `embed()` call. The race we are guarding against corrupts this
 * exact file when two processes download concurrently.
 */
export function modelOnnxPath(modelId: string): string {
  return join(modelCacheRoot(modelId), 'onnx', 'model.onnx');
}
