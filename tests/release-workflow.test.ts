/**
 * DAR-960 contract tests: release workflow YAML structure.
 *
 * Verifies the release workflow at `.github/workflows/release.yml` and the
 * release-process docs in `CONTRIBUTING.md`. Mirrors the structural-assertion
 * pattern used in `tests/ci-workflow.test.ts` (DAR-914): we parse the YAML
 * with the `yaml` package and assert structural properties of the committed
 * artifact rather than executing it against the live GitHub repo.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const exists = (rel: string) => existsSync(join(repoRoot, rel));

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const releaseYmlPath = '.github/workflows/release.yml';

const loadRelease = (): Record<string, unknown> => {
  const text = read(releaseYmlPath);
  const parsed: unknown = parseYaml(text);
  if (!isObject(parsed)) {
    throw new Error('release.yml did not parse to a YAML mapping');
  }
  return parsed;
};

/**
 * YAML 1.1 treats bare `on` as the boolean `true`. Look up the trigger
 * mapping under either key.
 */
const getOn = (wf: Record<string, unknown>): unknown =>
  wf.on ?? (wf as Record<string, unknown>)['true'];

const allSteps = (wf: Record<string, unknown>): Record<string, unknown>[] => {
  const jobs = wf.jobs;
  if (!isObject(jobs)) return [];
  const out: Record<string, unknown>[] = [];
  for (const job of Object.values(jobs)) {
    if (!isObject(job)) continue;
    const steps = job.steps;
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      if (isObject(s)) out.push(s);
    }
  }
  return out;
};

const stepRuns = (s: Record<string, unknown>): string => (typeof s.run === 'string' ? s.run : '');

const stepUses = (s: Record<string, unknown>): string => (typeof s.uses === 'string' ? s.uses : '');

/** Index of the first step whose `run:` matches the predicate, or -1. */
const findStepIndex = (
  steps: Record<string, unknown>[],
  predicate: (s: Record<string, unknown>) => boolean,
): number => steps.findIndex(predicate);

const publishStepIndex = (steps: Record<string, unknown>[]): number =>
  findStepIndex(steps, (s) => /\bpnpm\s+publish\b/.test(stepRuns(s)));

describe('ac-1: release.yml triggers', () => {
  it('release.yml exists at .github/workflows/release.yml and is valid YAML', () => {
    expect(exists(releaseYmlPath)).toBe(true);
    expect(() => parseYaml(read(releaseYmlPath))).not.toThrow();
    const parsed: unknown = parseYaml(read(releaseYmlPath));
    expect(isObject(parsed)).toBe(true);
  });

  it('release.yml `on:` trigger is restricted to `push` events (no pull_request, no workflow_dispatch)', () => {
    const wf = loadRelease();
    const on = getOn(wf);
    expect(on).toBeDefined();
    expect(isObject(on), 'on: must be a mapping').toBe(true);
    if (!isObject(on)) return;
    const keys = Object.keys(on);
    expect(keys).toContain('push');
    expect(keys, 'pull_request must not appear').not.toContain('pull_request');
    expect(keys, 'workflow_dispatch must not appear').not.toContain('workflow_dispatch');
    expect(keys, 'schedule must not appear').not.toContain('schedule');
  });

  it('release.yml `on.push.tags` array contains the pattern `v*` and no broader pattern (e.g., `**`)', () => {
    const wf = loadRelease();
    const on = getOn(wf);
    expect(isObject(on)).toBe(true);
    if (!isObject(on)) return;
    const push = on.push;
    expect(isObject(push), 'on.push must be a mapping').toBe(true);
    if (!isObject(push)) return;
    const tags = push.tags;
    expect(Array.isArray(tags)).toBe(true);
    if (!Array.isArray(tags)) return;
    expect(tags).toContain('v*');
    for (const t of tags) {
      expect(t, 'no broader tag pattern allowed').not.toBe('*');
      expect(t, 'no broader tag pattern allowed').not.toBe('**');
    }
  });

  it('release.yml `on.push` does NOT include a `branches` filter (publishing must be tag-driven only)', () => {
    const wf = loadRelease();
    const on = getOn(wf);
    expect(isObject(on)).toBe(true);
    if (!isObject(on)) return;
    const push = on.push;
    expect(isObject(push)).toBe(true);
    if (!isObject(push)) return;
    expect(
      push.branches,
      'on.push.branches must NOT be present (would make the workflow branch-driven)',
    ).toBeUndefined();
  });
});

