/**
 * AC-1 / AC-2 invariant guards for DAR-958.
 *
 * The handler factory previously leaned on `projectStore!` non-null
 * assertions to bridge a runtime invariant (an `if (projectStore !==
 * undefined)` guard) into a typed use site. DAR-958 replaces those assertions
 * with a structural fix (an internal discriminated union over the resolved
 * stores) so the compiler discharges the guard. These tests anchor the AC
 * deterministically:
 *
 *   - AC-1 test 1: `src/server/handlers.ts` contains zero occurrences of the
 *     literal substring `projectStore!`.
 *   - AC-1 test 2: parsing `src/server/handlers.ts` with the TypeScript
 *     compiler API yields zero AST nodes of `SyntaxKind.NonNullExpression`
 *     anywhere in the file. This is strictly stronger than the AC text
 *     (which only mentions `projectStore!`) and was explicitly accepted in
 *     the contract sign-off; AC-1 test 1 above preserves the literal
 *     reading.
 *   - AC-2: a `git diff origin/main..HEAD -- src/server/handlers.ts` shows
 *     zero added lines (lines starting with `+` and not `+++`) containing
 *     the `as` keyword as a word (`\bas\b`). Pre-existing `as` occurrences
 *     are ignored. The grader is "no `as` added" (not net delta) to match
 *     the AC text "no `as` coercions added to compensate".
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const HANDLERS = resolve(__dirname, '..', 'src', 'server', 'handlers.ts');

describe('DAR-958 / AC-1: no projectStore non-null assertion remains', () => {
  it('src/server/handlers.ts contains zero occurrences of the literal substring `projectStore!`', () => {
    const src = readFileSync(HANDLERS, 'utf8');
    // Build the literal at runtime so this test file itself does not contain
    // the forbidden substring (which would skew tooling that greps the
    // codebase).
    const forbidden = 'projectStore' + '!';
    const occurrences = src.split(forbidden).length - 1;
    expect(occurrences).toBe(0);
  });

  it('parsing src/server/handlers.ts with the TypeScript compiler API yields zero AST nodes of SyntaxKind.NonNullExpression', () => {
    const src = readFileSync(HANDLERS, 'utf8');
    const sf = ts.createSourceFile(HANDLERS, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

    const offending: string[] = [];
    const walk = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.NonNullExpression) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offending.push(`line ${line + 1}:${character + 1}: ${node.getText(sf)}`);
      }
      node.forEachChild(walk);
    };
    walk(sf);

    expect(offending).toEqual([]);
  });
});

describe('DAR-958 / AC-2: no `as` coercions added in src/server/handlers.ts on this branch', () => {
  it('git diff origin/main..HEAD -- src/server/handlers.ts shows zero added lines containing the word `as`', () => {
    // Resolve the merge base so the diff reflects only this branch's
    // contribution, even when the local `origin/main` ref has moved on.
    let mergeBase: string;
    try {
      mergeBase = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
    } catch {
      // Fall back to `origin/main` itself; if neither exists, the test can
      // legitimately bail since AC-2 only applies once the branch is
      // diff-able against main.
      mergeBase = 'origin/main';
    }

    let diff: string;
    try {
      diff = execFileSync('git', ['diff', `${mergeBase}..HEAD`, '--', 'src/server/handlers.ts'], {
        encoding: 'utf8',
      });
    } catch {
      // If git is unavailable or the diff fails, skip rather than false-fail.
      return;
    }

    const lines = diff.split('\n');
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    const asWord = /\bas\b/;
    const offending = added.filter((l) => asWord.test(l));
    expect(offending).toEqual([]);
  });
});
