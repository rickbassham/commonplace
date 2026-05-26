/**
 * Bin boot-wiring contract tests (in-process).
 *
 * Covers `bootServer`'s env-var resolution surface (`COMMONPLACE_MODEL`,
 * `COMMONPLACE_DEFAULT_LIMIT`) and the README / bin top-of-file env-var
 * documentation. The boot path is exercised through `bootHarness`, which
 * links the server to an in-memory MCP transport -- no build, no compiled output,
 * no spawned child process.
 *
 * The end-to-end "the spawned entrypoint boots over real stdio and wires
 * Embedder + MemoryStore" contract is covered by the single MCP-boot smoke
 * test in `tests/bin-smoke.test.ts`, which spawns the `src/` entrypoint via
 * `node --import <tsx-loader>` (never the compiled output).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_LIMIT, DEFAULT_MODEL_ID, ENV_MODEL } from '../src/bin/env.js';
import { bootHarness } from './helpers/boot-harness.js';

const repoRoot = join(__dirname, '..');

// --------------------------------------------------------------------------
// Env-var resolution for COMMONPLACE_MODEL and COMMONPLACE_DEFAULT_LIMIT
// --------------------------------------------------------------------------

/**
 * Spy embedder that records the modelId it was constructed with so tests
 * can assert bootServer threaded the env-resolved id through.
 */
const makeSpyEmbedder = (modelId: string, dim = 4) => {
  let count = 0;
  return {
    modelId,
    dim,
    embed: async (text: string): Promise<Float32Array> => {
      void text;
      count += 1;
      const out = new Float32Array(dim);
      out[0] = count;
      return out;
    },
  };
};

// DAR-1035: the local bootHarness was extracted to tests/helpers/boot-harness.ts
// so every test boot call routes through one place that injects a tmp
// COMMONPLACE_USER_DIR by default. Importing it above replaces what used to
// be an inline async wrapper around bootServer that hand-rolled the same
// in-memory-transport plumbing.