describe('ac-2: setup mirrors ci.yml', () => {
  it('release.yml job uses `actions/checkout@v4` as a step', () => {
    const wf = loadRelease();
    const uses = allSteps(wf).map(stepUses);
    expect(uses).toContain('actions/checkout@v4');
  });

  it('release.yml job uses `actions/setup-node@v4` and reads Node version from `.nvmrc` via `node-version-file: .nvmrc` (no hard-coded numeric version)', () => {
    const wf = loadRelease();
    const setupNode = allSteps(wf).find((s) => stepUses(s) === 'actions/setup-node@v4');
    expect(setupNode, 'expected a step using actions/setup-node@v4').toBeDefined();
    if (!setupNode) return;
    const withInputs = setupNode.with;
    expect(isObject(withInputs)).toBe(true);
    if (!isObject(withInputs)) return;
    expect(withInputs['node-version-file']).toBe('.nvmrc');
    // node-version must NOT be a hard-coded numeric version. It can be
    // absent entirely (preferred) or a workflow expression.
    const v = withInputs['node-version'];
    if (v !== undefined) {
      expect(typeof v).toBe('string');
      expect(String(v), 'node-version must not be a hard-coded version literal').toMatch(/\$\{\{/);
    }
  });

  it('release.yml job uses `pnpm/action-setup@v4` and does NOT pin a `version:` in `with:` (defers to packageManager)', () => {
    const wf = loadRelease();
    const setupPnpm = allSteps(wf).find((s) => stepUses(s) === 'pnpm/action-setup@v4');
    expect(setupPnpm, 'expected a step using pnpm/action-setup@v4').toBeDefined();
    if (!setupPnpm) return;
    const withInputs = setupPnpm.with;
    if (withInputs === undefined) return;
    expect(isObject(withInputs)).toBe(true);
    if (!isObject(withInputs)) return;
    expect(
      withInputs.version,
      'pnpm version must not be hard-coded; defer to packageManager',
    ).toBeUndefined();
  });

  it("release.yml configures pnpm store caching (setup-node `cache: pnpm` OR an explicit actions/cache step keyed on `hashFiles('**/pnpm-lock.yaml')`)", () => {
    const text = read(releaseYmlPath);
    const wf = loadRelease();
    const setupNode = allSteps(wf).find((s) => stepUses(s) === 'actions/setup-node@v4');
    const setupNodeWith = isObject(setupNode?.with) ? setupNode.with : undefined;
    const usesSetupNodeCache = setupNodeWith?.cache === 'pnpm';

    const usesActionsCache = allSteps(wf).some((s) => stepUses(s).startsWith('actions/cache@'));
    const referencesLockfileHash = /hashFiles\(\s*['"]\*\*\/pnpm-lock\.yaml['"]\s*\)/.test(text);

    expect(usesSetupNodeCache || (usesActionsCache && referencesLockfileHash)).toBe(true);
  });
});

describe('ac-3: pre-publish gate steps', () => {
  it('release.yml runs `make install` and no step invokes `pnpm install` directly', () => {
    const wf = loadRelease();
    const runs = allSteps(wf)
      .map(stepRuns)
      .filter((r) => r.length > 0);
    expect(runs.some((r) => /\bmake\s+install\b/.test(r))).toBe(true);
    for (const r of runs) {
      expect(r, 'no step should invoke `pnpm install` directly').not.toMatch(/\bpnpm\s+install\b/);
    }
  });

  it('release.yml runs `make typecheck` and no step invokes `tsc` directly', () => {
    const wf = loadRelease();
    const runs = allSteps(wf)
      .map(stepRuns)
      .filter((r) => r.length > 0);
    expect(runs.some((r) => /\bmake\s+typecheck\b/.test(r))).toBe(true);
    for (const r of runs) {
      expect(r, 'no step should invoke `tsc` directly').not.toMatch(/(^|\s)tsc(\s|$)/);
    }
  });

  it('release.yml runs `make lint` and no step invokes `eslint` or `pnpm lint` directly', () => {
    const wf = loadRelease();
    const runs = allSteps(wf)
      .map(stepRuns)
      .filter((r) => r.length > 0);
    expect(runs.some((r) => /\bmake\s+lint\b/.test(r))).toBe(true);
    for (const r of runs) {
      expect(r).not.toMatch(/(^|\s)eslint(\s|$)/);
      expect(r).not.toMatch(/\bpnpm\s+lint\b/);
    }
  });

  it('release.yml runs `make build` and no step invokes `tsc` or `pnpm build` directly', () => {
    const wf = loadRelease();
    const runs = allSteps(wf)
      .map(stepRuns)
      .filter((r) => r.length > 0);
    expect(runs.some((r) => /\bmake\s+build\b/.test(r))).toBe(true);
    for (const r of runs) {
      expect(r).not.toMatch(/(^|\s)tsc(\s|$)/);
      expect(r).not.toMatch(/\bpnpm\s+build\b/);
    }
  });

  it('release.yml runs `make test` and no step invokes `vitest` or `pnpm test` directly', () => {
    const wf = loadRelease();
    const runs = allSteps(wf)
      .map(stepRuns)
      .filter((r) => r.length > 0);
    expect(runs.some((r) => /\bmake\s+test\b/.test(r))).toBe(true);
    for (const r of runs) {
      expect(r).not.toMatch(/(^|\s)vitest(\s|$)/);
      expect(r).not.toMatch(/\bpnpm\s+test\b/);
    }
  });

  it('the gate steps (install/typecheck/lint/build/test) all appear before the `pnpm publish` step', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const publishIdx = publishStepIndex(steps);
    expect(publishIdx, 'expected a `pnpm publish` step').toBeGreaterThanOrEqual(0);
    const gates: { name: string; pattern: RegExp }[] = [
      { name: 'install', pattern: /\bmake\s+install\b/ },
      { name: 'typecheck', pattern: /\bmake\s+typecheck\b/ },
      { name: 'lint', pattern: /\bmake\s+lint\b/ },
      { name: 'build', pattern: /\bmake\s+build\b/ },
      { name: 'test', pattern: /\bmake\s+test\b/ },
    ];
    for (const gate of gates) {
      const idx = findStepIndex(steps, (s) => gate.pattern.test(stepRuns(s)));
      expect(idx, `gate \`make ${gate.name}\` must exist`).toBeGreaterThanOrEqual(0);
      expect(idx, `gate \`make ${gate.name}\` must precede publish`).toBeLessThan(publishIdx);
    }
  });

  it('no gate step uses `continue-on-error: true`', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const gatePattern = /\bmake\s+(install|typecheck|lint|build|test)\b/;
    for (const s of steps) {
      const run = stepRuns(s);
      if (!gatePattern.test(run)) continue;
      expect(s['continue-on-error'], `gate step must not be non-blocking: ${run}`).not.toBe(true);
    }
  });
});

describe('ac-4: package.json/tag drift guard', () => {
  it('release.yml contains a step that reads the version from `package.json`', () => {
    const wf = loadRelease();
    const runs = allSteps(wf).map(stepRuns);
    const reads = runs.some(
      (r) =>
        /\bpnpm\s+pkg\s+get\s+version\b/.test(r) ||
        /\bjq\s+[^\n]*\.version[^\n]*package\.json/.test(r) ||
        /node\s+-p\s+["'][^"']*require\(["']\.\/package\.json["']\)\.version/.test(r) ||
        /node\s+-p\s+["'][^"']*JSON\.parse[^"']*package\.json[^"']*\.version/.test(r),
    );
    expect(reads, 'expected a step reading version from package.json').toBe(true);
  });

  it('release.yml contains a step that extracts the tag-derived version from `GITHUB_REF` by stripping the `refs/tags/v` prefix', () => {
    const wf = loadRelease();
    const runs = allSteps(wf).map(stepRuns);
    const matches = runs.some((r) => /GITHUB_REF#refs\/tags\/v/.test(r));
    expect(matches).toBe(true);
  });

  it('the package.json/tag drift-guard step compares the two values and exits non-zero on mismatch', () => {
    const text = read(releaseYmlPath);
    // Look for a comparison form that exits non-zero on mismatch.
    const compareForm =
      /if\s*\[\s*"\$\{?[A-Z_]+\}?"\s*!=\s*"\$\{?[A-Z_]+\}?"\s*\]\s*;\s*then[\s\S]*?exit\s+1/.test(
        text,
      );
    expect(
      compareForm,
      'expected `if [ "$X" != "$Y" ]; then ... exit 1` style mismatch check',
    ).toBe(true);
  });

  it('the package.json/tag drift-guard step appears before the `pnpm publish` step', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const publishIdx = publishStepIndex(steps);
    expect(publishIdx).toBeGreaterThanOrEqual(0);
    const driftIdx = findStepIndex(steps, (s) => /GITHUB_REF#refs\/tags\/v/.test(stepRuns(s)));
    expect(driftIdx, 'expected tag-drift step').toBeGreaterThanOrEqual(0);
    expect(driftIdx).toBeLessThan(publishIdx);
  });
});

describe('ac-5: SERVER_VERSION drift guard', () => {
  it('release.yml contains a step that reads `SERVER_VERSION` from `src/server/server.ts`', () => {
    const wf = loadRelease();
    const runs = allSteps(wf).map(stepRuns);
    const reads = runs.some((r) => /SERVER_VERSION/.test(r) && /server\.ts/.test(r));
    expect(reads).toBe(true);
  });

  it('the SERVER_VERSION drift-guard step compares the extracted SERVER_VERSION to the package.json version and exits non-zero on mismatch', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const guard = steps.find(
      (s) => /SERVER_VERSION/.test(stepRuns(s)) && /server\.ts/.test(stepRuns(s)),
    );
    expect(guard, 'expected a SERVER_VERSION guard step').toBeDefined();
    if (!guard) return;
    const run = stepRuns(guard);
    expect(/exit\s+1/.test(run), 'SERVER_VERSION guard must exit non-zero on mismatch').toBe(true);
    // Must compare against the package version somewhere in this step.
    expect(
      /PKG_VERSION|package\.json|pnpm\s+pkg\s+get\s+version/.test(run),
      'SERVER_VERSION guard must reference the package.json version',
    ).toBe(true);
  });

  it('the SERVER_VERSION drift-guard step appears before the `pnpm publish` step', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const publishIdx = publishStepIndex(steps);
    expect(publishIdx).toBeGreaterThanOrEqual(0);
    const guardIdx = findStepIndex(
      steps,
      (s) => /SERVER_VERSION/.test(stepRuns(s)) && /server\.ts/.test(stepRuns(s)),
    );
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(publishIdx);
  });
});

describe('ac-6: dist-tag derivation script wiring', () => {
  it('exactly one of `scripts/derive-dist-tag.sh` or `scripts/derive-dist-tag.mjs` exists at the repo root', () => {
    const sh = exists('scripts/derive-dist-tag.sh');
    const mjs = exists('scripts/derive-dist-tag.mjs');
    expect(sh !== mjs, 'exactly one of the two filenames must exist').toBe(true);
  });

  it('release.yml invokes the derivation script and uses its stdout as the value passed to `pnpm publish --tag`', () => {
    const text = read(releaseYmlPath);
    const usesScript =
      /scripts\/derive-dist-tag\.sh/.test(text) || /scripts\/derive-dist-tag\.mjs/.test(text);
    expect(usesScript).toBe(true);
    // The publish --tag must reference a script invocation expression.
    const publishMatch = text.match(/pnpm\s+publish[^\n]*--tag[^\n]+/);
    expect(publishMatch, 'expected `pnpm publish ... --tag ...`').toBeTruthy();
    if (!publishMatch) return;
    const publishLine = publishMatch[0];
    expect(
      /\$\([^)]*scripts\/derive-dist-tag/.test(publishLine) ||
        /\$\{\{\s*[^}]*outputs[^}]*\}\}/.test(publishLine) ||
        /\$\{?DIST_TAG\}?/.test(publishLine) ||
        /\$\{?TAG\}?/.test(publishLine),
      'publish --tag must take its value from a script invocation or step output, not a literal',
    ).toBe(true);
  });

  it('release.yml does NOT pass a hard-coded literal to `pnpm publish --tag`', () => {
    const text = read(releaseYmlPath);
    const publishMatch = text.match(/pnpm\s+publish[^\n]*--tag[^\n]+/);
    expect(publishMatch).toBeTruthy();
    if (!publishMatch) return;
    const publishLine = publishMatch[0];
    expect(publishLine, 'no hard-coded `--tag latest`').not.toMatch(/--tag\s+latest\b/);
    expect(publishLine, 'no hard-coded `--tag beta`').not.toMatch(/--tag\s+beta\b/);
    expect(publishLine, 'no hard-coded `--tag rc`').not.toMatch(/--tag\s+rc\b/);
    expect(publishLine, 'no hard-coded `--tag alpha`').not.toMatch(/--tag\s+alpha\b/);
    expect(publishLine, 'no hard-coded `--tag next`').not.toMatch(/--tag\s+next\b/);
  });
});

describe('ac-7: pnpm publish step', () => {
  it('release.yml contains a step whose `run:` invokes `pnpm publish` with both `--access public` and `--tag <derivation>`', () => {
    const wf = loadRelease();
    const publish = allSteps(wf).find((s) => /\bpnpm\s+publish\b/.test(stepRuns(s)));
    expect(publish, 'expected a pnpm publish step').toBeDefined();
    if (!publish) return;
    const run = stepRuns(publish);
    expect(/--access\s+public\b/.test(run)).toBe(true);
    expect(/--tag\b/.test(run)).toBe(true);
  });

  it('the `pnpm publish` step is preceded by all gate steps AND both drift-guard steps', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const publishIdx = publishStepIndex(steps);
    expect(publishIdx).toBeGreaterThanOrEqual(0);

    const expected: { name: string; predicate: (s: Record<string, unknown>) => boolean }[] = [
      { name: 'install gate', predicate: (s) => /\bmake\s+install\b/.test(stepRuns(s)) },
      { name: 'typecheck gate', predicate: (s) => /\bmake\s+typecheck\b/.test(stepRuns(s)) },
      { name: 'lint gate', predicate: (s) => /\bmake\s+lint\b/.test(stepRuns(s)) },
      { name: 'build gate', predicate: (s) => /\bmake\s+build\b/.test(stepRuns(s)) },
      { name: 'test gate', predicate: (s) => /\bmake\s+test\b/.test(stepRuns(s)) },
      {
        name: 'tag drift guard',
        predicate: (s) => /GITHUB_REF#refs\/tags\/v/.test(stepRuns(s)),
      },
      {
        name: 'SERVER_VERSION drift guard',
        predicate: (s) => /SERVER_VERSION/.test(stepRuns(s)) && /server\.ts/.test(stepRuns(s)),
      },
    ];

    for (const e of expected) {
      const idx = findStepIndex(steps, e.predicate);
      expect(idx, `${e.name} must exist`).toBeGreaterThanOrEqual(0);
      expect(idx, `${e.name} must precede publish`).toBeLessThan(publishIdx);
    }
  });

  it('the `pnpm publish` step sets `NODE_AUTH_TOKEN` from `${{ secrets.NPM_TOKEN }}` in its `env:` block', () => {
    const wf = loadRelease();
    const publish = allSteps(wf).find((s) => /\bpnpm\s+publish\b/.test(stepRuns(s)));
    expect(publish).toBeDefined();
    if (!publish) return;
    const env = publish.env;
    expect(isObject(env), 'publish step must have env block').toBe(true);
    if (!isObject(env)) return;
    const tok = env.NODE_AUTH_TOKEN;
    expect(typeof tok).toBe('string');
    expect(String(tok)).toMatch(/\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
  });

  it('no other step in release.yml exposes `NPM_TOKEN`/`NODE_AUTH_TOKEN` (token scope is limited to the publish step only)', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const publishIdx = publishStepIndex(steps);
    for (let i = 0; i < steps.length; i++) {
      if (i === publishIdx) continue;
      const s = steps[i];
      if (!s) continue;
      const env = s.env;
      if (isObject(env)) {
        expect(env.NODE_AUTH_TOKEN, `step ${i} must not expose NODE_AUTH_TOKEN`).toBeUndefined();
        expect(env.NPM_TOKEN, `step ${i} must not expose NPM_TOKEN`).toBeUndefined();
      }
      const run = stepRuns(s);
      expect(run, `step ${i} run must not reference secrets.NPM_TOKEN`).not.toMatch(
        /secrets\.NPM_TOKEN/,
      );
    }
  });
});

