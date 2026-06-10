/**
 * Unit tests: real handler for memory_search.
 *
 * Covers the in-process handler surface only -- argument validation, dispatch
 * to `MemoryStore.search`, and response serialisation. End-to-end coverage
 * over the in-memory MCP transport lives in
 * `server-handlers-search.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore, type SearchHit, type SearchOptions } from '../src/store/memory-store.js';
import {
  buildToolDefinitions,
  createDefaultHandlers,
  type ToolDefinition,
} from '../src/server/tools.js';
import { createMemorySearchHandler } from '../src/server/handlers.js';
import { DEFAULT_LIMIT, ENV_DEFAULT_LIMIT, resolveDefaultLimit } from '../src/bin/env.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar920-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const makeStubEmbedder = (modelId = 'Xenova/bge-base-en-v1.5', dim = 4) => {
  let count = 0;
  const calls: string[] = [];
  const embed = vi.fn(async (text: string): Promise<Float32Array> => {
    count += 1;
    calls.push(text);
    const out = new Float32Array(dim);
    out[0] = count;
    for (let i = 1; i < dim; i++) out[i] = (i + (text.length % 7)) / 10;
    return out;
  });
  return {
    modelId,
    dim,
    embed,
    callsRef: calls,
  };
};

const makeStore = (dir = tmp): MemoryStore => {
  return new MemoryStore({ dir, embedder: makeStubEmbedder() });
};

const findDef = (defs: readonly ToolDefinition[], name: string): ToolDefinition => {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`expected tool ${name} to be registered`);
  return def;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// --------------------------------------------------------------------------
// ac-1: registration
// --------------------------------------------------------------------------

describe('ac-1: tool registration with real memory_search handler', () => {
  it("createDefaultHandlers({ store }) returns a memory_search handler that is NOT the not-implemented stub (i.e. invoking it does not throw an Error whose message is exactly 'not implemented')", async () => {
    const store = makeStore();
    await store.scan();
    const handlers = createDefaultHandlers({ store });
    let stubMessage: string | null = null;
    try {
      await handlers.memory_search({ query: 'x' });
    } catch (err) {
      stubMessage = err instanceof Error ? err.message : String(err);
    }
    expect(stubMessage).not.toBe('not implemented');
  });
});

// --------------------------------------------------------------------------
// ac-2: dispatch + serialisation (unit-level)
// --------------------------------------------------------------------------

describe('ac-2: memory_search handler dispatches to store.search', () => {
  it('memory_search handler invokes store.search exactly once per call, passing the `query` argument verbatim as the first positional argument (verified via spy/mock store)', async () => {
    const store = makeStore();
    await store.scan();
    const spy = vi.spyOn(store, 'search');
    const handler = createMemorySearchHandler({ store });
    await handler({ query: 'hello world' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe('hello world');
  });

  it('memory_search handler forwards `limit`, `type`, and `threshold` from the tool arguments into the SearchOptions object passed to store.search (verified via spy/mock store)', async () => {
    const store = makeStore();
    await store.scan();
    const spy = vi.spyOn(store, 'search');
    const handler = createMemorySearchHandler({ store });
    await handler({ query: 'q', limit: 7, type: 'feedback', threshold: 0.25 });
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0]?.[1];
    expect(opts).toBeDefined();
    if (!opts) throw new Error('expected opts');
    expect(opts.limit).toBe(7);
    expect(opts.type).toBe('feedback');
    expect(opts.threshold).toBe(0.25);
  });

  it('memory_search handler omits unset SearchOptions fields when the corresponding tool argument is absent (e.g. no `type` argument means `opts.type` is undefined on the store call)', async () => {
    const store = makeStore();
    await store.scan();
    const spy = vi.spyOn(store, 'search');
    const handler = createMemorySearchHandler({ store });
    await handler({ query: 'q' });
    expect(spy).toHaveBeenCalledTimes(1);
    const opts: SearchOptions = spy.mock.calls[0]?.[1] ?? {};
    expect(opts.type).toBeUndefined();
    expect(opts.limit).toBeUndefined();
    expect(opts.threshold).toBeUndefined();
  });

  it('memory_search response payload is a JSON-serialisable object with top-level keys `matches`, `query`, `totalScanned` (no extra top-level keys for v0.1; ac-5/ac-6 own the inner shape)', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemorySearchHandler({ store });
    const out = await handler({ query: 'q' });
    expect(isRecord(out)).toBe(true);
    if (!isRecord(out)) throw new Error('not record');
    // Round-trip JSON.
    const round = JSON.parse(JSON.stringify(out));
    expect(round).toEqual(out);
    // The top-level envelope is fixed at three keys; inner match shape is
    // additive (later changes added `relations` and the optional `supersededBy`).
    expect(new Set(Object.keys(out))).toEqual(new Set(['matches', 'query', 'totalScanned']));
  });

  it('memory_search rejects non-string `query` arguments (number, null, missing) with a validation error that names the offending field', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemorySearchHandler({ store });
    await expect(handler({})).rejects.toThrow(/query/);
    await expect(handler({ query: 123 })).rejects.toThrow(/query/);
    await expect(handler({ query: null })).rejects.toThrow(/query/);
  });
});

// --------------------------------------------------------------------------
// ac-3: full body returned + match shape
// --------------------------------------------------------------------------

describe('ac-3: match shape and full-body return', () => {
  it('match objects contain `name`, `type`, `description`, `body`, and `score` fields with values sourced from the underlying MemoryEntry and SearchHit', async () => {
    const store = makeStore();
    await store.scan();
    // Fake search to emit a single deterministic SearchHit so we can assert
    // the handler's projection field-by-field.
    const fakeHit: SearchHit = {
      memory: {
        name: 'alpha',
        description: 'description for alpha',
        type: 'reference',
        body: 'BODY-ALPHA',
        relations: [],
        supersedes: [],
        pinned: false,
        vector: new Float32Array(4),
        descriptionVector: new Float32Array(4),
        contentSha: 'deadbeef',
        modelId: 'Xenova/bge-base-en-v1.5',
        dim: 4,
      },
      score: 0.5,
    };
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit]);
    const handler = createMemorySearchHandler({ store });
    const out = await handler({ query: 'q' });
    if (!isRecord(out)) throw new Error('not record');
    const matches = out.matches;
    if (!Array.isArray(matches)) throw new Error('matches not array');
    expect(matches).toHaveLength(1);
    const m = matches[0];
    if (!isRecord(m)) throw new Error('m not record');
    expect(m.name).toBe('alpha');
    expect(m.type).toBe('reference');
    expect(m.description).toBe('description for alpha');
    expect(m.body).toBe('BODY-ALPHA');
    expect(typeof m.score).toBe('number');
    // The supersede-filter pass added `relations` (always present) and an
    // optional `supersededBy` to the match shape; the dual-store split
    // added the always-present `scope` tag identifying which store
    // produced the match.
    expect(new Set(Object.keys(m))).toEqual(
      new Set(['name', 'type', 'description', 'body', 'score', 'relations', 'scope']),
    );
  });

  it('match `score` is the cosine similarity returned by store.search rounded to 3 decimal places', async () => {
    const store = makeStore();
    await store.scan();
    const fakeHit: SearchHit = {
      memory: {
        name: 'a',
        description: 'd',
        type: 'reference',
        body: 'b',
        relations: [],
        supersedes: [],
        pinned: false,
        vector: new Float32Array(4),
        descriptionVector: new Float32Array(4),
        contentSha: 'x',
        modelId: 'Xenova/bge-base-en-v1.5',
        dim: 4,
      },
      // 0.123456789 -> round to 0.123
      score: 0.123456789,
    };
    const fakeHit2: SearchHit = {
      ...fakeHit,
      memory: { ...fakeHit.memory, name: 'b' },
      score: 0.9876,
    };
    vi.spyOn(store, 'search').mockResolvedValueOnce([fakeHit, fakeHit2]);
    const handler = createMemorySearchHandler({ store });
    const out = await handler({ query: 'q' });
    if (!isRecord(out)) throw new Error('not record');
    const matches = out.matches as Array<{ score: number; name: string }>;
    // The dual-store handler merges hits across stores and re-sorts
    // descending by score so the merged top-k is ordered correctly. Asserts
    // are by name (rather than position) so the test is robust to ordering
    // changes that don't affect the rounding contract under test.
    const a = matches.find((m) => m.name === 'a');
    const b = matches.find((m) => m.name === 'b');
    expect(a?.score).toBe(0.123);
    expect(b?.score).toBe(0.988);
  });
});

// --------------------------------------------------------------------------
// ac-5: type validation
// --------------------------------------------------------------------------

describe('ac-5: type filter validation', () => {
  it('memory_search rejects an invalid `type` value (string outside the user|feedback|project|reference enum) with a validation error that lists the allowed values', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemorySearchHandler({ store });
    let msg = '';
    try {
      await handler({ query: 'q', type: 'bogus' });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    for (const t of ['user', 'feedback', 'project', 'reference']) {
      expect(msg).toContain(t);
    }
  });
});

// --------------------------------------------------------------------------
// ac-6: empty / response invariants
// --------------------------------------------------------------------------

describe('ac-6: empty corpus + response invariants', () => {
  it("memory_search against an empty corpus does not invoke the embedder (verified via spy on the embedder's `embed` method) -- preserves the cold-store fast path", async () => {
    const embedder = makeStubEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();
    const handler = createMemorySearchHandler({ store });
    const out = await handler({ query: 'anything' });
    expect(embedder.embed).not.toHaveBeenCalled();
    if (!isRecord(out)) throw new Error('not record');
    expect(out.matches).toEqual([]);
    expect(out.totalScanned).toBe(0);
    expect(out.query).toBe('anything');
  });

  it('memory_search response `query` field echoes the input query string verbatim (no trimming, no lowercasing) on both empty-corpus and populated-corpus calls', async () => {
    // empty corpus
    const store1 = makeStore();
    await store1.scan();
    const handler1 = createMemorySearchHandler({ store: store1 });
    const out1 = await handler1({ query: '  Mixed CASE  ' });
    if (!isRecord(out1)) throw new Error('out1 not record');
    expect(out1.query).toBe('  Mixed CASE  ');

    // populated corpus
    const store2 = makeStore();
    await store2.scan();
    await store2.save({ name: 'alpha', type: 'reference', description: 'd', body: 'b' });
    const handler2 = createMemorySearchHandler({ store: store2 });
    const out2 = await handler2({ query: '  Mixed CASE  ' });
    if (!isRecord(out2)) throw new Error('out2 not record');
    expect(out2.query).toBe('  Mixed CASE  ');
  });

  it('memory_search response `totalScanned` equals the count of entries the store considered (i.e. matches store.all().length at call time, regardless of how many were filtered out by `type`/`threshold`/`limit`)', async () => {
    const store = makeStore();
    await store.scan();
    await store.save({ name: 'a', type: 'reference', description: 'd', body: 'aaa' });
    await store.save({ name: 'b', type: 'feedback', description: 'd', body: 'bbb' });
    await store.save({ name: 'c', type: 'project', description: 'd', body: 'ccc' });
    const handler = createMemorySearchHandler({ store });

    // No filter
    const out1 = await handler({ query: 'q' });
    if (!isRecord(out1)) throw new Error('out1 not record');
    expect(out1.totalScanned).toBe(store.all().length);
    expect(out1.totalScanned).toBe(3);

    // Type filter: still totalScanned reflects everything store considered.
    const out2 = await handler({ query: 'q', type: 'feedback' });
    if (!isRecord(out2)) throw new Error('out2 not record');
    expect(out2.totalScanned).toBe(3);

    // Threshold filter: same.
    const out3 = await handler({ query: 'q', threshold: 1.5 });
    if (!isRecord(out3)) throw new Error('out3 not record');
    expect(out3.totalScanned).toBe(3);

    // Limit: same.
    const out4 = await handler({ query: 'q', limit: 1 });
    if (!isRecord(out4)) throw new Error('out4 not record');
    expect(out4.totalScanned).toBe(3);
  });
});

// --------------------------------------------------------------------------
// ac-1: tool-definitions wiring sanity
// --------------------------------------------------------------------------

describe('ac-1: buildToolDefinitions surfaces real memory_search', () => {
  it('buildToolDefinitions returns a memory_search definition whose handler is NOT the not-implemented stub when the real handler is wired', async () => {
    const store = makeStore();
    await store.scan();
    const handlers = createDefaultHandlers({ store });
    const defs = buildToolDefinitions(handlers);
    const def = findDef(defs, 'memory_search');
    let stubMessage: string | null = null;
    try {
      await def.handler({ query: 'x' });
    } catch (err) {
      stubMessage = err instanceof Error ? err.message : String(err);
    }
    expect(stubMessage).not.toBe('not implemented');
  });
});

// --------------------------------------------------------------------------
// COMMONPLACE_DEFAULT_LIMIT honoured by memory_search
// --------------------------------------------------------------------------

/**
 * Populate the store with `count` distinct memories so search has room to
 * return more than `DEFAULT_LIMIT` hits when no slice is applied.
 */
