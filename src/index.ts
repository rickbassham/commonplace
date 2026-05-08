// Entry point for the commonplace CLI / MCP server.
// This is intentionally minimal in DAR-908: it only proves that the build
// pipeline (tsc -> dist/index.js) produces a runnable artifact. Real wiring
// (MCP server, embedder, store) lands in DAR-909/910/911/912.

console.log('commonplace');
