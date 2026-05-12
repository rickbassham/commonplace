/**
 * DAR-933 ac-1 / ac-3 / ac-6 spawned-bin coverage: prove the built
 * `commonplace` bin dispatches the `graph` subcommand and produces a
 * mermaid / json / dot rendering for a fixture memory dir.
 *
 * The in-process suite (`graph-cli.test.ts`) drives `graphMain` directly
 * with a stub embedder so it can run fast. This file exists so the
 * spawned-bin wiring -- the dispatcher's `argv[0] === 'graph'` short-
 * circuit, the embedder factory, the real `MemoryStore.scan()` cold-start --
 * is covered end-to-end. A missing wire would surface here as a non-zero
 * exit or an empty stdout despite an in-process test passing.
 *
 * Slow on purpose: pays the real Embedder cold-start price.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeMemory, type Memory } from '../src/store/memory.js';

const repoRoot = join(__dirname, '..');

interface PackageJson {
  bin?: Record<string, string>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isPackageJson = (v: unknown): v is PackageJson => {
  if (!isObject(v)) return false;
  if (v.bin === undefined) return true;
  return isObject(v.bin) && Object.values(v.bin).every((entry) => typeof entry === 'string');
};

function readBinPath(): string {
  const raw: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (!isPackageJson(raw)) throw new Error('package.json shape unexpected');
  const bin = raw.bin;
  if (bin === undefined) throw new Error('package.json bin field missing');
  const entry = bin['commonplace'];
  if (typeof entry !== 'string') throw new Error('bin.commonplace missing');
  return join(repoRoot, entry);
}

const makeMemory = (name: string, body = `body of ${name}`): Memory => ({
  name,
  description: `description for ${name}`,
  type: 'reference',
  body,
});

describe('DAR-933: spawned `commonplace graph` bin', () => {
  const binPath = readBinPath();
  let userDir: string;

  beforeAll(() => {
    const res = spawnSync('make', ['build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, CI: '1' },
    });
    if (res.status !== 0) {
      throw new Error(`make build failed: ${res.stderr || res.stdout}`);
    }
    if (!existsSync(binPath)) {
      throw new Error(`bin not found after build: ${binPath}`);
    }
  }, 200_000);

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'dar933-bin-'));
    // Seed two memories so the graph traversal has something to walk. The
    // bin's scan/embed pass will write the sidecars on first run -- the
    // graph render exercises the same path the in-process test exercises
    // via the stub embedder.
    writeMemory(join(userDir, 'alpha.md'), {
      ...makeMemory('alpha'),
      relations: [{ to: 'beta', type: 'related-to' }],
    });
    writeMemory(join(userDir, 'beta.md'), makeMemory('beta'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('`commonplace graph alpha` against a fixture memory dir exits 0 and writes a mermaid block to stdout', () => {
    const res = spawnSync('node', [binPath, 'graph', 'alpha'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        COMMONPLACE_USER_DIR: userDir,
      },
    });
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout.startsWith('```mermaid\nflowchart LR\n')).toBe(true);
    expect(res.stdout.trimEnd().endsWith('```')).toBe(true);
    expect(res.stdout).toContain('alpha');
    expect(res.stdout).toContain('beta');
    expect(res.stdout).toContain('-- "related-to" -->');
  }, 180_000);

  it('`commonplace graph` (no positional arg) prints a usage message to stderr and exits non-zero', () => {
    const res = spawnSync('node', [binPath, 'graph'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        COMMONPLACE_USER_DIR: userDir,
      },
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('Usage');
    expect(res.stderr).toContain('graph');
  }, 60_000);

  it('`commonplace graph --help` exits 0 and prints flag documentation', () => {
    const res = spawnSync('node', [binPath, 'graph', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, COMMONPLACE_USER_DIR: userDir },
    });
    expect(res.status, res.stderr).toBe(0);
    for (const flag of ['--depth', '--types', '--direction', '--format', '--scope']) {
      expect(res.stdout).toContain(flag);
    }
    expect(res.stdout).toMatch(/--format[^\n]*default[^\n]*mermaid/i);
  }, 60_000);

  it('`commonplace graph alpha --format json` emits parseable JSON matching the memory_graph response shape', () => {
    const res = spawnSync('node', [binPath, 'graph', 'alpha', '--format', 'json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, COMMONPLACE_USER_DIR: userDir },
    });
    expect(res.status, res.stderr).toBe(0);
    const decoded = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(['edges', 'nodes', 'root']);
  }, 180_000);
});