describe('ac-8: GitHub Release creation', () => {
  it('release.yml contains a step that creates a GitHub Release for the pushed tag', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const text = read(releaseYmlPath);
    const usesAction = steps.some((s) => /^softprops\/action-gh-release@/.test(stepUses(s)));
    const usesGhCli = steps.some((s) => /\bgh\s+release\s+create\b/.test(stepRuns(s)));
    const usesScript = steps.some((s) => /github-script@/.test(stepUses(s)));
    expect(
      usesAction || usesGhCli || usesScript,
      `expected a release-create step in:\n${text}`,
    ).toBe(true);
  });

  it('the GitHub Release body is sourced from the CHANGELOG section matching `## [X.Y.Z]` (extracted via awk/sed/Node, not a hard-coded string and not the entire CHANGELOG)', () => {
    const text = read(releaseYmlPath);
    // The extraction must reference the CHANGELOG and the section heading
    // pattern. We do NOT accept passing the entire CHANGELOG.md verbatim.
    const referencesChangelog = /CHANGELOG\.md/.test(text);
    expect(referencesChangelog, 'release.yml must reference CHANGELOG.md').toBe(true);
    const extractsSection =
      /awk[^\n]*## \[/.test(text) ||
      /sed[^\n]*## \\?\[/.test(text) ||
      /## \[\$\{?[A-Z_]+\}?\]/.test(text) ||
      /node[^\n]*CHANGELOG/.test(text);
    expect(extractsSection, 'expected awk/sed/node-based extraction of `## [X.Y.Z]` section').toBe(
      true,
    );
  });

  it('the GitHub Release step sets `prerelease: true` when the resolved version contains a pre-release identifier and `prerelease: false` otherwise -- driven by derivation, not a hard-coded literal', () => {
    const text = read(releaseYmlPath);
    // The prerelease field must be an expression -- not a static literal.
    // Accept any of: ${{ ... }} interpolation, env var reference, or a step
    // output reference. Static `prerelease: true` or `prerelease: false`
    // alone is forbidden.
    const lines = text.split(/\n/).filter((l) => /\bprerelease\s*:/.test(l));
    expect(lines.length, 'expected at least one `prerelease:` line').toBeGreaterThan(0);
    for (const l of lines) {
      const value = l.split(':').slice(1).join(':').trim();
      const isExpr =
        /\$\{\{/.test(value) ||
        /\$\{?[A-Z_]+\}?/.test(value) ||
        /steps\.[A-Za-z_-]+\.outputs/.test(value);
      expect(isExpr, `prerelease must be derived dynamically, got: ${l.trim()}`).toBe(true);
    }
  });

  it('the GitHub Release step appears after `pnpm publish` succeeds (release creation must not run if publish fails)', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const publishIdx = publishStepIndex(steps);
    expect(publishIdx).toBeGreaterThanOrEqual(0);
    const releaseIdx = findStepIndex(
      steps,
      (s) =>
        /^softprops\/action-gh-release@/.test(stepUses(s)) ||
        /\bgh\s+release\s+create\b/.test(stepRuns(s)) ||
        /github-script@/.test(stepUses(s)),
    );
    expect(releaseIdx, 'expected a release-create step').toBeGreaterThanOrEqual(0);
    expect(releaseIdx, 'release create must come after publish').toBeGreaterThan(publishIdx);
  });
});

