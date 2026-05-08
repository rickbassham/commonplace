/**
 * DAR-916 contract tests.
 *
 * Behavioral tests for the MemoryStore class -- the in-memory vector index
 * backed by `<dir>/*.md` + `<name>.embedding` sidecar files.
 *
 * Test names mirror the contract envelope on DAR-916 (round 1, approved).
 *
 * The Embedder dependency is stubbed (no real model load) so these tests
 * run hermetically and quickly. The stub satisfies the structural contract
 * the MemoryStore depends on: `modelId`, `dim`, and `embed(text)`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { contentSha, writeMemory, type Memory } from '../src/store/memory.js';
import { encodeSidecar } from '../src/store/sidecar.js';
import { MemoryStore, type MemoryEntry } from '../src/store/memory-store.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar916-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Minimal Embedder stub matching the structural contract MemoryStore needs
 * (`modelId`, `dim`, and `embed(text)`). Each instance counts how many times
 * `embed()` has been invoked and returns a deterministic Float32Array whose
 * first slot encodes the call number, so tests can assert provenance.
 */
const makeStubEmbedder = (
  modelId = 'Xenova/bge-base-en-v1.5',
  dim = 4,
): {
  modelId: string;
  dim: number;
  embed: (text: string) => Promise<Float32Array>;
  callCount: () => number;
  lastInputs: () => string[];
} => {
  let callCount = 0;
  const inputs: string[] = [];
  const embed = vi.fn(async (text: string): Promise<Float32Array> => {
    callCount += 1;
    inputs.push(text);
    const out = new Float32Array(dim);
    out[0] = callCount;
    for (let i = 1; i < dim; i++) out[i] = i / 10;
    return out;
  });
  return {
    modelId,
    dim,
    embed,
    callCount: () => callCount,
    lastInputs: () => inputs.slice(),
  };
};

const makeMemory = (name: string, body = `body of ${name}`): Memory => ({
  name,
  description: `description for ${name}`,
  type: 'reference',
  body,
});

const writeMemoryFile = (dir: string, m: Memory): string => {
  const p = join(dir, `${m.name}.md`);
  writeMemory(p, m);
  return p;
};

const writeValidSidecar = (
  dir: string,
  m: Memory,
  modelId: string,
  dim: number,
  vector: Float32Array,
): string => {
  const p = join(dir, `${m.name}.embedding`);
  const buf = encodeSidecar({ modelId, dim, contentSha: contentSha(m), vector });
  writeFileSync(p, buf);
  return p;
};

// -------------------------------------------------------------------------
// ac-1: class shape and TypeScript surface
// -------------------------------------------------------------------------

