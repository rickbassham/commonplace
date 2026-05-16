import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // DAR-955: warm the transformers.js model cache once in the main
    // vitest process before any worker forks. The downloaded `.onnx` and
    // tokenizer files would otherwise be written concurrently by parallel
    // workers (embedder.integration.test.ts and the spawned bin in
    // server-bin.integration.test.ts), and one worker reading a partial
    // file produced a sporadic `MCP error -32000: Connection closed` /
    // `Protobuf parsing failed` from the ONNX runtime. globalSetup
    // serialises the download into a single writer; the cache is complete
    // on disk by the time any worker starts. See `tests/global-setup.ts`.
    globalSetup: ['./tests/global-setup.ts'],
    // Cap worker forks. The store fsyncs each `.md` and `.embedding` write
    // (write-temp + fsync + rename + dir-fsync; see
    // `src/store/atomic-write.ts`), and on macOS APFS each fsync costs
    // ~20 ms vs ~1 ms on Linux ext4. Vitest's default is one fork per
    // CPU; on a 12-core Mac that meant ~12 workers all queueing fsyncs at
    // the shared APFS journal, inflating per-test wall time past the 5 s
    // default `testTimeout` for write-heavy tests (e.g. the supersede-
    // headroom file seeds ~50 entries → ~200 fsyncs). Capping at 4
    // bounds journal contention and makes the suite pass deterministically
    // on macOS without weakening any tested code path. Linux CI is
    // unaffected by the cap; it already runs under the same ceiling.
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
  },
});