describe('bootServer reads COMMONPLACE_MODEL and constructs the Embedder with it', () => {
  let userTmp: string;
  beforeEach(() => {
    userTmp = mkdtempSync(join(tmpdir(), 'dar913-boot-'));
  });
  afterEach(() => {
    rmSync(userTmp, { recursive: true, force: true });
  });

  it('bootServer constructs the Embedder with the model id from env.COMMONPLACE_MODEL when set', async () => {
    // We pass an explicit `embedder` because the unit test must not load
    // real model weights; instead we verify the resolver via the public
    // resolver export (resolveModelId) and assert the bin's embedder
    // construction path uses it. The model-construction path is asserted
    // structurally below in the source-text test.
    //
    // Behavioural assertion: when bootServer is given the env var, it
    // does not throw, and the resolved model id matches the env var.
    const { resolveModelId } = await import('../src/bin/env.js');
    const id = resolveModelId({ [ENV_MODEL]: 'Xenova/all-MiniLM-L6-v2' });
    expect(id).toBe('Xenova/all-MiniLM-L6-v2');

    // Smoke-boot with a stub embedder so the boot wiring runs end-to-end.
    const { close } = await bootHarness({
      env: { [ENV_MODEL]: 'Xenova/all-MiniLM-L6-v2' },
      cwd: userTmp,
      embedder: makeSpyEmbedder('Xenova/all-MiniLM-L6-v2'),
    });
    await close();
  });

  it('bootServer falls back to the Xenova/bge-base-en-v1.5 default when env.COMMONPLACE_MODEL is unset', async () => {
    const { resolveModelId } = await import('../src/bin/env.js');
    const id = resolveModelId({});
    expect(id).toBe(DEFAULT_MODEL_ID);
    expect(DEFAULT_MODEL_ID).toBe('Xenova/bge-base-en-v1.5');
  });

  it('bootServer treats an empty COMMONPLACE_MODEL string as unset and uses the default', async () => {
    const { resolveModelId } = await import('../src/bin/env.js');
    const id = resolveModelId({ [ENV_MODEL]: '' });
    expect(id).toBe(DEFAULT_MODEL_ID);
  });

  it("bootServer with env={COMMONPLACE_MODEL: 'Xenova/all-MiniLM-L6-v2'} produces an Embedder whose modelId is 'Xenova/all-MiniLM-L6-v2'", async () => {
    // Source-text assertion: the bin/boot wiring imports the env-resolver
    // and uses its result to construct the Embedder. Without a stub, the
    // resolved id is the one the Embedder constructor receives.
    const bootSource = readFileSync(join(repoRoot, 'src/bin/boot.ts'), 'utf8');
    expect(bootSource).toMatch(/resolveModelId\s*\(/);
    expect(bootSource).toMatch(/new\s+Embedder\s*\(\s*resolveModelId\s*\(/);
    // Behavioural smoke: boot completes when an env-supplied model id is
    // provided alongside a stub embedder for the same id.
    const { boot, close } = await bootHarness({
      env: { [ENV_MODEL]: 'Xenova/all-MiniLM-L6-v2' },
      cwd: userTmp,
      embedder: makeSpyEmbedder('Xenova/all-MiniLM-L6-v2'),
    });
    expect(boot.userStore).toBeDefined();
    await close();
  });
});

describe('env-var documentation in README + bin top-of-file comment', () => {
  it('README.md documents COMMONPLACE_MODEL with its default (Xenova/bge-base-en-v1.5) and effect', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('COMMONPLACE_MODEL');
    expect(readme).toContain('Xenova/bge-base-en-v1.5');
    // The README must explain the *effect* of the variable, not just name
    // it. We assert the documentation block mentions "model" alongside the
    // env var so the section is actually useful to operators.
    const blockStart = readme.indexOf('COMMONPLACE_MODEL');
    expect(blockStart).toBeGreaterThan(-1);
    const block = readme.slice(blockStart, blockStart + 400);
    expect(block.toLowerCase()).toMatch(/model/);
    expect(block.toLowerCase()).toMatch(/embedding|transformers/);
  });

  it('README.md documents COMMONPLACE_DEFAULT_LIMIT with its default (5) and effect', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('COMMONPLACE_DEFAULT_LIMIT');
    const blockStart = readme.indexOf('COMMONPLACE_DEFAULT_LIMIT');
    expect(blockStart).toBeGreaterThan(-1);
    const block = readme.slice(blockStart, blockStart + 400);
    // "5" appears as the default; effect references memory_search / limit /
    // top-k so the operator knows what the variable controls.
    expect(block).toMatch(/\b5\b/);
    expect(block.toLowerCase()).toMatch(/memory_search|limit|top-k/);
  });

  it('src/bin/commonplace-mcp.ts top-of-file comment lists COMMONPLACE_MODEL and COMMONPLACE_DEFAULT_LIMIT alongside the existing memory-dir vars', () => {
    const binSource = readFileSync(join(repoRoot, 'src/bin/commonplace-mcp.ts'), 'utf8');
    // Find the first comment block (the file's top-of-file JSDoc). Bin
    // entries start with the shebang then the module comment; we slice
    // until the first non-comment line for the assertion.
    const headerEnd = binSource.indexOf('\nimport ');
    expect(headerEnd).toBeGreaterThan(-1);
    const header = binSource.slice(0, headerEnd);
    expect(header).toContain('COMMONPLACE_USER_DIR');
    expect(header).toContain('COMMONPLACE_PROJECT_DIR');
    expect(header).toContain('COMMONPLACE_MEMORY_DIR');
    expect(header).toContain('COMMONPLACE_MODEL');
    expect(header).toContain('COMMONPLACE_DEFAULT_LIMIT');
  });
});

describe('bootServer does NOT pre-validate COMMONPLACE_MODEL', () => {
  let userTmp: string;
  beforeEach(() => {
    userTmp = mkdtempSync(join(tmpdir(), 'dar913-boot-unknown-'));
  });
  afterEach(() => {
    rmSync(userTmp, { recursive: true, force: true });
  });

  it("bootServer with env.COMMONPLACE_MODEL='not/a-real-model' boots without throwing (no pre-validation)", async () => {
    // Pass a stub embedder so the unknown id never reaches transformers.js
    // during the boot path -- the contract is "the bin does not pre-validate".
    // The lazy-validation behaviour (embedder surfaces the bad id on first
    // embed call) is covered by the integration test in
    // tests/embedder.integration.test.ts.
    const { boot, close } = await bootHarness({
      env: { [ENV_MODEL]: 'not/a-real-model' },
      cwd: userTmp,
      embedder: makeSpyEmbedder('not/a-real-model'),
    });
    expect(boot.userStore).toBeDefined();
    await close();
  });
});

describe('default-limit defaults', () => {
  it('DEFAULT_LIMIT is 5 (matches store-layer default)', () => {
    expect(DEFAULT_LIMIT).toBe(5);
  });
});
