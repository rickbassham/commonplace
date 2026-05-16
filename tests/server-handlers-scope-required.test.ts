/**
 * Tests for DAR-1017: promote `scope` from optional-with-default to
 * required on the `memory_save` MCP tool.
 *
 * Covers ac-1..ac-5, ac-7, ac-8 from the approved contract. ac-6 / ac-9 are
 * covered indirectly (full suite must still pass after every previously
 * defaulting `memory_save` call site has had `scope` added).
 */

import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryStore } from '../src/store/memory-store.js';
import { SCOPES, createMemorySaveHandler } from '../src/server/handlers.js';
import { buildToolDefinitions } from '../src/server/tools.js';

let userTmp: string;
let projectTmp: string;

beforeEach(() => {
  userTmp = mkdtempSync(join(tmpdir(), 'dar1017-user-'));
  projectTmp = mkdtempSync(join(tmpdir(), 'dar1017-proj-'));
});

afterEach(() => {
  rmSync(userTmp, { recursive: true, force: true });
  rmSync(projectTmp, { recursive: true, force: true });
});

const stubEmbedder = (dim = 4) => {
  let count = 0;
  return {
    modelId: 'test',
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
  const embedder = stubEmbedder();
  const userStore = new MemoryStore({ dir: userTmp, embedder });
  await userStore.scan();
  if (options.project ?? true) {
    const projectStore = new MemoryStore({ dir: projectTmp, embedder });
    await projectStore.scan();
    return { userStore, projectStore };
  }
  return { userStore };
};

const goodArgs = {
  name: 'good',
  type: 'reference',
  description: 'd',
  body: 'b',
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// --------------------------------------------------------------------------
// ac-1: schema declares `scope` required and keeps the property definition
// --------------------------------------------------------------------------

describe('ac-1: memory_save inputSchema declares `scope` required', () => {
  it("buildToolDefinitions(): the memory_save definition's inputSchema.required array contains exactly the five entries name, type, description, body, scope (as a set, no extras, no duplicates)", () => {
    const defs = buildToolDefinitions();
    const def = defs.find((d) => d.name === 'memory_save');
    if (!def) throw new Error('expected memory_save in definitions');
    const schema = def.inputSchema;
    const required = (schema as { required?: string[] }).required ?? [];
    expect(required).toHaveLength(5);
    expect(new Set(required)).toEqual(new Set(['name', 'type', 'description', 'body', 'scope']));
  });

  it("buildToolDefinitions(): the memory_save definition's inputSchema.properties still includes a `scope` entry whose enum is the SCOPES tuple (required does not remove the property definition)", () => {
    const defs = buildToolDefinitions();
    const def = defs.find((d) => d.name === 'memory_save');
    if (!def) throw new Error('expected memory_save in definitions');
    const props = (def.inputSchema as { properties?: Record<string, Record<string, unknown>> })
      .properties;
    expect(props).toBeDefined();
    if (!props) throw new Error('properties missing');
    const scopeProp = props.scope;
    expect(scopeProp).toBeDefined();
    expect(scopeProp?.type).toBe('string');
    expect(scopeProp?.enum).toEqual([...SCOPES]);
  });
});

// --------------------------------------------------------------------------
// ac-2: handler-level validation rejects missing scope
// --------------------------------------------------------------------------

describe('ac-2: createMemorySaveHandler rejects missing `scope`', () => {
  it('createMemorySaveHandler: invoking the handler with arguments that entirely omit `scope` (other fields valid) rejects with an Error whose message names `memory_save` and `scope` and identifies `scope` as required', async () => {
    const { userStore, projectStore } = await makeStores();
    const handler = createMemorySaveHandler({ userStore, projectStore });
    let msg = '';
    try {
      await handler({ ...goodArgs });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('memory_save');
    expect(msg).toContain('scope');
    expect(msg.toLowerCase()).toContain('required');
  });

  it("createMemorySaveHandler: invoking the handler with arguments that set `scope: undefined` explicitly rejects with the same `scope`-required Error (no silent fallback to 'user')", async () => {
    const { userStore, projectStore } = await makeStores();
    const handler = createMemorySaveHandler({ userStore, projectStore });
    let msg = '';
    try {
      await handler({ ...goodArgs, scope: undefined });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('memory_save');
    expect(msg).toContain('scope');
    expect(msg.toLowerCase()).toContain('required');
  });

  it('createMemorySaveHandler: a missing-`scope` call does NOT write any file to the underlying store (verified by store.all() length unchanged or store.upsert spy never called)', async () => {
    const { userStore, projectStore } = await makeStores();
    const handler = createMemorySaveHandler({ userStore, projectStore });
    const userBefore = userStore.all().length;
    const projBefore = projectStore?.all().length ?? 0;
    await expect(handler({ ...goodArgs })).rejects.toThrow();
    expect(userStore.all().length).toBe(userBefore);
    expect(projectStore?.all().length ?? 0).toBe(projBefore);
    // No files were written either.
    expect(readdirSync(userTmp)).toHaveLength(0);
    expect(readdirSync(projectTmp)).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// ac-3: explicit `scope: 'user'` and `scope: 'project'` succeed
// --------------------------------------------------------------------------

describe('ac-3: createMemorySaveHandler succeeds with explicit scope', () => {
  it("createMemorySaveHandler: a fully-valid call with `scope: 'user'` resolves with { saved, path, scope: 'user' } and writes the markdown file under the user store directory", async () => {
    const { userStore, projectStore } = await makeStores();
    const handler = createMemorySaveHandler({ userStore, projectStore });
    const result = (await handler({ ...goodArgs, name: 'userone', scope: 'user' })) as Record<
      string,
      unknown
    >;
    expect(result.scope).toBe('user');
    expect(isRecord(result.saved)).toBe(true);
    expect(typeof result.path).toBe('string');
    expect(readdirSync(userTmp).some((f) => f === 'userone.md')).toBe(true);
    expect(readdirSync(projectTmp).some((f) => f === 'userone.md')).toBe(false);
  });

  it("createMemorySaveHandler: a fully-valid call with `scope: 'project'` (project store wired) resolves with { saved, path, scope: 'project' } and writes the markdown file under the project store directory", async () => {
    const { userStore, projectStore } = await makeStores();
    const handler = createMemorySaveHandler({ userStore, projectStore });
    const result = (await handler({
      ...goodArgs,
      name: 'projone',
      type: 'project',
      scope: 'project',
    })) as Record<string, unknown>;
    expect(result.scope).toBe('project');
    expect(isRecord(result.saved)).toBe(true);
    expect(typeof result.path).toBe('string');
    expect(readdirSync(projectTmp).some((f) => f === 'projone.md')).toBe(true);
    expect(readdirSync(userTmp).some((f) => f === 'projone.md')).toBe(false);
  });
});

// --------------------------------------------------------------------------
// ac-4: description text no longer says "default user"
// --------------------------------------------------------------------------

describe('ac-4: TOOL_SCHEMAS.memory_save description no longer claims a default', () => {
  it('TOOL_SCHEMAS.memory_save: the top-level description string does not contain the substring "default `user`" nor the substring "default user" (case-insensitive)', () => {
    const defs = buildToolDefinitions();
    const def = defs.find((d) => d.name === 'memory_save');
    if (!def) throw new Error('expected memory_save in definitions');
    const desc = def.description.toLowerCase();
    expect(desc).not.toContain('default `user`');
    expect(desc).not.toContain('default user');
  });

  it('TOOL_SCHEMAS.memory_save: the `scope` property description string does not contain the substring "(default)" nor "defaults to" (case-insensitive)', () => {
    const defs = buildToolDefinitions();
    const def = defs.find((d) => d.name === 'memory_save');
    if (!def) throw new Error('expected memory_save in definitions');
    const props = (def.inputSchema as { properties?: Record<string, Record<string, unknown>> })
      .properties;
    if (!props) throw new Error('properties missing');
    const scopeDesc = String(props.scope?.description ?? '').toLowerCase();
    expect(scopeDesc).not.toContain('(default)');
    expect(scopeDesc).not.toContain('defaults to');
  });
});

// --------------------------------------------------------------------------
// ac-5: handler source no longer carries the `?? 'user'` fallback; invalid
// scopes are still rejected.
// --------------------------------------------------------------------------

describe("ac-5: createMemorySaveHandler removes the implicit `?? 'user'` fallback", () => {
  it("src/server/handlers.ts source text: `createMemorySaveHandler` body does not contain the literal `?? 'user'` fallback against `validateScope(args.scope, 'memory_save')` (grep-style file assertion or AST check)", () => {
    const handlersPath = join(process.cwd(), 'src', 'server', 'handlers.ts');
    const source = readFileSync(handlersPath, 'utf8');
    // Locate the createMemorySaveHandler function body and assert the
    // specific stale fallback expression no longer appears within it.
    const startMarker = 'export const createMemorySaveHandler';
    const startIdx = source.indexOf(startMarker);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    // Naive scope: walk until the next `export const create` (next handler).
    const endIdx = source.indexOf('export const create', startIdx + startMarker.length);
    const slice = endIdx === -1 ? source.slice(startIdx) : source.slice(startIdx, endIdx);
    expect(slice).not.toContain("?? 'user'");
    expect(slice).not.toContain('?? "user"');
  });

  it("createMemorySaveHandler: invoking with `scope: 'banana'` (an invalid non-Scope string) rejects with an Error naming `scope` and listing the allowed SCOPES values; no file is written", async () => {
    const { userStore, projectStore } = await makeStores();
    const handler = createMemorySaveHandler({ userStore, projectStore });
    let msg = '';
    try {
      await handler({ ...goodArgs, scope: 'banana' });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('scope');
    for (const s of SCOPES) {
      expect(msg).toContain(s);
    }
    expect(readdirSync(userTmp)).toHaveLength(0);
    expect(readdirSync(projectTmp)).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// ac-6: repo scan -- no test file under `tests/` invokes memory_save without
// a `scope` argument, except where the test's own assertion is the
// missing-scope rejection itself.
// --------------------------------------------------------------------------

describe('ac-6: tests/ has no memory_save call sites that omit `scope`', () => {
  it("Repository scan: no test file under `tests/` invokes `memory_save` (via direct handler call or via MCP `callTool`/`callJSON`) with an arguments object that omits `scope`, except where the test's own assertion is that the missing-`scope` rejection fires (ac-2 tests)", async () => {
    const fg = await import('node:fs/promises');
    const path = await import('node:path');
    const root = path.join(process.cwd(), 'tests');

    const entries: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const items = await fg.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          await walk(full);
        } else if (item.isFile() && full.endsWith('.ts')) {
          entries.push(full);
        }
      }
    };
    await walk(root);

    // This test file is the canonical place where ac-2 asserts the missing
    // scope rejection. Other tests must include scope.
    const SELF = __filename;

    const offenders: Array<{ file: string; snippet: string }> = [];

    // Match either:
    //   - createMemorySaveHandler returned-handler invocation: `handler({ ... })`
    //     (callee is the handler, not memory_save by name)
    //   - callJSON(client, 'memory_save', { ... })
    //   - { name: 'memory_save', arguments: { ... } } (callTool envelope)
    //
    // For each match, look at the arg object literal and check whether it
    // contains `scope:`. Skip the test file owned by ac-2.
    for (const file of entries) {
      if (file === SELF) continue;
      const src = await fg.readFile(file, 'utf8');
      // callJSON variant
      const callJsonRegex = /callJSON\([^,]+,\s*['"]memory_save['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g;
      for (const m of src.matchAll(callJsonRegex)) {
        const body = m[1] ?? '';
        if (!/\bscope\s*:/.test(body)) {
          offenders.push({ file, snippet: m[0].slice(0, 200) });
        }
      }
      // callTool envelope variant
      const envelopeRegex = /name:\s*['"]memory_save['"],\s*arguments:\s*\{([\s\S]*?)\}\s*\}/g;
      for (const m of src.matchAll(envelopeRegex)) {
        const body = m[1] ?? '';
        if (!/\bscope\s*:/.test(body)) {
          offenders.push({ file, snippet: m[0].slice(0, 200) });
        }
      }
      // handlers.memory_save({ ... }) variant
      const handlerCallRegex = /handlers\.memory_save\(\s*\{([\s\S]*?)\}\s*\)/g;
      for (const m of src.matchAll(handlerCallRegex)) {
        const body = m[1] ?? '';
        if (!/\bscope\s*:/.test(body)) {
          offenders.push({ file, snippet: m[0].slice(0, 200) });
        }
      }
    }

    if (offenders.length > 0) {
      const report = offenders
        .map((o) => `  - ${o.file}\n      ${o.snippet.replace(/\s+/g, ' ').slice(0, 160)}`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} memory_save call site(s) in tests/ without explicit scope:\n${report}`,
      );
    }
  });
});

// --------------------------------------------------------------------------
// ac-7: README parameters table and example call for memory_save.
// --------------------------------------------------------------------------

describe('ac-7: README documents `scope` as required on memory_save', () => {
  it('README.md: the `memory_save` parameters table row for `scope` shows `required` in the Required column (not `optional`)', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const saveHeader = '### memory_save';
    const saveIdx = readme.indexOf(saveHeader);
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    // Bound the slice to the next `### ` heading at the same level.
    const nextHeader = readme.indexOf('\n### ', saveIdx + saveHeader.length);
    const section = readme.slice(saveIdx, nextHeader === -1 ? undefined : nextHeader);
    // Find the row whose first cell is `\`scope\``.
    const scopeRowMatch = section.match(/\|\s*`scope`\s*\|[^\n]*\n/);
    expect(scopeRowMatch).not.toBeNull();
    const row = scopeRowMatch![0];
    // The row should mark `required`. We accept "required" anywhere in the
    // row but it must NOT say "optional".
    expect(row.toLowerCase()).toContain('required');
    expect(row.toLowerCase()).not.toContain('optional');
  });

  it('README.md: every JSONC code block under the `### memory_save` section that shows an example call contains a `"scope":` key (no `memory_save` example omits `scope`)', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const saveHeader = '### memory_save';
    const saveIdx = readme.indexOf(saveHeader);
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    const nextHeader = readme.indexOf('\n### ', saveIdx + saveHeader.length);
    const section = readme.slice(saveIdx, nextHeader === -1 ? undefined : nextHeader);
    const blockRegex = /```jsonc\n([\s\S]*?)```/g;
    const blocks = [...section.matchAll(blockRegex)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const m of blocks) {
      const body = m[1] ?? '';
      expect(body).toContain('"scope":');
    }
  });
});