describe('ac-1: class shape', () => {
  it('MemoryStore is a class constructible with { dir, embedder } and exposes scan / save / delete / all as own methods', () => {
    const embedder = makeStubEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    expect(store).toBeInstanceOf(MemoryStore);
    expect(typeof store.scan).toBe('function');
    expect(typeof store.save).toBe('function');
    expect(typeof store.delete).toBe('function');
    expect(typeof store.all).toBe('function');
  });

  it('constructor records dir and embedder without performing any filesystem I/O or embedder calls', () => {
    const embedder = makeStubEmbedder();
    // A non-existent directory must not raise during construction.
    const nonExistent = join(tmp, 'does-not-exist');
    const store = new MemoryStore({ dir: nonExistent, embedder });
    expect(store).toBeInstanceOf(MemoryStore);
    expect(embedder.callCount()).toBe(0);
    // all() works on a fresh store too -- another way to confirm no I/O.
    expect(store.all()).toEqual([]);
  });

  it('scan() returns a Promise resolving to an object with numeric `loaded` and `reembedded` fields', async () => {
    const embedder = makeStubEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const result = store.scan();
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(typeof resolved.loaded).toBe('number');
    expect(typeof resolved.reembedded).toBe('number');
  });

  it('all() returns an array of MemoryEntry objects whose shape includes the parsed memory fields plus the loaded vector and contentSha', async () => {
    const embedder = makeStubEmbedder();
    const m = makeMemory('alpha');
    writeMemoryFile(tmp, m);
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();
    const entries = store.all();
    expect(entries).toHaveLength(1);
    const [entry] = entries as [MemoryEntry];
    expect(entry.name).toBe('alpha');
    expect(entry.description).toBe('description for alpha');
    expect(entry.type).toBe('reference');
    expect(entry.body).toBe('body of alpha');
    expect(entry.relations).toEqual([]);
    expect(entry.supersedes).toEqual([]);
    expect(entry.vector).toBeInstanceOf(Float32Array);
    expect(entry.vector.length).toBe(embedder.dim);
    expect(entry.contentSha).toBe(contentSha(m));
    expect(entry.modelId).toBe(embedder.modelId);
    expect(entry.dim).toBe(embedder.dim);
  });

  it('all() returns an empty array before scan() has been called', () => {
    const embedder = makeStubEmbedder();
    writeMemoryFile(tmp, makeMemory('alpha'));
    writeMemoryFile(tmp, makeMemory('beta'));
    const store = new MemoryStore({ dir: tmp, embedder });
    expect(store.all()).toEqual([]);
  });

  it('all() return type is ReadonlyArray<MemoryEntry> -- mutating methods are not on the type (regression: PR #6 f-2)', async () => {
    const embedder = makeStubEmbedder();
    writeMemoryFile(tmp, makeMemory('alpha'));
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();

    const entries = store.all();
    // ReadonlyArray<T> exposes iteration / read accessors but not push/splice/sort.
    // These properties must be `undefined` on the type-narrowed result; the
    // runtime array still has them, but the public surface promised by all()
    // doesn't. Use `in` so the test exercises the type, not the runtime.
    type AllReturn = ReturnType<MemoryStore['all']>;
    type HasPush = 'push' extends keyof AllReturn ? true : false;
    type HasSplice = 'splice' extends keyof AllReturn ? true : false;
    type HasSort = 'sort' extends keyof AllReturn ? true : false;
    const hasPush: HasPush = false;
    const hasSplice: HasSplice = false;
    const hasSort: HasSort = false;
    expect(hasPush).toBe(false);
    expect(hasSplice).toBe(false);
    expect(hasSort).toBe(false);
    // And the runtime contract still works: read access, length, iteration.
    expect(entries.length).toBe(1);
    expect(entries[0]?.name).toBe('alpha');
    expect([...entries].map((e) => e.name)).toEqual(['alpha']);
  });
});

// -------------------------------------------------------------------------
// ac-2: scan is idempotent on a clean directory (no rewrites)
// -------------------------------------------------------------------------

describe('ac-2: scan idempotency', () => {
  it('scan() over a directory whose .md files all have valid matching sidecars writes zero bytes to any .embedding file (verified by mtime comparison before/after)', async () => {
    const embedder = makeStubEmbedder();
    const memories = [makeMemory('one'), makeMemory('two'), makeMemory('three')];
    for (const m of memories) {
      writeMemoryFile(tmp, m);
      const v = new Float32Array(embedder.dim);
      v[0] = 99;
      writeValidSidecar(tmp, m, embedder.modelId, embedder.dim, v);
    }

    const sidecarPaths = memories.map((m) => join(tmp, `${m.name}.embedding`));
    const beforeMtimes = sidecarPaths.map((p) => statSync(p, { bigint: true }).mtimeNs);
    const beforeBytes = sidecarPaths.map((p) => readFileSync(p));

    // Pause long enough that any rewrite would update mtime detectably.
    await delay(20);

    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();

    const afterMtimes = sidecarPaths.map((p) => statSync(p, { bigint: true }).mtimeNs);
    const afterBytes = sidecarPaths.map((p) => readFileSync(p));

    for (let i = 0; i < sidecarPaths.length; i++) {
      expect(afterMtimes[i]).toBe(beforeMtimes[i]);
      expect(afterBytes[i]!.equals(beforeBytes[i]!)).toBe(true);
    }
  });

  it('second scan() on the same clean directory reports reembedded:0 and loaded equal to the number of .md files', async () => {
    const embedder = makeStubEmbedder();
    const names = ['a', 'b', 'c', 'd'];
    for (const name of names) writeMemoryFile(tmp, makeMemory(name));

    const store = new MemoryStore({ dir: tmp, embedder });
    const first = await store.scan();
    // First scan re-embeds because no sidecars exist yet.
    expect(first.loaded).toBe(names.length);
    expect(first.reembedded).toBe(names.length);

    const second = await store.scan();
    expect(second.reembedded).toBe(0);
    expect(second.loaded).toBe(names.length);
  });

  it('scan() does not invoke embedder.embed when every sidecar has matching magic, version, model id, dim, and contentSha', async () => {
    const embedder = makeStubEmbedder();
    const memories = [makeMemory('one'), makeMemory('two')];
    for (const m of memories) {
      writeMemoryFile(tmp, m);
      writeValidSidecar(tmp, m, embedder.modelId, embedder.dim, new Float32Array(embedder.dim));
    }
    const before = embedder.callCount();
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();
    expect(embedder.callCount()).toBe(before);
  });
});

