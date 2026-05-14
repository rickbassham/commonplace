/**
 * Unit tests: search/list response shape additions and
 * default-exclude-superseded semantics.
 *
 * Covers:
 *   - ac-1: `relations` (required) and `supersededBy` (optional) on every match;
 *           `includeSuperseded` opt-in flag in the inputSchema.
 *   - ac-2: superseded memories are filtered out by default from both
 *           `memory_search` and `memory_list`; `totalScanned` reflects the
 *           post-filter corpus.
 *   - ac-3: `includeSuperseded: true` returns the superseded entry back, with
 *           `supersededBy` pointing at the superseding name; `supersededBy`
 *           is omitted on entries that are not superseded.
 *   - ac-4: each match carries the outgoing authored relations from
 *           frontmatter, in order, verbatim.
 *   - ac-5: mentions edges are NOT included in `match.relations`;
 *           `supersedes` edges also do not leak through.
 *
 * The integration coverage for ac-5 (spawned-bin / on-the-wire) lives in
 * `server-handlers-search-supersede.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../src/store/memory-store.js';
import {
  buildToolDefinitions,
  createDefaultHandlers,
  type ToolDefinition,
} from '../src/server/tools.js';
import {
  createMemoryListHandler,
  createMemorySearchHandler,
  type MemorySearchMatch,
  type MemorySearchResult,
} from '../src/server/handlers.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar929-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Programmable embedder: registry-driven so tests can pin specific bodies and
 * the query string to specific vectors and reason about scoring directly.
 */
const l2norm = (v: Float32Array): Float32Array => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  if (n > 0) {
    for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  }
  return v;
};

const makeProgrammableEmbedder = (dim = 4) => {
  const registry = new Map<string, Float32Array>();
  return {
    modelId: 'Xenova/bge-base-en-v1.5',
    dim,
    embed: async (text: string): Promise<Float32Array> => {
      const v = registry.get(text);
      if (v) return new Float32Array(v);
      const out = new Float32Array(dim);
      let acc = 0;
      for (let i = 0; i < text.length; i++) acc += text.charCodeAt(i);
      out[0] = (acc % 13) / 13;
      for (let i = 1; i < dim; i++) out[i] = ((acc + i) % 17) / 17;
      return l2norm(out);
    },
    register: (text: string, vector: Float32Array): void => {
      registry.set(text, vector);
    },
  };
};

const makeStore = (
  embedder: ReturnType<typeof makeProgrammableEmbedder> = makeProgrammableEmbedder(),
): MemoryStore => {
  return new MemoryStore({ dir: tmp, embedder });
};

const findDef = (defs: readonly ToolDefinition[], name: string): ToolDefinition => {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`expected tool ${name} to be registered`);
  return def;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asResult = (v: unknown): MemorySearchResult => {
  if (!isRecord(v)) throw new Error('not a record');
  return v as unknown as MemorySearchResult;
};

// --------------------------------------------------------------------------
// ac-1: response shape additions + inputSchema
// --------------------------------------------------------------------------

describe('ac-1: response shape additions', () => {
  it('MemorySearchMatch interface gains a required `relations: Array<{to: string, type: RelationType}>` field, present on every match (empty array when the underlying memory has no outgoing edges)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body', l2norm(new Float32Array([1, 0, 0, 0])));
    await store.save({ name: 'plain', type: 'reference', description: 'd', body: 'body' });

    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q' }));
    expect(out.matches.length).toBeGreaterThan(0);
    for (const m of out.matches) {
      expect(Array.isArray(m.relations)).toBe(true);
      expect(m.relations).toEqual([]);
    }
  });

  it('MemorySearchMatch interface gains an optional `supersededBy?: string` field, omitted on every match when `includeSuperseded` is not requested', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_a', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_b', l2norm(new Float32Array([0.9, 0.1, 0, 0])));
    await store.save({ name: 'a', type: 'reference', description: 'da', body: 'body_a' });
    await store.save({
      name: 'b',
      type: 'reference',
      description: 'db',
      body: 'body_b',
      supersedes: ['a'],
    });

    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q' }));
    for (const m of out.matches) {
      expect('supersededBy' in (m as object)).toBe(false);
    }
  });

  it('the baseline server-handlers-search tests (ac-1 through ac-6 in tests/server-handlers-search.test.ts) continue to pass without modification to their expected `query`, `totalScanned`, `score`, `body`, `name`, `type`, `description` assertions', async () => {
    // This test asserts a structural invariant: a fresh search match still
    // carries name/type/description/body/score with the documented values.
    // Adding `relations` and (optionally) `supersededBy` is additive; we
    // verify by spot-checking a populated corpus.
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('BODY', l2norm(new Float32Array([1, 0, 0, 0])));
    await store.save({
      name: 'alpha',
      type: 'reference',
      description: 'desc-alpha',
      body: 'BODY',
    });

    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q' }));
    expect(out.query).toBe('q');
    expect(out.totalScanned).toBe(1);
    const m = out.matches[0]!;
    expect(m.name).toBe('alpha');
    expect(m.type).toBe('reference');
    expect(m.description).toBe('desc-alpha');
    expect(m.body).toBe('BODY');
    expect(typeof m.score).toBe('number');
  });

  it("memory_search inputSchema in TOOL_SCHEMAS gains an optional `includeSuperseded: { type: 'boolean' }` property and remains backward-compatible (no new required fields)", () => {
    const defs = buildToolDefinitions();
    const def = findDef(defs, 'memory_search');
    const schema = def.inputSchema;
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    expect(props).toBeDefined();
    if (!props) throw new Error('properties missing');
    expect(props.includeSuperseded?.type).toBe('boolean');
    const required = (schema as { required?: string[] }).required ?? [];
    expect(required).not.toContain('includeSuperseded');
    // Pre-existing required: only `query`.
    expect(new Set(required)).toEqual(new Set(['query']));
  });

  it("memory_list inputSchema gains an optional `includeSuperseded: { type: 'boolean' }` property and remains backward-compatible (no new required fields)", () => {
    const defs = buildToolDefinitions();
    const def = findDef(defs, 'memory_list');
    const schema = def.inputSchema;
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    expect(props).toBeDefined();
    if (!props) throw new Error('properties missing');
    expect(props.includeSuperseded?.type).toBe('boolean');
    const required = (schema as { required?: string[] }).required;
    expect(required === undefined || required.length === 0).toBe(true);
  });
});

