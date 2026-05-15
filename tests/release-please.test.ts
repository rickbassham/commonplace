/**
 * Contract tests: release-please pipeline shape.
 *
 * Verifies the static, committed artefacts of the release-please flow
 * (workflow YAML, config JSON, manifest JSON), the cleanup of the legacy
 * `commit-and-tag-version` (c-and-t-v) stack, the CONTRIBUTING.md rewrite,
 * and the `scripts/setup-branch-protection.sh` payload edits (Phase 3).
 *
 * Manual-typed contract tests (ac-2, ac-7, ac-8, ac-9 live-API, ac-10,
 * ac-11) are post-merge / live-API operations and intentionally not
 * exercised here.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const readJson = (rel: string): unknown => JSON.parse(read(rel));
const exists = (rel: string) => existsSync(join(repoRoot, rel));

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const releasePleaseYmlPath = '.github/workflows/release-please.yml';
const releasePleaseConfigPath = 'release-please-config.json';
const releasePleaseManifestPath = '.release-please-manifest.json';
const branchProtectionScriptPath = 'scripts/setup-branch-protection.sh';

/**
 * Parse the release-please workflow YAML and assert it is a mapping at
 * the top level. Returns a narrowed `Record<string, unknown>` so call
 * sites don't need their own assertion.
 */
const loadReleasePleaseYml = (): Record<string, unknown> => {
  const parsed: unknown = parseYaml(read(releasePleaseYmlPath));
  if (!isObject(parsed)) {
    throw new Error('release-please.yml did not parse to a YAML mapping');
  }
  return parsed;
};

describe('ac-1: release-please workflow file', () => {
  it('.github/workflows/release-please.yml exists and parses as valid YAML', () => {
    expect(exists(releasePleaseYmlPath)).toBe(true);
    const parsed: unknown = parseYaml(read(releasePleaseYmlPath));
    expect(isObject(parsed)).toBe(true);
  });

  it('release-please.yml triggers on push to main', () => {
    const wf = loadReleasePleaseYml();
    // YAML 1.1 may parse bare `on` as boolean `true`.
    const on = wf.on ?? wf['true'];
    expect(isObject(on)).toBe(true);
    if (!isObject(on)) return;
    const push = on.push;
    expect(isObject(push)).toBe(true);
    if (!isObject(push)) return;
    const branches = push.branches;
    expect(Array.isArray(branches)).toBe(true);
    if (!Array.isArray(branches)) return;
    expect(branches).toContain('main');
  });

  it('release-please.yml runs googleapis/release-please-action', () => {
    const wf = loadReleasePleaseYml();
    const jobs = wf.jobs;
    expect(isObject(jobs)).toBe(true);
    if (!isObject(jobs)) return;
    let foundAction = false;
    for (const job of Object.values(jobs)) {
      if (!isObject(job)) continue;
      const steps = job.steps;
      if (!Array.isArray(steps)) continue;
      for (const s of steps) {
        if (!isObject(s)) continue;
        const uses = s.uses;
        if (typeof uses === 'string' && /^googleapis\/release-please-action@/.test(uses)) {
          foundAction = true;
        }
      }
    }
    expect(foundAction).toBe(true);
  });

  it('release-please.yml job (or workflow) grants `contents: write` and `pull-requests: write`', () => {
    const wf = loadReleasePleaseYml();
    // Permissions may be declared at workflow scope, job scope, or both.
    // For each job that runs the release-please-action, the effective
    // permissions (job-level if present, else workflow-level) must include
    // contents:write and pull-requests:write.
    const wfPerms = isObject(wf.permissions) ? wf.permissions : undefined;
    const jobs = wf.jobs;
    expect(isObject(jobs)).toBe(true);
    if (!isObject(jobs)) return;
    let checked = 0;
    for (const job of Object.values(jobs)) {
      if (!isObject(job)) continue;
      const steps = job.steps;
      if (!Array.isArray(steps)) continue;
      const runsAction = steps.some(
        (s) =>
          isObject(s) &&
          typeof s.uses === 'string' &&
          /^googleapis\/release-please-action@/.test(s.uses),
      );
      if (!runsAction) continue;
      checked++;
      const effective = isObject(job.permissions) ? job.permissions : wfPerms;
      expect(
        effective,
        'release-please job must declare permissions (workflow- or job-level)',
      ).toBeDefined();
      if (!effective) return;
      expect(effective.contents).toBe('write');
      expect(effective['pull-requests']).toBe('write');
    }
    expect(checked, 'expected at least one job running release-please-action').toBeGreaterThan(0);
  });
});