// -------------------------------------------------------------------------
// ac-3: stale sidecars are detected
// -------------------------------------------------------------------------

describe('ac-3: stale sidecar detection', () => {
  it("scan() re-embeds and rewrites the sidecar when the .md body has been edited so its contentSha no longer matches the sidecar's contentSha", async () => {
    const embedder = makeStubEmbedder();
    const original = makeMemory('alpha', 'original body');
    writeMemoryFile(tmp, original);
    writeValidSidecar(
      tmp,
      original,
      embedder.modelId,
      embedder.dim,
      new Float32Array(embedder.dim),
    );

    // Edit the .md body so contentSha changes.
    const edited = makeMemory('alpha', 'edited body, totally different');
    writeMemoryFile(tmp, edited);

    const store = new MemoryStore({ dir: tmp, embedder });
    const result = await store.scan();
    expect(result.reembedded).toBe(1);
    expect(result.loaded).toBe(1);

    // Sidecar must now reflect the new contentSha.
    const sidecarBytes = readFileSync(join(tmp, 'alpha.embedding'));
    const sha = contentSha(edited);
    expect(sidecarBytes.includes(Buffer.from(sha, 'hex'))).toBe(true);
  });

  it("scan() re-embeds and rewrites the sidecar when the configured embedder.modelId differs from the sidecar's modelId", async () => {
    const oldModel = makeStubEmbedder('old/model-v1');
    const m = makeMemory('alpha');
    writeMemoryFile(tmp, m);
    writeValidSidecar(tmp, m, oldModel.modelId, oldModel.dim, new Float32Array(oldModel.dim));

    const newModel = makeStubEmbedder('new/model-v2', oldModel.dim);
    const store = new MemoryStore({ dir: tmp, embedder: newModel });
    const result = await store.scan();
    expect(result.reembedded).toBe(1);
    expect(newModel.callCount()).toBe(1);
  });

  it("scan() re-embeds and rewrites the sidecar when the configured embedder.dim differs from the sidecar's dim", async () => {
    const small = makeStubEmbedder('Xenova/bge-base-en-v1.5', 4);
    const m = makeMemory('alpha');
    writeMemoryFile(tmp, m);
    writeValidSidecar(tmp, m, small.modelId, small.dim, new Float32Array(small.dim));

    const big = makeStubEmbedder('Xenova/bge-base-en-v1.5', 8);
    const store = new MemoryStore({ dir: tmp, embedder: big });
    const result = await store.scan();
    expect(result.reembedded).toBe(1);
    expect(big.callCount()).toBe(1);
  });

  it('scan() re-embeds and rewrites the sidecar when the .embedding file is missing for an existing .md', async () => {
    const embedder = makeStubEmbedder();
    const m = makeMemory('alpha');
    writeMemoryFile(tmp, m);
    // No sidecar written.

    const store = new MemoryStore({ dir: tmp, embedder });
    const result = await store.scan();
    expect(result.reembedded).toBe(1);
    expect(result.loaded).toBe(1);
    expect(existsSync(join(tmp, 'alpha.embedding'))).toBe(true);
  });

  it('scan() re-embeds and rewrites the sidecar when the existing sidecar bytes are corrupt (decodeSidecar throws)', async () => {
    const embedder = makeStubEmbedder();
    const m = makeMemory('alpha');
    writeMemoryFile(tmp, m);
    // Garbage bytes -- bad magic, decodeSidecar will throw.
    writeFileSync(join(tmp, 'alpha.embedding'), Buffer.from('not a valid sidecar'));

    const store = new MemoryStore({ dir: tmp, embedder });
    const result = await store.scan();
    expect(result.reembedded).toBe(1);
    expect(result.loaded).toBe(1);
    // Sidecar should now be valid: starts with CMEM magic.
    const fixed = readFileSync(join(tmp, 'alpha.embedding'));
    expect(fixed.subarray(0, 4).toString('ascii')).toBe('CMEM');
  });

  it('scan() propagates real readFileSync I/O errors instead of treating them as corrupt sidecars (regression: PR #6 f-1)', async () => {
    const embedder = makeStubEmbedder();
    const m = makeMemory('alpha');
    writeMemoryFile(tmp, m);
    // Create a *directory* at the sidecar path. existsSync() returns true,
    // but readFileSync() will throw EISDIR -- a real I/O error, not a decode
    // failure. The narrowed catch must let this propagate; otherwise the
    // store would silently re-embed and overwrite, masking the operator
    // problem (e.g. someone mis-managed the directory layout).
    mkdirSync(join(tmp, 'alpha.embedding'));

    const store = new MemoryStore({ dir: tmp, embedder });
    await expect(store.scan()).rejects.toThrow(/EISDIR|illegal operation on a directory/i);
  });

  it('scan() returns reembedded equal to the number of stale-or-missing sidecars and loaded equal to the total .md count after the run', async () => {
    const embedder = makeStubEmbedder();

    // Four memories: 1 fresh-and-valid, 1 missing sidecar, 1 corrupt sidecar, 1 stale sha.
    const fresh = makeMemory('fresh');
    writeMemoryFile(tmp, fresh);
    writeValidSidecar(tmp, fresh, embedder.modelId, embedder.dim, new Float32Array(embedder.dim));

    const missing = makeMemory('missing');
    writeMemoryFile(tmp, missing);

    const corrupt = makeMemory('corrupt');
    writeMemoryFile(tmp, corrupt);
    writeFileSync(join(tmp, 'corrupt.embedding'), Buffer.from('garbage'));

    const stale = makeMemory('stale', 'old body');
    writeMemoryFile(tmp, stale);
    writeValidSidecar(tmp, stale, embedder.modelId, embedder.dim, new Float32Array(embedder.dim));
    // Now overwrite the .md with new body, leaving the sidecar with old sha.
    writeMemoryFile(tmp, makeMemory('stale', 'new body'));

    const store = new MemoryStore({ dir: tmp, embedder });
    const result = await store.scan();
    expect(result.loaded).toBe(4);
    expect(result.reembedded).toBe(3);
  });
});

