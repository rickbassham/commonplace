/**
 * DAR-914 contract tests.
 *
 * Verifies the CI workflow at `.github/workflows/ci.yml`, the
 * reproducible branch-protection script at
 * `scripts/setup-branch-protection.sh`, and contributor documentation.
 *
 * The contract tests assert structural properties of the committed
 * artifacts -- they do not invoke `gh api` against the live GitHub repo
 * (live state requires admin token + network access; verifying the
 * artifact is the contract).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const exists = (rel: string) => existsSync(join(repoRoot, rel));

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const ciYmlPath = '.github/workflows/ci.yml';
const protectionScriptPath = 'scripts/setup-branch-protection.sh';

const loadCi = (): Record<string, unknown> => {
  const text = read(ciYmlPath);
  const parsed: unknown = parseYaml(text);
  if (!isObject(parsed)) {
    throw new Error('ci.yml did not parse to a YAML mapping');
  }
  return parsed;
};

/**
 * Walk the `jobs.<id>.steps[]` arrays and return every step object as a
 * flat list. Returns `[]` when the structure is missing or malformed.
 */
const allSteps = (ci: Record<string, unknown>): Record<string, unknown>[] => {
  const jobs = ci.jobs;
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

describe('ac-1: ci.yml triggers', () => {
  it('ci.yml exists at .github/workflows/ci.yml and is valid YAML', () => {
    expect(exists(ciYmlPath)).toBe(true);
    expect(() => parseYaml(read(ciYmlPath))).not.toThrow();
    const parsed: unknown = parseYaml(read(ciYmlPath));
    expect(isObject(parsed)).toBe(true);
  });

  it('ci.yml `on:` trigger includes `pull_request`', () => {
    const ci = loadCi();
    // YAML `on:` is parsed as the boolean key `true` by yaml because `on`
    // is a YAML 1.1 boolean alias. Accept either spelling.
    // YAML 1.1 treats bare `on` as the boolean `true`, so the parser may
    // expose the trigger under either key. Look up the boolean form
    // through a string-keyed view since JS object keys are strings.
    const on = ci.on ?? (ci as Record<string, unknown>)['true'];
    expect(on).toBeDefined();
    if (typeof on === 'string') {
      expect(on).toBe('pull_request');
    } else if (Array.isArray(on)) {
      expect(on).toContain('pull_request');
    } else if (isObject(on)) {
      expect(Object.keys(on)).toContain('pull_request');
    } else {
      throw new Error('on: trigger has unexpected shape');
    }
  });

  it('ci.yml `on:` trigger includes `push` restricted to branches `main`', () => {
    const ci = loadCi();
    // YAML 1.1 treats bare `on` as the boolean `true`, so the parser may
    // expose the trigger under either key. Look up the boolean form
    // through a string-keyed view since JS object keys are strings.
    const on = ci.on ?? (ci as Record<string, unknown>)['true'];
    expect(isObject(on), 'on: must be a mapping to constrain push branches').toBe(true);
    if (!isObject(on)) return;
    const push = on.push;
    expect(isObject(push), 'on.push must be a mapping with a branches key').toBe(true);
    if (!isObject(push)) return;
    const branches = push.branches;
    expect(Array.isArray(branches)).toBe(true);
    if (!Array.isArray(branches)) return;
    expect(branches).toContain('main');
  });
});

describe('ac-2: actions/checkout@v4', () => {
  it('ci.yml job uses `actions/checkout@v4` as a step', () => {
    const ci = loadCi();
    const uses = allSteps(ci).map(stepUses);
    expect(uses).toContain('actions/checkout@v4');
  });
});

describe('ac-3: actions/setup-node@v4 with .nvmrc', () => {
  it('ci.yml job uses `actions/setup-node@v4`', () => {
    const ci = loadCi();
    const setupNode = allSteps(ci).find((s) => stepUses(s) === 'actions/setup-node@v4');
    expect(setupNode, 'expected a step using actions/setup-node@v4').toBeDefined();
  });

  it('setup-node step reads Node version from `.nvmrc` (e.g., `node-version-file: .nvmrc`) rather than a hard-coded version', () => {
    const ci = loadCi();
    const setupNode = allSteps(ci).find((s) => stepUses(s) === 'actions/setup-node@v4');
    expect(setupNode).toBeDefined();
    if (!setupNode) return;
    const withInputs = setupNode.with;
    expect(isObject(withInputs)).toBe(true);
    if (!isObject(withInputs)) return;
    // Either the literal `.nvmrc` path or matrix expansion that points at
    // the file is acceptable. We accept the canonical `node-version-file:
    // .nvmrc` spelling and require `node-version` NOT to be a hard-coded
    // numeric version (matrix expressions are fine because they fan out
    // across the declared matrix legs).
    if (typeof withInputs['node-version-file'] === 'string') {
      expect(withInputs['node-version-file']).toMatch(/\.nvmrc$/);
    } else {
      const v = withInputs['node-version'];
      expect(typeof v).toBe('string');
      // Must be an expression, not a hard-coded version literal.
      expect(String(v)).toMatch(/\$\{\{/);
    }
  });
});

describe('ac-4: pnpm/action-setup@v4 reads packageManager from package.json', () => {
  it('ci.yml job uses `pnpm/action-setup@v4`', () => {
    const ci = loadCi();
    const setupPnpm = allSteps(ci).find((s) => stepUses(s) === 'pnpm/action-setup@v4');
    expect(setupPnpm, 'expected a step using pnpm/action-setup@v4').toBeDefined();
  });

  it('pnpm setup step does not pin a version in workflow input and instead defers to `package.json` `packageManager` field', () => {
    const ci = loadCi();
    const setupPnpm = allSteps(ci).find((s) => stepUses(s) === 'pnpm/action-setup@v4');
    expect(setupPnpm).toBeDefined();
    if (!setupPnpm) return;
    const withInputs = setupPnpm.with;
    // Either no `with:` block at all, or a `with:` block that does NOT
    // set a hard-coded `version`. The action defers to packageManager
    // by default in this case.
    if (withInputs === undefined) {
      expect(withInputs).toBeUndefined();
      return;
    }
    expect(isObject(withInputs)).toBe(true);
    if (!isObject(withInputs)) return;
    expect(
      withInputs.version,
      'pnpm version must not be hard-coded; defer to packageManager',
    ).toBeUndefined();
  });
});

describe('ac-5: pnpm store cache keyed on pnpm-lock.yaml hash', () => {
  it("ci.yml uses `actions/cache` (or setup-node/pnpm cache) for pnpm store with key derived from `hashFiles('**/pnpm-lock.yaml')`", () => {
    const text = read(ciYmlPath);
    const ci = loadCi();
    // Accept either: setup-node `cache: pnpm` (which keys the pnpm store
    // on the lockfile automatically), OR explicit actions/cache@vN with a
    // hashFiles('**/pnpm-lock.yaml') key. Both satisfy the contract.
    const setupNode = allSteps(ci).find((s) => stepUses(s) === 'actions/setup-node@v4');
    const setupNodeWith = isObject(setupNode?.with) ? setupNode.with : undefined;
    const usesSetupNodeCache = setupNodeWith?.cache === 'pnpm';

    const usesActionsCache = allSteps(ci).some((s) => stepUses(s).startsWith('actions/cache@'));
    const referencesLockfileHash = /hashFiles\(\s*['"]\*\*\/pnpm-lock\.yaml['"]\s*\)/.test(text);

    expect(
      usesSetupNodeCache || (usesActionsCache && referencesLockfileHash),
      "expected setup-node `cache: pnpm` OR actions/cache with hashFiles('**/pnpm-lock.yaml') key",
    ).toBe(true);
  });
});

describe('ac-6: make install', () => {
  it('ci.yml runs `make install` and does not run `pnpm install` directly in any step', () => {
    const ci = loadCi();
    const runs = allSteps(ci)
      .map(stepRuns)
      .filter((r) => r.length > 0);
    expect(runs.some((r) => /\bmake\s+install\b/.test(r))).toBe(true);
    for (const r of runs) {
      expect(r, 'no step should invoke `pnpm install` directly').not.toMatch(/\bpnpm\s+install\b/);
    }
  });
});

describe('ac-7: make typecheck', () => {
  it('ci.yml runs `make typecheck` and does not invoke `tsc` directly', () => {
    const ci = loadCi();
    const runs = allSteps(ci)
      .map(stepRuns)
      .filter((r) => r.length > 0);
    expect(runs.some((r) => /\bmake\s+typecheck\b/.test(r))).toBe(true);
    for (const r of runs) {
      expect(r, 'no step should invoke `tsc` directly').not.toMatch(/(^|\s)tsc(\s|$)/);
    }
  });
});

describe('ac-8: make lint', () => {
  it('ci.yml runs `make lint` and does not invoke `eslint`/`pnpm lint` directly', () => {
    const ci = loadCi();
    const runs = allSteps(ci)
      .map(stepRuns)
      .filter((r) => r.length > 0);
    expect(runs.some((r) => /\bmake\s+lint\b/.test(r))).toBe(true);
    for (const r of runs) {
      expect(r, 'no step should invoke `eslint` directly').not.toMatch(/(^|\s)eslint(\s|$)/);
      expect(r, 'no step should invoke `pnpm lint` directly').not.toMatch(/\bpnpm\s+lint\b/);
    }
  });
});

describe('ac-9: make build', () => {
  it('ci.yml runs `make build` and does not invoke `tsc`/`pnpm build` directly', () => {
    const ci = loadCi();
    const runs = allSteps(ci)
      .map(stepRuns)
      .filter((r) => r.length > 0);
    expect(runs.some((r) => /\bmake\s+build\b/.test(r))).toBe(true);
    for (const r of runs) {
      expect(r, 'no step should invoke `tsc` directly').not.toMatch(/(^|\s)tsc(\s|$)/);
      expect(r, 'no step should invoke `pnpm build` directly').not.toMatch(/\bpnpm\s+build\b/);
    }
  });
});

describe('ac-10: make test', () => {
  it('ci.yml runs `make test` and does not invoke `vitest`/`pnpm test` directly', () => {
    const ci = loadCi();
    const runs = allSteps(ci)
      .map(stepRuns)
      .filter((r) => r.length > 0);
    expect(runs.some((r) => /\bmake\s+test\b/.test(r))).toBe(true);
    for (const r of runs) {
      expect(r, 'no step should invoke `vitest` directly').not.toMatch(/(^|\s)vitest(\s|$)/);
      expect(r, 'no step should invoke `pnpm test` directly').not.toMatch(/\bpnpm\s+test\b/);
    }
  });
});

describe('ac-11: make audit (non-blocking)', () => {
  it('ci.yml runs `make audit` as a step', () => {
    const ci = loadCi();
    const runs = allSteps(ci)
      .map(stepRuns)
      .filter((r) => r.length > 0);
    expect(runs.some((r) => /\bmake\s+audit\b/.test(r))).toBe(true);
  });

  it('the `make audit` step is configured non-blocking (e.g., `continue-on-error: true`) so a failure does not fail the job', () => {
    const ci = loadCi();
    const auditStep = allSteps(ci).find((s) => /\bmake\s+audit\b/.test(stepRuns(s)));
    expect(auditStep, 'expected a step running `make audit`').toBeDefined();
    if (!auditStep) return;
    expect(auditStep['continue-on-error']).toBe(true);
  });
});

describe('ac-12: matrix on Node 20 and 22', () => {
  it('ci.yml job declares a strategy matrix containing Node `20` and `22`', () => {
    const ci = loadCi();
    const jobs = ci.jobs;
    expect(isObject(jobs)).toBe(true);
    if (!isObject(jobs)) return;

    let foundMatrix = false;
    for (const job of Object.values(jobs)) {
      if (!isObject(job)) continue;
      const strategy = job.strategy;
      if (!isObject(strategy)) continue;
      const matrix = strategy.matrix;
      if (!isObject(matrix)) continue;
      // Find a matrix axis whose values include both 20 and 22 (numbers
      // or strings).
      for (const v of Object.values(matrix)) {
        if (!Array.isArray(v)) continue;
        const versions = v.map((x) => String(x));
        if (versions.includes('20') && versions.includes('22')) {
          foundMatrix = true;
        }
      }
    }
    expect(foundMatrix, 'expected matrix axis with values [20, 22]').toBe(true);
  });

  it('matrix Node version is consumed by the setup-node step (so each leg actually runs on its declared version)', () => {
    const ci = loadCi();
    const jobs = ci.jobs;
    expect(isObject(jobs)).toBe(true);
    if (!isObject(jobs)) return;

    // For each job that has a matrix with a Node-version axis, find the
    // setup-node step and assert its `with` block references that axis
    // via `${{ matrix.<axis> }}`.
    let verified = false;
    for (const job of Object.values(jobs)) {
      if (!isObject(job)) continue;
      const strategy = job.strategy;
      if (!isObject(strategy)) continue;
      const matrix = strategy.matrix;
      if (!isObject(matrix)) continue;

      let nodeAxis: string | undefined;
      for (const [k, v] of Object.entries(matrix)) {
        if (!Array.isArray(v)) continue;
        const versions = v.map((x) => String(x));
        if (versions.includes('20') && versions.includes('22')) {
          nodeAxis = k;
          break;
        }
      }
      if (!nodeAxis) continue;

      const steps = job.steps;
      if (!Array.isArray(steps)) continue;
      const setupNode = steps.find((s) => isObject(s) && stepUses(s) === 'actions/setup-node@v4');
      if (!isObject(setupNode)) continue;
      const withInputs = setupNode.with;
      if (!isObject(withInputs)) continue;

      const vStr = typeof withInputs['node-version'] === 'string' ? withInputs['node-version'] : '';
      const fStr =
        typeof withInputs['node-version-file'] === 'string' ? withInputs['node-version-file'] : '';
      // Either node-version is a matrix expression referencing the axis,
      // or node-version-file references a matrix expression. The .nvmrc
      // case alone is NOT sufficient -- the matrix would not actually
      // change Node versions.
      const expr = new RegExp(`\\$\\{\\{\\s*matrix\\.${nodeAxis}\\s*\\}\\}`);
      if (expr.test(vStr) || expr.test(fStr)) {
        verified = true;
      }
    }
    expect(
      verified,
      'expected setup-node step to reference matrix Node-version axis via ${{ matrix.<axis> }}',
    ).toBe(true);
  });
});

describe('ac-13: setup-branch-protection.sh exists, executable, valid', () => {
  it('`scripts/setup-branch-protection.sh` exists, is executable, and uses `gh api` to call the branch-protection endpoint for `main`', () => {
    expect(exists(protectionScriptPath)).toBe(true);
    const stat = statSync(join(repoRoot, protectionScriptPath));
    // Owner-execute bit must be set.
    expect((stat.mode & 0o100) !== 0, `${protectionScriptPath} must be executable`).toBe(true);
    const body = read(protectionScriptPath);
    expect(body).toMatch(/\bgh\s+api\b/);
    // Calls the branch-protection endpoint for `main`. The path is
    // `repos/<owner>/<repo>/branches/main/protection`. Accept either a
    // literal `branches/main/protection` or a variable expansion
    // (`branches/${BRANCH}/protection`) paired with a `BRANCH=main`
    // assignment in the same script.
    const literalForm = /branches\/main\/protection/.test(body);
    const variableForm =
      /branches\/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/protection/.test(body) &&
      /\bBRANCH\s*=\s*"?main"?/.test(body);
    expect(
      literalForm || variableForm,
      'expected branch-protection endpoint for main (literal or BRANCH=main expansion)',
    ).toBe(true);
  });

  it('running `bash -n scripts/setup-branch-protection.sh` succeeds (script is syntactically valid)', () => {
    const result = spawnSync('bash', ['-n', join(repoRoot, protectionScriptPath)], {
      stdio: 'pipe',
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `bash -n stderr: ${result.stderr.toString()}`).toBe(0);
  });
});

describe('ac-14..ac-22: branch-protection script payload settings', () => {
  const body = (): string => read(protectionScriptPath);

  it('branch-protection script sends `required_pull_request_reviews.required_approving_review_count: 1`', () => {
    // Accept JSON forms ("required_approving_review_count": 1) and -F /
    // -f form-field flags (required_pull_request_reviews[required_approving_review_count]=1).
    const b = body();
    expect(
      /"required_approving_review_count"\s*:\s*1\b/.test(b) ||
        /required_approving_review_count\s*[:=]\s*1\b/.test(b),
    ).toBe(true);
  });

  it('branch-protection script sends `required_pull_request_reviews.dismiss_stale_reviews: true`', () => {
    const b = body();
    expect(
      /"dismiss_stale_reviews"\s*:\s*true\b/.test(b) ||
        /dismiss_stale_reviews\s*[:=]\s*true\b/.test(b),
    ).toBe(true);
  });

  it("branch-protection script's `required_status_checks.contexts` (or `checks`) lists each Node-matrix leg by name (one entry per Node version in the CI matrix)", () => {
    // The CI matrix declares Nodes 20 and 22 -> 2 status-check contexts.
    const b = body();
    // Pull the contexts/checks array regardless of which key was used.
    // We accept either a JSON `"contexts": [...]` or `"checks": [{...}]`.
    const contextsMatch = b.match(/"contexts"\s*:\s*\[([\s\S]*?)\]/);
    const checksMatch = b.match(/"checks"\s*:\s*\[([\s\S]*?)\]/);
    let entries: string[] = [];
    if (contextsMatch) {
      entries = (contextsMatch[1] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter((s) => s.length > 0);
    } else if (checksMatch) {
      const inner = checksMatch[1] ?? '';
      entries = [...inner.matchAll(/"context"\s*:\s*"([^"]+)"/g)].map((m) => m[1] ?? '');
    }
    expect(entries.length, 'expected 2 status-check contexts (one per Node matrix leg)').toBe(2);
  });

  it('branch-protection script sends `required_status_checks.strict: true`', () => {
    const b = body();
    // Search within the required_status_checks block.
    const block = b.match(/"required_status_checks"\s*:\s*\{[\s\S]*?\}/);
    expect(block, 'required_status_checks block missing').toBeTruthy();
    if (!block) return;
    expect(/"strict"\s*:\s*true\b/.test(block[0])).toBe(true);
  });

  it("the names listed in required_status_checks match the job names produced by ci.yml's matrix (no drift between workflow and protection script)", () => {
    const ci = loadCi();
    const jobs = ci.jobs;
    expect(isObject(jobs)).toBe(true);
    if (!isObject(jobs)) return;

    // Compute expected names: for each job with a Node matrix axis, the
    // GitHub Actions job-context name is `<job-name> (<matrix-value>)`.
    // The job-name is the jobs.<id>.name field if set, otherwise the
    // job id. We expect one entry per matrix leg.
    const expected: string[] = [];
    for (const [jobId, job] of Object.entries(jobs)) {
      if (!isObject(job)) continue;
      const strategy = job.strategy;
      if (!isObject(strategy)) continue;
      const matrix = strategy.matrix;
      if (!isObject(matrix)) continue;

      let nodeAxis: string | undefined;
      let versions: string[] = [];
      for (const [k, v] of Object.entries(matrix)) {
        if (!Array.isArray(v)) continue;
        const vs = v.map((x) => String(x));
        if (vs.includes('20') && vs.includes('22')) {
          nodeAxis = k;
          versions = vs;
          break;
        }
      }
      if (!nodeAxis) continue;
      const baseName = typeof job.name === 'string' ? job.name : jobId;
      // GitHub renders matrix-leg job names as `<job-name> (<value>)` when
      // there is a single matrix axis. The job's display name may itself
      // reference `${{ matrix.<axis> }}` -- in that case the rendered name
      // is just the substituted value with no surrounding parens.
      const exprRe = new RegExp(`\\$\\{\\{\\s*matrix\\.${nodeAxis}\\s*\\}\\}`);
      for (const v of versions) {
        if (exprRe.test(baseName)) {
          expected.push(baseName.replace(exprRe, v));
        } else {
          expected.push(`${baseName} (${v})`);
        }
      }
    }
    expect(expected.length).toBeGreaterThan(0);

    const b = body();
    for (const name of expected) {
      expect(b, `branch-protection script missing required check: ${name}`).toContain(name);
    }
  });

  it('branch-protection script sends `enforce_admins: false`', () => {
    const b = body();
    expect(
      /"enforce_admins"\s*:\s*false\b/.test(b) || /enforce_admins\s*[:=]\s*false\b/.test(b),
    ).toBe(true);
  });

  it('branch-protection script sends `required_linear_history: true`', () => {
    const b = body();
    expect(
      /"required_linear_history"\s*:\s*true\b/.test(b) ||
        /required_linear_history\s*[:=]\s*true\b/.test(b),
    ).toBe(true);
  });

  it('branch-protection script sends `allow_force_pushes: false`', () => {
    const b = body();
    expect(
      /"allow_force_pushes"\s*:\s*false\b/.test(b) || /allow_force_pushes\s*[:=]\s*false\b/.test(b),
    ).toBe(true);
  });

  it('branch-protection script sends `allow_deletions: false`', () => {
    const b = body();
    expect(
      /"allow_deletions"\s*:\s*false\b/.test(b) || /allow_deletions\s*[:=]\s*false\b/.test(b),
    ).toBe(true);
  });

  it('branch-protection script sends `block_creations: false`', () => {
    const b = body();
    expect(
      /"block_creations"\s*:\s*false\b/.test(b) || /block_creations\s*[:=]\s*false\b/.test(b),
    ).toBe(true);
  });

  it('branch-protection script sends `required_conversation_resolution: true`', () => {
    const b = body();
    expect(
      /"required_conversation_resolution"\s*:\s*true\b/.test(b) ||
        /required_conversation_resolution\s*[:=]\s*true\b/.test(b),
    ).toBe(true);
  });
});

describe('ac-23: contributor docs', () => {
  /**
   * Locate the contributing docs. If `CONTRIBUTING.md` exists, return
   * that. Otherwise return the README's contributing section -- callers
   * then check for the required statements.
   */
  const loadContributingDoc = (): { source: string; body: string } => {
    if (exists('CONTRIBUTING.md')) {
      return { source: 'CONTRIBUTING.md', body: read('CONTRIBUTING.md') };
    }
    expect(exists('README.md'), 'expected CONTRIBUTING.md or README.md to exist').toBe(true);
    const readme = read('README.md');
    // Pull the heading-bound contributing section so we don't accidentally
    // match unrelated copy elsewhere in the README.
    const idx = readme.search(/^##\s+(Contributing|Contribute)\b/im);
    expect(idx, 'README.md missing a Contributing section').toBeGreaterThanOrEqual(0);
    const after = readme.slice(idx);
    const next = after.slice(2).search(/\n##\s/);
    const section = next < 0 ? after : after.slice(0, next + 2);
    return { source: 'README.md#contributing', body: section };
  };

  it('either `CONTRIBUTING.md` exists or `README.md` has a contributing section, and the chosen location is discoverable (linked from README if separate)', () => {
    const hasContributingFile = exists('CONTRIBUTING.md');
    const readme = exists('README.md') ? read('README.md') : '';
    if (hasContributingFile) {
      // README must link to CONTRIBUTING.md so contributors can find it.
      expect(readme, 'README.md should link to CONTRIBUTING.md').toMatch(/CONTRIBUTING\.md/);
    } else {
      // README itself must contain the contributing section.
      expect(readme).toMatch(/^##\s+(Contributing|Contribute)\b/im);
    }
  });

  it('the contributing docs explain branching from `main`', () => {
    const { body } = loadContributingDoc();
    expect(body).toMatch(/branch\s+from\s+`?main`?/i);
  });

  it('the contributing docs state changes land via PR (no direct push to main)', () => {
    const { body } = loadContributingDoc();
    // Must mention pull request flow AND prohibit direct pushes to main.
    expect(body).toMatch(/pull\s+request|\bPR\b/i);
    expect(body).toMatch(
      /no\s+direct\s+push|don'?t\s+push\s+(directly\s+)?to\s+main|never\s+push\s+(directly\s+)?to\s+main/i,
    );
  });

  it('the contributing docs state CI must pass before merge', () => {
    const { body } = loadContributingDoc();
    expect(body).toMatch(
      /CI\s+must\s+pass|green\s+CI|CI\s+(checks\s+)?(must\s+be\s+)?(green|passing)/i,
    );
  });

  it('the contributing docs state PR conversations must be resolved before merge', () => {
    const { body } = loadContributingDoc();
    expect(body).toMatch(/conversations?\s+(must\s+be\s+)?resolved/i);
  });

  it('the contributing docs state squash-merge is the merge strategy', () => {
    const { body } = loadContributingDoc();
    expect(body).toMatch(/squash[- ]merge|squash\s+(and\s+)?merge/i);
  });
});
