/**
 * Tests for ac-1: memory frontmatter `pinned: boolean` field.
 *
 * The `pinned` field is optional, defaults to `false` when absent, and
 * round-trips through `readMemory` / `writeMemory`. The flag is excluded
 * from `contentSha` so toggling it does not invalidate sidecars.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { contentSha, readMemory, writeMemory, type Memory } from '../src/store/memory.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar1003-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const writeFile = (rel: string, contents: string): string => {
  const p = join(tmp, rel);
  writeFileSync(p, contents, 'utf8');
  return p;
};

describe('ac-1: readMemory parses pinned from frontmatter', () => {
  it('readMemory parses `pinned: true` from frontmatter and exposes it as `true` on the ReadMemory record', () => {
    const md = `---
name: pin_true
description: a pinned memory
type: feedback
pinned: true
---
body
`;
    const p = writeFile('pt.md', md);
    const m = readMemory(p);
    expect(m.pinned).toBe(true);
  });

  it('readMemory parses `pinned: false` from frontmatter and exposes it as `false` on the ReadMemory record', () => {
    const md = `---
name: pin_false
description: an explicitly-unpinned memory
type: feedback
pinned: false
---
body
`;
    const p = writeFile('pf.md', md);
    const m = readMemory(p);
    expect(m.pinned).toBe(false);
  });

  it('readMemory defaults the `pinned` field to `false` when the key is absent from frontmatter', () => {
    const md = `---
name: pin_absent
description: pre-existing file with no pinned key
type: feedback
---
body
`;
    const p = writeFile('pa.md', md);
    const m = readMemory(p);
    expect(m.pinned).toBe(false);
  });

  it('readMemory rejects a non-boolean `pinned` value (e.g. string `"true"`, number `1`) with an error naming the field', () => {
    const cases = [
      `---\nname: bad1\ndescription: d\ntype: user\npinned: "true"\n---\nb\n`,
      `---\nname: bad2\ndescription: d\ntype: user\npinned: 1\n---\nb\n`,
      `---\nname: bad3\ndescription: d\ntype: user\npinned: yes\n---\nb\n`,
    ];
    for (let i = 0; i < cases.length; i++) {
      const p = writeFile(`b${i}.md`, cases[i]!);
      let msg = '';
      try {
        readMemory(p);
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      expect(msg).toContain('pinned');
    }
  });
});

describe('ac-1: writeMemory round-trips and omits pinned when false', () => {
  it('writeMemory then readMemory round-trips `pinned: true` byte-for-byte (canonical-form idempotence preserved)', () => {
    const p = join(tmp, 'rt.md');
    const m: Memory = {
      name: 'rt',
      description: 'd',
      type: 'feedback',
      body: 'b\n',
      pinned: true,
    };
    writeMemory(p, m);
    const back = readMemory(p);
    expect(back.pinned).toBe(true);

    const before = readFileSync(p, 'utf8');
    writeMemory(p, {
      name: back.name,
      description: back.description,
      type: back.type,
      body: back.body,
      relations: back.relations,
      supersedes: back.supersedes,
      pinned: back.pinned,
    });
    const after = readFileSync(p, 'utf8');
    expect(after).toBe(before);
  });

  it('writeMemory omits the `pinned` key entirely when the in-memory value is `false`, keeping pre-existing files byte-identical', () => {
    const p1 = join(tmp, 'no-pinned.md');
    writeMemory(p1, {
      name: 'np',
      description: 'd',
      type: 'user',
      body: 'b\n',
    });
    const noPinnedBytes = readFileSync(p1, 'utf8');

    const p2 = join(tmp, 'with-false.md');
    writeMemory(p2, {
      name: 'np',
      description: 'd',
      type: 'user',
      body: 'b\n',
      pinned: false,
    });
    const withFalseBytes = readFileSync(p2, 'utf8');

    expect(withFalseBytes).toBe(noPinnedBytes);
    expect(withFalseBytes).not.toContain('pinned');
  });
});

describe('ac-1: contentSha is unchanged by pinned', () => {
  it('contentSha is unchanged by toggling `pinned` (the flag does not invalidate embedding sidecars)', () => {
    const base: Memory = {
      name: 'b',
      description: 'd',
      type: 'user',
      body: 'body\n',
    };
    const shaUnset = contentSha(base);
    const shaTrue = contentSha({ ...base, pinned: true });
    const shaFalse = contentSha({ ...base, pinned: false });
    expect(shaTrue).toBe(shaUnset);
    expect(shaFalse).toBe(shaUnset);
  });
});
