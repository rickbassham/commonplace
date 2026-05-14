/**
 * Contract tests: dist-tag derivation script.
 *
 * The script lives at `scripts/derive-dist-tag.sh`. It reads a version
 * string (the package version stripped of the leading `v` from the git
 * tag) and prints a single dist-tag value on stdout. The release
 * workflow uses its stdout as the value passed to
 * `pnpm publish --tag <derived>`. Living in a script (rather than inline
 * shell in the workflow) makes it unit-testable -- which is exactly what
 * this file exercises.
 *
 * Rule: strip the leading `v` (the workflow does this before invoking
 * the script -- the script itself rejects a leading `v` as malformed),
 * then look at any pre-release identifier after the first `-`. If
 * absent, dist-tag is `latest`. If present, dist-tag is the alphabetic
 * prefix of the first pre-release segment (e.g. `beta.1` -> `beta`).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');
const scriptPath = join(repoRoot, 'scripts/derive-dist-tag.sh');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const run = (input: string): RunResult => {
  const result = spawnSync('bash', [scriptPath, input], { encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

describe('ac-10: dist-tag derivation script', () => {
  it('script exists at scripts/derive-dist-tag.sh and is executable', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const stat = statSync(scriptPath);
    expect((stat.mode & 0o100) !== 0, 'derive-dist-tag.sh must be executable').toBe(true);
  });

  it('script is syntactically valid (`bash -n`)', () => {
    const result = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    expect(result.status, `bash -n stderr: ${result.stderr}`).toBe(0);
  });

  it('input `0.1.0` prints `latest` on stdout and exits 0', () => {
    const r = run('0.1.0');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('latest');
  });

  it('input `0.1.0-beta.1` prints `beta` on stdout and exits 0', () => {
    const r = run('0.1.0-beta.1');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('beta');
  });

  it('input `0.1.0-rc.0` prints `rc` on stdout and exits 0', () => {
    const r = run('0.1.0-rc.0');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('rc');
  });

  it('input `1.0.0-alpha` prints `alpha` on stdout and exits 0', () => {
    const r = run('1.0.0-alpha');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('alpha');
  });

  it('input `0.2.0-next.5` prints `next` on stdout and exits 0', () => {
    const r = run('0.2.0-next.5');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('next');
  });

  it('empty-string input exits non-zero with a non-empty stderr message', () => {
    const r = run('');
    expect(r.status).not.toBe(0);
    expect(r.stderr.trim().length).toBeGreaterThan(0);
  });

  it('malformed input `not-a-version` exits non-zero with a non-empty stderr message', () => {
    const r = run('not-a-version');
    expect(r.status).not.toBe(0);
    expect(r.stderr.trim().length).toBeGreaterThan(0);
  });

  it('malformed input `v0.1.0` (leading v) exits non-zero with a non-empty stderr message', () => {
    const r = run('v0.1.0');
    expect(r.status).not.toBe(0);
    expect(r.stderr.trim().length).toBeGreaterThan(0);
  });

  it('malformed input `0.1` (incomplete) exits non-zero with a non-empty stderr message', () => {
    const r = run('0.1');
    expect(r.status).not.toBe(0);
    expect(r.stderr.trim().length).toBeGreaterThan(0);
  });

  it('multi-segment alphabetic prefix (e.g., `0.1.0-beta.1`) returns only `beta`, not `beta.1`', () => {
    const r = run('0.1.0-beta.1');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('beta');
    expect(r.stdout.trim()).not.toBe('beta.1');
  });
});