const populateStore = async (store: MemoryStore, count: number): Promise<void> => {
  for (let i = 0; i < count; i++) {
    await store.save({
      name: `entry_${i}`,
      type: 'reference',
      description: `entry ${i}`,
      body: `body ${i}`,
    });
  }
};

describe('memory_search honours COMMONPLACE_DEFAULT_LIMIT when caller omits limit', () => {
  it('memory_search uses COMMONPLACE_DEFAULT_LIMIT when the caller omits limit', async () => {
    const store = makeStore();
    await store.scan();
    await populateStore(store, 7);
    const defaultLimit = resolveDefaultLimit({ [ENV_DEFAULT_LIMIT]: '3' });
    const handler = createMemorySearchHandler({ store, defaultLimit });
    const out = await handler({ query: 'q' });
    if (!isRecord(out)) throw new Error('not record');
    const matches = out.matches as unknown[];
    expect(Array.isArray(matches)).toBe(true);
    expect((matches as unknown[]).length).toBeLessThanOrEqual(3);
    // The store has 7 entries; the env-resolved limit (3) wins over the
    // built-in default (5). A slice longer than 3 would mean the env var
    // was ignored.
    expect((matches as unknown[]).length).toBe(3);
  });

  it('memory_search prefers the caller-supplied limit over COMMONPLACE_DEFAULT_LIMIT when both are set', async () => {
    const store = makeStore();
    await store.scan();
    await populateStore(store, 7);
    const defaultLimit = resolveDefaultLimit({ [ENV_DEFAULT_LIMIT]: '3' });
    const handler = createMemorySearchHandler({ store, defaultLimit });
    const out = await handler({ query: 'q', limit: 2 });
    if (!isRecord(out)) throw new Error('not record');
    const matches = out.matches as unknown[];
    expect((matches as unknown[]).length).toBe(2);
  });

  it('memory_search falls back to the built-in default (5) when neither caller limit nor COMMONPLACE_DEFAULT_LIMIT is set', async () => {
    const store = makeStore();
    await store.scan();
    await populateStore(store, 9);
    // No defaultLimit option supplied -- the bin would resolve this from
    // an unset env var to the built-in default; we mirror that here.
    const handler = createMemorySearchHandler({ store });
    const out = await handler({ query: 'q' });
    if (!isRecord(out)) throw new Error('not record');
    const matches = out.matches as unknown[];
    expect((matches as unknown[]).length).toBe(DEFAULT_LIMIT);
    expect(DEFAULT_LIMIT).toBe(5);
  });

  it('memory_search rejects a non-integer / negative / NaN COMMONPLACE_DEFAULT_LIMIT with a clear error and does not silently coerce', () => {
    const cases = ['abc', '-1', '0', '10.5', 'NaN', 'Infinity'];
    for (const value of cases) {
      let msg = '';
      try {
        resolveDefaultLimit({ [ENV_DEFAULT_LIMIT]: value });
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      expect(msg, `expected rejection for ${JSON.stringify(value)}`).toContain(ENV_DEFAULT_LIMIT);
      expect(msg, `expected rejection for ${JSON.stringify(value)}`).toContain('positive integer');
      expect(
        msg,
        `expected rejection to name the offending value ${JSON.stringify(value)}`,
      ).toContain(value);
    }
  });
});

describe('memory_search slice honours env-resolved default limit on populated stores', () => {
  it("memory_search with env.COMMONPLACE_DEFAULT_LIMIT='3' and no caller limit returns at most 3 hits when the store has more than 3 entries", async () => {
    const store = makeStore();
    await store.scan();
    await populateStore(store, 8);
    const defaultLimit = resolveDefaultLimit({ [ENV_DEFAULT_LIMIT]: '3' });
    const handler = createMemorySearchHandler({ store, defaultLimit });
    const out = await handler({ query: 'q' });
    if (!isRecord(out)) throw new Error('not record');
    const matches = out.matches as unknown[];
    expect((matches as unknown[]).length).toBeLessThanOrEqual(3);
    expect((matches as unknown[]).length).toBe(3);
  });
});
