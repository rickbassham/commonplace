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
  },
});