describe('ac-9: contributor docs - release process', () => {
  /**
   * Locate the release docs. CONTRIBUTING.md is preferred; fall back to
   * README.md. Returns the section body bound by the first matching
   * Release/Releasing heading.
   */
  const loadReleaseDoc = (): { source: string; body: string } => {
    const candidates = ['CONTRIBUTING.md', 'README.md'];
    for (const path of candidates) {
      if (!exists(path)) continue;
      const body = read(path);
      if (/^##\s+(Release|Releasing|Releases)\b/im.test(body)) {
        // Pull the section bounded by the next `## ` heading.
        const idx = body.search(/^##\s+(Release|Releasing|Releases)\b/im);
        const after = body.slice(idx);
        const next = after.slice(2).search(/\n##\s/);
        const section = next < 0 ? after : after.slice(0, next + 2);
        return { source: path, body: section };
      }
    }
    throw new Error('no Release/Releasing section found in CONTRIBUTING.md or README.md');
  };

  it('either CONTRIBUTING.md or README.md contains a Release/Releasing section', () => {
    expect(() => loadReleaseDoc()).not.toThrow();
  });

  it('the release docs instruct contributors to write a new CHANGELOG section for the version being released', () => {
    const { body } = loadReleaseDoc();
    expect(body).toMatch(/CHANGELOG/i);
    expect(body).toMatch(/(write|add|create|new).*\s+section|section\s+(for|in).*CHANGELOG/i);
  });

  it('the release docs instruct contributors to bump `package.json` version AND `SERVER_VERSION` together in the same PR', () => {
    const { body } = loadReleaseDoc();
    expect(body).toMatch(/package\.json/i);
    expect(body).toMatch(/SERVER_VERSION/);
  });

  it('the release docs state the version-bump PR is merged before the tag is pushed (PR-then-tag ordering)', () => {
    const { body } = loadReleaseDoc();
    // Must mention merging the PR first, then pushing the tag.
    expect(body).toMatch(/merge.*\bPR\b|PR\s+(is\s+)?merged/i);
    expect(body).toMatch(/(push|tag).*tag|tag.*push/i);
  });

  it('the release docs instruct contributors to push a `v<version>` tag and watch the workflow run', () => {
    const { body } = loadReleaseDoc();
    expect(body).toMatch(/git\s+tag\s+v|push\s+(--tags|the\s+`?v|tag\s+v)/i);
    expect(body).toMatch(/workflow|actions/i);
  });

  it('the release docs document that `NPM_TOKEN` must be configured in repo secrets (out-of-band) before the first tag push', () => {
    const { body } = loadReleaseDoc();
    expect(body).toMatch(/NPM_TOKEN/);
    expect(body).toMatch(/secret/i);
  });
});

describe('ac-11: workflow YAML structure assertions (mirroring DAR-914)', () => {
  it('a vitest test file exists that loads .github/workflows/release.yml via the `yaml` package and asserts structural properties', () => {
    // This file is that test file -- its existence is asserted by the
    // test runner finding and executing it. The presence of the import
    // and loadRelease() helper above satisfies the contract.
    expect(typeof loadRelease).toBe('function');
    expect(exists('tests/release-workflow.test.ts')).toBe(true);
  });

  it('trigger shape: `on.push.tags` contains `v*`, no `pull_request`, no branch-restricted push', () => {
    const wf = loadRelease();
    const on = getOn(wf);
    expect(isObject(on)).toBe(true);
    if (!isObject(on)) return;
    const keys = Object.keys(on);
    expect(keys).not.toContain('pull_request');
    const push = on.push;
    expect(isObject(push)).toBe(true);
    if (!isObject(push)) return;
    expect(Array.isArray(push.tags)).toBe(true);
    if (Array.isArray(push.tags)) expect(push.tags).toContain('v*');
    expect(push.branches).toBeUndefined();
  });

  it('gate-step ordering: install/typecheck/lint/build/test all precede the publish step', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const publishIdx = publishStepIndex(steps);
    expect(publishIdx).toBeGreaterThanOrEqual(0);
    const gates = [
      /\bmake\s+install\b/,
      /\bmake\s+typecheck\b/,
      /\bmake\s+lint\b/,
      /\bmake\s+build\b/,
      /\bmake\s+test\b/,
    ];
    for (const g of gates) {
      const idx = findStepIndex(steps, (s) => g.test(stepRuns(s)));
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(publishIdx);
    }
  });

  it('package.json-vs-tag drift guard step exists (by `run:` content match) before the publish step', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const publishIdx = publishStepIndex(steps);
    const idx = findStepIndex(steps, (s) => /GITHUB_REF#refs\/tags\/v/.test(stepRuns(s)));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(publishIdx);
  });

  it('SERVER_VERSION drift guard step exists (by `run:` content match) before the publish step', () => {
    const wf = loadRelease();
    const steps = allSteps(wf);
    const publishIdx = publishStepIndex(steps);
    const idx = findStepIndex(
      steps,
      (s) => /SERVER_VERSION/.test(stepRuns(s)) && /server\.ts/.test(stepRuns(s)),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(publishIdx);
  });

  it("the publish step's secret name is `NPM_TOKEN` mapped to `NODE_AUTH_TOKEN` (no other secret name accepted)", () => {
    const wf = loadRelease();
    const publish = allSteps(wf).find((s) => /\bpnpm\s+publish\b/.test(stepRuns(s)));
    expect(publish).toBeDefined();
    if (!publish) return;
    const env = publish.env;
    expect(isObject(env)).toBe(true);
    if (!isObject(env)) return;
    expect(typeof env.NODE_AUTH_TOKEN).toBe('string');
    expect(String(env.NODE_AUTH_TOKEN)).toMatch(/\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
    // Must not pull from any other secret name.
    for (const v of Object.values(env)) {
      if (typeof v !== 'string') continue;
      const m = v.match(/secrets\.([A-Z0-9_]+)/);
      if (m) expect(m[1]).toBe('NPM_TOKEN');
    }
  });

  it('`pnpm publish --tag` value comes from a script invocation expression, not a literal string', () => {
    const text = read(releaseYmlPath);
    const publishMatch = text.match(/pnpm\s+publish[^\n]*--tag[^\n]+/);
    expect(publishMatch).toBeTruthy();
    if (!publishMatch) return;
    const publishLine = publishMatch[0];
    const isDerived =
      /\$\([^)]*scripts\/derive-dist-tag/.test(publishLine) ||
      /\$\{\{\s*[^}]*outputs[^}]*\}\}/.test(publishLine) ||
      /\$\{?DIST_TAG\}?/.test(publishLine) ||
      /\$\{?TAG\}?/.test(publishLine);
    expect(isDerived).toBe(true);
  });
});
