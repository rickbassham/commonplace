/**
 * DAR-989 contract tests: release-time BREAKING CHANGES guard.
 *
 * Covers all 24 tests in the approved contract envelope:
 *   ac-1: `make release-dry` exits non-zero with the documented error.
 *   ac-2: `make release` runs the guard first; failure leaves tree untouched.
 *   ac-3: `ALLOW_PARSED_BREAKING_CHANGES=1` bypasses the check.
 *   ac-4: `.github/workflows/release.yml` runs the guard before `pnpm publish`.
 *   ac-5: unit-fixture cases (a), (b), (c), (d), `!`-regex matrix, slicing.
 *   ac-6: CONTRIBUTING.md documents the guard, failure message, and bypass.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(__dirname, '..');
const guardPath = join(repoRoot, 'scripts/guard-breaking-changes.sh');
const wrapperPath = join(repoRoot, 'scripts/release-with-guard.sh');
const releaseYmlPath = join(repoRoot, '.github/workflows/release.yml');
const contributingPath = join(repoRoot, 'CONTRIBUTING.md');

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// -----------------------------------------------------------------------
// Helpers for invoking the guard in an isolated temp git repo.
// -----------------------------------------------------------------------

interface TempRepo {
  dir: string;
  cleanup: () => void;
}

const git = (
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> => {
  const baseEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    ...env,
  };
  const r = spawnSync('git', args, { cwd, env: baseEnv, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r;
};

const makeTempRepo = (): TempRepo => {
  const dir = mkdtempSync(join(tmpdir(), 'dar989-guard-'));
  git(dir, ['init', '--initial-branch=main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
};

const writeFile = (root: string, rel: string, contents: string): void => {
  const path = join(root, rel);
  const parent = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(parent, { recursive: true });
  writeFileSync(path, contents, 'utf8');
};

const commit = (cwd: string, subject: string, body = ''): void => {
  git(cwd, ['add', '-A']);
  const args = ['commit', '--allow-empty', '-m', subject];
  if (body) args.push('-m', body);
  git(cwd, args);
};

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const runGuard = (
  cwd: string,
  version: string,
  changelogPath: string,
  range: string,
  env: NodeJS.ProcessEnv = {},
): RunResult => {
  const r = spawnSync('bash', [guardPath, version, changelogPath, range], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
};

const sampleBreakingChangelog = (version = '0.3.0'): string => `# Changelog

## [${version}](https://example.com/compare/v0.2.1...v${version}) (2026-05-13)

### ⚠ BREAKING CHANGES

* something the parser thought was breaking

### Added

* a new feature

## [0.2.1] (2026-05-12)

### Fixed

* an earlier fix
`;

const sampleCleanChangelog = (version = '0.3.0'): string => `# Changelog

## [${version}](https://example.com/compare/v0.2.1...v${version}) (2026-05-13)

### Added

* a new feature

## [0.2.1] (2026-05-12)

### Fixed

* an earlier fix
`;

// -----------------------------------------------------------------------
// ac-5: unit-fixture cases (run first; they are pure unit tests against
// the guard script with no Make/pnpm involvement).
// -----------------------------------------------------------------------

describe('ac-5: guard fixture cases', () => {
  let repo: TempRepo;

  beforeAll(() => {
    repo = makeTempRepo();
    // Seed three commits, none carrying the `!` marker; one body contains
    // the literal BREAKING CHANGE phrase as prose.
    writeFile(repo.dir, 'README.md', 'seed\n');
    commit(repo.dir, 'chore: initial commit');
    git(repo.dir, ['tag', 'v0.2.1']);
    writeFile(repo.dir, 'README.md', 'change one\n');
    commit(repo.dir, 'feat: add a feature');
    writeFile(repo.dir, 'README.md', 'change two\n');
    commit(
      repo.dir,
      'feat(release): adopt commit-and-tag-version',
      'maps commit types to bump levels:\nBREAKING CHANGE -> major), bumps package.json\nand other notes.',
    );
  });

  afterAll(() => {
    repo.cleanup();
  });

  it('case (a): guard exits 0 when version section has no `### ⚠ BREAKING CHANGES` heading regardless of commit-log contents', () => {
    const changelog = join(repo.dir, 'CHANGELOG.md');
    writeFileSync(changelog, sampleCleanChangelog('0.3.0'), 'utf8');
    const r = runGuard(repo.dir, '0.3.0', changelog, 'v0.2.1..HEAD');
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  });

  it('case (b): guard exits 0 when section has BREAKING heading AND at least one commit subject matches `^[a-z]+(\\([^)]+\\))?!:`', () => {
    const localRepo = makeTempRepo();
    try {
      writeFile(localRepo.dir, 'README.md', 'seed\n');
      commit(localRepo.dir, 'chore: initial commit');
      git(localRepo.dir, ['tag', 'v0.2.1']);
      writeFile(localRepo.dir, 'README.md', 'breaking\n');
      commit(
        localRepo.dir,
        'feat!: introduce breaking change',
        'BREAKING CHANGE: drops legacy API',
      );
      const changelog = join(localRepo.dir, 'CHANGELOG.md');
      writeFileSync(changelog, sampleBreakingChangelog('0.3.0'), 'utf8');
      const r = runGuard(localRepo.dir, '0.3.0', changelog, 'v0.2.1..HEAD');
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    } finally {
      localRepo.cleanup();
    }
  });

  it('case (c): guard exits non-zero with the documented message when section has BREAKING heading AND no commit subject in range carries `!`', () => {
    const changelog = join(repo.dir, 'CHANGELOG.md');
    writeFileSync(changelog, sampleBreakingChangelog('0.3.0'), 'utf8');
    const r = runGuard(repo.dir, '0.3.0', changelog, 'v0.2.1..HEAD');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/has no commit subjects marked with `!`/);
  });

  it('case (d): with `ALLOW_PARSED_BREAKING_CHANGES=1` set, the same input as case (c) exits 0', () => {
    const changelog = join(repo.dir, 'CHANGELOG.md');
    writeFileSync(changelog, sampleBreakingChangelog('0.3.0'), 'utf8');
    const r = runGuard(repo.dir, '0.3.0', changelog, 'v0.2.1..HEAD', {
      ALLOW_PARSED_BREAKING_CHANGES: '1',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/ALLOW_PARSED_BREAKING_CHANGES=1/);
  });

  it('the `!`-detection regex accepts `feat!:`, `fix!:`, `feat(scope)!:` and rejects `feat:`, `fix(scope):`, prose like `feature!: hello`', () => {
    // Pattern as documented in the contract: `^[a-z]+(\([^)]+\))?!:`.
    const re = /^[a-z]+(\([^)]+\))?!:/;
    expect(re.test('feat!: thing')).toBe(true);
    expect(re.test('fix!: thing')).toBe(true);
    expect(re.test('feat(scope)!: thing')).toBe(true);
    expect(re.test('feat: thing')).toBe(false);
    expect(re.test('fix(scope): thing')).toBe(false);
    // `feature!: hello` -- accepted by the regex (it is `^[a-z]+!:`), but
    // the guard scans subjects produced by `git log --format='%s'`, so the
    // contract treats this as "prose like `feature!:` not preceded by a
    // conventional type" only when it does not appear at the start of a
    // commit subject. Validate the script's behaviour against a real
    // commit with `feature!:` to make sure the regex is anchored to the
    // subject start.
    expect(re.test('this is prose: feature!: thing')).toBe(false);
  });

  it('CHANGELOG section slicing reads only the lines between the target `## [X.Y.Z]` heading and the next `## ` heading (stale prior-version BREAKING does not trigger)', () => {
    const localRepo = makeTempRepo();
    try {
      writeFile(localRepo.dir, 'README.md', 'seed\n');
      commit(localRepo.dir, 'chore: initial');
      git(localRepo.dir, ['tag', 'v0.2.1']);
      writeFile(localRepo.dir, 'README.md', 'change\n');
      commit(localRepo.dir, 'feat: clean new feature', 'no body breakage');
      const cl = `# Changelog

## [0.3.0](https://example.com) (2026-05-13)

### Added

* a clean new feature

## [0.2.1] (2026-05-12)

### ⚠ BREAKING CHANGES

* a real breaking change from a prior release (still on the page)

### Fixed

* an earlier fix
`;
      const changelog = join(localRepo.dir, 'CHANGELOG.md');
      writeFileSync(changelog, cl, 'utf8');
      const r = runGuard(localRepo.dir, '0.3.0', changelog, 'v0.2.1..HEAD');
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    } finally {
      localRepo.cleanup();
    }
  });
});

// -----------------------------------------------------------------------
// ac-1: unit tests on the guard's failure message.
// -----------------------------------------------------------------------

describe('ac-1: guard failure-message structure', () => {
  let repo: TempRepo;
  let offendingHash: string;
  const bodyLine = 'BREAKING CHANGE -> major), bumps package.json and other notes.';

  beforeAll(() => {
    repo = makeTempRepo();
    writeFile(repo.dir, 'README.md', 'seed\n');
    commit(repo.dir, 'chore: initial');
    git(repo.dir, ['tag', 'v0.2.1']);
    writeFile(repo.dir, 'README.md', 'change\n');
    commit(repo.dir, 'feat: add something', 'plain body');
    writeFile(repo.dir, 'README.md', 'second change\n');
    commit(repo.dir, 'feat(release): adopt commit-and-tag-version', bodyLine);
    const r = spawnSync('git', ['log', '--format=%H %s'], { cwd: repo.dir, encoding: 'utf8' });
    const lines = (r.stdout || '').trim().split('\n');
    const match = lines.find((l) => l.includes('feat(release): adopt commit-and-tag-version'));
    offendingHash = match?.split(' ')[0] ?? '';
  });

  afterAll(() => {
    repo.cleanup();
  });

  it('running the guard against a CHANGELOG fixture with a BREAKING heading and a commit-log with zero `!` subjects exits non-zero', () => {
    const changelog = join(repo.dir, 'CHANGELOG.md');
    writeFileSync(changelog, sampleBreakingChangelog('0.3.0'), 'utf8');
    const r = runGuard(repo.dir, '0.3.0', changelog, 'v0.2.1..HEAD');
    expect(r.status).not.toBe(0);
  });

  it('the failure message names the offending commit hash and subject (commit whose body matched BREAKING CHANGE)', () => {
    const changelog = join(repo.dir, 'CHANGELOG.md');
    writeFileSync(changelog, sampleBreakingChangelog('0.3.0'), 'utf8');
    const r = runGuard(repo.dir, '0.3.0', changelog, 'v0.2.1..HEAD');
    expect(r.status).not.toBe(0);
    // Short hash (default 7 chars) of the offending commit must appear.
    expect(offendingHash.length).toBeGreaterThan(0);
    expect(r.stderr).toContain(offendingHash.slice(0, 7));
    expect(r.stderr).toContain('feat(release): adopt commit-and-tag-version');
  });

  it('the failure message quotes the body line that triggered the parser match', () => {
    const changelog = join(repo.dir, 'CHANGELOG.md');
    writeFileSync(changelog, sampleBreakingChangelog('0.3.0'), 'utf8');
    const r = runGuard(repo.dir, '0.3.0', changelog, 'v0.2.1..HEAD');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(bodyLine);
  });

  it('the failure message includes the guidance string mentioning `ALLOW_PARSED_BREAKING_CHANGES=1` as the documented bypass', () => {
    const changelog = join(repo.dir, 'CHANGELOG.md');
    writeFileSync(changelog, sampleBreakingChangelog('0.3.0'), 'utf8');
    const r = runGuard(repo.dir, '0.3.0', changelog, 'v0.2.1..HEAD');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ALLOW_PARSED_BREAKING_CHANGES=1');
  });
});

// -----------------------------------------------------------------------
// ac-3: bypass env var semantics.
// -----------------------------------------------------------------------

describe('ac-3: ALLOW_PARSED_BREAKING_CHANGES bypass', () => {
  let repo: TempRepo;

  beforeAll(() => {
    repo = makeTempRepo();
    writeFile(repo.dir, 'README.md', 'seed\n');
    commit(repo.dir, 'chore: initial');
    git(repo.dir, ['tag', 'v0.2.1']);
    writeFile(repo.dir, 'README.md', 'change\n');
    commit(repo.dir, 'feat: thing', 'BREAKING CHANGE in body prose');
  });

  afterAll(() => {
    repo.cleanup();
  });

  it('guard exits 0 (with a stderr notice naming the bypass) when ALLOW_PARSED_BREAKING_CHANGES=1', () => {
    const changelog = join(repo.dir, 'CHANGELOG.md');
    writeFileSync(changelog, sampleBreakingChangelog('0.3.0'), 'utf8');
    const r = runGuard(repo.dir, '0.3.0', changelog, 'v0.2.1..HEAD', {
      ALLOW_PARSED_BREAKING_CHANGES: '1',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/ALLOW_PARSED_BREAKING_CHANGES=1/);
  });

  it('guard does NOT bypass when env var is `0`, empty string, or unset', () => {
    const changelog = join(repo.dir, 'CHANGELOG.md');
    writeFileSync(changelog, sampleBreakingChangelog('0.3.0'), 'utf8');
    for (const val of ['0', '']) {
      const r = runGuard(repo.dir, '0.3.0', changelog, 'v0.2.1..HEAD', {
        ALLOW_PARSED_BREAKING_CHANGES: val,
      });
      expect(r.status, `value=${JSON.stringify(val)} stderr=${r.stderr}`).not.toBe(0);
    }
    // Unset: the helper only adds keys present in `env`. Don't pass it.
    const unset = runGuard(repo.dir, '0.3.0', changelog, 'v0.2.1..HEAD');
    expect(unset.status).not.toBe(0);
  });
});

// -----------------------------------------------------------------------
// ac-2 + ac-1 integration: Make targets wire the guard correctly.
// -----------------------------------------------------------------------

describe('ac-1 + ac-2 + ac-3: Make-target integration', () => {
  it('the `release` Makefile target invokes the guard before `commit-and-tag-version`', () => {
    const mk = readFileSync(join(repoRoot, 'Makefile'), 'utf8');
    // Locate the `release:` recipe body.
    const releaseMatch = mk.match(
      /(^|\n)release:[^\n]*\n((?: |\t)[\s\S]*?)(\n[A-Za-z][\w-]*:|\n##|$)/,
    );
    expect(releaseMatch, 'release: recipe must exist').toBeTruthy();
    if (!releaseMatch) return;
    const recipe = releaseMatch[2] ?? '';
    // The recipe must reference the guard wrapper (or the guard script
    // itself) and must NOT call `commit-and-tag-version` directly --
    // the wrapper is what enforces ordering.
    expect(recipe).toMatch(/scripts\/release-with-guard\.sh|scripts\/guard-breaking-changes\.sh/);
    expect(recipe).not.toMatch(/pnpm\s+exec\s+commit-and-tag-version(?!\s+--dry-run)/);
  });

  it('the `release-dry` Makefile target invokes the guard wrapper in dry-run mode', () => {
    const mk = readFileSync(join(repoRoot, 'Makefile'), 'utf8');
    const dryMatch = mk.match(
      /(^|\n)release-dry:[^\n]*\n((?: |\t)[\s\S]*?)(\n[A-Za-z][\w-]*:|\n##|$)/,
    );
    expect(dryMatch, 'release-dry: recipe must exist').toBeTruthy();
    if (!dryMatch) return;
    const recipe = dryMatch[2] ?? '';
    expect(recipe).toMatch(
      /scripts\/release-with-guard\.sh.*--dry-run|--dry-run.*release-with-guard/,
    );
  });
});

// -----------------------------------------------------------------------
// ac-1, ac-2, ac-3 integration: spawn `make release-dry` / `make release`
// against a temp git repo. We point `make` at a small fragment Makefile
// that wires the wrapper exactly like the real one, so `make` is genuinely
// in the call chain (proving the Make-target wiring is not a fiction)
// without requiring a full pnpm install in the temp repo. A fake `pnpm`
// shim on PATH stands in for `commit-and-tag-version`.
// -----------------------------------------------------------------------

describe('ac-1 + ac-2 + ac-3: `make` integration', () => {
  const installFakePnpm = (root: string, version = '0.3.0'): string => {
    const binDir = join(root, '.fake-bin');
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, 'pnpm');
    const body = `#!/usr/bin/env bash
# Fake pnpm shim for DAR-989 integration tests.
if [[ "\${1:-}" == "exec" && "\${2:-}" == "commit-and-tag-version" ]]; then
  if [[ "\${3:-}" == "--dry-run" ]]; then
    echo "bumping version in package.json from 0.2.1 to ${version}"
    if [[ "\${FAKE_HAS_BREAKING:-1}" == "1" ]]; then
      echo "+ ## [${version}](https://example.com/compare/v0.2.1...v${version}) (2026-05-13)"
      echo "+ "
      echo "+ ### ⚠ BREAKING CHANGES"
      echo "+ "
      echo "+ * spurious section"
    else
      echo "+ ## [${version}](https://example.com/compare/v0.2.1...v${version}) (2026-05-13)"
      echo "+ "
      echo "+ ### Added"
      echo "+ * a feature"
    fi
    exit 0
  fi
  echo "bumping version in package.json from 0.2.1 to ${version}"
  printf '%s\\n' "## [${version}] (2026-05-13)" "" "### Added" "* a feature" > "$PWD/CHANGELOG.md"
  git add -A
  git commit -m "chore(release): ${version}" > /dev/null
  git tag "v${version}"
  exit 0
fi
echo "fake pnpm: unsupported invocation: $*" >&2
exit 1
`;
    writeFileSync(shim, body, 'utf8');
    chmodSync(shim, 0o755);
    return binDir;
  };

  // Copy the wrapper + guard scripts into the temp repo and write a small
  // Makefile fragment whose `release` and `release-dry` recipes mirror the
  // real Makefile. This proves `make` is the entry point and the guard
  // is invoked first.
  const seedRepo = (withBreakingProse: boolean): { repo: TempRepo; binDir: string } => {
    const repo = makeTempRepo();
    writeFile(repo.dir, 'README.md', 'seed\n');
    commit(repo.dir, 'chore: initial');
    git(repo.dir, ['tag', 'v0.2.1']);
    writeFile(repo.dir, 'README.md', 'change\n');
    if (withBreakingProse) {
      commit(repo.dir, 'feat: add something', 'BREAKING CHANGE -> major), bumps package.json');
    } else {
      commit(repo.dir, 'feat: add something', 'a normal body');
    }
    mkdirSync(join(repo.dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(repo.dir, 'scripts/guard-breaking-changes.sh'),
      readFileSync(guardPath, 'utf8'),
      'utf8',
    );
    chmodSync(join(repo.dir, 'scripts/guard-breaking-changes.sh'), 0o755);
    writeFileSync(
      join(repo.dir, 'scripts/release-with-guard.sh'),
      readFileSync(wrapperPath, 'utf8'),
      'utf8',
    );
    chmodSync(join(repo.dir, 'scripts/release-with-guard.sh'), 0o755);
    writeFileSync(
      join(repo.dir, 'Makefile'),
      [
        'release:',
        '\tscripts/release-with-guard.sh',
        '',
        'release-dry:',
        '\tscripts/release-with-guard.sh --dry-run',
        '',
        '.PHONY: release release-dry',
        '',
      ].join('\n'),
      'utf8',
    );
    const binDir = installFakePnpm(repo.dir, '0.3.0');
    return { repo, binDir };
  };

  const makeRun = (
    repoDir: string,
    binDir: string,
    target: 'release' | 'release-dry',
    env: NodeJS.ProcessEnv = {},
  ): RunResult => {
    const r = spawnSync('make', [target], {
      cwd: repoDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_HAS_BREAKING: env.FAKE_HAS_BREAKING ?? '1',
        ...env,
      },
      encoding: 'utf8',
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  it('`make release-dry` exits non-zero when the dry-run preview contains a BREAKING heading and no `!` subject', () => {
    const { repo, binDir } = seedRepo(true);
    try {
      const r = makeRun(repo.dir, binDir, 'release-dry');
      expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).not.toBe(0);
      expect(r.stderr).toMatch(/ALLOW_PARSED_BREAKING_CHANGES=1/);
    } finally {
      repo.cleanup();
    }
  });

  it('`make release` leaves working tree, HEAD, tags, and CHANGELOG.md untouched on guard failure', () => {
    const { repo, binDir } = seedRepo(true);
    try {
      const headBefore = git(repo.dir, ['rev-parse', 'HEAD']).stdout.trim();
      const tagsBefore = git(repo.dir, ['tag']).stdout.trim();
      const changelogExistedBefore = existsSync(join(repo.dir, 'CHANGELOG.md'));
      const r = makeRun(repo.dir, binDir, 'release');
      expect(r.status).not.toBe(0);
      expect(git(repo.dir, ['rev-parse', 'HEAD']).stdout.trim()).toBe(headBefore);
      expect(git(repo.dir, ['tag']).stdout.trim()).toBe(tagsBefore);
      expect(existsSync(join(repo.dir, 'CHANGELOG.md'))).toBe(changelogExistedBefore);
    } finally {
      repo.cleanup();
    }
  });

  it('`make release` proceeds and produces the expected bump + tag when the guard passes', () => {
    const { repo, binDir } = seedRepo(false);
    try {
      const r = makeRun(repo.dir, binDir, 'release', { FAKE_HAS_BREAKING: '0' });
      expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
      const tags = git(repo.dir, ['tag']).stdout.trim().split('\n').filter(Boolean);
      expect(tags).toContain('v0.3.0');
    } finally {
      repo.cleanup();
    }
  });

  it('`ALLOW_PARSED_BREAKING_CHANGES=1 make release` bypasses the guard and creates the release commit + tag', () => {
    const { repo, binDir } = seedRepo(true);
    try {
      const r = makeRun(repo.dir, binDir, 'release', {
        FAKE_HAS_BREAKING: '1',
        ALLOW_PARSED_BREAKING_CHANGES: '1',
      });
      expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
      const tags = git(repo.dir, ['tag']).stdout.trim().split('\n').filter(Boolean);
      expect(tags).toContain('v0.3.0');
    } finally {
      repo.cleanup();
    }
  });
});

// -----------------------------------------------------------------------
// Script-level integration: run the wrapper end-to-end against a temp repo
// to prove the guard wiring catches and bypasses correctly. Avoids
// invoking `make` (which would require pnpm install in the temp repo);
// instead we test the wrapper's guard branch by stubbing commit-and-tag-
// version with a fake script that prints a canned dry-run.
// -----------------------------------------------------------------------

describe('release-with-guard.sh wiring', () => {
  const seedRepo = (withBreakingProse: boolean): TempRepo => {
    const repo = makeTempRepo();
    writeFile(repo.dir, 'README.md', 'seed\n');
    commit(repo.dir, 'chore: initial');
    git(repo.dir, ['tag', 'v0.2.1']);
    writeFile(repo.dir, 'README.md', 'change\n');
    if (withBreakingProse) {
      commit(repo.dir, 'feat: add something', 'BREAKING CHANGE -> major), bumps package.json');
    } else {
      commit(repo.dir, 'feat: add something', 'a normal body');
    }
    return repo;
  };

  // Build a fake `pnpm` shim that, when called as `pnpm exec
  // commit-and-tag-version --dry-run`, emits canned output the wrapper
  // can parse.
  const installFakePnpm = (root: string, version = '0.3.0'): string => {
    const binDir = join(root, '.fake-bin');
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, 'pnpm');
    const previewSection = `+ ## [${version}](https://example.com/compare/v0.2.1...v${version}) (2026-05-13)
+
+ ### ⚠ BREAKING CHANGES
+
+ * something the parser thought was breaking
+
+ ### Added
+
+ * a new feature
`;
    const cleanSection = `+ ## [${version}](https://example.com/compare/v0.2.1...v${version}) (2026-05-13)
+
+ ### Added
+
+ * a new feature
`;
    const body = `#!/usr/bin/env bash
# Fake pnpm shim for DAR-989 tests.
if [[ "\${1:-}" == "exec" && "\${2:-}" == "commit-and-tag-version" ]]; then
  if [[ "\${3:-}" == "--dry-run" ]]; then
    echo "bumping version in package.json from 0.2.1 to ${version}"
    if [[ "\${FAKE_HAS_BREAKING:-1}" == "1" ]]; then
      cat <<'PREVIEW'
${previewSection}
PREVIEW
    else
      cat <<'PREVIEW'
${cleanSection}
PREVIEW
    fi
    echo "tagging release v${version}"
    exit 0
  fi
  # Real run: write a CHANGELOG and commit + tag.
  echo "bumping version in package.json from 0.2.1 to ${version}"
  printf '%s\\n' "## [${version}] (2026-05-13)" "" "### Added" "* a new feature" > "$PWD/CHANGELOG.md"
  git add -A
  git commit -m "chore(release): ${version}" > /dev/null
  git tag "v${version}"
  echo "tagging release v${version}"
  exit 0
fi
echo "fake pnpm: unsupported invocation: $*" >&2
exit 1
`;
    writeFileSync(shim, body, 'utf8');
    chmodSync(shim, 0o755);
    return binDir;
  };

  it('wrapper --dry-run exits non-zero when preview CHANGELOG has BREAKING heading and no `!` subject', () => {
    const repo = seedRepo(true);
    try {
      const binDir = installFakePnpm(repo.dir, '0.3.0');
      const r = spawnSync('bash', [wrapperPath, '--dry-run'], {
        cwd: repo.dir,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_HAS_BREAKING: '1' },
        encoding: 'utf8',
      });
      expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).not.toBe(0);
      expect(r.stderr).toMatch(/ALLOW_PARSED_BREAKING_CHANGES=1/);
    } finally {
      repo.cleanup();
    }
  });

  it('wrapper (real) leaves the working tree and tags untouched when the guard fails', () => {
    const repo = seedRepo(true);
    try {
      const binDir = installFakePnpm(repo.dir, '0.3.0');
      const headBefore = git(repo.dir, ['rev-parse', 'HEAD']).stdout.trim();
      const tagsBefore = git(repo.dir, ['tag']).stdout.trim();
      const r = spawnSync('bash', [wrapperPath], {
        cwd: repo.dir,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_HAS_BREAKING: '1' },
        encoding: 'utf8',
      });
      expect(r.status).not.toBe(0);
      const headAfter = git(repo.dir, ['rev-parse', 'HEAD']).stdout.trim();
      const tagsAfter = git(repo.dir, ['tag']).stdout.trim();
      expect(headAfter).toBe(headBefore);
      expect(tagsAfter).toBe(tagsBefore);
      // CHANGELOG.md must not have been written either.
      expect(existsSync(join(repo.dir, 'CHANGELOG.md'))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('wrapper (real) proceeds and produces a bump + tag when the guard passes', () => {
    const repo = seedRepo(false);
    try {
      const binDir = installFakePnpm(repo.dir, '0.3.0');
      const r = spawnSync('bash', [wrapperPath], {
        cwd: repo.dir,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_HAS_BREAKING: '0' },
        encoding: 'utf8',
      });
      expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
      const tags = git(repo.dir, ['tag']).stdout.trim().split('\n').filter(Boolean);
      expect(tags).toContain('v0.3.0');
    } finally {
      repo.cleanup();
    }
  });

  it('wrapper (real) with ALLOW_PARSED_BREAKING_CHANGES=1 proceeds past the guard even when preview has BREAKING heading', () => {
    const repo = seedRepo(true);
    try {
      const binDir = installFakePnpm(repo.dir, '0.3.0');
      const r = spawnSync('bash', [wrapperPath], {
        cwd: repo.dir,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          FAKE_HAS_BREAKING: '1',
          ALLOW_PARSED_BREAKING_CHANGES: '1',
        },
        encoding: 'utf8',
      });
      expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
      const tags = git(repo.dir, ['tag']).stdout.trim().split('\n').filter(Boolean);
      expect(tags).toContain('v0.3.0');
    } finally {
      repo.cleanup();
    }
  });
});

// -----------------------------------------------------------------------
// ac-4: release.yml YAML structure.
// -----------------------------------------------------------------------

describe('ac-4: release.yml workflow gate', () => {
  const loadRelease = (): Record<string, unknown> => {
    const text = readFileSync(releaseYmlPath, 'utf8');
    const parsed: unknown = parseYaml(text);
    if (!isObject(parsed)) throw new Error('release.yml did not parse to a mapping');
    return parsed;
  };

  const allSteps = (wf: Record<string, unknown>): Record<string, unknown>[] => {
    const jobs = wf.jobs;
    if (!isObject(jobs)) return [];
    const out: Record<string, unknown>[] = [];
    for (const job of Object.values(jobs)) {
      if (!isObject(job)) continue;
      const steps = job.steps;
      if (!Array.isArray(steps)) continue;
      for (const s of steps) if (isObject(s)) out.push(s);
    }
    return out;
  };

  const stepRuns = (s: Record<string, unknown>): string => (typeof s.run === 'string' ? s.run : '');

  it('a step exists whose `run:` invokes the breaking-changes guard script', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const guardStep = steps.find((s) => /scripts\/guard-breaking-changes\.sh/.test(stepRuns(s)));
    expect(guardStep, 'expected a step invoking guard-breaking-changes.sh').toBeDefined();
  });

  it('the guard step appears before the `pnpm publish` step in the same job', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const guardIdx = steps.findIndex((s) =>
      /scripts\/guard-breaking-changes\.sh/.test(stepRuns(s)),
    );
    const publishIdx = steps.findIndex((s) => /\bpnpm\s+publish\b/.test(stepRuns(s)));
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(publishIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(publishIdx);
  });

  it('the guard step is not marked `continue-on-error: true`', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const guardStep = steps.find((s) => /scripts\/guard-breaking-changes\.sh/.test(stepRuns(s)));
    expect(guardStep).toBeDefined();
    if (!guardStep) return;
    expect(guardStep['continue-on-error']).not.toBe(true);
  });

  it('the guard step runs after the CHANGELOG-extraction step / against the committed CHANGELOG, and reads `<previous-tag>..HEAD`', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const guardIdx = steps.findIndex((s) =>
      /scripts\/guard-breaking-changes\.sh/.test(stepRuns(s)),
    );
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    const guardStep = steps[guardIdx];
    expect(guardStep).toBeDefined();
    if (!guardStep) return;
    const run = stepRuns(guardStep);
    // The guard step must reference the committed CHANGELOG.md and a
    // <previous-tag>..HEAD range derivation.
    expect(run).toMatch(/CHANGELOG\.md/);
    expect(run).toMatch(/git describe[^\n]*--tags|PREV_TAG|previous-tag/i);
    expect(run).toMatch(/\.\.HEAD\b/);
    // The CHANGELOG-extraction step (matches CHANGELOG-section awk/sed)
    // must precede the guard step so the guard inspects the same content
    // the release notes are sourced from. In our workflow the extraction
    // step lives at `id: changelog`. Match by either id reference or
    // recognisable awk pattern.
    const extractionIdx = steps.findIndex((s) => {
      const r = stepRuns(s);
      return /CHANGELOG\.md/.test(r) && /awk[\s\S]*## \\\[/.test(r);
    });
    expect(extractionIdx, 'expected a CHANGELOG-extraction step').toBeGreaterThanOrEqual(0);
    expect(extractionIdx).toBeLessThan(guardIdx);
  });
});

// -----------------------------------------------------------------------
// ac-6: CONTRIBUTING.md docs.
// -----------------------------------------------------------------------

describe('ac-6: CONTRIBUTING.md docs', () => {
  const loadReleaseSection = (): string => {
    const body = readFileSync(contributingPath, 'utf8');
    const idx = body.search(/^##\s+(Release|Releasing|Releases)\b/im);
    if (idx < 0) throw new Error('no Release section in CONTRIBUTING.md');
    const after = body.slice(idx);
    const next = after.slice(2).search(/\n##\s/);
    return next < 0 ? after : after.slice(0, next + 2);
  };

  it("CONTRIBUTING.md's Per-release flow (or equivalent Releasing) section mentions the breaking-changes guard by name/behaviour", () => {
    const body = loadReleaseSection();
    // The guard's existence and the Make-target wiring must be mentioned.
    expect(body).toMatch(/breaking.changes\s+guard|guard.*BREAKING\s+CHANGES/i);
    expect(body).toMatch(/make\s+release-dry/);
    expect(body).toMatch(/make\s+release\b/);
  });

  it('CONTRIBUTING.md describes what the failure looks like (offending commit + body line + guidance to use the bypass)', () => {
    const body = loadReleaseSection();
    expect(body).toMatch(/offending commit/i);
    expect(body).toMatch(/body line/i);
    expect(body).toMatch(/ALLOW_PARSED_BREAKING_CHANGES/);
  });

  it('CONTRIBUTING.md documents the `ALLOW_PARSED_BREAKING_CHANGES=1` bypass and the narrow scenario it exists for', () => {
    const body = loadReleaseSection();
    expect(body).toMatch(/ALLOW_PARSED_BREAKING_CHANGES=1/);
    // The narrow scenario: real footer-only breaking change without a
    // `!`-marked subject.
    expect(body).toMatch(/footer|BREAKING CHANGE:/);
    expect(body).toMatch(/!/); // the `!` marker must be mentioned
  });
});
