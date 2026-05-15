/**
 * Tests for ac-9: README contains a short section describing the
 * `pinned` frontmatter field with a YAML example showing `pinned: true`
 * and cross-linking to the layered agent-memory nudge / MCP
 * `instructions` section.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');
const readMarkdown = (): string => readFileSync(join(repoRoot, 'README.md'), 'utf8');

const SECTION_HEADING_REGEX = /^#{2,3}\s+Pinned memories\b/m;

function findSection(): string | undefined {
  const body = readMarkdown();
  const match = SECTION_HEADING_REGEX.exec(body);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const hashes = match[0].trim().split(' ')[0];
  const level = hashes ? hashes.length : 2;
  const rest = body.slice(start);
  const masked = rest.replace(/```[\s\S]*?```/g, (block) => block.replace(/#/g, ' '));
  const next = new RegExp(`\\n#{1,${level}}\\s`, 'm').exec(masked);
  return next ? rest.slice(0, next.index) : rest;
}

describe('ac-9: pinned-memories README section', () => {
  it('README contains a section describing the `pinned` frontmatter field with a YAML example showing `pinned: true`', () => {
    const section = findSection();
    expect(section, 'README missing "Pinned memories" section').toBeDefined();
    if (!section) return;
    expect(section).toMatch(/`pinned/);
    expect(section).toMatch(/frontmatter/i);
    expect(section).toMatch(/```ya?ml[\s\S]*pinned:\s*true[\s\S]*```/);
  });

  it('README pinned-memories section cross-links to the existing layered-agent-memory-nudge / MCP-instructions section', () => {
    const section = findSection();
    expect(section).toBeDefined();
    if (!section) return;
    const hasAnchor = /\(#layered-agent-memory-nudge\)/.test(section);
    const hasMention = /Layered agent-memory nudge/i.test(section);
    expect(hasAnchor || hasMention).toBe(true);
  });
});
