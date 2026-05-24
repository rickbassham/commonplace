---
name: macos_apfs_fsync_test_perf
description: Why MemoryStore-backed tests are dramatically slower on macOS than
  Linux CI, and the vitest.config.ts cap that compensates.
type: project
---

# macOS APFS fsync is the dominant cost in write-heavy tests

## The phenomenon

Tests that drive `MemoryStore.save()` many times are roughly **10-20x
slower on macOS than on Linux CI**, even though the macOS host has a
faster CPU and SSD. The cost is per-call, not per-byte.

Measured on DAR-959 / PR #64 (commit `3db4043`):

|                                                                                   | Linux CI (Node 22) | This M2 Mac (APFS)                              |
| --------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------- |
| `tests/server-handlers-search-supersede-headroom.test.ts` (8 tests, ~1600 fsyncs) | **2043 ms**        | **31581 ms** (with default 12-fork parallelism) |
| Per-fsync amortised                                                               | ~1.3 ms            | ~20 ms                                          |

With fsyncs disabled experimentally (don't ship), the same file ran in
**404 ms** on macOS — a 21x improvement. That isolates fsync as the
cause; the rest of the code path is fast.

## Why

`src/store/atomic-write.ts` does write-temp + `fileHandle.sync()` +
rename + dir `fsync()`. Two fsyncs per `.md` or `.embedding` write,
four per `MemoryStore.save()` (md + sidecar). APFS's fsync forces a
journal flush; Linux ext4's fsync is roughly an order of magnitude
cheaper for the same call pattern. This is the crash-safety guarantee
the production path is paying for and is **not negotiable**: the store
exists to be durable, and crash-safety tests
(`tests/*ac-7*crash-safety*`) lock that contract in.

## The compensation in `vitest.config.ts`

Vitest defaults to one fork per CPU (12 on this Mac). 12 parallel fork
workers all issue fsyncs at the **same shared APFS journal**, so per-
fsync latency degrades further under contention. The supersede-
headroom file's individual tests then tipped past the 5s default
`testTimeout` and looked "flaky."

`vitest.config.ts` now caps `poolOptions.forks.maxForks: 4`. This
bounds journal contention without weakening anything tested. Linux CI
runners have fewer cores, so the cap is a no-op there.

## Knock-on rules for future work

- **Don't add `sync: false` / "skip fsync in tests" hatches** to
  `atomic-write`. That would have tests run a different code path than
  production -- the whole point of the helper is durability.
- **Don't paper over slowness with `testTimeout` bumps** unless the
  test genuinely needs longer wall time on its merits.
- When writing new tests that seed many entries via `MemoryStore.save()`,
  prefer the minimum corpus that proves the assertion. A 50-entry
  seed when the assertion needs `corpus > 8` is wasted fsync cost on
  every macOS contributor's machine.
- If you ever need a fast in-memory store for a test, widen the
  injection seam (atomic-write already has `__atomicWriteHooks.fs`;
  `MemoryStore` reads via raw `node:fs` and would need its own seam).
  Memfs would run the **same** atomic-write code path with the fsyncs
  becoming no-ops -- principled, unlike a `sync: false` flag.

## See also

- `vitest.config.ts` (the cap, with inline explanation)
- `src/store/atomic-write.ts:94,102` (the two fsync sites)
- PR #64 / commit `3db4043` (where this was diagnosed and fixed)
