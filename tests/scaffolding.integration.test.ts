/**
 * Scaffolding contract integration tests.
 *
 * These shell out to `make` and assert exit codes / stdout for the
 * required targets.
 *
 * A few targets are intentionally NOT spawned from inside vitest:
 *   - `make test` would recurse (vitest invoking vitest).
 *   - `make install` mutates node_modules under us mid-run.
 *   - `make audit` depends on the live registry and is flaky as a unit
 *     test; the recipe correctness is asserted statically.
 *
 * Their recipes are validated structurally in `scaffolding.test.ts`
 * and operationally by CI invoking the targets directly. They are
 * declared in the implementation envelope's `untested[]` with reasons.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');

const runMake = (args: string[], timeoutMs = 120_000): SpawnSyncReturns<string> =>
  spawnSync('make', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, CI: '1' },
  });

// The build-pipeline contract that previously lived here (`make build`
// produces the compiled CLI entry; running it prints a usage message)
// was removed: no test may invoke a build or depend on the compiled output. The
// production build is verified by CI's `make build` gate, and the
// bare-CLI usage-message behaviour is covered in-process via
// `parseMigrateArgs([])` in `tests/migrate.test.ts` / `tests/graph-cli.test.ts`
// (which assert the dispatcher renders USAGE naming `commonplace migrate`).

describe('ac-10: required Make targets exit 0', () => {
  it('make help exits 0 and lists each required target', () => {
    const res = runMake(['help'], 30_000);
    expect(res.status, res.stderr).toBe(0);
    const out = res.stdout;
    for (const t of ['help', 'install', 'build', 'test', 'typecheck', 'lint', 'format', 'audit']) {
      expect(out, `help output missing target ${t}`).toContain(t);
    }
  });

  it('make typecheck runs tsc --noEmit and exits 0', () => {
    const res = runMake(['typecheck'], 180_000);
    expect(res.status, res.stderr || res.stdout).toBe(0);
  }, 200_000);

  it('make lint exits 0', () => {
    const res = runMake(['lint'], 180_000);
    expect(res.status, res.stderr || res.stdout).toBe(0);
  }, 200_000);

  it('make format exits 0 and is the writing variant', () => {
    const res = runMake(['format'], 180_000);
    expect(res.status, res.stderr || res.stdout).toBe(0);
  }, 200_000);
});

describe('ac-14: bare make runs help', () => {
  it('running `make` (no target) executes the help target', () => {
    const res = runMake([], 30_000);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('Available targets');
  });
});
