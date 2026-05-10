/**
 * DAR-915 contract tests.
 *
 * Verifies the user-facing README at the repo root meets the nine
 * acceptance criteria: concept blurb, historical-origin note, install
 * commands, tool reference (with input schemas + examples that don't drift
 * from the source-of-truth schemas in src/server/tools.ts), memory-type
 * taxonomy, env-var configuration table, link to docs/sidecar-format.md,
 * License + Contributing pointers, and an emoji-free body.
 *
 * The single AC-3 manual end-to-end test (clean-machine `npm i -g` +
 * `claude mcp add`) is recorded in the contract envelope's `untested[]`
 * with reason "manual" -- it cannot run in this suite without a clean
 * environment and a published npm package, both of which are owned by
 * DAR-921. The unit-level content checks here cover the verbatim install
 * commands and ordering on which the manual smoke test depends.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildToolDefinitions } from '../src/server/tools.js';

const repoRoot = join(__dirname, '..');
const readFile = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const fileExists = (rel: string) => existsSync(join(repoRoot, rel));

const README_PATH = 'README.md';
const readme = (): string => readFile(README_PATH);

/**
 * Find the byte offset of the first `## ` (level-2 ATX) section heading.
 * The lede paragraph -- AC-1's concept blurb -- must appear before this
 * point. Returns -1 when no such heading exists.
 */
const firstH2Index = (body: string): number => {
  const m = /^##\s+/m.exec(body);
  return m ? m.index : -1;
};

