/**
 * Tests for ac-4..ac-7: createServer renders a pinned-memories recall pack
 * into the MCP `instructions` string at startup.
 *
 * Construction: createServer accepts user/project stores; iterates each
 * store's loaded entries; emits one line per non-superseded pinned memory.
 * When no memories are pinned across any accessible store, the recall
 * pack is omitted entirely (instructions are byte-equal to the
 * SERVER_INSTRUCTIONS prefix).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/store/memory-store.js';
import { SERVER_INSTRUCTIONS, createServer } from '../src/server/server.js';

interface ServerInternals {
  _instructions?: string;
}

function readInstructions(server: unknown): string {
  if (typeof server !== 'object' || server === null) return '';
  const internals = server as ServerInternals;
  return internals._instructions ?? '';
}

let tmpUser: string;
let tmpProject: string;

beforeEach(() => {
  tmpUser = mkdtempSync(join(tmpdir(), 'dar1003u-'));
  tmpProject = mkdtempSync(join(tmpdir(), 'dar1003p-'));
});

afterEach(() => {
  rmSync(tmpUser, { recursive: true, force: true });
  rmSync(tmpProject, { recursive: true, force: true });
});

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

const makeStore = (dir: string): MemoryStore =>
  new MemoryStore({ dir, embedder: makeStubEmbedder() });

describe('ac-4: createServer renders recall pack into instructions', () => {
  it('createServer instructions string begins with the existing SERVER_INSTRUCTIONS prefix verbatim', async () => {
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'pin_one',
      type: 'feedback',
      description: 'first pinned memory',
      body: 'body one',
      pinned: true,
    });
    const server = createServer({ userStore });
    const instr = readInstructions(server);
    expect(instr.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
  });

  it('createServer appends a fixed heading (e.g. `## Pinned memories`) before the recall pack when at least one pinned memory exists', async () => {
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'pin_a',
      type: 'feedback',
      description: 'a',
      body: 'b',
      pinned: true,
    });
    const server = createServer({ userStore });
    const instr = readInstructions(server);
    expect(instr).toMatch(/##\s+Pinned memories/);
  });

  it('createServer renders each pinned memory on its own line with `- `, `[scope/type]`, name, `--`, and description substrings in that order', async () => {
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
    // Match the substring shape: `- ` then `[user/feedback]` then `pin_one`
    // then `--` then `description one` somewhere on the same line.
    expect(instr).toMatch(/-\s+\[user\/feedback\][^\n]*pin_one[^\n]*--[^\n]*description one/);
  });

  it('createServer includes both user-scope and project-scope pinned memories when both stores are wired', async () => {
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'user_pin',
      type: 'feedback',
      description: 'user description',
      body: 'b',
      pinned: true,
    });
    const projectStore = makeStore(tmpProject);
    await projectStore.scan();
    await projectStore.save({
      name: 'project_pin',
      type: 'project',
      description: 'project description',
      body: 'b',
      pinned: true,
    });
    const server = createServer({ userStore, projectStore });
    const instr = readInstructions(server);
    expect(instr).toContain('user_pin');
    expect(instr).toContain('user description');
    expect(instr).toContain('project_pin');
    expect(instr).toContain('project description');
    expect(instr).toMatch(/\[user\/feedback\]/);
    expect(instr).toMatch(/\[project\/project\]/);
  });

  it('createServer with only the user store wired surfaces only user-scope pinned memories (no project entries leak in)', async () => {
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'user_only_pin',
      type: 'feedback',
      description: 'user only',
      body: 'b',
      pinned: true,
    });
    const server = createServer({ userStore });
    const instr = readInstructions(server);
    expect(instr).toContain('user_only_pin');
    expect(instr).not.toContain('[project/');
  });
});

describe('ac-5: recall pack omitted when zero pinned memories', () => {
  it('createServer against stores with zero pinned memories emits instructions byte-equal to SERVER_INSTRUCTIONS (no heading, no trailing whitespace stub)', async () => {
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'unpinned_one',
      type: 'feedback',
      description: 'd',
      body: 'b',
    });
    const projectStore = makeStore(tmpProject);
    await projectStore.scan();
    const server = createServer({ userStore, projectStore });
    const instr = readInstructions(server);
    expect(instr).toBe(SERVER_INSTRUCTIONS);
  });
});

describe('ac-6: recall pack excludes superseded memories', () => {
  it("createServer omits a pinned memory whose name appears in another memory's `supersedes[]` (within the same store) from the recall pack", async () => {
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'old_pin',
      type: 'feedback',
      description: 'old description',
      body: 'old',
      pinned: true,
    });
    await userStore.save({
      name: 'new_one',
      type: 'feedback',
      description: 'new description',
      body: 'new',
      supersedes: ['old_pin'],
    });
    const server = createServer({ userStore });
    const instr = readInstructions(server);
    expect(instr).not.toContain('old_pin');
    expect(instr).not.toContain('old description');
  });

  it('createServer still includes a pinned memory that is NOT superseded even when other memories in the store are superseded', async () => {
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'kept_pin',
      type: 'feedback',
      description: 'still pinned',
      body: 'b',
      pinned: true,
    });
    await userStore.save({
      name: 'replaced_pin',
      type: 'feedback',
      description: 'replaced',
      body: 'b',
      pinned: true,
    });
    await userStore.save({
      name: 'replacer',
      type: 'feedback',
      description: 'replacer',
      body: 'b',
      supersedes: ['replaced_pin'],
    });
    const server = createServer({ userStore });
    const instr = readInstructions(server);
    expect(instr).toContain('kept_pin');
    expect(instr).toContain('still pinned');
    expect(instr).not.toContain('replaced_pin');
  });
});

describe('ac-7: fixture-driven assertion', () => {
  it("fixture-driven unit test: instructions contains both pinned memories' names and descriptions, and does not contain the unpinned memory's name", async () => {
    const userStore = makeStore(tmpUser);
    await userStore.scan();
    await userStore.save({
      name: 'pinned_feedback',
      type: 'feedback',
      description: 'first pinned description',
      body: 'b',
      pinned: true,
    });
    await userStore.save({
      name: 'unpinned_feedback',
      type: 'feedback',
      description: 'unpinned description',
      body: 'b',
    });
    const projectStore = makeStore(tmpProject);
    await projectStore.scan();
    await projectStore.save({
      name: 'pinned_project',
      type: 'project',
      description: 'project pinned description',
      body: 'b',
      pinned: true,
    });
    const server = createServer({ userStore, projectStore });
    const instr = readInstructions(server);
    expect(instr).toContain('pinned_feedback');
    expect(instr).toContain('first pinned description');
    expect(instr).toContain('pinned_project');
    expect(instr).toContain('project pinned description');
    expect(instr).not.toContain('unpinned_feedback');
  });
});
