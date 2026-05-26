/**
 * In-process coverage for the `commonplace migrate` CLI dispatcher
 * (`migrateMain`) happy paths.
 *
 * These ported the assertions that previously lived in the spawned-bin
 * `tests/migrate-bin.integration.test.ts` (deleted in this change). The bin
 * dispatcher is driven directly via `migrateMain` -- which takes injected
 * stdout/stderr writers, an embedder factory, and returns an exit code
 * rather than calling `process.exit` -- so the CLI's stdout summary, exit
 * code, and on-disk effects are asserted without spawning a child process
 * or depending on the compiled output.
 *
 * The skip-section / resilience variants of these same dispatcher paths are
 * covered in `tests/migrate-resilience.test.ts`; this file covers the
 * happy-path summaries (scan-mode counts, import-mode file landing,
 * detect-mode reporting) that the spawned bin asserted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateMain } from '../src/cli/migrate.js';
import { writeMemory, type Memory } from '../src/store/memory.js';
import type { Embedder } from '../src/store/memory-store.js';

let home: string;
let userDir: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'migrate-cli-home-'));
  userDir = mkdtempSync(join(tmpdir(), 'migrate-cli-user-'));
  dir = mkdtempSync(join(tmpdir(), 'migrate-cli-dir-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const makeStubEmbedder = (modelId = 'Xenova/bge-base-en-v1.5', dim = 4): Embedder => {
  let callCount = 0;
  return {
    modelId,
    dim,
    embed: vi.fn(async (): Promise<Float32Array> => {
      callCount += 1;
      const out = new Float32Array(dim);
      out[0] = callCount;
      return out;
    }),
  };
};

const makeMemory = (name: string, body = `body of ${name}`): Memory => ({
  name,
  description: `description for ${name}`,
  type: 'reference',
  body,
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const runMain = async (
  argv: string[],
  opts: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<RunResult> => {
  let stdout = '';
  let stderr = '';
  const result = await migrateMain({
    argv,
    embedderFactory: () => makeStubEmbedder(),
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
  });
  return { exitCode: result.exitCode, stdout, stderr };
};

// -------------------------------------------------------------------------
// scan mode: `migrate <dir>`
// -------------------------------------------------------------------------

describe('migrateMain `migrate <dir>` happy path', () => {
  it('produces the embedding sidecars and a summary with the contract labels (loaded/embedded/re-embedded/orphaned) and counts, exiting 0', async () => {
    writeMemory(join(dir, 'alpha.md'), makeMemory('alpha'));
    writeMemory(join(dir, 'bravo.md'), makeMemory('bravo'));

    const res = await runMain(['migrate', dir]);

    expect(res.exitCode, res.stderr || res.stdout).toBe(0);
    expect(existsSync(join(dir, 'alpha.embedding'))).toBe(true);
    expect(existsSync(join(dir, 'bravo.embedding'))).toBe(true);
    expect(res.stdout).toContain('loaded');
    expect(res.stdout).toContain('embedded');
    expect(res.stdout).toContain('re-embedded');
    expect(res.stdout).toContain('orphaned');
    expect(res.stdout).toMatch(/embedded:\s+2/);
  });
});

// -------------------------------------------------------------------------
// import mode: `migrate --from claude-code`
// -------------------------------------------------------------------------

describe('migrateMain `migrate --from claude-code` happy path', () => {
  it('imports two compatible files from a fixture HOME and writes both `.md` and `.embedding` into COMMONPLACE_USER_DIR, exiting 0 with an `imported:` summary', async () => {
    const memDir = join(home, '.claude', 'projects', '-test-slug', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeMemory(join(memDir, 'alpha.md'), makeMemory('alpha'));
    writeMemory(join(memDir, 'bravo.md'), makeMemory('bravo'));

    const res = await runMain(['migrate', '--from', 'claude-code'], {
      env: { COMMONPLACE_USER_DIR: userDir },
      home,
    });

    expect(res.exitCode, res.stderr || res.stdout).toBe(0);
    expect(existsSync(join(userDir, 'alpha.md'))).toBe(true);
    expect(existsSync(join(userDir, 'bravo.md'))).toBe(true);
    expect(existsSync(join(userDir, 'alpha.embedding'))).toBe(true);
    expect(existsSync(join(userDir, 'bravo.embedding'))).toBe(true);
    expect(res.stdout).toContain('imported:');
  });
});

// -------------------------------------------------------------------------
// detect mode: `migrate` (no positional)
// -------------------------------------------------------------------------

describe('migrateMain `migrate` (detection mode) happy path', () => {
  it('runs detection against an empty fixture HOME, exits 0, and prints a detection summary header', async () => {
    const res = await runMain(['migrate'], { home });

    expect(res.exitCode, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toContain('commonplace migrate');
    expect(
      res.stdout.includes('detected') || res.stdout.includes('no external memory sources'),
    ).toBe(true);
  });
});
