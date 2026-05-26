/**
 * DAR-1035: tests for the shared `bootHarness` test helper.
 *
 * Covers ac-1 (#1, #2, #3, #4) from the DAR-1035 contract:
 *
 *   - ac-1 #1: bootHarness refuses to boot when env omits
 *     COMMONPLACE_USER_DIR/COMMONPLACE_MEMORY_DIR AND the caller did not
 *     supply an explicit userDir.
 *   - ac-1 #2: bootHarness without an explicit COMMONPLACE_USER_DIR defaults
 *     the env's COMMONPLACE_USER_DIR to a path under the per-test cwd
 *     tmpdir (not homedir()/.commonplace/memory).
 *   - ac-1 #3: every tests/*.test.ts file that calls bootServer or
 *     bootHarness either sets env.COMMONPLACE_USER_DIR (or the deprecated
 *     COMMONPLACE_MEMORY_DIR alias) on the call site OR uses the shared
 *     bootHarness helper (which injects a tmp userDir by default). No call
 *     site passes `env: {}` to bootServer/bootHarness without a tmp userDir.
 *   - ac-1 #4: the existing tests/server-bin-update-check-wiring.test.ts
 *     boot call passes COMMONPLACE_USER_DIR (or uses the harness default)
 *     such that BootResult.userDir is a path under userTmp, not
 *     homedir()/.commonplace/memory.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootHarness, ENV_USER_DIR } from './helpers/boot-harness.js';

const repoRoot = join(__dirname, '..');

const stubEmbedder = () => ({
  modelId: 'stub',
  dim: 4,
  embed: async (text: string): Promise<Float32Array> => {
    void text;
    return new Float32Array(4);
  },
});

describe('ac-1 #1: bootHarness refuses to boot without an explicit user dir', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'dar1035-refuse-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('throws when env omits both env vars AND userDir is explicitly null', async () => {
    await expect(
      bootHarness({
        env: {},
        cwd,
        embedder: stubEmbedder(),
        userDir: null,
      }),
    ).rejects.toThrow(/COMMONPLACE_USER_DIR/);
  });
});

describe('ac-1 #2: bootHarness defaults COMMONPLACE_USER_DIR to a path under the per-test tmpdir', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'dar1035-default-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('uses a path under cwd (NOT under homedir()/.commonplace/memory) when COMMONPLACE_USER_DIR is unset', async () => {
    const { boot, close } = await bootHarness({
      env: {},
      cwd,
      embedder: stubEmbedder(),
    });
    try {
      const realHome = homedir();
      const realDefault = join(realHome, '.commonplace', 'memory');
      // The resolved user dir lives under cwd, not the real homedir.
      expect(boot.scope.userDir.startsWith(cwd + sep)).toBe(true);
      expect(boot.scope.userDir.startsWith(realDefault)).toBe(false);
    } finally {
      await close();
    }
  });

  it('honours an explicit env.COMMONPLACE_USER_DIR (does not override caller-supplied path)', async () => {
    const explicit = mkdtempSync(join(tmpdir(), 'dar1035-explicit-'));
    try {
      const { boot, close } = await bootHarness({
        env: { [ENV_USER_DIR]: explicit },
        cwd,
        embedder: stubEmbedder(),
      });
      try {
        expect(boot.scope.userDir).toBe(explicit);
      } finally {
        await close();
      }
    } finally {
      rmSync(explicit, { recursive: true, force: true });
    }
  });
});

describe('ac-1 #3: no test file passes `env: {}` to bootServer/bootHarness without a tmp userDir', () => {
  /**
   * Static-grep guard. Walks `tests/` and asserts that every call to
   * `bootServer(` or `bootHarness(` either:
   *
   *   - passes the call through the shared helper at
   *     `tests/helpers/boot-harness.ts` (which injects a tmp userDir by
   *     default), OR
   *   - sets COMMONPLACE_USER_DIR (or the deprecated COMMONPLACE_MEMORY_DIR
   *     alias) in the call's env literal.
   *
   * Implementation: for each call site we expand the parenthesised argument
   * block (matching balanced parens) and check that the literal text either
   * contains `COMMONPLACE_USER_DIR`, `COMMONPLACE_MEMORY_DIR`, or `userDir:`
   * (the bootHarness-shaped explicit override). Calls inside the helper
   * module itself are exempt (the helper is the thing that injects the var
   * downstream).
   */
  const collectTestFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        out.push(...collectTestFiles(full));
      } else if (entry.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  };

  /**
   * Replace every comment and string literal in `source` with spaces of
   * the same length so character offsets stay aligned but no
   * comment/string content can match the call-site needle. This avoids
   * false positives like a JSDoc that mentions `bootServer(...)` or a
   * string literal `'bootServer('` in unrelated code.
   */
  const stripCommentsAndStrings = (source: string): string => {
    const buf = source.split('');
    let i = 0;
    while (i < buf.length) {
      const ch = buf[i]!;
      const next = buf[i + 1] ?? '';
      if (ch === '/' && next === '/') {
        while (i < buf.length && buf[i] !== '\n') {
          buf[i] = ' ';
          i += 1;
        }
        continue;
      }
      if (ch === '/' && next === '*') {
        buf[i] = ' ';
        buf[i + 1] = ' ';
        i += 2;
        while (i < buf.length) {
          if (buf[i] === '*' && buf[i + 1] === '/') {
            buf[i] = ' ';
            buf[i + 1] = ' ';
            i += 2;
            break;
          }
          if (buf[i] !== '\n') buf[i] = ' ';
          i += 1;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        buf[i] = ' ';
        i += 1;
        while (i < buf.length) {
          if (buf[i] === '\\') {
            buf[i] = ' ';
            buf[i + 1] = ' ';
            i += 2;
            continue;
          }
          if (buf[i] === quote) {
            buf[i] = ' ';
            i += 1;
            break;
          }
          if (buf[i] !== '\n') buf[i] = ' ';
          i += 1;
        }
        continue;
      }
      i += 1;
    }
    return buf.join('');
  };

  const findCallArgs = (rawSource: string, fnName: string): string[] => {
    // Preprocess: blank out comments and strings so call-site detection
    // cannot trigger on documentation prose or string literals.
    const source = stripCommentsAndStrings(rawSource);
    // Re-derive the original args text from `rawSource` once we know the
    // span (so callers see the actual content, not the blanked version).
    const out: string[] = [];
    const needle = `${fnName}(`;
    let idx = 0;
    while (idx < source.length) {
      const found = source.indexOf(needle, idx);
      if (found < 0) break;
      // Make sure the preceding character is not an identifier char (so we
      // don't match `foo.bootServer(` inside an unrelated name). We DO want
      // to match property accesses like `module.bootServer(`, but those are
      // still legitimate call sites for this audit.
      const prev = found > 0 ? source[found - 1]! : '';
      const isIdentChar = /[A-Za-z0-9_$]/.test(prev);
      if (isIdentChar) {
        idx = found + needle.length;
        continue;
      }
      // Walk forward (over the comment/string-stripped source) to find
      // the matching closing paren by simple paren-balance.
      let depth = 1;
      let i = found + needle.length;
      while (i < source.length && depth > 0) {
        const ch = source[i]!;
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        i += 1;
      }
      // Slice from `rawSource` so the args text returned to the assertion
      // matches the original (un-blanked) characters.
      out.push(rawSource.slice(found + needle.length, i - 1));
      idx = i;
    }
    return out;
  };

  it('every bootServer/bootHarness call site in tests/ either uses the shared helper or sets a tmp userDir env var', () => {
    const helperPath = join(repoRoot, 'tests/helpers/boot-harness.ts');
    const testFiles = collectTestFiles(join(repoRoot, 'tests'));

    const offenders: string[] = [];
    for (const file of testFiles) {
      const source = readFileSync(file, 'utf8');

      // bootServer calls MUST set the env var in the args literal
      // (bootServer has no default-injection behaviour). The helper
      // module itself is the legitimate aggregator and is exempt.
      //
      // NOTE: this allowlist is a best-effort fast-feedback signal --
      // it matches known env-var names and the literal `ENV_USER_DIR` /
      // `ENV_DEPRECATED_MEMORY_DIR` constants exported from
      // `tests/helpers/boot-harness.ts`. A caller indirecting through a
      // differently-named local constant could slip past this grep. The
      // hard guarantee against the ~/.commonplace/memory leak lives in
      // `bootHarness`'s runtime throw at `tests/helpers/boot-harness.ts`
      // (the refuse-to-boot guard when env omits both vars and no
      // explicit userDir is set). Treat this static check as an early
      // warning, not the safety floor.
      const bootServerCalls = findCallArgs(source, 'bootServer');
      for (const args of bootServerCalls) {
        const ok =
          args.includes('COMMONPLACE_USER_DIR') ||
          args.includes('COMMONPLACE_MEMORY_DIR') ||
          args.includes('ENV_USER_DIR') ||
          args.includes('ENV_DEPRECATED_MEMORY_DIR') ||
          /\buserDir\s*:/.test(args);
        if (ok) continue;
        if (file === helperPath) continue;
        offenders.push(
          `${file.slice(repoRoot.length + 1)}: bootServer(${args.slice(0, 80).replace(/\s+/g, ' ')}...) -- direct bootServer call without COMMONPLACE_USER_DIR; route through tests/helpers/boot-harness.ts instead`,
        );
      }

      // bootHarness calls are safe by default (the helper injects a tmp
      // userDir under cwd). They are unsafe only if the caller passes
      // `userDir: null` AND omits the env var; the helper itself throws
      // in that case at runtime, so we don't need a static check here.
      // We still scan for an explicit `userDir: null` to surface it as a
      // double-check.
      const bootHarnessCalls = findCallArgs(source, 'bootHarness');
      for (const args of bootHarnessCalls) {
        // `userDir: null` is only safe when env sets one of the dir vars.
        if (!/\buserDir\s*:\s*null\b/.test(args)) continue;
        const envSet =
          args.includes('COMMONPLACE_USER_DIR') ||
          args.includes('COMMONPLACE_MEMORY_DIR') ||
          args.includes('ENV_USER_DIR') ||
          args.includes('ENV_DEPRECATED_MEMORY_DIR');
        if (envSet) continue;
        // The bootHarness leak-prevention test deliberately exercises
        // this throw path -- detect that case and exempt it.
        if (file.endsWith('helpers-boot-harness.test.ts')) continue;
        offenders.push(
          `${file.slice(repoRoot.length + 1)}: bootHarness(${args.slice(0, 80).replace(/\s+/g, ' ')}...) -- userDir: null with no env override; will throw at runtime, but the call site is suspect`,
        );
      }
    }

    expect(
      offenders,
      `Found bootServer/bootHarness call sites that risk reaching the developer's real ~/.commonplace/memory corpus. Offenders:\n  - ${offenders.join('\n  - ')}`,
    ).toEqual([]);
  });
});

