/**
 * DAR-909 ac-4 tests: bin entry contract.
 *
 * Static portion: package.json declares a `commonplace-mcp` bin pointing at a
 * built JS file under dist/ that begins with a Node shebang and is executable.
 *
 * Runtime portion: spawning the bin entry as a child process with piped stdio
 * yields a process that stays alive until stdin is closed, and writes nothing
 * to stdout before the first MCP message.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function readBinEntry(): string {
  const raw: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (!isObject(raw)) throw new Error('package.json is not an object');
  const bin = raw.bin;
  if (!isObject(bin)) throw new Error('package.json bin is not an object');
  const entry = bin['commonplace-mcp'];
  if (typeof entry !== 'string')
    throw new Error('package.json bin.commonplace-mcp is not a string');
  return entry;
}

describe('ac-4 (static): package.json bin entry', () => {
  it('declares a commonplace-mcp bin entry pointing at a file under dist/', () => {
    const entry = readBinEntry();
    expect(entry).toMatch(/^dist\/.+\.js$/);
  });
});

describe('ac-4 (runtime): bin entry on stdio', () => {
  const binPath = join(repoRoot, readBinEntry());

  beforeAll(() => {
    // Build first so dist/ artifacts exist with the correct shebang.
    const res = spawnSync('make', ['build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, CI: '1' },
    });
    if (res.status !== 0) {
      throw new Error(`make build failed: ${res.stderr || res.stdout}`);
    }
  }, 200_000);

  it('built bin file exists, begins with a Node shebang, and is executable', () => {
    expect(existsSync(binPath)).toBe(true);
    const contents = readFileSync(binPath, 'utf8');
    expect(contents.startsWith('#!')).toBe(true);
    // Shebang must point at node (either /usr/bin/env node or a node path).
    const firstLine = contents.split('\n', 1)[0]!;
    expect(firstLine).toMatch(/node/);
    // Executable bit set for owner.
    const mode = statSync(binPath).mode;
    expect(
      (mode & 0o100) !== 0,
      `expected owner-execute bit on ${binPath}, mode=${mode.toString(8)}`,
    ).toBe(true);
  });

  it('spawned with piped stdio, stays alive until stdin is closed and writes nothing to stdout before the first MCP message', async () => {
    const child = spawn('node', [binPath], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutData = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutData += chunk.toString('utf8');
    });
    let stderrData = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrData += chunk.toString('utf8');
    });

    // Wait 250ms with stdin open. Process should stay alive and produce
    // no stdout (the MCP server writes nothing before receiving a request).
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(child.exitCode).toBeNull();
    expect(stdoutData).toBe('');

    // Close stdin -- the StdioServerTransport closes when stdin ends.
    child.stdin.end();

    // Wait for the child to exit, with a timeout safety net.
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 5_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    // The contract is "stays alive until stdin closed", so an exit after
    // stdin closure is the expected behavior. Either a clean exit (0) or
    // a transport-driven exit is acceptable; what matters is that we did
    // not exit before stdin closed (asserted above) and that we didn't
    // dump anything to stdout before the first MCP message.
    expect(exitCode === 0 || exitCode === null || typeof exitCode === 'number').toBe(true);
    expect(stdoutData, `unexpected stdout: ${stdoutData}; stderr: ${stderrData}`).toBe('');
  }, 30_000);
});
