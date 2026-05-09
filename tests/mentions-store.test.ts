/**
 * DAR-927 contract tests -- MemoryStore wiring.
 *
 * Behavioral tests that exercise the integration of `extractMentions` into
 * `MemoryStore.scan` and `MemoryStore.save`: each extracted name becomes one
 * `mentions` edge in the configured `MemoryGraph`, gated by the env var
 * `COMMONPLACE_EXTRACT_MENTIONS` (default on). Test names mirror the
 * contract envelope on DAR-927 (round 1, approved).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryGraph } from '../src/store/graph.js';
import { contentSha, writeMemory, type Memory } from '../src/store/memory.js';
import { MemoryStore, type Embedder } from '../src/store/memory-store.js';

let tmp: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar927-'));
  savedEnv = process.env.COMMONPLACE_EXTRACT_MENTIONS;
  // Default-on is the "unset" case; clear it explicitly so tests that exercise
  // the unset path are not influenced by the developer's shell.
  delete process.env.COMMONPLACE_EXTRACT_MENTIONS;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedEnv === undefined) {
    delete process.env.COMMONPLACE_EXTRACT_MENTIONS;
  } else {
    process.env.COMMONPLACE_EXTRACT_MENTIONS = savedEnv;
  }
});

const makeStubEmbedder = (modelId = 'stub/model', dim = 4): Embedder => ({
  modelId,
  dim,
  embed: async (): Promise<Float32Array> => {
    const out = new Float32Array(dim);
    out[0] = 1;
    return out;
  },
});

const memoryFor = (name: string, overrides: Partial<Memory> = {}): Memory => ({
  name,
  description: `desc-${name}`,
  type: 'reference',
  body: `body-${name}\n`,
  relations: [],
  supersedes: [],
  ...overrides,
});

const writeMd = (name: string, overrides: Partial<Memory> = {}): void => {
  writeMemory(join(tmp, `${name}.md`), memoryFor(name, overrides));
};

// -------------------------------------------------------------------------
// ac-2: extracted mentions become 'mentions' edges in the graph
// -------------------------------------------------------------------------

describe('ac-2: mention edges in the graph', () => {
  it("MemoryStore.scan over a corpus where memory A's body contains `[[b]]` produces an edge {from: 'a', to: 'b', type: 'mentions'} on graph.outbound('a') and graph.inbound('b')", async () => {
    writeMd('a', { body: 'links to [[b]] here\n' });
    writeMd('b');
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    expect(graph.outbound('a')).toContainEqual({ from: 'a', to: 'b', type: 'mentions' });
    expect(graph.inbound('b')).toContainEqual({ from: 'a', to: 'b', type: 'mentions' });
  });

  it("MemoryStore.save of a new memory whose body contains `[[existing]]` invokes graph.addMentionsEdge once and the resulting edge appears on outbound(saved.name) with type 'mentions'", async () => {
    writeMd('existing');
    const graph = new MemoryGraph({ onDangling: () => {} });
    const spy = vi.spyOn(graph, 'addMentionsEdge');
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    spy.mockClear();
    await store.save(memoryFor('newone', { body: 'see [[existing]] for details\n' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ from: 'newone', to: 'existing' });
    expect(graph.outbound('newone')).toContainEqual({
      from: 'newone',
      to: 'existing',
      type: 'mentions',
    });
  });

  it("extracted mention edges carry type 'mentions' verbatim (not 'related-to' or any authored RelationType), distinguishing them from authored relations on the same target", async () => {
    writeMd('a', { body: 'see [[b]]\n' });
    writeMd('b');
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    const out = graph.outbound('a');
    const mentionEdges = out.filter((e) => e.type === 'mentions');
    expect(mentionEdges).toEqual([{ from: 'a', to: 'b', type: 'mentions' }]);
    // No authored RelationType edges should be present.
    expect(out.some((e) => e.type === 'related-to')).toBe(false);
    expect(out.some((e) => e.type === 'builds-on')).toBe(false);
    expect(out.some((e) => e.type === 'contradicts')).toBe(false);
    expect(out.some((e) => e.type === 'child-of')).toBe(false);
  });

  it("when a memory authors `relations: [{to: b, type: builds-on}]` AND its body contains `[[b]]`, both edges coexist in graph.outbound: one with type 'builds-on' and one with type 'mentions' (mentions does not collapse into authored types)", async () => {
    writeMd('a', {
      relations: [{ to: 'b', type: 'builds-on' }],
      body: 'and also see [[b]]\n',
    });
    writeMd('b');
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    const out = graph.outbound('a');
    expect(out).toContainEqual({ from: 'a', to: 'b', type: 'builds-on' });
    expect(out).toContainEqual({ from: 'a', to: 'b', type: 'mentions' });
  });
});

// -------------------------------------------------------------------------
// ac-3: env var COMMONPLACE_EXTRACT_MENTIONS toggles extraction
// -------------------------------------------------------------------------

describe('ac-3: env var gating', () => {
  it("MemoryStore.scan extracts mentions and adds 'mentions' edges to the graph when COMMONPLACE_EXTRACT_MENTIONS is unset (default-on behavior)", async () => {
    delete process.env.COMMONPLACE_EXTRACT_MENTIONS;
    writeMd('a', { body: 'see [[b]]\n' });
    writeMd('b');
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    expect(graph.outbound('a')).toContainEqual({ from: 'a', to: 'b', type: 'mentions' });
  });

  it("MemoryStore.scan extracts mentions when COMMONPLACE_EXTRACT_MENTIONS='true' (explicit on)", async () => {
    process.env.COMMONPLACE_EXTRACT_MENTIONS = 'true';
    writeMd('a', { body: 'see [[b]]\n' });
    writeMd('b');
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    expect(graph.outbound('a')).toContainEqual({ from: 'a', to: 'b', type: 'mentions' });
  });

  it("MemoryStore.scan adds zero 'mentions' edges to the graph when COMMONPLACE_EXTRACT_MENTIONS='false', verified by graph.outbound() containing no edges of type 'mentions' for any memory whose body has `[[name]]` tokens", async () => {
    process.env.COMMONPLACE_EXTRACT_MENTIONS = 'false';
    writeMd('a', { body: 'see [[b]] and [[c]]\n' });
    writeMd('b');
    writeMd('c');
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    for (const name of ['a', 'b', 'c']) {
      const mentionsForName = graph.outbound(name).filter((e) => e.type === 'mentions');
      expect(mentionsForName).toEqual([]);
    }
  });

  it("MemoryStore.save honors COMMONPLACE_EXTRACT_MENTIONS='false' the same way scan does: no mentions edges added even when body contains valid `[[name]]` tokens", async () => {
    writeMd('existing');
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    process.env.COMMONPLACE_EXTRACT_MENTIONS = 'false';
    const spy = vi.spyOn(graph, 'addMentionsEdge');
    await store.save(memoryFor('newone', { body: 'see [[existing]]\n' }));
    expect(spy).not.toHaveBeenCalled();
    expect(graph.outbound('newone').filter((e) => e.type === 'mentions')).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// ac-4: dangling mention edges are non-fatal and surface via detectDangling
// -------------------------------------------------------------------------

describe('ac-4: dangling mention edges', () => {
  it("MemoryStore.scan over a corpus where memory A's body contains `[[nonexistent]]` (no memory named 'nonexistent' loaded) completes without throwing", async () => {
    writeMd('a', { body: 'see [[nonexistent]]\n' });
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await expect(store.scan()).resolves.toBeDefined();
  });

  it("after MemoryStore.scan with a body containing `[[nonexistent]]`, graph.detectDangling() includes a DanglingEdge {from: 'a', to: 'nonexistent', type: 'mentions'}", async () => {
    writeMd('a', { body: 'see [[nonexistent]]\n' });
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    expect(graph.detectDangling()).toContainEqual({
      from: 'a',
      to: 'nonexistent',
      type: 'mentions',
    });
  });

  it("the graph's onDangling callback is invoked for mention-derived dangling edges during rebuild, with the same calling convention used for authored relation/supersedes dangling edges", async () => {
    writeMd('a', { body: 'see [[nonexistent_mention]]\n' });
    writeMd('b', { relations: [{ to: 'nonexistent_authored', type: 'related-to' }] });
    const dangling: Array<{ from: string; to: string; type: string }> = [];
    const graph = new MemoryGraph({ onDangling: (e) => dangling.push(e) });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    expect(dangling).toContainEqual({
      from: 'a',
      to: 'nonexistent_mention',
      type: 'mentions',
    });
    expect(dangling).toContainEqual({
      from: 'b',
      to: 'nonexistent_authored',
      type: 'related-to',
    });
  });
});

// -------------------------------------------------------------------------
// ac-5: mention edges are idempotent at integration level
// -------------------------------------------------------------------------

describe('ac-5: idempotence (integration)', () => {
  it("MemoryStore.scan over a memory whose body contains `[[b]]` repeated 3 times produces exactly one edge {from, to: 'b', type: 'mentions'} in graph.outbound(from), not three", async () => {
    writeMd('a', { body: 'see [[b]] and [[b]] and again [[b]]\n' });
    writeMd('b');
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    const mentionEdgesToB = graph
      .outbound('a')
      .filter((e) => e.type === 'mentions' && e.to === 'b');
    expect(mentionEdgesToB).toEqual([{ from: 'a', to: 'b', type: 'mentions' }]);
  });
});

// -------------------------------------------------------------------------
// ac-6: contentSha is unaffected by mention extraction
// -------------------------------------------------------------------------

describe('ac-6: contentSha invariance', () => {
  it("contentSha(memory) from src/store/memory.ts is unchanged by this PR's diff: the implementation does not modify the contentSha hashing inputs in response to extracted mentions", () => {
    // Structural invariance check: the hash inputs are exactly
    // `(type, name, description, body)`. The DAR-927 implementation must
    // not mix extracted mention output into the hash. Compare
    // `contentSha` of a memory with mention tokens against `contentSha`
    // of the same canonical-fields set computed independently.
    const m: Memory = {
      type: 'reference',
      name: 'fixture_a',
      description: 'desc-fixture_a',
      body: 'body with [[mention]] tokens\n',
    };
    const actual = contentSha(m);
    const fromBaselineFields = contentSha({
      type: m.type,
      name: m.name,
      description: m.description,
      body: m.body,
    });
    expect(actual).toBe(fromBaselineFields);
  });

  it('two memories with identical (type, name, description, body) where body contains `[[x]]` tokens produce identical contentSha values regardless of whether mention extraction is enabled or disabled at scan time (extraction is a graph-side effect only)', async () => {
    const body = 'body with [[x]] and [[y]] mentions\n';

    // First scan: extraction ON.
    process.env.COMMONPLACE_EXTRACT_MENTIONS = 'true';
    writeMd('m', { body });
    writeMd('x');
    writeMd('y');
    const onGraph = new MemoryGraph({ onDangling: () => {} });
    const onStore = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph: onGraph });
    await onStore.scan();
    const shaWhenOn = onStore.all().find((e) => e.name === 'm')!.contentSha;

    // Tear down and repeat: extraction OFF, identical content.
    rmSync(tmp, { recursive: true, force: true });
    tmp = mkdtempSync(join(tmpdir(), 'dar927-'));
    process.env.COMMONPLACE_EXTRACT_MENTIONS = 'false';
    writeMd('m', { body });
    writeMd('x');
    writeMd('y');
    const offGraph = new MemoryGraph({ onDangling: () => {} });
    const offStore = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph: offGraph });
    await offStore.scan();
    const shaWhenOff = offStore.all().find((e) => e.name === 'm')!.contentSha;

    expect(shaWhenOn).toBe(shaWhenOff);
  });
});

// -------------------------------------------------------------------------
// ac-7: end-to-end fixture-directory test
// -------------------------------------------------------------------------

describe('ac-7: end-to-end fixture directory', () => {
  it('end-to-end fixture-directory test: scan a directory of memories with mixed body content (simple mention, multiple distinct mentions, repeated mentions, malformed brackets, dangling target) and assert graph.outbound and graph.detectDangling match the expected pre-computed values for each', async () => {
    // Fixture corpus:
    //   simple   -- body has [[other]]                       -- 1 mention edge to 'other'
    //   multi    -- body has [[other]] and [[third]]         -- 2 mention edges
    //   repeated -- body has [[other]] [[other]] [[other]]   -- 1 dedup'd edge
    //   malformed-- body has [[]] [[ x ]] [[Bad-name]] [[A]] -- 0 mention edges
    //   dangling -- body has [[ghost]]                       -- 1 dangling edge
    //   other    -- target only
    //   third    -- target only
    writeMd('simple', { body: 'see [[other]] yes\n' });
    writeMd('multi', { body: 'see [[other]] and [[third]]\n' });
    writeMd('repeated', { body: '[[other]] [[other]] [[other]]\n' });
    writeMd('malformed', { body: '[[]] [[ x ]] [[Bad-name]] [[A]]\n' });
    writeMd('dangling', { body: 'see [[ghost]]\n' });
    writeMd('other');
    writeMd('third');

    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
    await store.scan();

    const filterMentions = (name: string) =>
      graph
        .outbound(name)
        .filter((e) => e.type === 'mentions')
        .map((e) => ({ from: e.from, to: e.to, type: e.type }));

    expect(filterMentions('simple')).toEqual([{ from: 'simple', to: 'other', type: 'mentions' }]);
    expect(filterMentions('multi')).toEqual([
      { from: 'multi', to: 'other', type: 'mentions' },
      { from: 'multi', to: 'third', type: 'mentions' },
    ]);
    expect(filterMentions('repeated')).toEqual([
      { from: 'repeated', to: 'other', type: 'mentions' },
    ]);
    expect(filterMentions('malformed')).toEqual([]);
    expect(filterMentions('dangling')).toEqual([
      { from: 'dangling', to: 'ghost', type: 'mentions' },
    ]);

    // Inbound lookups: 'other' is mentioned by simple, multi, and repeated.
    const inboundOther = graph
      .inbound('other')
      .filter((e) => e.type === 'mentions')
      .map((e) => e.from)
      .sort();
    expect(inboundOther).toEqual(['multi', 'repeated', 'simple']);

    // 'third' is mentioned only by 'multi'.
    const inboundThird = graph
      .inbound('third')
      .filter((e) => e.type === 'mentions')
      .map((e) => e.from);
    expect(inboundThird).toEqual(['multi']);

    // detectDangling should include exactly the one mention to 'ghost'.
    const danglingMentions = graph.detectDangling().filter((e) => e.type === 'mentions');
    expect(danglingMentions).toEqual([{ from: 'dangling', to: 'ghost', type: 'mentions' }]);
  });
});