// -------------------------------------------------------------------------
// ac-4: save refuses to overwrite an existing memory
// -------------------------------------------------------------------------

describe('ac-4: save refuses overwrite', () => {
  it('save({ name }) rejects with a clear error when a memory with that name is already present in the in-memory index after scan()', async () => {
    const embedder = makeStubEmbedder();
    const m = makeMemory('alpha');
    writeMemoryFile(tmp, m);
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();

    await expect(store.save(makeMemory('alpha', 'new body'))).rejects.toThrow(/alpha/);
  });

  it('save({ name }) rejects with a clear error when <dir>/<name>.md already exists on disk even if the in-memory index does not yet contain it', async () => {
    const embedder = makeStubEmbedder();
    const existing = makeMemory('alpha');
    writeMemoryFile(tmp, existing);
    // Note: do NOT call scan() -- in-memory index empty but file exists on disk.
    const store = new MemoryStore({ dir: tmp, embedder });

    await expect(store.save(makeMemory('alpha', 'something else'))).rejects.toThrow(/alpha/);
    expect(store.all()).toEqual([]);
  });

  it('save() rejection on duplicate name leaves both .md and .embedding files for the existing entry untouched (byte-equal before/after)', async () => {
    const embedder = makeStubEmbedder();
    const m = makeMemory('alpha');
    writeMemoryFile(tmp, m);
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan(); // Writes sidecar.

    const mdPath = join(tmp, 'alpha.md');
    const sidePath = join(tmp, 'alpha.embedding');
    const mdBefore = readFileSync(mdPath);
    const sideBefore = readFileSync(sidePath);

    await expect(store.save(makeMemory('alpha', 'try to overwrite'))).rejects.toThrow();

    expect(readFileSync(mdPath).equals(mdBefore)).toBe(true);
    expect(readFileSync(sidePath).equals(sideBefore)).toBe(true);
  });

  it('save() rejection on duplicate name does not append a new entry to all()', async () => {
    const embedder = makeStubEmbedder();
    const m = makeMemory('alpha');
    writeMemoryFile(tmp, m);
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();
    const before = store.all().length;

    await expect(store.save(makeMemory('alpha', 'try to overwrite'))).rejects.toThrow();
    expect(store.all().length).toBe(before);
  });
});

