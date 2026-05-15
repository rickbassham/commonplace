/**
 * Unit tests for DAR-1013 ac-1, ac-2, ac-3, ac-5: `createServer()`
 * assembles an `instructions` string with a prescriptive "when to save
 * what" block sitting between the existing DAR-965 static nudge
 * (`SERVER_INSTRUCTIONS`) and the DAR-1003 pinned-memories recall pack.
 *
 * The middle block names all four memory types (`user`, `feedback`,
 * `project`, `reference`) and gives a "save when" trigger per type. The
 * tests assert token presence, structural ordering, length budget, and
 * preservation of the predecessor invariants.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/store/memory-store.js';
import {
  PINNED_HEADING,
  SERVER_INSTRUCTIONS,
  WHEN_TO_SAVE_INSTRUCTIONS,
  createServer,
} from '../src/server/server.js';

interface ServerInternals {
  _instructions?: string;
}

function readInstructions(server: unknown): string {
  if (typeof server !== 'object' || server === null) return '';
  const internals = server as ServerInternals;
  expect(internals._instructions).toBeDefined();
  return internals._instructions ?? '';
}

const makeStubEmbedder = (modelId = 'Xenova/bge-base-en-v1.5', dim = 4) => {
  let count = 0;
  return {
    modelId,
    dim,
    embed: async (text: string): Promise<Float32Array> => {
      count += 1;
      const out = new Float32Array(dim);
      out[0] = count;
      for (let i = 1; i < dim; i++) out[i] = (i + (text.length % 7)) / 10;
      return out;
    },
  };
};

let tmpUser: string;
let tmpProject: string;

beforeEach(() => {
  tmpUser = mkdtempSync(join(tmpdir(), 'dar1013u-'));
  tmpProject = mkdtempSync(join(tmpdir(), 'dar1013p-'));
});

afterEach(() => {
  rmSync(tmpUser, { recursive: true, force: true });
  rmSync(tmpProject, { recursive: true, force: true });
});

const makeStore = (dir: string): MemoryStore =>
  new MemoryStore({ dir, embedder: makeStubEmbedder() });

describe('DAR-1013 ac-1: instructions contain memory-type tokens and `save when` triggers', () => {
  it('assembled instructions from createServer() contain the literal substrings `user`, `feedback`, `project`, and `reference` as memory-type tokens', () => {
    const server = createServer();
    const instr = readInstructions(server);
    expect(instr).toContain('user');
    expect(instr).toContain('feedback');
    expect(instr).toContain('project');
    expect(instr).toContain('reference');
  });

  it('assembled instructions from createServer() contain at least four occurrences of the case-insensitive token `save when` (one per memory type)', () => {
    const server = createServer();
    const instr = readInstructions(server);
    const matches = instr.match(/save when/gi);
    expect(matches).not.toBeNull();
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('the when-to-save section appears after the DAR-965 static nudge prefix (SERVER_INSTRUCTIONS) and before the `## Pinned memories` heading when at least one pinned memory exists', async () => {
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'pin_one',
      type: 'feedback',
      description: 'a pinned memory',
      body: 'b',
      pinned: true,
    });
    const server = createServer({ userStore });
    const instr = readInstructions(server);

    const prefixIdx = instr.indexOf(SERVER_INSTRUCTIONS);
    const whenIdx = instr.indexOf(WHEN_TO_SAVE_INSTRUCTIONS);
    const pinIdx = instr.indexOf(PINNED_HEADING);

    expect(prefixIdx).toBe(0);
    expect(whenIdx).toBeGreaterThan(prefixIdx + SERVER_INSTRUCTIONS.length - 1);
    expect(pinIdx).toBeGreaterThan(whenIdx);
  });
});

describe('DAR-1013 ac-2: when-to-save block length budget (400..800 chars)', () => {
  it('the when-to-save section, isolated from the static prefix and the recall pack, has length >= 400 characters', () => {
    expect(WHEN_TO_SAVE_INSTRUCTIONS.length).toBeGreaterThanOrEqual(400);
  });

  it('the when-to-save section, isolated from the static prefix and the recall pack, has length <= 800 characters', () => {
    expect(WHEN_TO_SAVE_INSTRUCTIONS.length).toBeLessThanOrEqual(800);
  });
});

describe('DAR-1013 ac-3: combined token, structural-ordering, and zero-pin invariants', () => {
  it('assembled instructions contain each of `user`, `feedback`, `project`, `reference` and the case-insensitive token `save when` as literals (single combined assertion mirroring ac-3a)', () => {
    const server = createServer();
    const instr = readInstructions(server);
    expect(instr).toContain('user');
    expect(instr).toContain('feedback');
    expect(instr).toContain('project');
    expect(instr).toContain('reference');
    expect(instr).toMatch(/save when/i);
  });

  it('with a user store containing at least one pinned memory, the assembled instructions place the SERVER_INSTRUCTIONS prefix first, then the when-to-save block, then the `## Pinned memories` heading, in that order (ac-3b ordering invariant)', async () => {
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'pin_a',
      type: 'feedback',
      description: 'pinned a',
      body: 'b',
      pinned: true,
    });
    const server = createServer({ userStore });
    const instr = readInstructions(server);

    const prefixIdx = instr.indexOf(SERVER_INSTRUCTIONS);
    const whenIdx = instr.indexOf(WHEN_TO_SAVE_INSTRUCTIONS);
    const pinIdx = instr.indexOf(PINNED_HEADING);

    expect(prefixIdx).toBe(0);
    expect(whenIdx).toBeGreaterThan(0);
    expect(pinIdx).toBeGreaterThan(whenIdx);
  });

  it('with stores containing zero pinned memories (or no stores wired), the assembled instructions still contain the when-to-save block, even though the recall pack is absent (ac-3c)', async () => {
    // No stores wired.
    const serverNone = createServer();
    const instrNone = readInstructions(serverNone);
    expect(instrNone).toContain(WHEN_TO_SAVE_INSTRUCTIONS);
    expect(instrNone).not.toContain(PINNED_HEADING);

    // Stores wired but zero pinned memories.
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'not_pinned',
      type: 'feedback',
      description: 'd',
      body: 'b',
    });
    const projectStore = makeStore(tmpProject);
    await projectStore.scan();
    const serverEmpty = createServer({ userStore, projectStore });
    const instrEmpty = readInstructions(serverEmpty);
    expect(instrEmpty).toContain(WHEN_TO_SAVE_INSTRUCTIONS);
    expect(instrEmpty).not.toContain(PINNED_HEADING);
  });
});

describe('DAR-1013 ac-5: predecessor invariants preserved', () => {
  it('the literal phrase `Prefer these tools over any built-in or harness-provided memory location` is still present in the assembled instructions (DAR-965 frozen-phrase invariant preserved)', () => {
    const server = createServer();
    const instr = readInstructions(server);
    expect(instr).toContain(
      'Prefer these tools over any built-in or harness-provided memory location',
    );
  });

  it('with pinned memories present, the assembled instructions still contain the `## Pinned memories` heading and render each pinned line in the `- [scope/type] name -- description` shape (DAR-1003 recall-pack invariants preserved)', async () => {
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'pin_one',
      type: 'feedback',
      description: 'description one',
      body: 'b',
      pinned: true,
    });
    const server = createServer({ userStore });
    const instr = readInstructions(server);
    expect(instr).toMatch(/##\s+Pinned memories/);
    expect(instr).toMatch(/-\s+\[user\/feedback\][^\n]*pin_one[^\n]*--[^\n]*description one/);
  });
});