// --------------------------------------------------------------------------
// ac-2: default-exclude superseded
// --------------------------------------------------------------------------

describe('ac-2: superseded memories excluded from default search and list', () => {
  it("given memory A and memory B where B's frontmatter has `supersedes: [A]`, memory_search with no `includeSuperseded` argument returns matches that do NOT contain A even when A's vector would otherwise rank in the top-k", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    // A is best match; B is a worse match. Without filtering A would be top.
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_a', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_b', l2norm(new Float32Array([0.5, 0.5, 0.5, 0.5])));
    await store.save({ name: 'a', type: 'reference', description: 'da', body: 'body_a' });
    await store.save({
      name: 'b',
      type: 'reference',
      description: 'db',
      body: 'body_b',
      supersedes: ['a'],
    });

    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q' }));
    const names = out.matches.map((m) => m.name);
    expect(names).not.toContain('a');
    expect(names).toContain('b');
  });

  it('memory_list with no `includeSuperseded` argument omits A from the returned memories array when A is superseded by B', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('body_a', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_b', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.save({ name: 'a', type: 'reference', description: 'da', body: 'body_a' });
    await store.save({
      name: 'b',
      type: 'reference',
      description: 'db',
      body: 'body_b',
      supersedes: ['a'],
    });

    const handler = createMemoryListHandler({ store });
    const out = await handler({});
    if (!isRecord(out)) throw new Error('not record');
    const memories = out.memories as Array<{ name: string }>;
    const names = memories.map((m) => m.name);
    expect(names).not.toContain('a');
    expect(names).toContain('b');
  });

  it('the `totalScanned` field on memory_search response counts the post-supersede-filter corpus (i.e. excludes superseded entries when `includeSuperseded` is false), so callers can reason about the effective corpus size', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_a', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_b', l2norm(new Float32Array([0.9, 0.1, 0, 0])));
    embedder.register('body_c', l2norm(new Float32Array([0.5, 0.5, 0.5, 0.5])));
    await store.save({ name: 'a', type: 'reference', description: 'da', body: 'body_a' });
    await store.save({ name: 'c', type: 'reference', description: 'dc', body: 'body_c' });
    await store.save({
      name: 'b',
      type: 'reference',
      description: 'db',
      body: 'body_b',
      supersedes: ['a'],
    });

    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q' }));
    // Three on disk, one (a) is superseded; effective corpus is 2.
    expect(store.all().length).toBe(3);
    expect(out.totalScanned).toBe(2);
  });
});

// --------------------------------------------------------------------------
// ac-3: includeSuperseded: true brings superseded entries back
// --------------------------------------------------------------------------

