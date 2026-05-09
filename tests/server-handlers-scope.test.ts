/**
 * DAR-924 unit tests: dual-store, scope-aware handlers.
 *
 * Covers ac-3 (project store auto-create on first save), ac-4 (search merge
 * across two stores), and the scope routing pieces of save / list / delete.
 * Spawned-bin coverage for the same behaviours lives in
 * `server-bin-scope.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/store/memory-store.js';
import {
  createMemoryDeleteHandler,
  createMemoryListHandler,
  createMemorySaveHandler,
  createMemorySearchHandler,
} from '../src/server/handlers.js';

let userTmp: string;
let projectTmp: string;

beforeEach(() => {
  userTmp = mkdtempSync(join(tmpdir(), 'dar924-user-'));
  projectTmp = mkdtempSync(join(tmpdir(), 'dar924-proj-'));
});

afterEach(() => {
  rmSync(userTmp, { recursive: true, force: true });
  rmSync(projectTmp, { recursive: true, force: true });
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

const makeStores = async (
  options: { project?: boolean } = {},
): Promise<{ userStore: MemoryStore; projectStore?: MemoryStore }> => {
  const embedder = makeStubEmbedder();
  const userStore = new MemoryStore({ dir: userTmp, embedder });
  await userStore.scan();
  if (options.project ?? true) {
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();
    return { userStore, projectStore };
  }
  return { userStore };
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// --------------------------------------------------------------------------
// ac-3: project store auto-create on first save
// --------------------------------------------------------------------------

describe('DAR-924 ac-3: project store auto-create on first save', () => {
  it('project store directory does NOT exist before the first memory_save({ scope: "project" }) call when env points at a fresh path', async () => {
    const embedder = makeStubEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const fresh = join(projectTmp, 'never-created');
    const projectStore = new MemoryStore({ dir: fresh, embedder });
    expect(existsSync(fresh)).toBe(false);

    // Construct the handler but do not call it yet -- the contract is
    // "directory does NOT exist before the first save call", verified by
    // re-checking after factory construction.
    void createMemorySaveHandler({ userStore, projectStore });
    expect(existsSync(fresh)).toBe(false);
  });

  it('first memory_save({ scope: "project" }) creates the project directory recursively (mkdir -p) and writes the memory file', async () => {
    const embedder = makeStubEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const fresh = join(projectTmp, 'never-created', 'nested');
    const projectStore = new MemoryStore({ dir: fresh, embedder });

    const handler = createMemorySaveHandler({ userStore, projectStore });
    const result = await handler({
      name: 'first_proj',
      type: 'project',
      description: 'd',
      body: 'b',
      scope: 'project',
    });
    expect(existsSync(fresh)).toBe(true);
    expect(readdirSync(fresh).sort()).toEqual(['first_proj.embedding', 'first_proj.md'].sort());
    if (!isRecord(result)) throw new Error('save result not object');
    expect(result.scope).toBe('project');
  });

  it('second memory_save({ scope: "project" }) against an existing project dir is a no-op for directory creation and still writes the memory', async () => {
    const { userStore, projectStore } = await makeStores();
    const handler = createMemorySaveHandler({ userStore, projectStore });
    await handler({
      name: 'first',
      type: 'project',
      description: 'd',
      body: 'b',
      scope: 'project',
    });
    await handler({
      name: 'second',
      type: 'project',
      description: 'd',
      body: 'b',
      scope: 'project',
    });
    expect(existsSync(projectTmp)).toBe(true);
    const files = readdirSync(projectTmp).sort();
    expect(files).toEqual(['first.embedding', 'first.md', 'second.embedding', 'second.md'].sort());
  });

  it('memory_save({ scope: "project" }) rejects with a clear error when no project store was detected (user-only mode)', async () => {
    const { userStore } = await makeStores({ project: false });
    const handler = createMemorySaveHandler({ userStore });
    await expect(
      handler({
        name: 'x',
        type: 'project',
        description: 'd',
        body: 'b',
        scope: 'project',
      }),
    ).rejects.toThrow(/project/i);
  });

  it('memory_save defaults to scope: "user" when scope is omitted', async () => {
    const { userStore, projectStore } = await makeStores();
    const handler = createMemorySaveHandler({ userStore, projectStore });
    const result = await handler({
      name: 'defaultscope',
      type: 'reference',
      description: 'd',
      body: 'b',
    });
    if (!isRecord(result)) throw new Error('save result not object');
    expect(result.scope).toBe('user');
    // Must be in user dir, not project dir.
    expect(readdirSync(userTmp).some((f) => f === 'defaultscope.md')).toBe(true);
    expect(readdirSync(projectTmp).some((f) => f === 'defaultscope.md')).toBe(false);
  });
});

// --------------------------------------------------------------------------
// ac-4: search merges across two stores
// --------------------------------------------------------------------------

describe('DAR-924 ac-4: search merges across two stores', () => {
  // We use a deterministic synthetic embedder that scores by string match, so
  // we can predictably arrange "store A wins one slot, store B wins one slot".
  // The dimensionality must match between user and project stores' embedders.

  // We'll seed each store with memories that get distinct scores against the
  // query "needle". Since the stub embedder above produces non-deterministic
  // scoring (count-based), we use a different stub here that scores by
  // body-substring containment.

  const semanticEmbedder = (modelId = 'test-model', dim = 8) => {
    return {
      modelId,
      dim,
      embed: async (text: string): Promise<Float32Array> => {
        // Build a vector where dim 0 = 1.0 if "needle" in text, else 0; dim 1 = lower priority match.
        const out = new Float32Array(dim);
        const t = text.toLowerCase();
        out[0] = t.includes('needle') ? 1.0 : 0.0;
        out[1] = t.includes('hay') ? 0.5 : 0.0;
        out[2] = t.length / 100; // tiebreaker by length
        // L2 normalise
        let n = 0;
        for (let i = 0; i < dim; i++) n += out[i]! * out[i]!;
        n = Math.sqrt(n) || 1;
        for (let i = 0; i < dim; i++) out[i] = out[i]! / n;
        return out;
      },
    };
  };

  const seed = async (
    store: MemoryStore,
    entries: Array<{
      name: string;
      body: string;
      type?: 'user' | 'project' | 'feedback' | 'reference';
    }>,
  ) => {
    for (const e of entries) {
      await store.save({
        name: e.name,
        description: 'd',
        type: e.type ?? 'reference',
        body: e.body,
      });
    }
  };

  it('given memories in both stores, memory_search returns a single merged list ordered by descending score', async () => {
    const embedder = semanticEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();

    await seed(userStore, [
      { name: 'user_a', body: 'this body has needle in it' }, // high
      { name: 'user_b', body: 'just some hay no match' }, // mid
    ]);
    await seed(projectStore, [
      { name: 'proj_a', body: 'needle once and again' }, // high
      { name: 'proj_b', body: 'unrelated text' }, // low
    ]);

    const handler = createMemorySearchHandler({ userStore, projectStore });
    const result = await handler({ query: 'needle' });
    if (!isRecord(result)) throw new Error('result not object');
    const matches = result.matches;
    if (!Array.isArray(matches)) throw new Error('matches not array');
    // Must be ordered by descending score
    for (let i = 1; i < matches.length; i++) {
      const prev = matches[i - 1];
      const curr = matches[i];
      if (!isRecord(prev) || !isRecord(curr)) throw new Error('not records');
      expect(typeof prev.score).toBe('number');
      expect(typeof curr.score).toBe('number');
      expect(prev.score as number).toBeGreaterThanOrEqual(curr.score as number);
    }
    // The two needle-containing entries (user_a, proj_a) must rank above the
    // ones without.
    const names = matches.map((m) => (isRecord(m) ? (m.name as string) : ''));
    expect(names.indexOf('user_a')).toBeLessThan(names.indexOf('user_b'));
    expect(names.indexOf('proj_a')).toBeLessThan(names.indexOf('proj_b'));
  });

  it('merged top-k applies to the combined list, not per store (limit=3 against 5 user + 5 project hits returns 3 entries total)', async () => {
    const embedder = semanticEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();

    for (let i = 0; i < 5; i++) {
      await userStore.save({
        name: `u_${i}`,
        type: 'reference',
        description: 'd',
        body: `needle entry user ${i}`,
      });
      await projectStore.save({
        name: `p_${i}`,
        type: 'reference',
        description: 'd',
        body: `needle entry proj ${i}`,
      });
    }

    const handler = createMemorySearchHandler({ userStore, projectStore });
    const result = await handler({ query: 'needle', limit: 3 });
    if (!isRecord(result)) throw new Error('result not object');
    const matches = result.matches;
    if (!Array.isArray(matches)) throw new Error('matches not array');
    expect(matches).toHaveLength(3);
  });

  it('each match in the merged response carries scope: user | project reflecting which store produced it', async () => {
    const embedder = semanticEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();

    await seed(userStore, [{ name: 'u1', body: 'needle a' }]);
    await seed(projectStore, [{ name: 'p1', body: 'needle b' }]);

    const handler = createMemorySearchHandler({ userStore, projectStore });
    const result = await handler({ query: 'needle' });
    if (!isRecord(result)) throw new Error('result not object');
    const matches = result.matches as unknown[];
    const u1 = matches.find((m) => isRecord(m) && m.name === 'u1');
    const p1 = matches.find((m) => isRecord(m) && m.name === 'p1');
    if (!isRecord(u1) || !isRecord(p1)) throw new Error('matches not found');
    expect(u1.scope).toBe('user');
    expect(p1.scope).toBe('project');
  });

  it('memory_search({ scope: "user" }) filters results to user-store hits only', async () => {
    const embedder = semanticEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();

    await seed(userStore, [{ name: 'u1', body: 'needle u' }]);
    await seed(projectStore, [{ name: 'p1', body: 'needle p' }]);

    const handler = createMemorySearchHandler({ userStore, projectStore });
    const result = await handler({ query: 'needle', scope: 'user' });
    if (!isRecord(result)) throw new Error('result not object');
    const matches = result.matches as unknown[];
    expect(matches.length).toBe(1);
    expect(isRecord(matches[0]) && matches[0].name).toBe('u1');
    expect(isRecord(matches[0]) && matches[0].scope).toBe('user');
  });

  it('memory_search({ scope: "project" }) filters results to project-store hits only', async () => {
    const embedder = semanticEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();

    await seed(userStore, [{ name: 'u1', body: 'needle u' }]);
    await seed(projectStore, [{ name: 'p1', body: 'needle p' }]);

    const handler = createMemorySearchHandler({ userStore, projectStore });
    const result = await handler({ query: 'needle', scope: 'project' });
    if (!isRecord(result)) throw new Error('result not object');
    const matches = result.matches as unknown[];
    expect(matches.length).toBe(1);
    expect(isRecord(matches[0]) && matches[0].name).toBe('p1');
    expect(isRecord(matches[0]) && matches[0].scope).toBe('project');
  });

  it('in user-only mode (no project store), search returns user hits only and does not error', async () => {
    const embedder = semanticEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    await seed(userStore, [{ name: 'u1', body: 'needle in haystack' }]);

    const handler = createMemorySearchHandler({ userStore });
    const result = await handler({ query: 'needle' });
    if (!isRecord(result)) throw new Error('result not object');
    const matches = result.matches as unknown[];
    expect(matches.length).toBe(1);
    expect(isRecord(matches[0]) && matches[0].scope).toBe('user');
  });

  it('ties in cosine score across stores are stably ordered and both entries appear in the merged top-k', async () => {
    // Use an embedder that yields IDENTICAL vectors for every input so all
    // entries score 1.0 (cosine of identical vectors). Both user and project
    // entries will tie; both must appear in the top-k.
    const tieEmbedder = (modelId = 'tie-model', dim = 4) => ({
      modelId,
      dim,
      embed: async (text: string): Promise<Float32Array> => {
        // Identical vectors regardless of input -- the text is intentionally
        // ignored so every embedding scores 1.0 against any query.
        void text;
        const out = new Float32Array(dim);
        out[0] = 1.0;
        return out;
      },
    });
    const embedder = tieEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();

    await seed(userStore, [{ name: 'u_tie', body: 'a' }]);
    await seed(projectStore, [{ name: 'p_tie', body: 'b' }]);

    const handler = createMemorySearchHandler({ userStore, projectStore });
    const result = await handler({ query: 'q', limit: 5 });
    if (!isRecord(result)) throw new Error('result not object');
    const matches = result.matches as unknown[];
    expect(matches.length).toBe(2);
    const names = matches
      .filter((m): m is Record<string, unknown> => isRecord(m))
      .map((m) => m.name);
    expect(names.sort()).toEqual(['p_tie', 'u_tie']);
  });
});

// --------------------------------------------------------------------------
// list / delete scope routing
// --------------------------------------------------------------------------

describe('DAR-924 list and delete scope routing', () => {
  it('memory_list returns scope-tagged entries from both stores when both are present', async () => {
    const embedder = makeStubEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();

    await userStore.save({ name: 'u1', type: 'user', description: 'd', body: 'b' });
    await projectStore.save({ name: 'p1', type: 'project', description: 'd', body: 'b' });

    const handler = createMemoryListHandler({ userStore, projectStore });
    const result = await handler({});
    if (!isRecord(result)) throw new Error('result not object');
    const memories = result.memories as unknown[];
    const u = memories.find((m) => isRecord(m) && m.name === 'u1');
    const p = memories.find((m) => isRecord(m) && m.name === 'p1');
    if (!isRecord(u) || !isRecord(p)) throw new Error('entries missing');
    expect(u.scope).toBe('user');
    expect(p.scope).toBe('project');
  });

  it('memory_list with scope filter returns only entries from that scope', async () => {
    const embedder = makeStubEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();
    await userStore.save({ name: 'u1', type: 'user', description: 'd', body: 'b' });
    await projectStore.save({ name: 'p1', type: 'project', description: 'd', body: 'b' });

    const handler = createMemoryListHandler({ userStore, projectStore });
    const userOnly = await handler({ scope: 'user' });
    if (!isRecord(userOnly)) throw new Error('not object');
    const userMems = userOnly.memories as unknown[];
    expect(userMems.length).toBe(1);
    expect(isRecord(userMems[0]) && userMems[0].name).toBe('u1');
  });

  it('same memory name in both scopes: memory_list returns two entries, each tagged with its scope', async () => {
    const embedder = makeStubEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();
    await userStore.save({ name: 'shared', type: 'user', description: 'd', body: 'b' });
    await projectStore.save({ name: 'shared', type: 'project', description: 'd', body: 'b' });

    const handler = createMemoryListHandler({ userStore, projectStore });
    const result = await handler({});
    if (!isRecord(result)) throw new Error('not object');
    const memories = result.memories as unknown[];
    const filtered = memories.filter((m) => isRecord(m) && m.name === 'shared');
    expect(filtered.length).toBe(2);
    const scopes = filtered.map((m) => (isRecord(m) ? m.scope : null)).sort();
    expect(scopes).toEqual(['project', 'user']);
  });

  it('memory_delete({ name }) without scope is rejected with an error naming the ambiguity when name exists in both scopes', async () => {
    const embedder = makeStubEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();
    await userStore.save({ name: 'shared', type: 'user', description: 'd', body: 'b' });
    await projectStore.save({ name: 'shared', type: 'project', description: 'd', body: 'b' });

    const handler = createMemoryDeleteHandler({ userStore, projectStore });
    await expect(handler({ name: 'shared' })).rejects.toThrow(/ambig|both|scope/i);
  });

  it('memory_delete({ name, scope: "user" }) removes only the user-scoped entry', async () => {
    const embedder = makeStubEmbedder();
    const userStore = new MemoryStore({ dir: userTmp, embedder });
    await userStore.scan();
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();
    await userStore.save({ name: 'shared', type: 'user', description: 'd', body: 'b' });
    await projectStore.save({ name: 'shared', type: 'project', description: 'd', body: 'b' });

    const handler = createMemoryDeleteHandler({ userStore, projectStore });
    const result = await handler({ name: 'shared', scope: 'user' });
    if (!isRecord(result)) throw new Error('not object');
    expect(result.scope).toBe('user');

    // user store must no longer contain it; project store still does.
    expect(userStore.all().some((e) => e.name === 'shared')).toBe(false);
    expect(projectStore.all().some((e) => e.name === 'shared')).toBe(true);
  });
});

// --------------------------------------------------------------------------
// ac-5 wiring shape: createDefaultHandlers signature
// --------------------------------------------------------------------------

describe('DAR-924 ac-5: handler factory signature accepts { userStore, projectStore? }', () => {
  it('createDefaultHandlers accepts { userStore, projectStore? } and dispatches scope-aware', async () => {
    // Importing here to keep the test self-contained; the runtime check is
    // that calling the factory with the new shape returns a working handler
    // map.
    const { createDefaultHandlers } = await import('../src/server/tools.js');
    const { userStore, projectStore } = await makeStores();
    const handlers = createDefaultHandlers({ userStore, projectStore });
    expect(typeof handlers.memory_save).toBe('function');
    expect(typeof handlers.memory_list).toBe('function');
    expect(typeof handlers.memory_delete).toBe('function');
    expect(typeof handlers.memory_search).toBe('function');
    // Smoke: a save with scope=project lands in the project store.
    await handlers.memory_save({
      name: 'shape_test',
      type: 'project',
      description: 'd',
      body: 'b',
      scope: 'project',
    });
    if (projectStore === undefined) throw new Error('projectStore not constructed');
    expect(projectStore.all().some((e) => e.name === 'shape_test')).toBe(true);
  });

  it('createDefaultHandlers accepts the legacy { store } shape and treats it as user-only mode', async () => {
    const { createDefaultHandlers } = await import('../src/server/tools.js');
    const { userStore } = await makeStores({ project: false });
    const handlers = createDefaultHandlers({ store: userStore });
    expect(typeof handlers.memory_save).toBe('function');
    // Saving to project scope must reject because no project store was given.
    const result = await (async () => {
      try {
        await handlers.memory_save({
          name: 'x',
          type: 'project',
          description: 'd',
          body: 'b',
          scope: 'project',
        });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    })();
    expect(result).toMatch(/project/i);
  });
});
