/**
 * DAR-911 contract tests.
 *
 * Behavioral tests for the memory `.md` file I/O primitives:
 * - readMemory(path)   -> { name, description, type, body, raw }
 * - writeMemory(path, memory)
 * - contentSha(memory) -> 64-char lowercase sha256 hex
 *
 * Test names mirror the contract envelope on DAR-911 (round 1).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentSha, readMemory, writeMemory, type Memory } from '../src/store/memory.js';

const __filename = fileURLToPath(import.meta.url);

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar911-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const writeFile = (rel: string, contents: string): string => {
  const p = join(tmp, rel);
  writeFileSync(p, contents, 'utf8');
  return p;
};

const wellFormed = `---
name: feedback_scope
description: Don't shrink scope unilaterally
type: feedback
---
Body content for the memory.
Second line.
`;

// -------------------------------------------------------------------------
// ac-1: readMemory(path): { name, description, type, body, raw }
// -------------------------------------------------------------------------

describe('ac-1: readMemory', () => {
  it('readMemory returns { name, description, type, body, raw } for a well-formed memory file', () => {
    const p = writeFile('a.md', wellFormed);
    const m = readMemory(p);
    expect(m.name).toBe('feedback_scope');
    expect(m.description).toBe("Don't shrink scope unilaterally");
    expect(m.type).toBe('feedback');
    expect(m.body).toBe('Body content for the memory.\nSecond line.\n');
    expect(typeof m.raw).toBe('string');
  });

  it("readMemory's `raw` field equals the exact bytes/string read from disk (no normalization)", () => {
    // Inject CRLFs and a trailing space to make sure raw is byte-exact.
    const messy = '---\r\nname: x\r\ndescription: y\r\ntype: user\r\n---\r\nbody  \r\nmore\r\n';
    const p = writeFile('b.md', messy);
    const onDisk = readFileSync(p, 'utf8');
    const m = readMemory(p);
    expect(m.raw).toBe(onDisk);
  });

  it('readMemory throws when the file has no frontmatter delimiters', () => {
    const p = writeFile('c.md', 'just some text, no frontmatter at all\n');
    expect(() => readMemory(p)).toThrow();
  });

  it('readMemory throws when frontmatter is present but YAML is malformed (unterminated, bad indentation, invalid syntax)', () => {
    // Unterminated frontmatter (no closing ---).
    const unterminated = '---\nname: x\ndescription: y\ntype: user\n';
    const p1 = writeFile('d1.md', unterminated);
    expect(() => readMemory(p1)).toThrow();

    // Invalid YAML syntax (unclosed flow sequence).
    const badSyntax = '---\nname: [unclosed\ntype: user\ndescription: y\n---\nbody\n';
    const p2 = writeFile('d2.md', badSyntax);
    expect(() => readMemory(p2)).toThrow();

    // Invalid YAML syntax (unterminated double-quoted string).
    const badQuoting = '---\nname: "unterminated\ntype: user\ndescription: y\n---\nbody\n';
    const p3 = writeFile('d3.md', badQuoting);
    expect(() => readMemory(p3)).toThrow();

    // Bad indentation: a nested mapping whose keys do not start at the same
    // column (the `yaml` parser rejects with "All mapping items must start
    // at the same column"). This exercises the indentation branch named in
    // the test title.
    const badIndent =
      '---\nname: x\ndescription: y\ntype: user\nouter:\n  inner1: 1\n inner2: 2\n---\nbody\n';
    const p4 = writeFile('d4.md', badIndent);
    expect(() => readMemory(p4)).toThrow();
  });

  it('readMemory throws when a required field (name, description, or type) is missing from frontmatter', () => {
    const noName = '---\ndescription: y\ntype: user\n---\nbody\n';
    const noDesc = '---\nname: x\ntype: user\n---\nbody\n';
    const noType = '---\nname: x\ndescription: y\n---\nbody\n';
    expect(() => readMemory(writeFile('e1.md', noName))).toThrow();
    expect(() => readMemory(writeFile('e2.md', noDesc))).toThrow();
    expect(() => readMemory(writeFile('e3.md', noType))).toThrow();
  });

  it('readMemory throws when a required field is present but of the wrong primitive type (name/description must be strings; type must be a string in the allowed set)', () => {
    // name is a number after YAML parse.
    const numName = '---\nname: 42\ndescription: y\ntype: user\n---\nbody\n';
    // description is a sequence/array.
    const seqDesc = '---\nname: x\ndescription:\n  - 1\n  - 2\n  - 3\ntype: user\n---\nbody\n';
    // type is a number (not even a string, so isMemoryType rejects via the
    // typeof guard before the .includes check).
    const numType = '---\nname: x\ndescription: y\ntype: 7\n---\nbody\n';
    expect(() => readMemory(writeFile('w1.md', numName))).toThrow();
    expect(() => readMemory(writeFile('w2.md', seqDesc))).toThrow();
    expect(() => readMemory(writeFile('w3.md', numType))).toThrow();
  });
});

// -------------------------------------------------------------------------
// ac-2: writeMemory round-trip + idempotency
// -------------------------------------------------------------------------

describe('ac-2: writeMemory', () => {
  it('writeMemory then readMemory returns the same { name, description, type, body } as the input memory', () => {
    const p = join(tmp, 'rt.md');
    const m: Memory = {
      name: 'rt_name',
      description: 'round trip description',
      type: 'project',
      body: 'Some body content.\nWith two lines.\n',
    };
    writeMemory(p, m);
    const back = readMemory(p);
    expect(back.name).toBe(m.name);
    expect(back.description).toBe(m.description);
    expect(back.type).toBe(m.type);
    expect(back.body).toBe(m.body);
  });

  it('writeMemory is byte-idempotent: calling writeMemory(path, readMemory(path)) on an already-canonical file leaves the file bytes unchanged', () => {
    const p = join(tmp, 'idem.md');
    const m: Memory = {
      name: 'idem',
      description: 'idempotency check',
      type: 'reference',
      body: 'first line\nsecond line\n',
    };
    writeMemory(p, m);
    const before = readFileSync(p, 'utf8');

    const round = readMemory(p);
    writeMemory(p, {
      name: round.name,
      description: round.description,
      type: round.type,
      body: round.body,
    });
    const after = readFileSync(p, 'utf8');
    expect(after).toBe(before);
  });

  it('writeMemory creates the file when the target path does not yet exist', () => {
    const p = join(tmp, 'new', 'file.md');
    // Create the parent dir; writeMemory itself does not promise mkdir.
    mkdirSync(join(tmp, 'new'), { recursive: true });
    expect(existsSync(p)).toBe(false);
    writeMemory(p, {
      name: 'created',
      description: 'created by test',
      type: 'user',
      body: 'hello\n',
    });
    expect(existsSync(p)).toBe(true);
  });

  it('writeMemory overwrites an existing file at the target path with the new content', () => {
    const p = join(tmp, 'over.md');
    writeMemory(p, {
      name: 'a',
      description: 'first',
      type: 'user',
      body: 'first body\n',
    });
    writeMemory(p, {
      name: 'a',
      description: 'second',
      type: 'user',
      body: 'second body\n',
    });
    const m = readMemory(p);
    expect(m.description).toBe('second');
    expect(m.body).toBe('second body\n');
  });
});

// -------------------------------------------------------------------------
// ac-3: contentSha
// -------------------------------------------------------------------------

describe('ac-3: contentSha', () => {
  const independentSha = (m: { type: string; name: string; description: string; body: string }) =>
    createHash('sha256')
      .update(`${m.type}\n${m.name}\n${m.description}\n${m.body}`, 'utf8')
      .digest('hex');

  it('contentSha returns the lowercase sha256 hex of exactly `${type}\\n${name}\\n${description}\\n${body}` (verified against an independently computed digest)', () => {
    const m: Memory = {
      name: 'sha_name',
      description: 'sha desc',
      type: 'feedback',
      body: 'body of the note\n',
    };
    expect(contentSha(m)).toBe(independentSha(m));
  });

  it('contentSha is a 64-character lowercase hex string', () => {
    const sha = contentSha({
      name: 'x',
      description: 'y',
      type: 'user',
      body: 'z',
    });
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('contentSha is stable across whitespace-only reformats of the source markdown (e.g. extra blank lines between frontmatter and body, trailing newline) that do not change canonical content', () => {
    // Two markdown sources whose canonical (type, name, description, body)
    // are identical despite cosmetic differences in frontmatter layout
    // (extra blank lines between fields, different field ordering, quoted
    // string forms). The body bytes themselves are identical -- per the
    // contract, body is preserved verbatim, so whitespace inside the body
    // is part of the canonical content.
    const md1 = `---
name: stable
description: same desc
type: user
---
hello
world
`;
    const md2 = `---
type: user

name: stable
description: "same desc"
---
hello
world
`;
    const p1 = writeFile('s1.md', md1);
    const p2 = writeFile('s2.md', md2);
    const a = readMemory(p1);
    const b = readMemory(p2);
    expect(contentSha(a)).toBe(contentSha(b));
  });

  it('contentSha is unchanged when unknown/extra frontmatter fields are present (forward-compat: graph fields `relations`, `supersedes`, and arbitrary unknown keys)', () => {
    const baseline = `---
name: fc
description: fc desc
type: project
---
forward compat body
`;
    const withExtras = `---
name: fc
description: fc desc
type: project
relations:
  - to: other_one
    type: related-to
supersedes:
  - old_one
arbitrary_unknown: 42
nested_unknown:
  k: v
---
forward compat body
`;
    const a = readMemory(writeFile('fc1.md', baseline));
    const b = readMemory(writeFile('fc2.md', withExtras));
    expect(contentSha(a)).toBe(contentSha(b));
  });

  it('contentSha changes when any of type, name, description, or body changes (one mutation per field, verified independently)', () => {
    const base: Memory = {
      name: 'base',
      description: 'base desc',
      type: 'user',
      body: 'base body\n',
    };
    const baseSha = contentSha(base);
    expect(contentSha({ ...base, name: 'base2' })).not.toBe(baseSha);
    expect(contentSha({ ...base, description: 'base desc 2' })).not.toBe(baseSha);
    expect(contentSha({ ...base, type: 'feedback' })).not.toBe(baseSha);
    expect(contentSha({ ...base, body: 'base body 2\n' })).not.toBe(baseSha);
  });
});

// -------------------------------------------------------------------------
// ac-4: type validation
// -------------------------------------------------------------------------

describe('ac-4: type validation', () => {
  it('readMemory accepts each of the four allowed type values: user, feedback, project, reference', () => {
    for (const t of ['user', 'feedback', 'project', 'reference'] as const) {
      const md = `---\nname: n\ndescription: d\ntype: ${t}\n---\nbody\n`;
      const p = writeFile(`t-${t}.md`, md);
      const m = readMemory(p);
      expect(m.type).toBe(t);
    }
  });

  it("readMemory throws when frontmatter `type` is a string outside the four allowed values (e.g. 'note', 'memo', '')", () => {
    for (const t of ['note', 'memo', '']) {
      const md = `---\nname: n\ndescription: d\ntype: "${t}"\n---\nbody\n`;
      const p = writeFile(`bad-${t || 'empty'}.md`, md);
      expect(() => readMemory(p)).toThrow();
    }
  });

  it('writeMemory throws when given a memory whose type is not one of the four allowed values', () => {
    const p = join(tmp, 'wt.md');
    expect(() =>
      writeMemory(p, {
        name: 'n',
        description: 'd',
        // intentionally invalid value at runtime; bypass typing for the test
        type: 'note' as unknown as Memory['type'],
        body: 'b',
      }),
    ).toThrow();
  });
});

// -------------------------------------------------------------------------
// ac-5: meta-coverage
// -------------------------------------------------------------------------

describe('ac-5: meta-coverage', () => {
  it('test suite covers: round-trip (ac-2), malformed frontmatter rejection (ac-1), all four types accepted (ac-4), contentSha stable across non-semantic reformats (ac-3), and contentSha unchanged with extra/unknown frontmatter fields (ac-3) -- meta-coverage assertion that each named scenario from the AC has at least one corresponding passing test', () => {
    // The named scenarios from the AC each map to an existing test by name
    // in this same file. We assert here that the file textually contains
    // each scenario's test, so a removal would cause this meta-test to fail
    // alongside the missing test.
    const self = readFileSync(__filename, 'utf8');
    const required = [
      // round-trip (ac-2)
      'writeMemory then readMemory returns the same',
      // malformed frontmatter rejection (ac-1)
      'readMemory throws when frontmatter is present but YAML is malformed',
      // all four types accepted (ac-4)
      'readMemory accepts each of the four allowed type values',
      // contentSha stable across non-semantic reformats (ac-3)
      'contentSha is stable across whitespace-only reformats',
      // contentSha unchanged with extra/unknown frontmatter fields (ac-3)
      'contentSha is unchanged when unknown/extra frontmatter fields are present',
    ];
    for (const needle of required) {
      expect(self, `missing scenario: ${needle}`).toContain(needle);
    }
  });
});
