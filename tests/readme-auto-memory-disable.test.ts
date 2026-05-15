/**
 * Tests for DAR-1009: README documents how to disable Claude Code's
 * built-in auto-memory feature when commonplace is the canonical memory
 * mechanism. The new subsection lives under `## Installing & invoking
 * commonplace-mcp` and documents three knobs:
 *
 *   - `.claude/settings.json` key `"autoMemoryEnabled": false`
 *     (project / user / local scope)
 *   - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` env var (per-shell)
 *   - `/memory` runtime toggle (per-session)
 *
 * Plus a regression-gate that asserts each knob substring is present
 * anywhere in the README.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');
const README_PATH = join(repoRoot, 'README.md');
const readme = (): string => readFileSync(README_PATH, 'utf8');

const PARENT_HEADING_REGEX = /^##\s+Installing & invoking commonplace-mcp\b/m;

interface Subsection {
  /** Heading line text (without the `### ` prefix). */
  heading: string;
  /** Body content between the `###` heading and the next heading of equal-or-higher level. */
  body: string;
}

/**
 * Locate the level-3 subsection nested under `## Installing & invoking
 * commonplace-mcp` whose heading mentions Claude Code auto-memory.
 */
function findAutoMemorySubsection(): Subsection | undefined {
  const content = readme();
  const parent = PARENT_HEADING_REGEX.exec(content);
  if (!parent) return undefined;

  // Restrict search to the body of the parent section (until the next
  // `##` heading).
  const sectionStart = parent.index + parent[0].length;
  const rest = content.slice(sectionStart);
  const nextH2 = /\n##\s/.exec(rest);
  const parentBody = nextH2 ? rest.slice(0, nextH2.index) : rest;

  // Find each `###` subsection within the parent body and pick the one
  // whose heading mentions Claude Code auto-memory.
  const subsectionRe = /^###\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = subsectionRe.exec(parentBody)) !== null) {
    const heading = m[1]?.trim() ?? '';
    if (!/claude\s*code/i.test(heading)) continue;
    if (!/auto[- ]?memory/i.test(heading)) continue;
    const bodyStart = m.index + m[0].length;
    const after = parentBody.slice(bodyStart);
    const nextHeading = /\n#{1,3}\s/.exec(after);
    const body = nextHeading ? after.slice(0, nextHeading.index) : after;
    return { heading, body };
  }
  return undefined;
}

describe('DAR-1009 ac-1: subsection placement and rationale', () => {
  it('README contains a level-3 (`###`) subsection whose heading mentions Claude Code auto-memory and which is nested under the `## Installing & invoking commonplace-mcp` section', () => {
    const sub = findAutoMemorySubsection();
    expect(
      sub,
      'expected a `###` subsection mentioning Claude Code auto-memory under `## Installing & invoking commonplace-mcp`',
    ).toBeDefined();
  });

  it('the new subsection body contains a 1-2 sentence explanation that names the structural prompt conflict, and recommends disabling auto-memory when commonplace is the intended memory mechanism', () => {
    const sub = findAutoMemorySubsection();
    expect(sub).toBeDefined();
    if (!sub) return;
    const body = sub.body.toLowerCase();
    expect(body, 'subsection must mention `system prompt`').toContain('system prompt');
    expect(body, 'subsection must mention `conflict`').toContain('conflict');
    expect(body, 'subsection must recommend something').toContain('recommend');
    expect(body, 'subsection must mention disabling').toContain('disable');
  });
});

describe('DAR-1009 ac-2: three knobs documented with scopes', () => {
  it('the new subsection contains a fenced code block whose body includes the literal JSON `"autoMemoryEnabled": false`', () => {
    const sub = findAutoMemorySubsection();
    expect(sub).toBeDefined();
    if (!sub) return;
    const fencedBlocks = sub.body.match(/```[\s\S]*?```/g) ?? [];
    const hasFenceWithKey = fencedBlocks.some((block) =>
      block.includes('"autoMemoryEnabled": false'),
    );
    expect(
      hasFenceWithKey,
      'expected a fenced code block in the subsection containing `"autoMemoryEnabled": false`',
    ).toBe(true);
  });

  it('the new subsection contains the literal substring `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`', () => {
    const sub = findAutoMemorySubsection();
    expect(sub).toBeDefined();
    if (!sub) return;
    expect(sub.body).toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
  });

  it('the new subsection contains the literal substring `/memory` referring to the runtime toggle in prose (not only inside a URL)', () => {
    const sub = findAutoMemorySubsection();
    expect(sub).toBeDefined();
    if (!sub) return;
    // Strip markdown links (and bare URLs) so a hit inside a URL like
    // `code.claude.com/docs/en/memory#...` does not count.
    const proseOnly = sub.body.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/https?:\/\/\S+/g, '');
    expect(proseOnly).toContain('/memory');
  });

  it('for the `autoMemoryEnabled` setting, the subsection names all three scopes (`project`, `user`, `local`); for `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, names per-shell scope; for `/memory`, names per-session scope', () => {
    const sub = findAutoMemorySubsection();
    expect(sub).toBeDefined();
    if (!sub) return;
    const body = sub.body.toLowerCase();
    expect(body, 'must name `project` scope for autoMemoryEnabled').toContain('project');
    expect(body, 'must name `user` scope for autoMemoryEnabled').toContain('user');
    expect(body, 'must name `local` scope for autoMemoryEnabled').toContain('local');
    expect(body, 'must name per-shell scope for the env var').toMatch(/per[- ]shell/);
    expect(body, 'must name per-session scope for the runtime toggle').toMatch(/per[- ]session/);
  });
});

describe('DAR-1009 ac-3: canonical docs cross-link', () => {
  it('the new subsection contains a markdown link whose target URL is exactly `https://code.claude.com/docs/en/memory#enable-or-disable-auto-memory`', () => {
    const sub = findAutoMemorySubsection();
    expect(sub).toBeDefined();
    if (!sub) return;
    expect(sub.body).toMatch(
      /\]\(https:\/\/code\.claude\.com\/docs\/en\/memory#enable-or-disable-auto-memory\)/,
    );
  });
});

describe('DAR-1009 ac-4: non-prescriptive framing', () => {
  it('the subsection body acknowledges that leaving auto-memory enabled is a valid choice (no hard prescription)', () => {
    const sub = findAutoMemorySubsection();
    expect(sub).toBeDefined();
    if (!sub) return;
    const body = sub.body.toLowerCase();
    const hasNonPrescriptivePhrase =
      /\bcan\s+leave\b/.test(body) ||
      /\bmay\s+leave\b/.test(body) ||
      /\bprefer\s+to\s+leave\b/.test(body) ||
      /\baccept\s+the\s+conflict\b/.test(body);
    expect(
      hasNonPrescriptivePhrase,
      'subsection must include a phrase like `can leave`, `may leave`, `prefer to leave`, or `accept the conflict`',
    ).toBe(true);
  });
});

describe('DAR-1009 ac-5: regression-gate substring assertions', () => {
  it('README.md contains the literal substring `autoMemoryEnabled`', () => {
    expect(readme()).toContain('autoMemoryEnabled');
  });

  it('README.md contains the literal substring `CLAUDE_CODE_DISABLE_AUTO_MEMORY`', () => {
    expect(readme()).toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
  });

  it('README.md contains the literal substring `/memory`', () => {
    expect(readme()).toContain('/memory');
  });
});