// -------------------------------------------------------------------------
// ac-5: delete on missing name throws
// -------------------------------------------------------------------------

describe('ac-5: delete on missing name', () => {
  it('delete(name) rejects with a clear error mentioning the name when no entry with that name exists in the in-memory index', async () => {
    const embedder = makeStubEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await expect(store.delete('ghost')).rejects.toThrow(/ghost/);
  });

  it('delete(name) rejects with a clear error when the in-memory entry is absent and no <dir>/<name>.md exists on disk', async () => {
    const embedder = makeStubEmbedder();
    // Create some unrelated memory so directory isn't empty.
    writeMemoryFile(tmp, makeMemory('other'));
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();
    await expect(store.delete('ghost')).rejects.toThrow(/ghost/);
  });

  it('delete(name) leaves all() unchanged when it rejects', async () => {
    const embedder = makeStubEmbedder();
    writeMemoryFile(tmp, makeMemory('alpha'));
    writeMemoryFile(tmp, makeMemory('beta'));
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan();
    const before = store
      .all()
      .map((e) => e.name)
      .sort();
    await expect(store.delete('ghost')).rejects.toThrow();
    const after = store
      .all()
      .map((e) => e.name)
      .sort();
    expect(after).toEqual(before);
  });
});

// -------------------------------------------------------------------------
// ac-6: scenario tests
// -------------------------------------------------------------------------

