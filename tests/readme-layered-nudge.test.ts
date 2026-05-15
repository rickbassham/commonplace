/**
 * Tests for DAR-965 ac-5: README (or CONTRIBUTING) carries a short
 * section describing the layered agent-memory nudge with three layers:
 * (a) MCP `instructions`, (b) tool descriptions, (c) per-project
 * `CLAUDE.md` directive (citing DAR-1004 as the future ergonomic
 * version of (c)).
 *
 * The section is bounded: at most one prose paragraph plus at most one
 * fenced code block. This keeps the nudge consumable and stops it from
 * silently sprawling.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');
const README_PATH = join(repoRoot, 'README.md');
const CONTRIBUTING_PATH = join(repoRoot, 'CONTRIBUTING.md');

const SECTION_HEADING_REGEX = /^#{2,3}\s+Layered agent-memory nudge\b/m;

interface Section {
  source: 'README.md' | 'CONTRIBUTING.md';
  body: string;
}

function findSection(): Section | undefined {
  for (const [source, path] of [
    ['README.md', README_PATH],
    ['CONTRIBUTING.md', CONTRIBUTING_PATH],
  ] as const) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    const match = SECTION_HEADING_REGEX.exec(content);
    if (!match) continue;
    const start = match.index + match[0].length;
    // Section ends at the next heading of equal-or-higher level or EOF.
    // Mask out fenced code blocks first so `## ...` lines that live
    // inside a fenced markdown example don't terminate the section.
    const hashes = match[0].trim().split(' ')[0];
    const headingLevel = hashes ? hashes.length : 2;
    const rest = content.slice(start);
    const masked = rest.replace(/```[\s\S]*?```/g, (block) => block.replace(/#/g, ' '));
    const nextHeading = new RegExp(`\\n#{1,${headingLevel}}\\s`, 'm').exec(masked);
    const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
    return { source, body };
  }
  return undefined;
}

describe('ac-5: layered agent-memory nudge documentation', () => {
  it('either README.md or CONTRIBUTING.md contains a section that names all three layers (MCP `instructions`, tool descriptions, per-project `CLAUDE.md`) and cites `DAR-1004`', () => {
    const section = findSection();
    expect(
      section,
      'expected a "Layered agent-memory nudge" section in README.md or CONTRIBUTING.md',
    ).toBeDefined();
    if (!section) return;
    const body = section.body;
    expect(body, 'section must mention MCP `instructions`').toMatch(/`instructions`/);
    expect(body, 'section must mention tool descriptions').toMatch(/tool description/i);
    expect(body, 'section must mention per-project `CLAUDE.md`').toMatch(/`CLAUDE\.md`/);
    expect(body, 'section must cite DAR-1004').toMatch(/DAR-1004/);
  });

  it('the new docs section contains at most one prose paragraph plus at most one fenced code block', () => {
    const section = findSection();
    expect(section).toBeDefined();
    if (!section) return;
    const body = section.body;

    const fenceMatches = body.match(/^```/gm) ?? [];
    const fencedBlocks = fenceMatches.length / 2;
    expect(fencedBlocks).toBeLessThanOrEqual(1);

    const withoutFences = body.replace(/```[\s\S]*?```/g, '');
    const paragraphs = withoutFences
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    expect(paragraphs.length).toBeLessThanOrEqual(1);
  });
});