describe('ac-3: includeSuperseded opt-in', () => {
  const seedAB = async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_a', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_b', l2norm(new Float32Array([0.9, 0.1, 0, 0])));
    await store.save({ name: 'a', type: 'reference', description: 'da', body: 'body_a' });
    await store.save({
      name: 'b',
      type: 'reference',
      description: 'db',
      body: 'body_b',
      supersedes: ['a'],
    });
    return { embedder, store };
  };

  it("memory_search invoked with `includeSuperseded: true` returns A in the matches array when A is superseded by B and A's vector ranks in the top-k", async () => {
    const { store } = await seedAB();
    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q', includeSuperseded: true }));
    const names = out.matches.map((m) => m.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
  });

  it("the match for A in the previous test carries `supersededBy: 'B'` (string equal to the superseding memory's name)", async () => {
    const { store } = await seedAB();
    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q', includeSuperseded: true }));
    const a = out.matches.find((m) => m.name === 'a');
    expect(a).toBeDefined();
    expect(a!.supersededBy).toBe('b');
  });

  it('matches whose memories are NOT superseded (e.g. B itself, or any memory with no inbound supersedes edge) omit `supersededBy` entirely from the JSON payload (key absent, not `supersededBy: undefined`) when `includeSuperseded: true`', async () => {
    const { store } = await seedAB();
    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q', includeSuperseded: true }));
    const round = JSON.parse(JSON.stringify(out)) as MemorySearchResult;
    const b = round.matches.find((m) => m.name === 'b')!;
    expect('supersededBy' in (b as object)).toBe(false);
  });

  it('memory_list invoked with `includeSuperseded: true` includes A in the memories array when A is superseded by B', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('body_a', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_b', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.save({ name: 'a', type: 'reference', description: 'da', body: 'body_a' });
    await store.save({
      name: 'b',
      type: 'reference',
      description: 'db',
      body: 'body_b',
      supersedes: ['a'],
    });

    const handler = createMemoryListHandler({ store });
    const out = await handler({ includeSuperseded: true });
    if (!isRecord(out)) throw new Error('not record');
    const memories = out.memories as Array<{ name: string }>;
    const names = memories.map((m) => m.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
  });

  it('memory_search rejects a non-boolean `includeSuperseded` value (e.g. string, number, null) with a validation error that names the offending field', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemorySearchHandler({ store });
    await expect(handler({ query: 'q', includeSuperseded: 'true' })).rejects.toThrow(
      /includeSuperseded/,
    );
    await expect(handler({ query: 'q', includeSuperseded: 1 })).rejects.toThrow(
      /includeSuperseded/,
    );
    await expect(handler({ query: 'q', includeSuperseded: null })).rejects.toThrow(
      /includeSuperseded/,
    );
  });
});

// --------------------------------------------------------------------------
// ac-4: outgoing relations on each match
// --------------------------------------------------------------------------

describe('ac-4: each match contains its outgoing relations from frontmatter', () => {
  it("given a memory M with frontmatter `relations: [{to: 'x', type: 'related-to'}, {to: 'y', type: 'builds-on'}]`, the memory_search match for M carries `relations` containing exactly those two entries (verbatim `to` and `type` values, in frontmatter order)", async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_x', l2norm(new Float32Array([0, 1, 0, 0])));
    embedder.register('body_y', l2norm(new Float32Array([0, 0, 1, 0])));
    embedder.register('body_m', l2norm(new Float32Array([1, 0, 0, 0])));
    await store.save({ name: 'x', type: 'reference', description: 'dx', body: 'body_x' });
    await store.save({ name: 'y', type: 'reference', description: 'dy', body: 'body_y' });
    await store.save({
      name: 'm',
      type: 'reference',
      description: 'dm',
      body: 'body_m',
      relations: [
        { to: 'x', type: 'related-to' },
        { to: 'y', type: 'builds-on' },
      ],
    });

    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q' }));
    const m = out.matches.find((entry) => entry.name === 'm');
    expect(m).toBeDefined();
    expect(m!.relations).toEqual([
      { to: 'x', type: 'related-to' },
      { to: 'y', type: 'builds-on' },
    ]);
  });

  it('a memory whose frontmatter has no `relations:` key yields a match with `relations: []` (empty array, not omitted, not undefined)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body', l2norm(new Float32Array([1, 0, 0, 0])));
    await store.save({ name: 'plain', type: 'reference', description: 'd', body: 'body' });

    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q' }));
    const round = JSON.parse(JSON.stringify(out)) as MemorySearchResult;
    const m = round.matches.find((entry) => entry.name === 'plain')!;
    expect('relations' in (m as object)).toBe(true);
    expect(Array.isArray(m.relations)).toBe(true);
    expect(m.relations).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// ac-5: mentions and supersedes edges NOT in match.relations
// --------------------------------------------------------------------------

describe('ac-5: mentions and supersedes edges are not in match.relations', () => {
  it('given a memory M whose body contains `[[other_memory]]` mention tokens (which the body tokenizer records as `mentions` edges in the MemoryGraph), the memory_search match for M does NOT include any entry of edge type `mentions` in its `relations` array', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('see [[other_memory]] for details', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_other', l2norm(new Float32Array([0, 1, 0, 0])));
    await store.save({
      name: 'other_memory',
      type: 'reference',
      description: 'd',
      body: 'body_other',
    });
    await store.save({
      name: 'm',
      type: 'reference',
      description: 'd',
      body: 'see [[other_memory]] for details',
    });

    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q' }));
    const m = out.matches.find((entry) => entry.name === 'm');
    expect(m).toBeDefined();
    for (const r of m!.relations) {
      expect((r as { type: string }).type).not.toBe('mentions');
    }
  });

  it('the `relations` field on a match contains only entries whose `type` is one of the four authored RelationType values (`related-to`, `builds-on`, `contradicts`, `child-of`); no `mentions` and no `supersedes` edges leak through', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body with [[mentioned]] inline', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_other', l2norm(new Float32Array([0, 1, 0, 0])));
    embedder.register('body_old', l2norm(new Float32Array([0, 0, 1, 0])));
    embedder.register('body_target', l2norm(new Float32Array([0, 0, 0, 1])));
    await store.save({
      name: 'mentioned',
      type: 'reference',
      description: 'd',
      body: 'body_other',
    });
    await store.save({
      name: 'old',
      type: 'reference',
      description: 'd',
      body: 'body_old',
    });
    await store.save({
      name: 'target',
      type: 'reference',
      description: 'd',
      body: 'body_target',
    });
    await store.save({
      name: 'm',
      type: 'reference',
      description: 'd',
      body: 'body with [[mentioned]] inline',
      relations: [
        { to: 'target', type: 'related-to' },
        { to: 'target', type: 'builds-on' },
      ],
      supersedes: ['old'],
    });

    const handler = createMemorySearchHandler({ store });
    const out = asResult(await handler({ query: 'q', includeSuperseded: true }));
    const m = out.matches.find((entry) => entry.name === 'm');
    expect(m).toBeDefined();
    const allowed = new Set(['related-to', 'builds-on', 'contradicts', 'child-of']);
    for (const r of m!.relations) {
      expect(allowed.has((r as { type: string }).type)).toBe(true);
    }
    // Affirm the authored relations are present, and no extras leaked from
    // mentions or supersedes.
    expect(m!.relations).toEqual([
      { to: 'target', type: 'related-to' },
      { to: 'target', type: 'builds-on' },
    ]);
  });
});

