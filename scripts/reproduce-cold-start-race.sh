#!/usr/bin/env bash
# DAR-955 cold-start race reproduction (maintainer-only diagnostic).
#
# Triggers the race that motivated tests/global-setup.ts: when two
# vitest workers concurrently load transformers.js with a cold model
# cache, they corrupt the in-flight `model.onnx` and downstream parsing
# fails with one of:
#
#   - `MCP error -32000: Connection closed` (child process died)
#   - `Load model from .../onnx/model.onnx failed: Protobuf parsing failed.`
#   - `mutex lock failed` (libc++ abi in ORT init when files mid-write)
#
# The fix is `tests/global-setup.ts`: serialise the download into the
# vitest main process before any workers fork. The boot-ordering
# invariants in `tests/server-bin-cold-start.integration.test.ts`
# (ac-2) lock the precondition (cache exists, parses) in place
# automatically on every `make test` run.
#
# This script exists as a manual escape hatch: if the cold-start race
# class ever returns (e.g. transformers.js reorganises its cache
# layout), run this to confirm the failure mode is back, then write a
# fresh test for the new manifestation.
#
# Usage:
#   scripts/reproduce-cold-start-race.sh
#
# What it does (destructive):
#   1. Deletes the on-disk transformers.js model cache for
#      Xenova/bge-base-en-v1.5 so every spawn re-downloads.
#   2. Spawns two child processes that each construct an Embedder and
#      call embed(). They share the same cache dir.
#   3. Reports each child's exit status and stderr.
#   4. With the race exposed, at least one child should fail with one
#      of the markers listed above.
#
# Cost: ~440 MB redownload. Several minutes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODEL_ID="Xenova/bge-base-en-v1.5"

# Resolve the cache root the same way tests/support/model-cache.ts does:
# transformers.js writes to `<pkg>/.cache/<modelId>/`.
CACHE_ROOT_JS=$(node --input-type=module -e "
  import { createRequire } from 'node:module';
  import { dirname, join } from 'node:path';
  const require = createRequire(process.cwd() + '/');
  const entry = require.resolve('@huggingface/transformers');
  const pkgDir = dirname(dirname(entry));
  process.stdout.write(join(pkgDir, '.cache', '$MODEL_ID'));
")

if [ -z "$CACHE_ROOT_JS" ]; then
  echo "Failed to resolve transformers.js cache root." >&2
  exit 2
fi

echo "Cache root: $CACHE_ROOT_JS"
if [ -d "$CACHE_ROOT_JS" ]; then
  echo "Clearing cache..."
  rm -rf "$CACHE_ROOT_JS"
fi

# Build dist/ first so the children import the compiled embedder.
echo "Building dist/..."
make build >/dev/null

run_child() {
  local out_file
  out_file=$(mktemp /tmp/race-child-XXXXXX.log)
  node --input-type=module -e "
    import { Embedder } from '${REPO_ROOT}/dist/embedder/index.js';
    const e = new Embedder('${MODEL_ID}');
    e.embed('reproduction probe').then(
      () => process.exit(0),
      (err) => { console.error(err && err.message ? err.message : String(err)); process.exit(1); }
    );
  " >"$out_file" 2>&1 &
  echo "$!:$out_file"
}

echo "Spawning two concurrent embedder loads..."
A=$(run_child)
B=$(run_child)
A_PID="${A%%:*}"; A_LOG="${A##*:}"
B_PID="${B%%:*}"; B_LOG="${B##*:}"

set +e
wait "$A_PID"; A_EXIT=$?
wait "$B_PID"; B_EXIT=$?
set -e

echo
echo "=== child A (pid $A_PID) exit=$A_EXIT ==="
cat "$A_LOG"
echo
echo "=== child B (pid $B_PID) exit=$B_EXIT ==="
cat "$B_LOG"

rm -f "$A_LOG" "$B_LOG"

if [ "$A_EXIT" -ne 0 ] || [ "$B_EXIT" -ne 0 ]; then
  echo
  echo "Race reproduced: at least one child failed (A=$A_EXIT, B=$B_EXIT)."
  echo "The fix in tests/global-setup.ts is the right shape; if you are seeing"
  echo "this on a green tree, the race class has returned -- write a fresh"
  echo "regression test for the specific failure surface and link this script."
  exit 1
fi

echo
echo "Both children succeeded. The race did not reproduce on this run."
echo "transformers.js may have started locking around its cache writes;"
echo "run a few more times to be sure before concluding the underlying"
echo "race is fixed upstream."
