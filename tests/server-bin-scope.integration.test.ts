/**
 * Spawned-bin integration tests for the dual-store scope contract.
 *
 * Spawns the built `commonplace-mcp` bin under varying scope configurations
 * (env / cwd / none) and verifies the dual-store behaviour end-to-end:
 *
 *   - user-only mode: tools work against the user store; saving to the
 *     project scope is rejected with an isError result.
 *   - project mode via env var: both stores load, save to each scope writes
 *     to the correct directory, list returns scope-tagged entries.
 *   - project mode via env var: search merges across stores with scope tags.
 *   - project mode via cwd: cwd containing `.commonplace/memory` triggers
 *     detection equivalently to env-var mode.
 *   - same memory name in both scopes: list returns two entries, delete
 *     without scope is rejected, delete with scope removes one side.
 *
 * Slow on purpose: the bin loads transformers.js model weights. We rely on
 * the cold-start preload in `tests/global-setup.ts` so the file
 * cache is warm before workers fork.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = join(__dirname, '..');

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

interface TextContent {
  type: 'text';
  text: string;
}

const isTextContent = (value: unknown): value is TextContent => {
  if (!isObject(value)) return false;
  return value.type === 'text' && typeof value.text === 'string';
};

function readBinPath(): string {
  const raw: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (!isObject(raw)) throw new Error('package.json is not an object');
  const bin = raw.bin;
  if (!isObject(bin)) throw new Error('package.json bin is not an object');
  const entry = bin['commonplace-mcp'];
  if (typeof entry !== 'string') throw new Error('bin.commonplace-mcp missing');
  return join(repoRoot, entry);
}

function firstTextContent(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`expected non-empty content array, got ${JSON.stringify(content)}`);
  }
  const first = content[0];
  if (!isTextContent(first)) {
    throw new Error(`expected text content, got ${JSON.stringify(first)}`);
  }
  return first.text;
}

const callJSON = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; parsed: unknown }> => {
  const result = await client.callTool({ name, arguments: args });
  const isError = result.isError === true;
  const text = firstTextContent(result.content);
  let parsed: unknown = null;
  if (!isError && text.length > 0) {
    parsed = JSON.parse(text);
  }
  return { isError, text, parsed };
};

const binPath = readBinPath();

beforeAll(() => {
  const res = spawnSync('make', ['build'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, CI: '1' },
  });
  if (res.status !== 0) {
    throw new Error(`make build failed: ${res.stderr || res.stdout}`);
  }
  if (!existsSync(binPath)) {
    throw new Error(`bin not found after build: ${binPath}`);
  }
}, 200_000);

interface Harness {
  client: Client;
  transport: StdioClientTransport;
  userDir: string;
  projectDir: string | null;
  cleanup: () => Promise<void>;
}

const spawnHarness = async (options: {
  userDir: string;
  projectDir?: string;
  cwd?: string;
}): Promise<Harness> => {
  const env: Record<string, string> = {
    ...process.env,
    COMMONPLACE_USER_DIR: options.userDir,
  } as Record<string, string>;
  if (options.projectDir !== undefined) {
    env.COMMONPLACE_PROJECT_DIR = options.projectDir;
  }
  // Strip any inherited COMMONPLACE_MEMORY_DIR so it doesn't ride along on
  // the deprecation path during these tests.
  delete env.COMMONPLACE_MEMORY_DIR;

  const transport = new StdioClientTransport({
    command: 'node',
    args: [binPath],
    env,
    stderr: 'inherit',
    cwd: options.cwd ?? repoRoot,
  });
  const client = new Client({ name: 'dar924-bin-int', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    transport,
    userDir: options.userDir,
    projectDir: options.projectDir ?? null,
    cleanup: async () => {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    },
  };
};

let userDir: string;
let projectDir: string;

beforeEach(() => {
  userDir = mkdtempSync(join(tmpdir(), 'dar924-bin-user-'));
  projectDir = mkdtempSync(join(tmpdir(), 'dar924-bin-proj-'));
});

afterEach(() => {
  rmSync(userDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

afterAll(() => {
  // No global teardown.
});

// --------------------------------------------------------------------------
// User-only mode (no COMMONPLACE_PROJECT_DIR, no cwd marker)
// --------------------------------------------------------------------------

describe('user-only mode', () => {
  it('memory_save / list / delete / search all succeed against the user store', async () => {
    // Spawn from a cwd that has no `.commonplace/memory` so detection
    // resolves to user-only.
    const cleanCwd = mkdtempSync(join(tmpdir(), 'dar924-clean-cwd-'));
    try {
      const h = await spawnHarness({ userDir, cwd: cleanCwd });
      try {
        const save = await callJSON(h.client, 'memory_save', {
          name: 'user_only_a',
          type: 'reference',
          description: 'd',
          body: 'b',
        });
        expect(save.isError).toBe(false);
        if (!isObject(save.parsed)) throw new Error('save not object');
        expect(save.parsed.scope).toBe('user');

        const list = await callJSON(h.client, 'memory_list', {});
        expect(list.isError).toBe(false);
        if (!isObject(list.parsed)) throw new Error('list not object');
        const memories = list.parsed.memories;
        if (!Array.isArray(memories)) throw new Error('memories not array');
        const entry = memories.find((m) => isObject(m) && m.name === 'user_only_a');
        if (!isObject(entry)) throw new Error('entry missing');
        expect(entry.scope).toBe('user');

        const search = await callJSON(h.client, 'memory_search', { query: 'b' });
        expect(search.isError).toBe(false);

        const del = await callJSON(h.client, 'memory_delete', { name: 'user_only_a' });
        expect(del.isError).toBe(false);
      } finally {
        await h.cleanup();
      }
    } finally {
      rmSync(cleanCwd, { recursive: true, force: true });
    }
  }, 60_000);

  it('memory_save({ scope: "project" }) returns an isError CallToolResult whose message names the missing project scope', async () => {
    const cleanCwd = mkdtempSync(join(tmpdir(), 'dar924-clean-cwd-'));
    try {
      const h = await spawnHarness({ userDir, cwd: cleanCwd });
      try {
        const result = await h.client.callTool({
          name: 'memory_save',
          arguments: {
            name: 'wants_proj',
            type: 'project',
            description: 'd',
            body: 'b',
            scope: 'project',
          },
        });
        expect(result.isError).toBe(true);
        const text = firstTextContent(result.content);
        expect(text).toMatch(/project/i);
      } finally {
        await h.cleanup();
      }
    } finally {
      rmSync(cleanCwd, { recursive: true, force: true });
    }
  }, 60_000);
});

// --------------------------------------------------------------------------
// Project mode via COMMONPLACE_PROJECT_DIR
// --------------------------------------------------------------------------

describe('project mode via COMMONPLACE_PROJECT_DIR', () => {
  it('both stores load on boot; saving to each scope writes to the correct directory; memory_list returns scope-tagged entries from both', async () => {
    const h = await spawnHarness({ userDir, projectDir });
    try {
      const userSave = await callJSON(h.client, 'memory_save', {
        name: 'in_user',
        type: 'user',
        description: 'd',
        body: 'b',
        // scope omitted -> defaults to user
      });
      expect(userSave.isError).toBe(false);
      const projSave = await callJSON(h.client, 'memory_save', {
        name: 'in_proj',
        type: 'project',
        description: 'd',
        body: 'b',
        scope: 'project',
      });
      expect(projSave.isError).toBe(false);

      // On-disk verification.
      expect(readdirSync(userDir).some((f) => f === 'in_user.md')).toBe(true);
      expect(readdirSync(userDir).some((f) => f === 'in_proj.md')).toBe(false);
      expect(readdirSync(projectDir).some((f) => f === 'in_proj.md')).toBe(true);
      expect(readdirSync(projectDir).some((f) => f === 'in_user.md')).toBe(false);

      const list = await callJSON(h.client, 'memory_list', {});
      expect(list.isError).toBe(false);
      if (!isObject(list.parsed)) throw new Error('list not object');
      const memories = list.parsed.memories;
      if (!Array.isArray(memories)) throw new Error('memories not array');
      const inUser = memories.find((m) => isObject(m) && m.name === 'in_user');
      const inProj = memories.find((m) => isObject(m) && m.name === 'in_proj');
      if (!isObject(inUser) || !isObject(inProj)) throw new Error('entries missing');
      expect(inUser.scope).toBe('user');
      expect(inProj.scope).toBe('project');
    } finally {
      await h.cleanup();
    }
  }, 60_000);

  it('memory_search over both stores returns merged top-k with scope tags on each match', async () => {
    const h = await spawnHarness({ userDir, projectDir });
    try {
      await callJSON(h.client, 'memory_save', {
        name: 'a_user',
        type: 'reference',
        description: 'd',
        body: 'shared topic in user store',
      });
      await callJSON(h.client, 'memory_save', {
        name: 'b_proj',
        type: 'reference',
        description: 'd',
        body: 'shared topic in project store',
        scope: 'project',
      });

      const search = await callJSON(h.client, 'memory_search', { query: 'shared topic' });
      expect(search.isError).toBe(false);
      if (!isObject(search.parsed)) throw new Error('search parsed not object');
      const matches = search.parsed.matches;
      if (!Array.isArray(matches)) throw new Error('matches not array');
      // Both should appear (limit defaults to 5; corpus has 2 entries).
      const names = matches
        .filter((m): m is Record<string, unknown> => isObject(m))
        .map((m) => m.name);
      expect(names).toContain('a_user');
      expect(names).toContain('b_proj');
      // Each carries a scope tag.
      const aUser = matches.find((m) => isObject(m) && m.name === 'a_user');
      const bProj = matches.find((m) => isObject(m) && m.name === 'b_proj');
      if (!isObject(aUser) || !isObject(bProj)) throw new Error('matches missing');
      expect(aUser.scope).toBe('user');
      expect(bProj.scope).toBe('project');
    } finally {
      await h.cleanup();
    }
  }, 60_000);
});

// --------------------------------------------------------------------------
// Project mode via cwd-walk (DAR-1016)
// --------------------------------------------------------------------------

describe('project mode via cwd', () => {
  it('spawning the bin with cwd containing .git is detected by the upward walk and the project memory dir is auto-created on first project-scope save', async () => {
    // Construct a project layout with a `.git` marker but NO pre-existing
    // `.commonplace/memory` directory. The walk MUST detect the marker and
    // the first project-scope save MUST create the memory directory.
    const cwd = mkdtempSync(join(tmpdir(), 'dar1016-cwd-walk-'));
    try {
      mkdirSync(join(cwd, '.git'), { recursive: true });
      const cwdProjDir = join(cwd, '.commonplace', 'memory');
      // Pre-condition: the project memory directory does NOT yet exist.
      expect(existsSync(cwdProjDir)).toBe(false);

      const h = await spawnHarness({ userDir, cwd });
      try {
        // First project save: the directory should be auto-created.
        const firstSave = await callJSON(h.client, 'memory_save', {
          name: 'walk_proj_a',
          type: 'project',
          description: 'd',
          body: 'b1',
          scope: 'project',
        });
        expect(firstSave.isError).toBe(false);
        if (!isObject(firstSave.parsed)) throw new Error('save not object');
        expect(firstSave.parsed.scope).toBe('project');
        expect(existsSync(cwdProjDir)).toBe(true);
        expect(readdirSync(cwdProjDir).some((f) => f === 'walk_proj_a.md')).toBe(true);

        // Second project save in the same session: idempotent mkdir, no
        // error.
        const secondSave = await callJSON(h.client, 'memory_save', {
          name: 'walk_proj_b',
          type: 'project',
          description: 'd',
          body: 'b2',
          scope: 'project',
        });
        expect(secondSave.isError).toBe(false);
        expect(readdirSync(cwdProjDir).some((f) => f === 'walk_proj_b.md')).toBe(true);

        // List returns both project entries with scope=project.
        const list = await callJSON(h.client, 'memory_list', {});
        if (!isObject(list.parsed)) throw new Error('list not object');
        const memories = list.parsed.memories;
        if (!Array.isArray(memories)) throw new Error('memories not array');
        const a = memories.find((m) => isObject(m) && m.name === 'walk_proj_a');
        const b = memories.find((m) => isObject(m) && m.name === 'walk_proj_b');
        if (!isObject(a) || !isObject(b)) throw new Error('entries missing');
        expect(a.scope).toBe('project');
        expect(b.scope).toBe('project');
      } finally {
        await h.cleanup();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  it('spawning the bin from a nested cwd under a .git-marked project root: upward walk resolves to the project root', async () => {
    // Top-level project with `.git`; cwd is a deep subdir.
    const projectRoot = mkdtempSync(join(tmpdir(), 'dar1016-cwd-nested-'));
    try {
      mkdirSync(join(projectRoot, '.git'), { recursive: true });
      const nested = join(projectRoot, 'a', 'b', 'c');
      mkdirSync(nested, { recursive: true });

      const h = await spawnHarness({ userDir, cwd: nested });
      try {
        const save = await callJSON(h.client, 'memory_save', {
          name: 'nested_proj',
          type: 'project',
          description: 'd',
          body: 'b',
          scope: 'project',
        });
        expect(save.isError).toBe(false);
        // The memory MUST land under the marked root, not the nested cwd.
        const projDir = join(projectRoot, '.commonplace', 'memory');
        expect(readdirSync(projDir).some((f) => f === 'nested_proj.md')).toBe(true);
      } finally {
        await h.cleanup();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

// --------------------------------------------------------------------------
// Same name in both scopes
// --------------------------------------------------------------------------

describe('same memory name saved in both scopes', () => {
  it('memory_list returns two entries, each tagged with its scope', async () => {
    const h = await spawnHarness({ userDir, projectDir });
    try {
      const userSave = await callJSON(h.client, 'memory_save', {
        name: 'shared',
        type: 'reference',
        description: 'in user',
        body: 'user body',
      });
      expect(userSave.isError).toBe(false);
      const projSave = await callJSON(h.client, 'memory_save', {
        name: 'shared',
        type: 'reference',
        description: 'in proj',
        body: 'proj body',
        scope: 'project',
      });
      expect(projSave.isError).toBe(false);

      const list = await callJSON(h.client, 'memory_list', {});
      if (!isObject(list.parsed)) throw new Error('list not object');
      const memories = list.parsed.memories;
      if (!Array.isArray(memories)) throw new Error('memories not array');
      const shared = memories.filter((m) => isObject(m) && m.name === 'shared');
      expect(shared.length).toBe(2);
      const scopes = shared
        .filter((m): m is Record<string, unknown> => isObject(m))
        .map((m) => m.scope)
        .sort();
      expect(scopes).toEqual(['project', 'user']);
    } finally {
      await h.cleanup();
    }
  }, 60_000);

  it('memory_delete({ name }) without scope is rejected with an error naming the ambiguity; memory_delete({ name, scope: "user" }) removes only the user-scoped entry', async () => {
    const h = await spawnHarness({ userDir, projectDir });
    try {
      await callJSON(h.client, 'memory_save', {
        name: 'shared_del',
        type: 'reference',
        description: 'd',
        body: 'b',
      });
      await callJSON(h.client, 'memory_save', {
        name: 'shared_del',
        type: 'reference',
        description: 'd',
        body: 'b',
        scope: 'project',
      });

      // Ambiguous delete -- must error.
      const ambig = await h.client.callTool({
        name: 'memory_delete',
        arguments: { name: 'shared_del' },
      });
      expect(ambig.isError).toBe(true);
      const ambigText = firstTextContent(ambig.content);
      expect(ambigText).toMatch(/(ambig|both|scope)/i);

      // Disambiguated delete -- must succeed and only remove the user entry.
      const userDel = await callJSON(h.client, 'memory_delete', {
        name: 'shared_del',
        scope: 'user',
      });
      expect(userDel.isError).toBe(false);
      if (!isObject(userDel.parsed)) throw new Error('del not object');
      expect(userDel.parsed.scope).toBe('user');

      // List again -- only the project entry remains.
      const list = await callJSON(h.client, 'memory_list', {});
      if (!isObject(list.parsed)) throw new Error('list not object');
      const memories = list.parsed.memories;
      if (!Array.isArray(memories)) throw new Error('memories not array');
      const survivors = memories.filter((m) => isObject(m) && m.name === 'shared_del');
      expect(survivors.length).toBe(1);
      expect(isObject(survivors[0]) && survivors[0].scope).toBe('project');
    } finally {
      await h.cleanup();
    }
  }, 60_000);
});

// --------------------------------------------------------------------------
// Project store auto-create on first save (ac-3 spawned-bin coverage)
// --------------------------------------------------------------------------

describe('bin: project store directory does not exist until first save', () => {
  it('first memory_save({ scope: "project" }) creates the directory recursively when env points at a fresh path', async () => {
    const fresh = join(projectDir, 'never-created', 'nested');
    expect(existsSync(fresh)).toBe(false);
    const h = await spawnHarness({ userDir, projectDir: fresh });
    try {
      // The dir should still not exist (boot-time scan handles missing
      // dirs gracefully).
      // Note: depending on timing the dir may have been created during
      // boot's `await projectStore.scan()`. Per the lazy-create contract, the
      // contract is that the dir exists after the first save -- not that
      // it stays missing through boot. We assert the post-save state.

      const save = await callJSON(h.client, 'memory_save', {
        name: 'first_save',
        type: 'project',
        description: 'd',
        body: 'b',
        scope: 'project',
      });
      expect(save.isError).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(readdirSync(fresh).some((f) => f === 'first_save.md')).toBe(true);
    } finally {
      await h.cleanup();
    }
  }, 60_000);
});