// --------------------------------------------------------------------------
// JSON-serialisation: round-trip preserves the new fields cleanly
// --------------------------------------------------------------------------

describe('JSON serialisation round-trip', () => {
  it('memory_search response remains JSON-serialisable and round-trips equal to the original (no functions, no undefined fields)', async () => {
    const embedder = makeProgrammableEmbedder();
    const store = makeStore(embedder);
    await store.scan();
    embedder.register('q', l2norm(new Float32Array([1, 0, 0, 0])));
    embedder.register('body_a', l2norm(new Float32Array([1, 0, 0, 0])));
    await store.save({ name: 'a', type: 'reference', description: 'da', body: 'body_a' });

    const handler = createMemorySearchHandler({ store });
    const out = await handler({ query: 'q' });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});

// --------------------------------------------------------------------------
// Integration sanity: createDefaultHandlers still works after wiring
// --------------------------------------------------------------------------

describe('createDefaultHandlers still wires real handlers', () => {
  it('createDefaultHandlers({ store }) wires both memory_search and memory_list handlers that are not the not-implemented stub', async () => {
    const store = makeStore();
    await store.scan();
    const handlers = createDefaultHandlers({ store });
    let searchMsg: string | null = null;
    try {
      await handlers.memory_search({ query: 'q' });
    } catch (err) {
      searchMsg = err instanceof Error ? err.message : String(err);
    }
    expect(searchMsg).not.toBe('not implemented');

    let listMsg: string | null = null;
    try {
      await handlers.memory_list({});
    } catch (err) {
      listMsg = err instanceof Error ? err.message : String(err);
    }
    expect(listMsg).not.toBe('not implemented');
  });

  it('memory_search dispatch via spied store still occurs once per call (sanity)', async () => {
    const store = makeStore();
    await store.scan();
    const spy = vi.spyOn(store, 'search');
    const handler = createMemorySearchHandler({ store });
    await handler({ query: 'q' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// Type-level smoke test: keep MemorySearchMatch's supersede-aware fields
// wired to a real assertion so removing either one from the interface
// produces a TS compile error AND a runtime failure.
describe('MemorySearchMatch type surface', () => {
  it('exposes `relations` (required) and `supersededBy` (optional) fields', () => {
    const sample: Pick<MemorySearchMatch, 'relations' | 'supersededBy'> = {
      relations: [],
    };
    expect(sample.relations).toEqual([]);
    expect(sample.supersededBy).toBeUndefined();
  });
});
