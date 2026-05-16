/**
 * Unit tests for the bootstrap-on-approval flow (DAR-1018).
 *
 * Covers:
 *   - ac-1: structured `NO_PROJECT_STORE` marker on memory_save when no
 *     project store is wired
 *   - ac-2: TOOL_NAMES / listTools surface the new tool with the
 *     `userConfirmed` strict-true contract
 *   - ac-3: handler success path (detection-mode rebinding + result shape)
 *   - ac-4: no-root-detected error path
 *   - ac-5: explicit path override and $HOME-exclusive safety
 *   - ac-7: nine-tool registry shape with the `Agent memory: ` prefix
 *
 * The end-to-end tests (ac-1 SDK marker, ac-6 single-connection retry)
 * live in `tests/server-handlers-bootstrap.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryGraph } from '../src/store/graph.js';
import { MemoryStore } from '../src/store/memory-store.js';
import {
  CodedError,
  ERROR_CODE_NO_PROJECT_STORE,
  createMemoryBootstrapHandler,
  createMemorySaveHandler,
  type BootstrapEnvironment,
} from '../src/server/handlers.js';
import { TOOL_NAMES, buildToolDefinitions, listTools } from '../src/server/tools.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

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

let userTmp: string;
let workspaceTmp: string;
let homeTmp: string;

beforeEach(() => {
  // On macOS, tmpdir() returns /var/... but realpath resolves to
  // /private/var/.... The bootstrap handler runs detectScope which calls
  // realpathSync internally, so the resolved projectRoot will be the
  // realpath-normalized form. Normalize the test's reference paths up
  // front so equality assertions match the handler's output.
  userTmp = realpathSync(mkdtempSync(join(tmpdir(), 'dar1018-user-')));
  workspaceTmp = realpathSync(mkdtempSync(join(tmpdir(), 'dar1018-ws-')));
  homeTmp = realpathSync(mkdtempSync(join(tmpdir(), 'dar1018-home-')));
});

afterEach(() => {
  rmSync(userTmp, { recursive: true, force: true });
  rmSync(workspaceTmp, { recursive: true, force: true });
  rmSync(homeTmp, { recursive: true, force: true });
});

const makeUserStore = async () => {
  const store = new MemoryStore({ dir: userTmp, embedder: makeStubEmbedder() });
  await store.scan();
  return store;
};

// --------------------------------------------------------------------------
// ac-1: memory_save NO_PROJECT_STORE marker
// --------------------------------------------------------------------------

describe('ac-1: memory_save returns NO_PROJECT_STORE marker in user-only mode', () => {
  it("memory_save with scope='project' in user-only mode throws a CodedError whose code is the fixed token 'NO_PROJECT_STORE'", async () => {
    const userStore = await makeUserStore();
    const handler = createMemorySaveHandler({ userStore });
    let caught: unknown;
    try {
      await handler({
        name: 'x',
        type: 'project',
        description: 'd',
        body: 'b',
        scope: 'project',
      });
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof CodedError)) {
      throw new Error('expected CodedError');
    }
    expect(caught.code).toBe('NO_PROJECT_STORE');
    expect(ERROR_CODE_NO_PROJECT_STORE).toBe('NO_PROJECT_STORE');
  });

  it("the CodedError's message names the memory_bootstrap_project_store tool so a human reading the prose still gets actionable guidance", async () => {
    const userStore = await makeUserStore();
    const handler = createMemorySaveHandler({ userStore });
    let caught: unknown;
    try {
      await handler({
        name: 'x',
        type: 'project',
        description: 'd',
        body: 'b',
        scope: 'project',
      });
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof Error)) {
      throw new Error('expected Error');
    }
    expect(caught.message).toContain('memory_bootstrap_project_store');
  });

  it('the NO_PROJECT_STORE marker is exposed at a stable field name (`code`) on the thrown CodedError so an agent can match without regex on the message text', async () => {
    const userStore = await makeUserStore();
    const handler = createMemorySaveHandler({ userStore });
    let caught: unknown;
    try {
      await handler({
        name: 'x',
        type: 'project',
        description: 'd',
        body: 'b',
        scope: 'project',
      });
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof CodedError)) {
      throw new Error('expected CodedError');
    }
    // The contract is that `code` is a stable JSON-serialisable field.
    expect(typeof caught.code).toBe('string');
    expect(caught.code).toBe('NO_PROJECT_STORE');
  });
});

// --------------------------------------------------------------------------
// ac-2: tool registration + strict-true handler gate
// --------------------------------------------------------------------------

describe("ac-2: memory_bootstrap_project_store is registered with required boolean 'userConfirmed'", () => {
  it("TOOL_NAMES includes 'memory_bootstrap_project_store'", () => {
    expect(TOOL_NAMES).toContain('memory_bootstrap_project_store');
  });

  it("listTools surfaces a 'memory_bootstrap_project_store' tool whose inputSchema declares 'userConfirmed' as a required boolean property", () => {
    const tools = listTools().tools;
    const tool = tools.find((t) => t.name === 'memory_bootstrap_project_store');
    if (!tool) throw new Error('expected memory_bootstrap_project_store in listTools');
    expect(tool.inputSchema.type).toBe('object');
    const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.userConfirmed?.type).toBe('boolean');
    const required = (tool.inputSchema as { required?: string[] }).required ?? [];
    expect(required).toContain('userConfirmed');
  });

  const buildEnv = (): { env: BootstrapEnvironment; mkdir: ReturnType<typeof vi.fn> } => {
    const mkdir = vi.fn(async () => {});
    const env: BootstrapEnvironment = {
      env: { COMMONPLACE_PROJECT_DIR: join(workspaceTmp, '.commonplace', 'memory') },
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: vi.fn(),
      mkdir,
    };
    return { env, mkdir };
  };

  it('handler rejects { userConfirmed: false } with a clear error and does not call mkdir', async () => {
    const { env, mkdir } = buildEnv();
    const handler = createMemoryBootstrapHandler(env);
    await expect(handler({ userConfirmed: false })).rejects.toThrow(/userConfirmed|strictly/);
    expect(mkdir).not.toHaveBeenCalled();
  });

  it.each([
    ['string "true"', 'true'],
    ['number 1', 1],
    ['empty object', {}],
    ['array', ['true']],
  ])(
    'handler rejects userConfirmed = %s (truthy but not strict true) without coercion and does not call mkdir',
    async (_label: string, value: unknown) => {
      const { env, mkdir } = buildEnv();
      const handler = createMemoryBootstrapHandler(env);
      await expect(handler({ userConfirmed: value })).rejects.toThrow(/userConfirmed|strictly/);
      expect(mkdir).not.toHaveBeenCalled();
    },
  );

  it('handler rejects calls that omit userConfirmed entirely with a clear error and does not call mkdir', async () => {
    const { env, mkdir } = buildEnv();
    const handler = createMemoryBootstrapHandler(env);
    await expect(handler({})).rejects.toThrow(/userConfirmed|required/);
    expect(mkdir).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// ac-3: detection success path
// --------------------------------------------------------------------------

describe('ac-3: bootstrap success path creates project dir and rebinds handlers', () => {
  it('with userConfirmed=true and a cwd whose ancestor contains a .git marker, the tool creates <root>/.commonplace/memory on disk', async () => {
    mkdirSync(join(workspaceTmp, '.git'));
    const rebind = vi.fn();
    const env: BootstrapEnvironment = {
      env: {},
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: rebind,
    };
    const handler = createMemoryBootstrapHandler(env);
    const result = await handler({ userConfirmed: true });
    expect(existsSync(join(workspaceTmp, '.commonplace', 'memory'))).toBe(true);
    if (!isRecord(result)) throw new Error('result not object');
    expect(result.projectRoot).toBe(workspaceTmp);
    expect(result.projectMemoryDir).toBe(join(workspaceTmp, '.commonplace', 'memory'));
  });

  it('with userConfirmed=true and a cwd whose ancestor contains a .commonplace marker, the tool resolves to that root and creates the memory subdirectory if missing', async () => {
    mkdirSync(join(workspaceTmp, '.commonplace'));
    const env: BootstrapEnvironment = {
      env: {},
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: vi.fn(),
    };
    const handler = createMemoryBootstrapHandler(env);
    const result = await handler({ userConfirmed: true });
    if (!isRecord(result)) throw new Error('result not object');
    expect(result.projectRoot).toBe(workspaceTmp);
    expect(existsSync(join(workspaceTmp, '.commonplace', 'memory'))).toBe(true);
  });

  it('with userConfirmed=true and a pre-existing <root>/.commonplace/memory directory, the tool succeeds without error and does not clobber existing contents', async () => {
    const memoryDir = join(workspaceTmp, '.commonplace', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'pre-existing.md'), '# pre-existing');
    mkdirSync(join(workspaceTmp, '.git'));
    const env: BootstrapEnvironment = {
      env: {},
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: vi.fn(),
    };
    const handler = createMemoryBootstrapHandler(env);
    await handler({ userConfirmed: true });
    const files = readdirSync(memoryDir);
    expect(files).toContain('pre-existing.md');
  });

  it("with userConfirmed=true and a successful detection, the tool's success result exposes the resolved project root path at the `projectRoot` field", async () => {
    mkdirSync(join(workspaceTmp, '.git'));
    const env: BootstrapEnvironment = {
      env: {},
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: vi.fn(),
    };
    const handler = createMemoryBootstrapHandler(env);
    const result = await handler({ userConfirmed: true });
    if (!isRecord(result)) throw new Error('result not object');
    expect(typeof result.projectRoot).toBe('string');
    expect(result.projectRoot).toBe(workspaceTmp);
  });

  it('with userConfirmed=true and a successful detection, the bootstrap handler invokes rebindHandlers exactly once with the newly-constructed project store and graph', async () => {
    mkdirSync(join(workspaceTmp, '.git'));
    const rebind = vi.fn();
    let createdStore: MemoryStore | null = null;
    let createdGraph: MemoryGraph | null = null;
    const env: BootstrapEnvironment = {
      env: {},
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => {
        const store = new MemoryStore({ dir, embedder: makeStubEmbedder() });
        const graph = new MemoryGraph();
        createdStore = store;
        createdGraph = graph;
        return { store, graph };
      },
      rebindHandlers: rebind,
    };
    const handler = createMemoryBootstrapHandler(env);
    await handler({ userConfirmed: true });
    expect(rebind).toHaveBeenCalledTimes(1);
    expect(rebind).toHaveBeenCalledWith(createdStore, createdGraph);
  });

  it("the bootstrap handler delegates detection to scope.ts's detectScope rather than implementing its own walk (verified by importing detectScope and confirming it produces the same projectDir for the same inputs)", async () => {
    mkdirSync(join(workspaceTmp, '.git'));
    const { detectScope } = await import('../src/bin/scope.js');
    const detected = detectScope({
      env: {},
      roots: null,
      cwd: workspaceTmp,
      homedir: homeTmp,
    });
    expect(detected.projectDir).toBe(join(workspaceTmp, '.commonplace', 'memory'));
    // The bootstrap handler resolves the same root for the same inputs.
    const env: BootstrapEnvironment = {
      env: {},
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: vi.fn(),
    };
    const handler = createMemoryBootstrapHandler(env);
    const result = await handler({ userConfirmed: true });
    if (!isRecord(result)) throw new Error('result not object');
    expect(result.projectMemoryDir).toBe(detected.projectDir);
  });
});

// --------------------------------------------------------------------------
// ac-4: no-root-detected error
// --------------------------------------------------------------------------

describe('ac-4: bootstrap rejects with remediation guidance when no root is detected', () => {
  it('with userConfirmed=true, no COMMONPLACE_PROJECT_DIR, and a cwd whose walk to $HOME finds no .git or .commonplace marker, the handler throws an Error', async () => {
    // workspaceTmp has no markers.
    const env: BootstrapEnvironment = {
      env: {},
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: vi.fn(),
    };
    const handler = createMemoryBootstrapHandler(env);
    await expect(handler({ userConfirmed: true })).rejects.toThrow(
      /project root|no project|detect/i,
    );
  });

  it('the no-root-detected error message names both COMMONPLACE_PROJECT_DIR and the git/marker remediation', async () => {
    const env: BootstrapEnvironment = {
      env: {},
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: vi.fn(),
    };
    const handler = createMemoryBootstrapHandler(env);
    let msg = '';
    try {
      await handler({ userConfirmed: true });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('COMMONPLACE_PROJECT_DIR');
    // Either `git init` literal or `.git` marker reference must appear.
    expect(/git init|\.git|\.commonplace/.test(msg)).toBe(true);
  });

  it('when detection fails, the handler does not create any directories on disk and does not call rebindHandlers', async () => {
    const rebind = vi.fn();
    const mkdir = vi.fn(async () => {});
    const env: BootstrapEnvironment = {
      env: {},
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: rebind,
      mkdir,
    };
    const handler = createMemoryBootstrapHandler(env);
    await handler({ userConfirmed: true }).catch(() => {});
    expect(mkdir).not.toHaveBeenCalled();
    expect(rebind).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// ac-5: explicit path override
// --------------------------------------------------------------------------

describe('ac-5: explicit path override with $HOME-exclusive safety', () => {
  it('with userConfirmed=true and an explicit path pointing at a markerless directory under $HOME (but not $HOME itself), the tool bypasses the walk and creates <path>/.commonplace/memory', async () => {
    // workspaceTmp has NO markers. Without the override the walk would
    // fail; with it, the handler should succeed.
    const env: BootstrapEnvironment = {
      env: {},
      cwd: '/some/unrelated/dir', // walk would not find anything anyway
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: vi.fn(),
    };
    const handler = createMemoryBootstrapHandler(env);
    const result = await handler({ userConfirmed: true, path: workspaceTmp });
    if (!isRecord(result)) throw new Error('result not object');
    expect(result.projectRoot).toBe(workspaceTmp);
    expect(existsSync(join(workspaceTmp, '.commonplace', 'memory'))).toBe(true);
  });

  it('with userConfirmed=true and an explicit path equal to $HOME, the tool refuses with an error naming the $HOME-exclusive safety check and does not create ~/.commonplace/memory', async () => {
    const rebind = vi.fn();
    const mkdir = vi.fn(async () => {});
    const env: BootstrapEnvironment = {
      env: {},
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: rebind,
      mkdir,
    };
    const handler = createMemoryBootstrapHandler(env);
    await expect(handler({ userConfirmed: true, path: homeTmp })).rejects.toThrow(
      /HOME|home|safety/i,
    );
    expect(mkdir).not.toHaveBeenCalled();
    expect(rebind).not.toHaveBeenCalled();
    expect(existsSync(join(homeTmp, '.commonplace'))).toBe(false);
  });

  it('with userConfirmed=true and an explicit path that is an ancestor of $HOME (e.g. / on a typical layout), the tool refuses with the same $HOME-exclusive safety error', async () => {
    // homeTmp lives under tmpdir; its parent (tmpdir or further up) is an
    // ancestor of homeTmp. Use the parent of homeTmp directly.
    const ancestor = join(homeTmp, '..');
    const mkdir = vi.fn(async () => {});
    const env: BootstrapEnvironment = {
      env: {},
      cwd: workspaceTmp,
      homedir: homeTmp,
      createProjectStore: async (dir: string) => ({
        store: new MemoryStore({ dir, embedder: makeStubEmbedder() }),
        graph: new MemoryGraph(),
      }),
      rebindHandlers: vi.fn(),
      mkdir,
    };
    const handler = createMemoryBootstrapHandler(env);
    // Use a synthetic ancestor that is a strict prefix of homeTmp.
    // homeTmp e.g. /private/var/.../dar1018-home-XXXX; ancestors include
    // /private/var/... -- pick the literal parent dir of homeTmp.
    void ancestor;
    // Determine the parent directory string of homeTmp.
    const parent = homeTmp.replace(/\/[^/]+$/, '');
    await expect(handler({ userConfirmed: true, path: parent })).rejects.toThrow(
      /HOME|home|safety/i,
    );
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("inputSchema for memory_bootstrap_project_store declares 'path' as an optional string property (not required)", () => {
    const defs = buildToolDefinitions();
    const def = defs.find((d) => d.name === 'memory_bootstrap_project_store');
    if (!def) throw new Error('expected memory_bootstrap_project_store in definitions');
    const props = def.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.path?.type).toBe('string');
    const required = (def.inputSchema as { required?: string[] }).required ?? [];
    expect(required).not.toContain('path');
  });
});

// --------------------------------------------------------------------------
// ac-7: nine-tool registry shape with `Agent memory: ` prefix
// --------------------------------------------------------------------------

describe('ac-7: bootstrap tool surfaces in listTools alongside the eight memory_* tools with the Agent memory prefix', () => {
  it('listTools returns nine tools (the existing eight memory_* tools plus memory_bootstrap_project_store)', () => {
    const tools = listTools().tools;
    expect(tools).toHaveLength(9);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'memory_bootstrap_project_store',
      'memory_delete',
      'memory_graph',
      'memory_link',
      'memory_list',
      'memory_path',
      'memory_save',
      'memory_search',
      'memory_unlink',
    ]);
  });

  it("memory_bootstrap_project_store's description starts with the literal 'Agent memory: ' prefix", () => {
    const tools = listTools().tools;
    const tool = tools.find((t) => t.name === 'memory_bootstrap_project_store');
    if (!tool) throw new Error('expected memory_bootstrap_project_store in listTools');
    expect(tool.description?.startsWith('Agent memory: ')).toBe(true);
  });
});
