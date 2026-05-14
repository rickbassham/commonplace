/**
 * Contract tests for the `relations[]` and `supersedes[]` frontmatter
 * graph fields layered on top of the memory I/O primitives:
 *   - readMemory(path)   -> { ..., relations, supersedes }
 *   - writeMemory(path, memory)   accepts relations / supersedes
 *   - contentSha(memory)          MUST NOT depend on relations / supersedes
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contentSha,
  readMemory,
  writeMemory,
  type Memory,
  type Relation,
} from '../src/store/memory.js';

const __filename = fileURLToPath(import.meta.url);

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar925-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const writeFile = (rel: string, contents: string): string => {
  const p = join(tmp, rel);
  writeFileSync(p, contents, 'utf8');
  return p;
};

// -------------------------------------------------------------------------
// ac-1: parser accepts both fields, defaults to empty arrays when missing
// -------------------------------------------------------------------------

describe('ac-1: parse + defaults', () => {
  it('readMemory returns relations: [] and supersedes: [] when neither field is present in frontmatter', () => {
    const md = `---
name: a
description: d
type: user
---
body
`;
    const m = readMemory(writeFile('a.md', md));
    expect(m.relations).toEqual([]);
    expect(m.supersedes).toEqual([]);
  });

  it('readMemory returns relations: [] when only supersedes is present (and vice versa)', () => {
    const onlySup = `---
name: a
description: d
type: user
supersedes:
  - old_one
---
body
`;
    const m1 = readMemory(writeFile('only-sup.md', onlySup));
    expect(m1.relations).toEqual([]);
    expect(m1.supersedes).toEqual(['old_one']);

    const onlyRel = `---
name: a
description: d
type: user
relations:
  - to: other
    type: related-to
---
body
`;
    const m2 = readMemory(writeFile('only-rel.md', onlyRel));
    expect(m2.supersedes).toEqual([]);
    expect(m2.relations).toEqual([{ to: 'other', type: 'related-to' }]);
  });

  it('readMemory parses a relations array of {to, type} entries into the canonical shape exposed on the returned object', () => {
    const md = `---
name: src
description: d
type: feedback
relations:
  - to: other_one
    type: builds-on
  - to: other_two
    type: contradicts
---
body
`;
    const m = readMemory(writeFile('rel.md', md));
    expect(m.relations).toEqual([
      { to: 'other_one', type: 'builds-on' },
      { to: 'other_two', type: 'contradicts' },
    ]);
  });

  it('readMemory parses a supersedes array of strings into the canonical shape exposed on the returned object', () => {
    const md = `---
name: a
description: d
type: user
supersedes:
  - old_a
  - old_b
---
body
`;
    const m = readMemory(writeFile('sup.md', md));
    expect(m.supersedes).toEqual(['old_a', 'old_b']);
  });

  it('readMemory throws when relations is present but is not a YAML sequence (e.g. mapping, scalar, null)', () => {
    const asScalar = `---
name: a
description: d
type: user
relations: just_a_string
---
body
`;
    const asMapping = `---
name: a
description: d
type: user
relations:
  to: x
  type: related-to
---
body
`;
    const asNull = `---
name: a
description: d
type: user
relations: null
---
body
`;
    expect(() => readMemory(writeFile('rs1.md', asScalar))).toThrow();
    expect(() => readMemory(writeFile('rs2.md', asMapping))).toThrow();
    expect(() => readMemory(writeFile('rs3.md', asNull))).toThrow();
  });

  it('readMemory throws when supersedes is present but is not a YAML sequence of strings (e.g. mapping, sequence containing non-strings)', () => {
    const asMapping = `---
name: a
description: d
type: user
supersedes:
  k: v
---
body
`;
    const seqWithNumber = `---
name: a
description: d
type: user
supersedes:
  - good_one
  - 42
---
body
`;
    const seqWithMapping = `---
name: a
description: d
type: user
supersedes:
  - good_one
  - to: nope
---
body
`;
    expect(() => readMemory(writeFile('ss1.md', asMapping))).toThrow();
    expect(() => readMemory(writeFile('ss2.md', seqWithNumber))).toThrow();
    expect(() => readMemory(writeFile('ss3.md', seqWithMapping))).toThrow();
  });

  it('readMemory throws when a relations entry is missing the required `to` or `type` key, or has them at wrong primitive types', () => {
    const missingTo = `---
name: a
description: d
type: user
relations:
  - type: related-to
---
body
`;
    const missingType = `---
name: a
description: d
type: user
relations:
  - to: other
---
body
`;
    const toWrongType = `---
name: a
description: d
type: user
relations:
  - to: 42
    type: related-to
---
body
`;
    const typeWrongType = `---
name: a
description: d
type: user
relations:
  - to: other
    type: 42
---
body
`;
    expect(() => readMemory(writeFile('me1.md', missingTo))).toThrow();
    expect(() => readMemory(writeFile('me2.md', missingType))).toThrow();
    expect(() => readMemory(writeFile('me3.md', toWrongType))).toThrow();
    expect(() => readMemory(writeFile('me4.md', typeWrongType))).toThrow();
  });
});

// -------------------------------------------------------------------------
// ac-2: relation type validation
// -------------------------------------------------------------------------

describe('ac-2: relation type validation', () => {
  it('readMemory accepts each of the four allowed relation types: related-to, builds-on, contradicts, child-of', () => {
    const md = `---
name: src
description: d
type: feedback
relations:
  - to: a_one
    type: related-to
  - to: a_two
    type: builds-on
  - to: a_three
    type: contradicts
  - to: a_four
    type: child-of
---
body
`;
    const m = readMemory(writeFile('all-types.md', md));
    expect(m.relations).toEqual([
      { to: 'a_one', type: 'related-to' },
      { to: 'a_two', type: 'builds-on' },
      { to: 'a_three', type: 'contradicts' },
      { to: 'a_four', type: 'child-of' },
    ]);
  });

  it("readMemory throws with an error message naming the offending value when a relations entry has type 'mentions' (intentionally absent — auto-extracted by the body tokenizer)", () => {
    const md = `---
name: src
description: d
type: feedback
relations:
  - to: other
    type: mentions
---
body
`;
    const p = writeFile('mentions.md', md);
    expect(() => readMemory(p)).toThrow(/mentions/);
  });

  it("readMemory throws with an error message naming the offending value when a relations entry has an unknown type string (e.g. 'refines', 'depends-on', '')", () => {
    for (const bad of ['refines', 'depends-on', '']) {
      const md = `---
name: src
description: d
type: feedback
relations:
  - to: other
    type: "${bad}"
---
body
`;
      const p = writeFile(`bad-${bad || 'empty'}.md`, md);
      expect(() => readMemory(p)).toThrow(new RegExp(bad === '' ? '""|empty|invalid' : bad));
    }
  });

  it('writeMemory throws when given a relations entry whose type is not one of the four allowed values', () => {
    const p = join(tmp, 'wbad.md');
    expect(() =>
      writeMemory(p, {
        name: 'src',
        description: 'd',
        type: 'feedback',
        body: 'b',
        relations: [{ to: 'other', type: 'refines' as unknown as Relation['type'] }],
        supersedes: [],
      }),
    ).toThrow();
  });
});

// -------------------------------------------------------------------------
// ac-3: target name validation
// -------------------------------------------------------------------------

describe('ac-3: target name validation', () => {
  it('readMemory accepts relation `to` and supersedes entries matching ^[a-z0-9_]+$ (lowercase, digits, underscore)', () => {
    const md = `---
name: src
description: d
type: feedback
relations:
  - to: abc_123
    type: related-to
  - to: a
    type: builds-on
  - to: x9_y_z
    type: child-of
supersedes:
  - old_one
  - x_2
---
body
`;
    const m = readMemory(writeFile('ok.md', md));
    expect(m.relations.map((r) => r.to)).toEqual(['abc_123', 'a', 'x9_y_z']);
    expect(m.supersedes).toEqual(['old_one', 'x_2']);
  });

  it('readMemory throws when a relation `to` contains uppercase letters, hyphens, spaces, dots, or other non-[a-z0-9_] characters', () => {
    for (const bad of ['Other', 'has-hyphen', 'has space', 'has.dot', 'has!bang']) {
      const md = `---
name: src
description: d
type: feedback
relations:
  - to: "${bad}"
    type: related-to
---
body
`;
      expect(() => readMemory(writeFile(`bn-${Math.random()}.md`, md))).toThrow();
    }
  });

  it("readMemory throws when a relation `to` or supersedes entry contains a path separator ('/' or '\\\\')", () => {
    const slashRel = `---
name: src
description: d
type: feedback
relations:
  - to: "subdir/other"
    type: related-to
---
body
`;
    const backslashRel = `---
name: src
description: d
type: feedback
relations:
  - to: "subdir\\\\other"
    type: related-to
---
body
`;
    const slashSup = `---
name: src
description: d
type: feedback
supersedes:
  - "subdir/old"
---
body
`;
    const backslashSup = `---
name: src
description: d
type: feedback
supersedes:
  - "subdir\\\\old"
---
body
`;
    expect(() => readMemory(writeFile('sep1.md', slashRel))).toThrow();
    expect(() => readMemory(writeFile('sep2.md', backslashRel))).toThrow();
    expect(() => readMemory(writeFile('sep3.md', slashSup))).toThrow();
    expect(() => readMemory(writeFile('sep4.md', backslashSup))).toThrow();
  });

  it('readMemory throws when a supersedes entry violates the ^[a-z0-9_]+$ rule', () => {
    for (const bad of ['Old', 'has-hyphen', 'has space', 'has.dot']) {
      const md = `---
name: src
description: d
type: feedback
supersedes:
  - "${bad}"
---
body
`;
      expect(() => readMemory(writeFile(`sb-${Math.random()}.md`, md))).toThrow();
    }
  });

  it('readMemory throws when a relation `to` or supersedes entry is the empty string', () => {
    const emptyRel = `---
name: src
description: d
type: feedback
relations:
  - to: ""
    type: related-to
---
body
`;
    const emptySup = `---
name: src
description: d
type: feedback
supersedes:
  - ""
---
body
`;
    expect(() => readMemory(writeFile('e1.md', emptyRel))).toThrow();
    expect(() => readMemory(writeFile('e2.md', emptySup))).toThrow();
  });
});

// -------------------------------------------------------------------------
// ac-4: self-edges rejected
// -------------------------------------------------------------------------

describe('ac-4: self-edges', () => {
  it("readMemory throws when frontmatter `name` equals a relation's `to` (self-edge in relations)", () => {
    const md = `---
name: self
description: d
type: feedback
relations:
  - to: self
    type: related-to
---
body
`;
    expect(() => readMemory(writeFile('self-rel.md', md))).toThrow();
  });

  it('readMemory throws when frontmatter `name` appears in supersedes[] (self-edge via supersedes)', () => {
    const md = `---
name: self
description: d
type: feedback
supersedes:
  - self
---
body
`;
    expect(() => readMemory(writeFile('self-sup.md', md))).toThrow();
  });

  it('writeMemory throws when given a memory whose name appears in its own relations[].to or supersedes[]', () => {
    const p = join(tmp, 'ws.md');
    expect(() =>
      writeMemory(p, {
        name: 'me',
        description: 'd',
        type: 'feedback',
        body: 'b',
        relations: [{ to: 'me', type: 'related-to' }],
        supersedes: [],
      }),
    ).toThrow();
    expect(() =>
      writeMemory(p, {
        name: 'me',
        description: 'd',
        type: 'feedback',
        body: 'b',
        relations: [],
        supersedes: ['me'],
      }),
    ).toThrow();
  });
});

// -------------------------------------------------------------------------
// ac-5: dedupe
// -------------------------------------------------------------------------

describe('ac-5: dedupe', () => {
  it('readMemory deduplicates relations entries with identical (to, type) pairs, preserving first-occurrence order, without throwing', () => {
    const md = `---
name: src
description: d
type: feedback
relations:
  - to: a
    type: related-to
  - to: b
    type: builds-on
  - to: a
    type: related-to
  - to: c
    type: child-of
  - to: b
    type: builds-on
---
body
`;
    const m = readMemory(writeFile('dd-rel.md', md));
    expect(m.relations).toEqual([
      { to: 'a', type: 'related-to' },
      { to: 'b', type: 'builds-on' },
      { to: 'c', type: 'child-of' },
    ]);
  });

  it('readMemory does NOT deduplicate relations entries that share `to` but differ in `type` (both edges are kept)', () => {
    const md = `---
name: src
description: d
type: feedback
relations:
  - to: a
    type: related-to
  - to: a
    type: builds-on
---
body
`;
    const m = readMemory(writeFile('share-to.md', md));
    expect(m.relations).toEqual([
      { to: 'a', type: 'related-to' },
      { to: 'a', type: 'builds-on' },
    ]);
  });

  it('readMemory deduplicates supersedes entries with identical names, preserving first-occurrence order, without throwing', () => {
    const md = `---
name: src
description: d
type: feedback
supersedes:
  - a
  - b
  - a
  - c
  - b
---
body
`;
    const m = readMemory(writeFile('dd-sup.md', md));
    expect(m.supersedes).toEqual(['a', 'b', 'c']);
  });

  it('writeMemory then readMemory of a memory whose authored input contained duplicate relations or supersedes entries round-trips to the deduplicated set', () => {
    const p = join(tmp, 'dd-rt.md');
    writeMemory(p, {
      name: 'src',
      description: 'd',
      type: 'feedback',
      body: 'b\n',
      relations: [
        { to: 'a', type: 'related-to' },
        { to: 'b', type: 'builds-on' },
        { to: 'a', type: 'related-to' },
      ],
      supersedes: ['old_a', 'old_b', 'old_a'],
    });
    const m = readMemory(p);
    expect(m.relations).toEqual([
      { to: 'a', type: 'related-to' },
      { to: 'b', type: 'builds-on' },
    ]);
    expect(m.supersedes).toEqual(['old_a', 'old_b']);
  });
});

// -------------------------------------------------------------------------
// ac-6: contentSha invariant
// -------------------------------------------------------------------------

describe('ac-6: contentSha excludes graph metadata', () => {
  it('contentSha is identical for two memories whose canonical (type, name, description, body) are equal but whose relations[] differ (added, removed, reordered, retyped edges)', () => {
    const base: Memory = {
      name: 'a',
      description: 'd',
      type: 'feedback',
      body: 'body\n',
      relations: [],
      supersedes: [],
    };
    const sha = contentSha(base);
    expect(
      contentSha({
        ...base,
        relations: [{ to: 'x', type: 'related-to' }],
      }),
    ).toBe(sha);
    expect(
      contentSha({
        ...base,
        relations: [
          { to: 'x', type: 'related-to' },
          { to: 'y', type: 'builds-on' },
        ],
      }),
    ).toBe(sha);
    expect(
      contentSha({
        ...base,
        relations: [
          { to: 'y', type: 'builds-on' },
          { to: 'x', type: 'related-to' },
        ],
      }),
    ).toBe(sha);
    expect(
      contentSha({
        ...base,
        relations: [{ to: 'x', type: 'contradicts' }],
      }),
    ).toBe(sha);
  });

  it('contentSha is identical for two memories whose canonical (type, name, description, body) are equal but whose supersedes[] differ', () => {
    const base: Memory = {
      name: 'a',
      description: 'd',
      type: 'feedback',
      body: 'body\n',
      relations: [],
      supersedes: [],
    };
    const sha = contentSha(base);
    expect(contentSha({ ...base, supersedes: ['old'] })).toBe(sha);
    expect(contentSha({ ...base, supersedes: ['old', 'older'] })).toBe(sha);
    expect(contentSha({ ...base, supersedes: ['older', 'old'] })).toBe(sha);
  });

  it('writeMemory followed by readMemory preserves the original contentSha when only relations or supersedes were edited between writes', () => {
    const p = join(tmp, 'sha-stable.md');
    const m: Memory = {
      name: 'a',
      description: 'd',
      type: 'feedback',
      body: 'body content\n',
      relations: [{ to: 'first', type: 'related-to' }],
      supersedes: ['old_one'],
    };
    writeMemory(p, m);
    const before = contentSha(readMemory(p));

    writeMemory(p, {
      ...m,
      relations: [
        { to: 'first', type: 'related-to' },
        { to: 'second', type: 'builds-on' },
      ],
      supersedes: ['old_one', 'older_two'],
    });
    const afterAdd = contentSha(readMemory(p));
    expect(afterAdd).toBe(before);

    writeMemory(p, {
      ...m,
      relations: [],
      supersedes: [],
    });
    const afterRemove = contentSha(readMemory(p));
    expect(afterRemove).toBe(before);
  });
});

// -------------------------------------------------------------------------
// ac-7: round-trip + idempotency + meta-coverage
// -------------------------------------------------------------------------

describe('ac-7: round-trip and idempotency', () => {
  it('writeMemory then readMemory round-trips a memory whose relations[] contains entries of all four relation types, preserving (to, type) pairs and order modulo dedupe', () => {
    const p = join(tmp, 'rt-rel.md');
    const m: Memory = {
      name: 'src',
      description: 'd',
      type: 'feedback',
      body: 'body\n',
      relations: [
        { to: 'a_one', type: 'related-to' },
        { to: 'a_two', type: 'builds-on' },
        { to: 'a_three', type: 'contradicts' },
        { to: 'a_four', type: 'child-of' },
      ],
      supersedes: [],
    };
    writeMemory(p, m);
    const back = readMemory(p);
    expect(back.relations).toEqual(m.relations);
  });

  it('writeMemory then readMemory round-trips a memory whose supersedes[] contains multiple distinct names, preserving order modulo dedupe', () => {
    const p = join(tmp, 'rt-sup.md');
    const m: Memory = {
      name: 'src',
      description: 'd',
      type: 'feedback',
      body: 'body\n',
      relations: [],
      supersedes: ['old_a', 'old_b', 'old_c'],
    };
    writeMemory(p, m);
    const back = readMemory(p);
    expect(back.supersedes).toEqual(m.supersedes);
  });

  it('writeMemory is byte-idempotent for memories with non-empty relations[] and supersedes[]: writeMemory(p, readMemory(p)) leaves bytes unchanged on an already-canonical file', () => {
    const p = join(tmp, 'idem.md');
    const m: Memory = {
      name: 'src',
      description: 'd',
      type: 'feedback',
      body: 'body\nline two\n',
      relations: [
        { to: 'a_one', type: 'related-to' },
        { to: 'a_two', type: 'builds-on' },
      ],
      supersedes: ['old_one'],
    };
    writeMemory(p, m);
    const before = readFileSync(p, 'utf8');

    const round = readMemory(p);
    writeMemory(p, {
      name: round.name,
      description: round.description,
      type: round.type,
      body: round.body,
      relations: round.relations,
      supersedes: round.supersedes,
    });
    const after = readFileSync(p, 'utf8');
    expect(after).toBe(before);
  });

  it('test suite contains a meta-coverage check that every named scenario from the AC (round-trip relations, round-trip supersedes, contentSha-stable-on-relations-change, all 4 types accepted, invalid type rejected, self-edge rejected, duplicates deduped) maps to at least one test in this file', () => {
    const self = readFileSync(__filename, 'utf8');
    const required = [
      // round-trip with relations (ac-7)
      'round-trips a memory whose relations[] contains entries of all four relation types',
      // round-trip with supersedes (ac-7)
      'round-trips a memory whose supersedes[] contains multiple distinct names',
      // contentSha stable when only relations change (ac-6)
      'contentSha is identical for two memories whose canonical (type, name, description, body) are equal but whose relations[] differ',
      // all 4 relation types accepted (ac-2)
      'readMemory accepts each of the four allowed relation types: related-to, builds-on, contradicts, child-of',
      // invalid type rejected (ac-2)
      'readMemory throws with an error message naming the offending value when a relations entry has an unknown type string',
      // self-edge rejected (ac-4)
      "readMemory throws when frontmatter `name` equals a relation's `to`",
      // duplicates deduped (ac-5)
      'readMemory deduplicates relations entries with identical (to, type) pairs',
    ];
    for (const needle of required) {
      expect(self, `missing scenario: ${needle}`).toContain(needle);
    }
  });
});