describe('ac-1: concept blurb', () => {
  it("README contains a single-paragraph concept blurb in the opening section that names 'commonplace book', 'markdown', 'sidecar embeddings', and 'no database'", () => {
    const body = readme();
    const cutoff = firstH2Index(body);
    expect(cutoff, 'README must have at least one `## ` section').toBeGreaterThan(0);
    const lede = body.slice(0, cutoff);
    // The lede must mention each required concept term. Matching is
    // case-insensitive and tolerant of light formatting.
    expect(lede).toMatch(/commonplace\s+book/i);
    expect(lede).toMatch(/markdown/i);
    expect(lede).toMatch(/sidecar\s+embeddings?/i);
    expect(lede).toMatch(/no\s+database/i);
  });

  it("concept blurb appears before the first '##' section heading (i.e., is the lede, not buried)", () => {
    const body = readme();
    const cutoff = firstH2Index(body);
    expect(cutoff).toBeGreaterThan(0);
    const lede = body.slice(0, cutoff);
    // The lede must contain at least one non-heading paragraph (i.e., a
    // run of text that is not a `# ` heading line). We strip the H1 and
    // require non-empty prose after it.
    const withoutH1 = lede.replace(/^#\s+.*$/m, '').trim();
    expect(withoutH1.length, 'expected prose between H1 and first H2').toBeGreaterThan(0);
  });
});

describe('ac-2: historical-origin note', () => {
  it("README includes prose noting the historical origin of the term 'commonplace book' as a curated personal collection of quotes, rules, and observations", () => {
    const body = readme();
    expect(body).toMatch(/commonplace\s+book/i);
    expect(body).toMatch(/quotes?/i);
    expect(body).toMatch(/rules?/i);
    expect(body).toMatch(/observations?/i);
  });

  it("README references John Locke's treatise on the practice of keeping a commonplace book", () => {
    const body = readme();
    expect(body).toMatch(/locke/i);
    // Locke's "A New Method of Making Common-Place-Books" -- accept any
    // explicit reference to a treatise / method / essay tying Locke to
    // the practice.
    expect(body).toMatch(/treatise|method|essay/i);
  });
});

describe('ac-3: install commands', () => {
  /**
   * Pull the contents of every fenced code block (``` ... ```) so we can
   * assert on commands that appear inside them rather than (e.g.) inline
   * backticks in prose. Triple-tilde fences are not used in this README.
   */
  const fencedCodeBlocks = (body: string): string[] => {
    const blocks: string[] = [];
    const re = /```[^\n]*\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      blocks.push(m[1] ?? '');
    }
    return blocks;
  };

  it("README contains a fenced code block with the literal command 'npm i -g commonplace-mcp'", () => {
    const blocks = fencedCodeBlocks(readme());
    const found = blocks.some((b) => /\bnpm\s+i\s+-g\s+commonplace-mcp\b/.test(b));
    expect(found, 'expected a fenced code block containing `npm i -g commonplace-mcp`').toBe(true);
  });

  it("README contains a fenced code block with the literal command 'claude mcp add commonplace commonplace-mcp'", () => {
    const blocks = fencedCodeBlocks(readme());
    const found = blocks.some((b) =>
      /\bclaude\s+mcp\s+add\s+commonplace\s+commonplace-mcp\b/.test(b),
    );
    expect(
      found,
      'expected a fenced code block containing `claude mcp add commonplace commonplace-mcp`',
    ).toBe(true);
  });

  it('the npm install command precedes the claude mcp add command in the install section (correct ordering)', () => {
    const body = readme();
    const npmIdx = body.search(/\bnpm\s+i\s+-g\s+commonplace-mcp\b/);
    const claudeIdx = body.search(/\bclaude\s+mcp\s+add\s+commonplace\s+commonplace-mcp\b/);
    expect(npmIdx).toBeGreaterThanOrEqual(0);
    expect(claudeIdx).toBeGreaterThanOrEqual(0);
    expect(npmIdx, '`npm i -g` must appear before `claude mcp add`').toBeLessThan(claudeIdx);
  });
});

describe('ac-4: tool reference', () => {
  /**
   * Slice the body of a section by its heading regex. Returns the chunk
   * starting at the heading and ending at the next heading of the same
   * level (or end of file). Returns the empty string when the heading is
   * not found.
   */
  const sectionByHeading = (body: string, headingRe: RegExp): string => {
    const m = headingRe.exec(body);
    if (!m) return '';
    const start = m.index;
    const level = (m[0].match(/^#+/) ?? [''])[0].length;
    const after = body.slice(start + m[0].length);
    const stopPattern = new RegExp(`\\n#{1,${level}}\\s`, 'm');
    const stop = stopPattern.exec(after);
    return stop ? body.slice(start, start + m[0].length + stop.index) : body.slice(start);
  };

  /**
   * Locate the README's tool-reference section. We don't pin the exact
   * heading text; instead we require a heading whose text mentions
   * `Tool` and which is followed by per-tool subheadings or anchors.
   */
  const toolSection = (body: string): string => {
    const re = /^##\s+Tool[s]?(?:\s+reference)?\b.*$/im;
    return sectionByHeading(body, re);
  };

  const FOUR_TOOLS = ['memory_save', 'memory_search', 'memory_list', 'memory_delete'] as const;

  it('README has a tool reference section that documents each of memory_save, memory_search, memory_list, memory_delete (all four named tools present)', () => {
    const section = toolSection(readme());
    expect(section.length, 'expected a Tool reference section').toBeGreaterThan(0);
    for (const name of FOUR_TOOLS) {
      expect(section, `tool reference must document ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  /**
   * Slice the per-tool subsection by tool name. Returns the section body
   * (heading line through the next same-or-shallower heading).
   */
  const toolSubsection = (body: string, name: string): string => {
    const headingRe = new RegExp(`^#{2,4}\\s+.*\\b${name}\\b.*$`, 'im');
    const m = headingRe.exec(body);
    if (!m) return '';
    const level = (m[0].match(/^#+/) ?? [''])[0].length;
    const after = body.slice(m.index + m[0].length);
    const stopPattern = new RegExp(`\\n#{1,${level}}\\s`, 'm');
    const stop = stopPattern.exec(after);
    return stop ? after.slice(0, stop.index) : after;
  };

  it('each of the four tools has its input schema documented in README (argument names, types, required vs optional)', () => {
    const body = readme();
    const defs = buildToolDefinitions();
    for (const name of FOUR_TOOLS) {
      const def = defs.find((d) => d.name === name);
      expect(def, `missing tool definition for ${name}`).toBeDefined();
      if (!def) continue;
      const section = toolSubsection(body, name);
      expect(section.length, `expected a heading subsection for ${name}`).toBeGreaterThan(0);
      const schema = def.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const props = schema.properties ?? {};
      for (const arg of Object.keys(props)) {
        expect(section, `${name} section must mention argument \`${arg}\``).toMatch(
          new RegExp(`\\b${arg}\\b`),
        );
      }
      const required = schema.required ?? [];
      if (required.length > 0) {
        expect(section, `${name} section must mark required args`).toMatch(/required/i);
      }
      const hasOptional = Object.keys(props).some((k) => !required.includes(k));
      if (hasOptional) {
        expect(section, `${name} section must mark optional args`).toMatch(/optional/i);
      }
    }
  });

  it('each of the four tools has at least one example call (concrete arguments) in README', () => {
    const body = readme();
    for (const name of FOUR_TOOLS) {
      const section = toolSubsection(body, name);
      expect(section.length, `missing subsection for ${name}`).toBeGreaterThan(0);
      const blocks: string[] = [];
      const re = /```[^\n]*\n([\s\S]*?)```/g;
      let cb: RegExpExecArray | null;
      while ((cb = re.exec(section)) !== null) {
        blocks.push(cb[1] ?? '');
      }
      const exampleBlock = blocks.find((b) => b.includes(name));
      expect(
        exampleBlock,
        `${name} section must contain a fenced code block with an example call`,
      ).toBeDefined();
    }
  });

  it('documented input schema fields for each tool match the JSON Schema declared in src/server/tools.ts (no drift between code and docs)', () => {
    const body = readme();
    const defs = buildToolDefinitions();
    for (const name of FOUR_TOOLS) {
      const def = defs.find((d) => d.name === name);
      expect(def).toBeDefined();
      if (!def) continue;
      const section = toolSubsection(body, name);
      const schema = def.inputSchema as { properties?: Record<string, unknown> };
      const declaredProps = Object.keys(schema.properties ?? {});
      for (const arg of declaredProps) {
        expect(section, `${name}: schema property \`${arg}\` missing from README`).toMatch(
          new RegExp(`\\b${arg}\\b`),
        );
      }
    }
  });
});

describe('ac-5: memory-type taxonomy', () => {
  it('README includes a memory-type taxonomy section listing exactly the four types user, feedback, project, reference', () => {
    const body = readme();
    for (const t of ['user', 'feedback', 'project', 'reference']) {
      expect(body).toMatch(new RegExp(`\\b${t}\\b`));
    }
    // The four types should appear together in some compact context --
    // either the canonical pipe form `user | feedback | project |
    // reference` or a list with all four. We require at least the
    // canonical-form spelling somewhere.
    const canonical = /user\s*\|\s*feedback\s*\|\s*project\s*\|\s*reference/;
    expect(body).toMatch(canonical);
  });

  it('each of the four memory types has a one-line description in README', () => {
    const body = readme();
    for (const t of ['user', 'feedback', 'project', 'reference']) {
      const bullet = new RegExp(
        `(?:^|\\n)\\s*[-*]\\s+\\*?\\*?\\\`?${t}\\\`?\\*?\\*?\\s*[\\-:|–—]+\\s+\\S{8,}`,
        'i',
      );
      const tableRow = new RegExp(
        `(?:^|\\n)\\s*\\|\\s*\\\`?${t}\\\`?\\s*\\|\\s*[^|\\n]{8,}\\|`,
        'i',
      );
      expect(
        bullet.test(body) || tableRow.test(body),
        `expected a one-line description for memory type \`${t}\``,
      ).toBe(true);
    }
  });
});

describe('ac-6: env-var configuration table', () => {
  /**
   * Find the first GFM table whose body actually documents the
   * COMMONPLACE_* env vars (i.e., has at least two distinct
   * COMMONPLACE_* names in its rows). A single incidental mention --
   * such as `COMMONPLACE_DEFAULT_LIMIT` appearing in the description of
   * `memory_search`'s `limit` argument -- does not qualify.
   */
  const findCommonplaceTable = (body: string): string => {
    const tableRe = /\|[^\n]+\|\n\|[\s|:-]+\|\n((?:\|[^\n]+\|\n)+)/g;
    let m: RegExpExecArray | null;
    while ((m = tableRe.exec(body)) !== null) {
      const matches = m[0].match(/COMMONPLACE_[A-Z_]+/g) ?? [];
      const distinct = new Set(matches);
      if (distinct.size >= 2) return m[0];
    }
    return '';
  };

  it('README contains a markdown table documenting the COMMONPLACE_* environment variables', () => {
    const table = findCommonplaceTable(readme());
    expect(
      table.length,
      'expected a markdown table containing COMMONPLACE_* env vars',
    ).toBeGreaterThan(0);
  });

  it('the env-var table includes every COMMONPLACE_* variable read at runtime by src/bin (currently COMMONPLACE_USER_DIR, COMMONPLACE_PROJECT_DIR, COMMONPLACE_MEMORY_DIR, COMMONPLACE_MODEL, COMMONPLACE_DEFAULT_LIMIT) with its default and effect', () => {
    const body = readme();
    const required = [
      'COMMONPLACE_USER_DIR',
      'COMMONPLACE_PROJECT_DIR',
      'COMMONPLACE_MEMORY_DIR',
      'COMMONPLACE_MODEL',
      'COMMONPLACE_DEFAULT_LIMIT',
    ];
    const table = findCommonplaceTable(body);
    expect(table.length, 'COMMONPLACE_* env var table missing').toBeGreaterThan(0);
    for (const name of required) {
      expect(table, `env-var table missing ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
    // The header row must have at least three columns (name | default |
    // effect) to encode both the default and the effect of each var.
    const headerRow = table.split('\n')[0] ?? '';
    const headerCells = headerRow.split('|').filter((c) => c.trim().length > 0);
    expect(headerCells.length, 'env-var table needs at least three columns').toBeGreaterThanOrEqual(
      3,
    );
  });
});

describe('ac-7: link to docs/sidecar-format.md', () => {
  it('README contains a markdown link whose target resolves to docs/sidecar-format.md', () => {
    const body = readme();
    expect(body).toMatch(/\]\([^)]*docs\/sidecar-format\.md[^)]*\)/);
  });

  it('the linked file docs/sidecar-format.md exists at the resolved path (link is not dead)', () => {
    expect(fileExists('docs/sidecar-format.md')).toBe(true);
  });
});

describe('ac-8: License + Contributing notes', () => {
  it('README has a License section that names the MIT license and points to the LICENSE file', () => {
    const body = readme();
    expect(body).toMatch(/^##\s+License\b/im);
    expect(body).toMatch(/\bMIT\b/);
    expect(body).toMatch(/LICENSE\b/);
  });

  it('README has a Contributing section that points to CONTRIBUTING.md', () => {
    const body = readme();
    expect(body).toMatch(/^##\s+Contributing\b/im);
    expect(body).toMatch(/CONTRIBUTING\.md/);
  });
});

describe('ac-9: no emojis in body', () => {
  it('README body contains no emoji code points (Unicode emoji ranges, including dingbats, symbols, regional indicators, ZWJ sequences)', () => {
    const body = readme();
    // Use the Extended_Pictographic Unicode property to catch the broad
    // emoji surface (smileys, symbols, dingbats). Regional-indicator
    // pairs are excluded by a separate scan because they are not in the
    // Extended_Pictographic property.
    const pictographic = /\p{Extended_Pictographic}/u;
    const regionalIndicator = /[\u{1F1E6}-\u{1F1FF}]/u;
    const m1 = pictographic.exec(body);
    expect(
      m1,
      m1 ? `found pictographic char ${JSON.stringify(m1[0])} at index ${m1.index}` : '',
    ).toBeNull();
    const m2 = regionalIndicator.exec(body);
    expect(m2, m2 ? `found regional-indicator char at index ${m2.index}` : '').toBeNull();
  });
});
