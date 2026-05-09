/**
 * DAR-919 unit tests: real handlers for memory_save, memory_list, memory_delete.
 *
 * These cover the in-process handler surface only -- input validation,
 * inputSchema shape, store dispatch, and return value structure. End-to-end
 * tests over the in-memory MCP transport live in
 * `server-handlers.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  createMemoryDeleteHandler,
  createMemoryListHandler,
  createMemorySaveHandler,
} from '../src/server/handlers.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar919-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
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
      // include a tiny perturbation tied to text length so different inputs
      // get different vectors; otherwise unused param triggers lint.
      for (let i = 1; i < dim; i++) out[i] = (i + (text.length % 7)) / 10;
      return out;
    },
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

// --------------------------------------------------------------------------
// ac-1: registration
// --------------------------------------------------------------------------

describe('ac-1: tool registration with real handlers', () => {
  it('buildToolDefinitions returns a definition for memory_save, memory_list, and memory_delete whose handler is NOT the not-implemented stub when DAR-919 handlers are wired', async () => {
    const store = makeStore();
    const handlers = createDefaultHandlers({ store });
    const defs = buildToolDefinitions(handlers);
    for (const name of ['memory_save', 'memory_list', 'memory_delete'] as const) {
      const def = findDef(defs, name);
      // The stub throws 'not implemented' immediately. Real handlers either
      // succeed or throw a validation-specific error -- not 'not implemented'.
      let stubMessage: string | null = null;
      try {
        await def.handler({});
      } catch (err) {
        stubMessage = err instanceof Error ? err.message : String(err);
      }
      expect(stubMessage, `${name} should not throw 'not implemented'`).not.toBe('not implemented');
    }
  });
});

// --------------------------------------------------------------------------
// ac-2: input validation
// --------------------------------------------------------------------------

describe('ac-2: memory_save inputSchema', () => {
  it("memory_save inputSchema declares required fields name, type, description, body with type='string' and type enum restricted to user|feedback|project|reference", () => {
    const defs = buildToolDefinitions();
    const def = findDef(defs, 'memory_save');
    const schema = def.inputSchema;
    expect(schema.type).toBe('object');
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    expect(props).toBeDefined();
    if (!props) throw new Error('properties missing');
    for (const field of ['name', 'description', 'body']) {
      expect(props[field]?.type, `${field}.type`).toBe('string');
    }
    expect(props.type?.type).toBe('string');
    expect(props.type?.enum).toEqual(['user', 'feedback', 'project', 'reference']);
    const required = (schema as { required?: string[] }).required ?? [];
    expect(new Set(required)).toEqual(new Set(['name', 'type', 'description', 'body']));
  });
});

describe('ac-2: memory_save handler validation', () => {
  const goodArgs = {
    name: 'foo',
    type: 'reference',
    description: 'd',
    body: 'b',
  };

  it('memory_save handler rejects a missing or non-string `name` with an error message naming the offending field', async () => {
    const store = makeStore();
    const handler = createMemorySaveHandler({ store });
    await expect(handler({ ...goodArgs, name: undefined })).rejects.toThrow(/name/);
    await expect(handler({ ...goodArgs, name: 123 })).rejects.toThrow(/name/);
  });

  it('memory_save handler rejects a `name` containing uppercase letters, hyphens, spaces, or other characters outside ^[a-z0-9_]+$ with an error referencing the allowed pattern', async () => {
    const store = makeStore();
    const handler = createMemorySaveHandler({ store });
    for (const bad of ['Foo', 'foo-bar', 'foo bar', 'foo.bar', 'FOO']) {
      const promise = handler({ ...goodArgs, name: bad });
      await expect(promise).rejects.toThrow(/\[a-z0-9_\]/);
    }
  });

  it("memory_save handler rejects a `name` containing a path separator ('/' or '\\\\') with an error explicitly mentioning path separators", async () => {
    const store = makeStore();
    const handler = createMemorySaveHandler({ store });
    await expect(handler({ ...goodArgs, name: 'foo/bar' })).rejects.toThrow(/path separator/i);
    await expect(handler({ ...goodArgs, name: 'foo\\bar' })).rejects.toThrow(/path separator/i);
  });

  it('memory_save handler rejects a `type` value not in the four-member union (user|feedback|project|reference) with an error listing the allowed values', async () => {
    const store = makeStore();
    const handler = createMemorySaveHandler({ store });
    let msg = '';
    try {
      await handler({ ...goodArgs, type: 'note' });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    for (const t of ['user', 'feedback', 'project', 'reference']) {
      expect(msg).toContain(t);
    }
  });

  it('memory_save handler rejects missing `description` and missing `body` with errors that name each missing field', async () => {
    const store = makeStore();
    const handler = createMemorySaveHandler({ store });
    await expect(handler({ ...goodArgs, description: undefined })).rejects.toThrow(/description/);
    await expect(handler({ ...goodArgs, body: undefined })).rejects.toThrow(/body/);
  });

  it('memory_save handler rejects a duplicate `name` (entry already exists in the store) with a clear error message containing the offending name', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemorySaveHandler({ store });
    await handler({ ...goodArgs, name: 'dupe' });
    await expect(handler({ ...goodArgs, name: 'dupe' })).rejects.toThrow(/dupe/);
  });
});

describe('ac-2: memory_list inputSchema', () => {
  it('memory_list inputSchema declares an optional `type` property restricted to the four-member memory-type enum and no required fields', () => {
    const defs = buildToolDefinitions();
    const def = findDef(defs, 'memory_list');
    const schema = def.inputSchema;
    expect(schema.type).toBe('object');
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    expect(props).toBeDefined();
    if (!props) throw new Error('properties missing');
    expect(props.type?.type).toBe('string');
    expect(props.type?.enum).toEqual(['user', 'feedback', 'project', 'reference']);
    const required = (schema as { required?: string[] }).required;
    // either absent or an empty array
    expect(required === undefined || required.length === 0).toBe(true);
  });
});

describe('ac-2: memory_list handler validation', () => {
  it('memory_list handler rejects a `type` value not in the four-member enum with an error listing the allowed values', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemoryListHandler({ store });
    let msg = '';
    try {
      await handler({ type: 'bogus' });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    for (const t of ['user', 'feedback', 'project', 'reference']) {
      expect(msg).toContain(t);
    }
  });

  it('memory_list handler accepts an empty arguments object and an arguments object with `type` omitted without error', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemoryListHandler({ store });
    await expect(handler({})).resolves.toBeDefined();
    await expect(handler(undefined)).resolves.toBeDefined();
  });
});

describe('ac-2: memory_delete inputSchema', () => {
  it("memory_delete inputSchema declares required field `name` with type='string'", () => {
    const defs = buildToolDefinitions();
    const def = findDef(defs, 'memory_delete');
    const schema = def.inputSchema;
    expect(schema.type).toBe('object');
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props) throw new Error('properties missing');
    expect(props.name?.type).toBe('string');
    const required = (schema as { required?: string[] }).required ?? [];
    expect(required).toContain('name');
  });
});

describe('ac-2: memory_delete handler validation', () => {
  it('memory_delete handler rejects a missing or non-string `name` with an error naming the field', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemoryDeleteHandler({ store });
    await expect(handler({})).rejects.toThrow(/name/);
    await expect(handler({ name: 123 })).rejects.toThrow(/name/);
  });

  it('memory_delete handler rejects a name not present in the store with a clear error message containing the offending name', async () => {
    const store = makeStore();
    await store.scan();
    const handler = createMemoryDeleteHandler({ store });
    await expect(handler({ name: 'ghost' })).rejects.toThrow(/ghost/);
  });
});

// --------------------------------------------------------------------------
// ac-4: response shape (unit-level coverage)
// --------------------------------------------------------------------------

describe('ac-4: handler return values are JSON-serialisable', () => {
  it('all three handlers return values that are structurally JSON-serializable (no functions, undefined fields, or circular references) -- verified by a round-trip JSON.parse(JSON.stringify(value))', async () => {
    const store = makeStore();
    await store.scan();
    const save = createMemorySaveHandler({ store });
    const list = createMemoryListHandler({ store });
    const del = createMemoryDeleteHandler({ store });

    const saved = await save({
      name: 'thing',
      type: 'reference',
      description: 'd',
      body: 'b',
    });
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);

    const listed = await list({});
    expect(JSON.parse(JSON.stringify(listed))).toEqual(listed);

    const deleted = await del({ name: 'thing' });
    expect(JSON.parse(JSON.stringify(deleted))).toEqual(deleted);
  });
});
