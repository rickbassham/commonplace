/**
 * Spawn the built `commonplace` bin with the `migrate`
 * subcommand and assert that:
 *
 *   - `migrate <dir>` against a fixture directory produces the expected
 *     sidecars, prints a non-empty summary on stdout containing the
 *     labels 'loaded', 'embedded', 're-embedded', and 'orphaned' along
 *     with their counts, and exits 0.
 *   - `migrate` with no positional argument prints a usage message to
 *     stderr and exits non-zero.
 *
 * The build is performed by `tests/scaffolding.integration.test.ts` via
 * the same `make build` target; we re-run it here defensively because
 * vitest does not order test files.
 *
 * The bin's first invocation pays the transformers.js model load cost
 * (~6-12s on a warm cache, longer cold). The vitest `globalSetup` warms
 * the cache before any worker forks so this test does not race the
 * embedder integration test.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

describe('spawned `commonplace migrate` bin', () => {
  const binPath = readBinPath();
  let tmp: string;

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
    tmp = mkdtempSync(join(tmpdir(), 'dar918-bin-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  afterAll(() => {
    // No-op; per-test cleanup handles tmp dirs.
  });

  it('spawning the bin with `migrate <dir>` against a fixture directory produces the embedding sidecars and a non-empty summary on stdout, exiting 0', () => {
    writeMemory(join(tmp, 'alpha.md'), makeMemory('alpha'));
    writeMemory(join(tmp, 'bravo.md'), makeMemory('bravo'));

    const res = spawnSync('node', [binPath, 'migrate', tmp], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(existsSync(join(tmp, 'alpha.embedding'))).toBe(true);
    expect(existsSync(join(tmp, 'bravo.embedding'))).toBe(true);
    // Summary contains the contract-required labels:
    expect(res.stdout).toContain('loaded');
    expect(res.stdout).toContain('embedded');
    expect(res.stdout).toContain('re-embedded');
    expect(res.stdout).toContain('orphaned');
    // Counts appear:
    expect(res.stdout).toMatch(/embedded:\s+2/);
  }, 180_000);

  it('spawning the bin with `migrate --from claude-code` against a fixture HOME imports two compatible files and writes both `.md` and `.embedding` files into COMMONPLACE_USER_DIR', () => {
    // Lay down ~/.claude/projects/<slug>/memory/{alpha,bravo}.md inside
    // the fixture HOME.
    const fixtureHome = mkdtempSync(join(tmpdir(), 'dar961-bin-home-'));
    const fixtureUserDir = mkdtempSync(join(tmpdir(), 'dar961-bin-user-'));
    try {
      const memDir = join(fixtureHome, '.claude', 'projects', '-test-slug', 'memory');
      mkdirSync(memDir, { recursive: true });
      writeMemory(join(memDir, 'alpha.md'), makeMemory('alpha'));
      writeMemory(join(memDir, 'bravo.md'), makeMemory('bravo'));

      const res = spawnSync('node', [binPath, 'migrate', '--from', 'claude-code'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          HOME: fixtureHome,
          COMMONPLACE_USER_DIR: fixtureUserDir,
        },
      });

      expect(res.status, res.stderr || res.stdout).toBe(0);
      expect(existsSync(join(fixtureUserDir, 'alpha.md'))).toBe(true);
      expect(existsSync(join(fixtureUserDir, 'bravo.md'))).toBe(true);
      expect(existsSync(join(fixtureUserDir, 'alpha.embedding'))).toBe(true);
      expect(existsSync(join(fixtureUserDir, 'bravo.embedding'))).toBe(true);
      expect(res.stdout).toContain('imported:');
    } finally {
      rmSync(fixtureHome, { recursive: true, force: true });
      rmSync(fixtureUserDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('spawning the bin with `migrate` and no positional argument runs detection mode and exits 0 with a stdout summary', () => {
    // Point HOME at an empty tmp dir so detection finds zero sources --
    // this asserts the detect-mode path works end-to-end through the
    // built bin without depending on the user's real `~/.claude/`.
    const res = spawnSync('node', [binPath, 'migrate'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: tmp },
    });
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toContain('commonplace migrate');
    // Either "no external memory sources detected" (empty HOME) or a
    // detected-sources summary header.
    expect(
      res.stdout.includes('detected') || res.stdout.includes('no external memory sources'),
    ).toBe(true);
  }, 60_000);
});