describe('ac-6: scenarios', () => {
  it('cold-scan scenario: scan() over a directory of N .md files with zero .embedding sidecars writes N valid sidecars and reports reembedded:N, loaded:N', async () => {
    const embedder = makeStubEmbedder();
    const names = ['m1', 'm2', 'm3'];
    for (const n of names) writeMemoryFile(tmp, makeMemory(n));

    const store = new MemoryStore({ dir: tmp, embedder });
    const result = await store.scan();
    expect(result.loaded).toBe(names.length);
    expect(result.reembedded).toBe(names.length);

    for (const n of names) {
      const p = join(tmp, `${n}.embedding`);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p).subarray(0, 4).toString('ascii')).toBe('CMEM');
    }
  });

  it('valid-sidecar scenario: scan() over a directory where every .md has a matching valid sidecar reports reembedded:0 and rewrites no sidecar bytes', async () => {
    const embedder = makeStubEmbedder();
    const memories = [makeMemory('a'), makeMemory('b'), makeMemory('c')];
    for (const m of memories) {
      writeMemoryFile(tmp, m);
      writeValidSidecar(tmp, m, embedder.modelId, embedder.dim, new Float32Array(embedder.dim));
    }

    const sidecarPaths = memories.map((m) => join(tmp, `${m.name}.embedding`));
    const before = sidecarPaths.map((p) => readFileSync(p));
    const beforeMtimes = sidecarPaths.map((p) => statSync(p, { bigint: true }).mtimeNs);

    await delay(20);

    const store = new MemoryStore({ dir: tmp, embedder });
    const result = await store.scan();
    expect(result.reembedded).toBe(0);

    const after = sidecarPaths.map((p) => readFileSync(p));
    const afterMtimes = sidecarPaths.map((p) => statSync(p, { bigint: true }).mtimeNs);
    for (let i = 0; i < sidecarPaths.length; i++) {
      expect(after[i]!.equals(before[i]!)).toBe(true);
      expect(afterMtimes[i]).toBe(beforeMtimes[i]);
    }
  });

  it('post-edit scenario: editing a single .md body and re-running scan() re-embeds only that one file and leaves the other sidecars byte-equal', async () => {
    const embedder = makeStubEmbedder();
    const memories = [makeMemory('a'), makeMemory('b'), makeMemory('c')];
    for (const m of memories) writeMemoryFile(tmp, m);

    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan(); // Writes initial sidecars.

    const sidecarPaths = memories.map((m) => join(tmp, `${m.name}.embedding`));
    const before = sidecarPaths.map((p) => readFileSync(p));

    await delay(20);

    // Edit only b's body.
    writeMemoryFile(tmp, makeMemory('b', 'edited body of b!'));

    const callsBeforeRescan = embedder.callCount();
    const result = await store.scan();
    expect(result.reembedded).toBe(1);
    expect(embedder.callCount() - callsBeforeRescan).toBe(1);

    const after = sidecarPaths.map((p) => readFileSync(p));
    expect(after[0]!.equals(before[0]!)).toBe(true); // a unchanged
    expect(after[1]!.equals(before[1]!)).toBe(false); // b changed
    expect(after[2]!.equals(before[2]!)).toBe(true); // c unchanged
  });

  it('model-swap scenario: scanning the same directory twice with two different embedder modelIds re-embeds every sidecar on the second scan', async () => {
    const memories = [makeMemory('a'), makeMemory('b'), makeMemory('c')];
    for (const m of memories) writeMemoryFile(tmp, m);

    const first = makeStubEmbedder('model/one', 4);
    const store1 = new MemoryStore({ dir: tmp, embedder: first });
    await store1.scan();

    const second = makeStubEmbedder('model/two', 4);
    const callsBefore = second.callCount();
    const store2 = new MemoryStore({ dir: tmp, embedder: second });
    const result = await store2.scan();
    expect(result.reembedded).toBe(memories.length);
    expect(second.callCount() - callsBefore).toBe(memories.length);
  });

  it('round-trip scenario: save({name,...}) writes <name>.md and <name>.embedding, all() includes the new entry, delete(name) removes both files and the entry from all()', async () => {
    const embedder = makeStubEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.scan(); // empty dir, just to mirror real usage.

    const m = makeMemory('alpha', 'some body');
    await store.save(m);
    expect(existsSync(join(tmp, 'alpha.md'))).toBe(true);
    expect(existsSync(join(tmp, 'alpha.embedding'))).toBe(true);
    expect(store.all().map((e) => e.name)).toEqual(['alpha']);

    await store.delete('alpha');
    expect(existsSync(join(tmp, 'alpha.md'))).toBe(false);
    expect(existsSync(join(tmp, 'alpha.embedding'))).toBe(false);
    expect(store.all()).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// ac-7: save / delete mechanics
// -------------------------------------------------------------------------

describe('ac-7: save and delete mechanics', () => {
  it('save() invokes embedder.embed exactly once with the memory body and persists a sidecar whose contentSha equals contentSha(memory)', async () => {
    const embedder = makeStubEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const m = makeMemory('alpha', 'the body to embed');
    const before = embedder.callCount();
    await store.save(m);
    expect(embedder.callCount() - before).toBe(1);
    const lastInputs = embedder.lastInputs();
    expect(lastInputs[lastInputs.length - 1]).toBe(m.body);

    const sidecarBytes = readFileSync(join(tmp, 'alpha.embedding'));
    const sha = contentSha(m);
    expect(sidecarBytes.includes(Buffer.from(sha, 'hex'))).toBe(true);
  });

  it('save() appends one entry to all() whose vector matches the Float32Array returned by embedder.embed and whose modelId/dim match the embedder', async () => {
    const embedder = makeStubEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    const m = makeMemory('alpha');
    await store.save(m);

    const entries = store.all();
    expect(entries).toHaveLength(1);
    const [entry] = entries as [MemoryEntry];
    expect(entry.name).toBe('alpha');
    expect(entry.modelId).toBe(embedder.modelId);
    expect(entry.dim).toBe(embedder.dim);
    expect(entry.vector).toBeInstanceOf(Float32Array);
    expect(entry.vector.length).toBe(embedder.dim);
    // Stub embedder writes the call number into slot 0 -- 1 means first call.
    expect(entry.vector[0]).toBe(1);
  });

  it('delete(name) removes <dir>/<name>.md and <dir>/<name>.embedding from the filesystem', async () => {
    const embedder = makeStubEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.save(makeMemory('alpha'));
    expect(existsSync(join(tmp, 'alpha.md'))).toBe(true);
    expect(existsSync(join(tmp, 'alpha.embedding'))).toBe(true);

    await store.delete('alpha');
    expect(existsSync(join(tmp, 'alpha.md'))).toBe(false);
    expect(existsSync(join(tmp, 'alpha.embedding'))).toBe(false);
  });

  it('delete(name) removes the entry from all() so a subsequent save({name,...}) with the same name succeeds', async () => {
    const embedder = makeStubEmbedder();
    const store = new MemoryStore({ dir: tmp, embedder });
    await store.save(makeMemory('alpha', 'first body'));
    await store.delete('alpha');
    expect(store.all()).toEqual([]);

    await store.save(makeMemory('alpha', 'second body'));
    const entries = store.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.body).toBe('second body');
  });
});