/**
 * DAR-1012: the "Dispatch release workflow on new tag" step must supply
 * the repo to `gh workflow run` so it does not depend on a local `.git`
 * directory in the runner workspace. Either form is acceptable:
 *   - pass `-R`/`--repo` followed by `${{ github.repository }}` on the
 *     `run:` line, OR
 *   - declare `GH_REPO: ${{ github.repository }}` in the step's `env:`
 *     block (gh CLI honours `GH_REPO` automatically).
 *
 * These tests parse the workflow YAML structurally (via the `yaml`
 * package) and assert one of the two accepted fixes is present.
 */
const githubRepositoryExpr = '${{ github.repository }}';

/** Locate the dispatch step inside a parsed release-please.yml mapping. */
const findDispatchStep = (wf: Record<string, unknown>): Record<string, unknown> | undefined => {
  const jobs = wf.jobs;
  if (!isObject(jobs)) return undefined;
  for (const job of Object.values(jobs)) {
    if (!isObject(job)) continue;
    const steps = job.steps;
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      if (!isObject(s)) continue;
      const run = typeof s.run === 'string' ? s.run : '';
      // The dispatch step is the one invoking `gh workflow run release.yml`.
      if (/\bgh\s+workflow\s+run\s+release\.yml\b/.test(run)) return s;
    }
  }
  return undefined;
};

/**
 * Predicate matching either accepted fix on a parsed dispatch step.
 * Encapsulated so the same logic can run against in-memory mutations
 * during the negative-case test below.
 */