describe('ac-1 #4: server-bin-update-check-wiring.test.ts boots with a tmp userDir', () => {
  it('the file routes its boot call through a path that injects a tmp userDir (shared helper or explicit env var)', () => {
    const file = join(repoRoot, 'tests/server-bin-update-check-wiring.test.ts');
    const source = readFileSync(file, 'utf8');
    // Either it imports the shared helper, OR every call site in the file
    // sets COMMONPLACE_USER_DIR / COMMONPLACE_MEMORY_DIR / ENV_USER_DIR
    // explicitly. We assert at least one of the two paths is in use.
    const usesSharedHelper = /from\s+['"]\.\/helpers\/boot-harness/.test(source);
    const setsUserDirInline =
      source.includes('COMMONPLACE_USER_DIR') ||
      source.includes('COMMONPLACE_MEMORY_DIR') ||
      source.includes('ENV_USER_DIR') ||
      source.includes('ENV_DEPRECATED_MEMORY_DIR');
    expect(
      usesSharedHelper || setsUserDirInline,
      'tests/server-bin-update-check-wiring.test.ts must either import the shared bootHarness helper (which injects a tmp userDir) or set COMMONPLACE_USER_DIR on the boot call site; otherwise bootServer will fall through to ~/.commonplace/memory.',
    ).toBe(true);
  });
});