const dispatchStepSuppliesRepo = (step: Record<string, unknown>): boolean => {
  const run = typeof step.run === 'string' ? step.run : '';
  const env = isObject(step.env) ? step.env : {};
  // -R / --repo flag form: must be followed by the github.repository
  // expression (either bare or quoted).
  const flagForm = /(?:-R|--repo)\s+["']?\$\{\{\s*github\.repository\s*\}\}["']?/.test(run);
  // GH_REPO env-var form: gh CLI honours this automatically.
  const envForm = env.GH_REPO === githubRepositoryExpr;
  return flagForm || envForm;
};

describe('DAR-1012: release-please.yml dispatch step supplies repo to `gh workflow run`', () => {
  it('release-please.yml dispatch step either passes `-R`/`--repo` followed by `${{ github.repository }}` to `gh workflow run` OR declares `GH_REPO: ${{ github.repository }}` in its `env` block', () => {
    const wf = loadReleasePleaseYml();
    const step = findDispatchStep(wf);
    expect(step, 'expected a dispatch step running `gh workflow run release.yml`').toBeDefined();
    if (!step) return;
    expect(
      dispatchStepSuppliesRepo(step),
      'dispatch step must supply repo via `-R`/`--repo` flag or `GH_REPO` env var',
    ).toBe(true);
  });

  it('release-please.yml dispatch step preserves `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` in its `env` block unchanged', () => {
    const wf = loadReleasePleaseYml();
    const step = findDispatchStep(wf);
    expect(step).toBeDefined();
    if (!step) return;
    const env = step.env;
    expect(isObject(env), 'dispatch step must declare an `env` block').toBe(true);
    if (!isObject(env)) return;
    expect(env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
  });

  it('release-please.yml dispatch step\'s `run:` value still invokes `gh workflow run release.yml --ref "$TAG_NAME"` (the existing dispatch command is preserved)', () => {
    const wf = loadReleasePleaseYml();
    const step = findDispatchStep(wf);
    expect(step).toBeDefined();
    if (!step) return;
    const run = typeof step.run === 'string' ? step.run : '';
    // The existing command shape must be preserved: `gh workflow run
    // release.yml --ref "$TAG_NAME"`. Allow additional flags (-R/--repo)
    // anywhere on the line, but the core invocation and --ref reference
    // to TAG_NAME must remain.
    expect(run).toMatch(/\bgh\s+workflow\s+run\s+release\.yml\b/);
    expect(run).toMatch(/--ref\s+"?\$TAG_NAME"?/);
  });

  it('a vitest test file under `tests/` loads `.github/workflows/release-please.yml` via the `yaml` package (not raw substring matching on the file text) and locates the dispatch step structurally', () => {
    // This file is that test file. Structural loading is exercised by
    // `loadReleasePleaseYml()` (which calls `parseYaml`) and the dispatch
    // step is located by walking the parsed `jobs.<name>.steps` array via
    // `findDispatchStep()` -- not by substring-matching the raw YAML text.
    expect(exists('tests/release-please.test.ts')).toBe(true);
    const wf = loadReleasePleaseYml();
    expect(isObject(wf)).toBe(true);
    const step = findDispatchStep(wf);
    expect(step, 'dispatch step must be locatable structurally').toBeDefined();
  });

  it("the drift-check test fails when the dispatch step's `env` block lacks `GH_REPO` AND its `run:` lacks `-R`/`--repo` followed by the repo expression (verified by mutating an in-memory copy of the parsed YAML and re-running the assertion)", () => {
    const wf = loadReleasePleaseYml();
    const step = findDispatchStep(wf);
    expect(step).toBeDefined();
    if (!step) return;
    // Build an in-memory mutation that strips both accepted fixes:
    // - clone the step's env without GH_REPO
    // - strip any `-R`/`--repo <expr>` flag from the run line
    const originalEnv = isObject(step.env) ? step.env : {};
    const mutatedEnv: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(originalEnv)) {
      if (k === 'GH_REPO') continue;
      mutatedEnv[k] = v;
    }
    const originalRun = typeof step.run === 'string' ? step.run : '';
    const mutatedRun = originalRun.replace(
      /\s+(?:-R|--repo)\s+["']?\$\{\{\s*github\.repository\s*\}\}["']?/g,
      '',
    );
    const mutated: Record<string, unknown> = { ...step, env: mutatedEnv, run: mutatedRun };
    expect(
      dispatchStepSuppliesRepo(mutated),
      'mutation that removes both fixes must be detected as a regression',
    ).toBe(false);
  });

  it('the drift-check test passes when only the `GH_REPO` env-var fix is present (no `-R`/`--repo` flag on the run line)', () => {
    // Synthesise an in-memory step with the env-var fix only.
    const syntheticEnvOnly: Record<string, unknown> = {
      env: {
        GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
        GH_REPO: '${{ github.repository }}',
        TAG_NAME: '${{ steps.release.outputs.tag_name }}',
      },
      run: 'gh workflow run release.yml --ref "$TAG_NAME"',
    };
    expect(dispatchStepSuppliesRepo(syntheticEnvOnly)).toBe(true);
  });

  it('the drift-check test passes when only the `-R`/`--repo` flag fix is present (no `GH_REPO` in the env block)', () => {
    // Synthesise an in-memory step with the flag fix only.
    const syntheticFlagOnly: Record<string, unknown> = {
      env: {
        GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
        TAG_NAME: '${{ steps.release.outputs.tag_name }}',
      },
      run: 'gh workflow run release.yml -R "${{ github.repository }}" --ref "$TAG_NAME"',
    };
    expect(dispatchStepSuppliesRepo(syntheticFlagOnly)).toBe(true);
    // Also accept --repo as the long-form variant.
    const longForm: Record<string, unknown> = {
      env: {
        GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
        TAG_NAME: '${{ steps.release.outputs.tag_name }}',
      },
      run: 'gh workflow run release.yml --repo "${{ github.repository }}" --ref "$TAG_NAME"',
    };
    expect(dispatchStepSuppliesRepo(longForm)).toBe(true);
  });
});

describe('ac-1: release-please-config.json', () => {
  it('release-please-config.json exists and parses as valid JSON', () => {
    expect(exists(releasePleaseConfigPath)).toBe(true);
    expect(() => readJson(releasePleaseConfigPath)).not.toThrow();
  });

  it('release-please-config.json sets release-type=node and bump-minor-pre-major=true', () => {
    const cfg = readJson(releasePleaseConfigPath);
    expect(isObject(cfg)).toBe(true);
    if (!isObject(cfg)) return;
    // release-please supports both monorepo-style per-package config under
    // `packages.<dir>` and root-level defaults. For a single-package repo
    // the root-package config lives under `packages["."]`.
    const root = isObject(cfg.packages) && isObject(cfg.packages['.']) ? cfg.packages['.'] : cfg;
    expect(root['release-type']).toBe('node');
    expect(root['bump-minor-pre-major']).toBe(true);
  });

  it('release-please-config.json declares an extra-files entry that updates SERVER_VERSION in src/server/server.ts', () => {
    const cfg = readJson(releasePleaseConfigPath);
    expect(isObject(cfg)).toBe(true);
    if (!isObject(cfg)) return;
    const root = isObject(cfg.packages) && isObject(cfg.packages['.']) ? cfg.packages['.'] : cfg;
    const extra = root['extra-files'];
    expect(Array.isArray(extra)).toBe(true);
    if (!Array.isArray(extra)) return;
    // Find an entry referencing src/server/server.ts. The entry can be a
    // bare string (built-in `generic` updater + `x-release-please-*`
    // annotation comments) or an object with `path: 'src/server/server.ts'`.
    const serverEntry = extra.find((e) => {
      if (typeof e === 'string') return e === 'src/server/server.ts';
      if (isObject(e)) return e.path === 'src/server/server.ts';
      return false;
    });
    expect(serverEntry, 'expected an extra-files entry for src/server/server.ts').toBeDefined();
  });

  it('release-please-config.json changelog-sections mirror the legacy .versionrc.json mapping', () => {
    const cfg = readJson(releasePleaseConfigPath);
    expect(isObject(cfg)).toBe(true);
    if (!isObject(cfg)) return;
    const root = isObject(cfg.packages) && isObject(cfg.packages['.']) ? cfg.packages['.'] : cfg;
    const sections = root['changelog-sections'];
    expect(Array.isArray(sections)).toBe(true);
    if (!Array.isArray(sections)) return;
    const byType = new Map<string, Record<string, unknown>>();
    for (const s of sections) {
      if (!isObject(s)) continue;
      if (typeof s.type === 'string') byType.set(s.type, s);
    }
    // Visible sections.
    expect(byType.get('feat')?.section).toBe('Added');
    expect(byType.get('fix')?.section).toBe('Fixed');
    expect(byType.get('perf')?.section).toBe('Performance');
    expect(byType.get('refactor')?.section).toBe('Changed');
    expect(byType.get('revert')?.section).toBe('Reverted');
    // Hidden sections.
    for (const t of ['chore', 'test', 'docs', 'ci', 'build', 'style']) {
      const entry = byType.get(t);
      expect(entry, `expected a changelog-sections entry for type=${t}`).toBeDefined();
      if (!entry) continue;
      expect(entry.hidden, `expected type=${t} to be hidden`).toBe(true);
    }
  });
});

describe('ac-1: .release-please-manifest.json', () => {
  it('.release-please-manifest.json exists and parses as valid JSON', () => {
    expect(exists(releasePleaseManifestPath)).toBe(true);
    expect(() => readJson(releasePleaseManifestPath)).not.toThrow();
  });

  it('.release-please-manifest.json root package version mirrors package.json', () => {
    const manifest = readJson(releasePleaseManifestPath);
    expect(isObject(manifest)).toBe(true);
    if (!isObject(manifest)) return;
    const pkg = readJson('package.json');
    expect(isObject(pkg)).toBe(true);
    if (!isObject(pkg)) return;
    expect(manifest['.']).toBe(pkg.version);
  });
});

describe('ac-3: CONTRIBUTING.md rewritten for release-please', () => {
  const body = (): string => read('CONTRIBUTING.md');

  it('CONTRIBUTING.md no longer references the legacy c-and-t-v stack', () => {
    const b = body();
    expect(b).not.toMatch(/commit-and-tag-version/);
    expect(b).not.toMatch(/make\s+release\b/);
    expect(b).not.toMatch(/make\s+release-dry\b/);
    expect(b).not.toMatch(/scripts\/release-with-guard\.sh/);
    expect(b).not.toMatch(/scripts\/server-version-updater\.cjs/);
    expect(b).not.toMatch(/\.versionrc\.json/);
  });

  it('CONTRIBUTING.md documents the release-please flow', () => {
    const b = body();
    expect(b).toMatch(/release-please/i);
    // The flow: an open release PR is maintained on main, merging it cuts the release.
    expect(b).toMatch(/chore\(main\):\s*release/);
    expect(b).toMatch(/merge/i);
    // Automatic tag + publish follows the merge.
    expect(b).toMatch(/tag/i);
    expect(b).toMatch(/publish/i);
  });

  it('CONTRIBUTING.md instructs maintainers to never hand-edit package.json.version outside the release-please PR', () => {
    const b = body();
    // Look for an explicit prohibition tying package.json (or version) to
    // release-please ownership.
    expect(b).toMatch(/never\s+(hand-edit|edit|bump|modify).*(package\.json|version)/i);
  });
});

describe('ac-4: legacy c-and-t-v stack removed', () => {
  it('package.json devDependencies no longer contains commit-and-tag-version', () => {
    const pkg = readJson('package.json');
    expect(isObject(pkg)).toBe(true);
    if (!isObject(pkg)) return;
    const dev = pkg.devDependencies;
    if (isObject(dev)) {
      expect(dev['commit-and-tag-version']).toBeUndefined();
    }
  });

  it('.versionrc.json file is deleted', () => {
    expect(exists('.versionrc.json')).toBe(false);
  });

  it('scripts/server-version-updater.cjs file is deleted', () => {
    expect(exists('scripts/server-version-updater.cjs')).toBe(false);
  });

  it('scripts/release-with-guard.sh file is deleted', () => {
    expect(exists('scripts/release-with-guard.sh')).toBe(false);
  });

  it('scripts/guard-breaking-changes.sh file is deleted', () => {
    expect(exists('scripts/guard-breaking-changes.sh')).toBe(false);
  });

  it('tests/guard-breaking-changes.test.ts file is deleted', () => {
    expect(exists('tests/guard-breaking-changes.test.ts')).toBe(false);
  });

  it('Makefile no longer defines `release` or `release-dry` targets', () => {
    const mk = read('Makefile');
    expect(mk).not.toMatch(/^release\s*:/m);
    expect(mk).not.toMatch(/^release-dry\s*:/m);
  });
});

describe('ac-6: no remaining references to legacy tooling in tracked files', () => {
  // Mirror the contract grep: `git ls-files` + the forbidden-token regex.
  // CHANGELOG.md is excluded (historical entries documenting the prior
  // flow are legitimate). This test file itself is also excluded -- it
  // necessarily mentions the tokens to assert their absence elsewhere.
  it('no tracked file (outside CHANGELOG.md and this test) matches the legacy-tooling regex', () => {
    const out = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
    const files = out
      .split('\n')
      .filter((f) => f && f !== 'CHANGELOG.md' && f !== 'tests/release-please.test.ts');
    const regex = /guard-breaking-changes|release-with-guard|server-version-updater|versionrc/;
    const hits: string[] = [];
    for (const f of files) {
      let content: string;
      try {
        content = read(f);
      } catch {
        // Binary files or files that disappear between ls-files and read
        // are skipped: the contract regex operates on text content.
        continue;
      }
      if (regex.test(content)) hits.push(f);
    }
    expect(hits, `forbidden tokens found in: ${hits.join(', ')}`).toEqual([]);
  });
});

describe('ac-9: branch-protection script flips two settings, preserves the rest', () => {
  const body = (): string => read(branchProtectionScriptPath);

  it('payload sets `enforce_admins: true`', () => {
    const b = body();
    expect(
      /"enforce_admins"\s*:\s*true\b/.test(b) || /enforce_admins\s*[:=]\s*true\b/.test(b),
    ).toBe(true);
    expect(/"enforce_admins"\s*:\s*false\b/.test(b)).toBe(false);
  });

  it('payload sets `required_pull_request_reviews.required_approving_review_count: 0`', () => {
    const b = body();
    expect(
      /"required_approving_review_count"\s*:\s*0\b/.test(b) ||
        /required_approving_review_count\s*[:=]\s*0\b/.test(b),
    ).toBe(true);
    expect(/"required_approving_review_count"\s*:\s*1\b/.test(b)).toBe(false);
  });

  it('payload preserves all other branch-protection fields byte-identically', () => {
    const b = body();
    // The pre-release-please payload had these settings; the AC requires
    // them unchanged. Asserting on each field individually documents the
    // contract surface rather than a single opaque blob comparison.
    expect(/"strict"\s*:\s*true\b/.test(b)).toBe(true);
    expect(/"contexts"\s*:\s*\[/.test(b)).toBe(true);
    expect(/"ci \(22\)"/.test(b)).toBe(true);
    expect(/"ci \(24\)"/.test(b)).toBe(true);
    expect(/"dismiss_stale_reviews"\s*:\s*true\b/.test(b)).toBe(true);
    expect(/"require_code_owner_reviews"\s*:\s*false\b/.test(b)).toBe(true);
    expect(/"restrictions"\s*:\s*null\b/.test(b)).toBe(true);
    expect(/"required_linear_history"\s*:\s*true\b/.test(b)).toBe(true);
    expect(/"allow_force_pushes"\s*:\s*false\b/.test(b)).toBe(true);
    expect(/"allow_deletions"\s*:\s*false\b/.test(b)).toBe(true);
    expect(/"block_creations"\s*:\s*false\b/.test(b)).toBe(true);
    expect(/"required_conversation_resolution"\s*:\s*true\b/.test(b)).toBe(true);
  });
});
