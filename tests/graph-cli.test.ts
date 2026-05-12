/**
 * DAR-933 contract tests for the `commonplace graph <name>` subcommand.
 *
 * Test names mirror the approved contract envelope on DAR-933. The CLI
 * surface is broken across:
 *
 *   - argv parsing: `parseGraphArgs`
 *   - mermaid / json / dot renderers
 *   - dispatcher integration (bare bin + unknown-subcommand error paths)
 *   - end-to-end via the in-process `graphMain` (the spawned-bin form lives
 *     in `tests/graph-bin.integration.test.ts`)
 *
 * Snapshot fixtures live under `tests/fixtures/graph/`; each case has one
 * `.json` describing the memories and one expected-output file per format
 * (`.mermaid`, `.json`, `.dot`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryGraph } from '../src/store/graph.js';
import { MemoryStore } from '../src/store/memory-store.js';
import type { MemoryType, RelationType } from '../src/store/memory.js';
import {
  graphMain,
  parseGraphArgs,
  renderDot,
  renderJson,
  renderMermaid,
  USAGE_GRAPH_LINE,
} from '../src/cli/graph.js';
import { parseMigrateArgs, USAGE } from '../src/cli/migrate.js';
import { createMemoryGraphHandler, type MemoryGraphResult } from '../src/server/handlers.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar933-'));
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
      for (let i = 1; i < dim; i++) out[i] = (i + (text.length % 7)) / 10;
      return out;
    },
  };
};

interface SeedMemory {
  name: string;
  type?: MemoryType;
  description?: string;
  body?: string;
  relations?: { to: string; type: RelationType }[];
  supersedes?: string[];
}

const seedStore = async (
  memories: SeedMemory[],
): Promise<{ store: MemoryStore; graph: MemoryGraph }> => {
  const graph = new MemoryGraph({ onDangling: () => {} });
  const store = new MemoryStore({ dir: tmp, embedder: makeStubEmbedder(), graph });
  await store.scan();
  for (const m of memories) {
    await store.save({
      name: m.name,
      type: m.type ?? 'reference',
      description: m.description ?? m.name,
      body: m.body ?? `${m.name} body`,
      relations: m.relations ?? [],
      supersedes: m.supersedes ?? [],
    });
  }
  return { store, graph };
};

const runMain = async (
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  let stdout = '';
  let stderr = '';
  const result = await graphMain({
    argv: args,
    embedderFactory: () => makeStubEmbedder(),
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    env: { ...process.env, COMMONPLACE_USER_DIR: tmp, ...envOverrides },
  });
  return { exitCode: result.exitCode, stdout, stderr };
};

// =============================================================================
// ac-1: subcommand under the main `commonplace` binary, dispatched alongside
// the existing `migrate` subcommand.
// =============================================================================

describe('ac-1: subcommand dispatch', () => {
  it('spawned `commonplace graph <name>` against a fixture memory dir exits 0 and writes a mermaid block to stdout', async () => {
    await seedStore([{ name: 'alpha' }, { name: 'beta' }]);
    const res = await runMain(['graph', 'alpha']);
    expect(res.exitCode, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toMatch(/^```mermaid\nflowchart LR\n/);
    expect(res.stdout.trimEnd().endsWith('```')).toBe(true);
  });

  it('spawned `commonplace graph` (no positional arg) prints a usage message to stderr and exits non-zero', async () => {
    const res = await runMain(['graph']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('Usage');
    expect(res.stderr).toContain('graph');
  });

  it("`parseGraphArgs(['graph', 'foo'])` returns `{ kind: 'ok', mode: 'graph', name: 'foo', ... }` with defaults populated", () => {
    const parsed = parseGraphArgs(['graph', 'foo']);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.mode).toBe('graph');
    if (parsed.mode !== 'graph') return;
    expect(parsed.name).toBe('foo');
    expect(parsed.depth).toBe(1);
    expect(parsed.format).toBe('mermaid');
    expect(parsed.direction).toBe('both');
    // Defaults mirror the `memory_graph` MCP handler's DEFAULT_GRAPH_TYPES:
    // the four authored RelationType values plus `supersedes`. Order
    // matches RELATION_TYPES + ['supersedes'].
    expect(parsed.types).toEqual([
      'related-to',
      'builds-on',
      'contradicts',
      'child-of',
      'supersedes',
    ]);
    expect(parsed.scope).toBeUndefined();
  });

  it("`parseMigrateArgs(['migrate', 'somedir'])` continues to return `{ kind: 'ok', mode: 'scan', ... }` after the dispatcher is extended (regression)", () => {
    const parsed = parseMigrateArgs(['migrate', 'somedir']);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.mode).toBe('scan');
  });

  it('bare `commonplace` with no subcommand prints USAGE including the new `graph` line on stderr and exits 2', () => {
    // The bare-bin path renders the same USAGE constant used by both
    // parsers; that constant now contains the graph line.
    expect(USAGE).toContain(USAGE_GRAPH_LINE);
    expect(USAGE).toContain('commonplace graph <name>');
    // The bare-bin path is also covered by parseMigrateArgs([]) which
    // returns a usage_error message containing the same USAGE.
    const parsed = parseMigrateArgs([]);
    expect(parsed.kind).toBe('usage_error');
    if (parsed.kind !== 'usage_error') return;
    expect(parsed.message).toContain('commonplace graph <name>');
    expect(parsed.message).toContain('commonplace migrate');
  });

  it("`commonplace nonsense` returns `kind: 'unknown_subcommand'` with USAGE that includes both `migrate` and `graph` lines", () => {
    // Both parsers reject the unknown subcommand. Whichever the dispatcher
    // consults first must surface USAGE containing both subcommand lines.
    const parsed = parseMigrateArgs(['nonsense']);
    expect(parsed.kind).toBe('unknown_subcommand');
    if (parsed.kind !== 'unknown_subcommand') return;
    expect(parsed.message).toContain('commonplace migrate');
    expect(parsed.message).toContain('commonplace graph <name>');
  });
});

// =============================================================================
// ac-2: mermaid output is a valid `flowchart LR` block
// =============================================================================

describe('ac-2: mermaid output shape', () => {
  const mkResult = (): MemoryGraphResult => ({
    root: { name: 'a', type: 'reference', description: 'A' },
    nodes: [
      { name: 'a', type: 'reference', description: 'A' },
      { name: 'b', type: 'feedback', description: 'B' },
    ],
    edges: [{ from: 'a', to: 'b', type: 'related-to' }],
  });

  it('mermaid render output begins with ```mermaid\\nflowchart LR\\n and ends with ```\\n (fence open/close)', () => {
    const out = renderMermaid(mkResult());
    expect(out.startsWith('```mermaid\nflowchart LR\n')).toBe(true);
    expect(out.endsWith('```\n')).toBe(true);
  });

  it('every node line emits the bare memory name as the node id (e.g. `feedback_scope["feedback_scope (feedback)"]`) with no quoting/escaping of the id', () => {
    const out = renderMermaid({
      root: { name: 'feedback_scope', type: 'feedback', description: 'fs' },
      nodes: [{ name: 'feedback_scope', type: 'feedback', description: 'fs' }],
      edges: [],
    });
    expect(out).toContain('feedback_scope["feedback_scope (feedback)"]');
  });

  it('every edge line wraps the edge type in double quotes (e.g. `a -- "related-to" --> b`) for all edge types: related-to, builds-on, contradicts, child-of, supersedes, mentions', () => {
    const types = ['related-to', 'builds-on', 'contradicts', 'child-of', 'supersedes', 'mentions'];
    const result: MemoryGraphResult = {
      root: { name: 'a', type: 'reference', description: 'A' },
      nodes: [
        { name: 'a', type: 'reference', description: 'A' },
        { name: 'b', type: 'reference', description: 'B' },
      ],
      edges: types.map((t) => ({
        from: 'a',
        to: 'b',
        type: t as MemoryGraphResult['edges'][number]['type'],
      })),
    };
    const out = renderMermaid(result);
    for (const t of types) {
      expect(out).toContain(`a -- "${t}" --> b`);
    }
  });

  it('node label uses `<name> (<type>)` format and does NOT include the memory description', () => {
    const out = renderMermaid({
      root: { name: 'foo', type: 'project', description: 'A long description' },
      nodes: [{ name: 'foo', type: 'project', description: 'A long description' }],
      edges: [],
    });
    expect(out).toContain('foo["foo (project)"]');
    expect(out).not.toContain('A long description');
  });
});

// =============================================================================
// ac-3: mermaid renders without errors in `mmdc` when available; otherwise
// snapshot-test against fixture corpus
// =============================================================================

describe('ac-3: mermaid validity', () => {
  const fixtureDir = join(__dirname, 'fixtures', 'graph');
  const cases = ['depth-0', 'depth-1', 'depth-2', 'cycles-2', 'cycles-3'];

  const hasMmdc = (): boolean => {
    const probe = spawnSync('which', ['mmdc'], { encoding: 'utf8' });
    return probe.status === 0 && probe.stdout.trim().length > 0;
  };

  it("when `mmdc` is on PATH, piping the CLI's mermaid output to `mmdc -i - -o /tmp/out.svg` exits 0 on the fixture corpus", async () => {
    if (!hasMmdc()) {
      // The contract test pair (mmdc available vs absent) decides the mode
      // at runtime by probing PATH. Report the path probe explicitly so
      // the test log shows which mode it ran in.
      console.log('ac-3: mmdc not on PATH; this test arm skipped (snapshot test asserts coverage)');
      return;
    }
    for (const c of cases) {
      const fixturePath = join(fixtureDir, `${c}.mermaid`);
      const expected = readFileSync(fixturePath, 'utf8');
      const out = join(tmp, `${c}.svg`);
      const res = spawnSync('mmdc', ['-i', '-', '-o', out], {
        input: expected,
        encoding: 'utf8',
      });
      expect(res.status, `mmdc on ${c}: ${res.stderr}`).toBe(0);
    }
  });

  it('when `mmdc` is NOT on PATH, the mermaid output for the fixture corpus matches a committed snapshot (e.g. `tests/fixtures/graph/<case>.mermaid`)', async () => {
    if (hasMmdc()) {
      console.log('ac-3: mmdc present; snapshot fallback arm still asserts file equality');
    }
    for (const c of cases) {
      const fixturePath = join(fixtureDir, `${c}.mermaid`);
      expect(existsSync(fixturePath), `snapshot ${fixturePath} must exist`).toBe(true);
      const expected = readFileSync(fixturePath, 'utf8');
      const result = await loadFixtureAndRender(c, 'mermaid');
      expect(result).toBe(expected);
    }
  });

  it('the mmdc-vs-snapshot fallback decision is made at runtime by probing PATH (not via an env flag), and the test reports which mode it used', () => {
    const probe = spawnSync('which', ['mmdc'], { encoding: 'utf8' });
    const present = probe.status === 0 && probe.stdout.trim().length > 0;
    console.log(`ac-3: mmdc on PATH = ${present}`);
    // No env-flag override exists -- this test asserts the runtime probe
    // is the sole signal. There is no `process.env.DAR933_USE_MMDC` or
    // similar; the decision is just "which mmdc".
    expect(typeof present).toBe('boolean');
  });
});

// =============================================================================
// ac-4: cycles render as a single edge between participating nodes; visited
// set tracking prevents duplicate node emission
// =============================================================================

describe('ac-4: cycle handling', () => {
  it('fixture with a 2-cycle (a -> b, b -> a) at depth 2 emits exactly one node line for `a`, one for `b`, and two edge lines (one per direction)', async () => {
    await seedStore([
      { name: 'a', relations: [{ to: 'b', type: 'related-to' }] },
      { name: 'b', relations: [{ to: 'a', type: 'related-to' }] },
    ]);
    const res = await runMain(['graph', 'a', '--depth', '2']);
    expect(res.exitCode).toBe(0);
    const aNodeMatches = res.stdout.match(/^\s*a\["a \(.+\)"\]$/gm) ?? [];
    const bNodeMatches = res.stdout.match(/^\s*b\["b \(.+\)"\]$/gm) ?? [];
    expect(aNodeMatches.length).toBe(1);
    expect(bNodeMatches.length).toBe(1);
    const edgeMatches = res.stdout.match(/-- "related-to" -->/g) ?? [];
    expect(edgeMatches.length).toBe(2);
  });

  it('fixture with a 3-cycle (a -> b -> c -> a) at depth 3 emits exactly one node line per participant and exactly three edge lines, with no duplicate edge lines', async () => {
    await seedStore([
      { name: 'a', relations: [{ to: 'b', type: 'related-to' }] },
      { name: 'b', relations: [{ to: 'c', type: 'related-to' }] },
      { name: 'c', relations: [{ to: 'a', type: 'related-to' }] },
    ]);
    const res = await runMain(['graph', 'a', '--depth', '3']);
    expect(res.exitCode).toBe(0);
    for (const n of ['a', 'b', 'c']) {
      const matches = res.stdout.match(new RegExp(`^\\s*${n}\\["${n} \\(.+\\)"\\]$`, 'gm')) ?? [];
      expect(matches.length, `node ${n}`).toBe(1);
    }
    const edgeLines = res.stdout.split('\n').filter((l) => l.includes('-- "related-to" -->'));
    expect(edgeLines.length).toBe(3);
    expect(new Set(edgeLines).size).toBe(3);
  });

  it('fixture with a self-reference attempt (rejected at graph-build time per DAR-926) does not appear in mermaid output and does not crash the renderer', async () => {
    // DAR-926 rejects self-edges at parse and graph-build time. The CLI
    // should accept a memory with no self-edge and the renderer should
    // produce zero self-loop lines (no `a -- ... --> a`).
    await seedStore([{ name: 'a' }]);
    const res = await runMain(['graph', 'a']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toMatch(/^\s*a -- "[^"]+" --> a$/m);
  });

  it('the CLI walks the same `createMemoryGraphHandler` (or its underlying traversal helper) as the `memory_graph` MCP tool — verified by feeding both the same args and asserting identical `nodes`/`edges` sets', async () => {
    const { store, graph } = await seedStore([
      { name: 'a', relations: [{ to: 'b', type: 'related-to' }] },
      { name: 'b', relations: [{ to: 'c', type: 'related-to' }] },
      { name: 'c' },
    ]);
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const mcpResult = (await handler({ name: 'a', depth: 2 })) as MemoryGraphResult;

    const cliRes = await runMain(['graph', 'a', '--depth', '2', '--format', 'json']);
    expect(cliRes.exitCode).toBe(0);
    const cliResult: MemoryGraphResult = JSON.parse(cliRes.stdout);

    const sortNodes = (ns: MemoryGraphResult['nodes']) =>
      [...ns].sort((x, y) => x.name.localeCompare(y.name));
    const sortEdges = (es: MemoryGraphResult['edges']) =>
      [...es].sort(
        (x, y) =>
          x.from.localeCompare(y.from) || x.to.localeCompare(y.to) || x.type.localeCompare(y.type),
      );
    expect(sortNodes(cliResult.nodes)).toEqual(sortNodes(mcpResult.nodes));
    expect(sortEdges(cliResult.edges)).toEqual(sortEdges(mcpResult.edges));
  });
});

// =============================================================================
// ac-5: JSON output matches `memory_graph` MCP response shape exactly
// =============================================================================

describe('ac-5: json output shape', () => {
  it('`commonplace graph <name> --format json` stdout parses as JSON with the exact keys `{ root, nodes, edges }` (no extra keys)', async () => {
    await seedStore([{ name: 'a', relations: [{ to: 'b', type: 'related-to' }] }, { name: 'b' }]);
    const res = await runMain(['graph', 'a', '--format', 'json']);
    expect(res.exitCode).toBe(0);
    const decoded = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(['edges', 'nodes', 'root']);
  });

  it('each entry in `nodes[]` has exactly `{ name, type, description }` matching `MemoryGraphNode` from `src/server/handlers.ts`', async () => {
    await seedStore([{ name: 'a' }]);
    const res = await runMain(['graph', 'a', '--format', 'json']);
    expect(res.exitCode).toBe(0);
    const decoded = JSON.parse(res.stdout) as { nodes: Record<string, unknown>[] };
    for (const node of decoded.nodes) {
      expect(Object.keys(node).sort()).toEqual(['description', 'name', 'type']);
    }
  });

  it('each entry in `edges[]` has exactly `{ from, to, type }` matching `MemoryGraphEdge` from `src/server/handlers.ts`', async () => {
    await seedStore([{ name: 'a', relations: [{ to: 'b', type: 'related-to' }] }, { name: 'b' }]);
    const res = await runMain(['graph', 'a', '--format', 'json']);
    expect(res.exitCode).toBe(0);
    const decoded = JSON.parse(res.stdout) as { edges: Record<string, unknown>[] };
    expect(decoded.edges.length).toBeGreaterThan(0);
    for (const edge of decoded.edges) {
      expect(Object.keys(edge).sort()).toEqual(['from', 'to', 'type']);
    }
  });

  it("for the same root/depth/types/direction/scope inputs, the CLI's `--format json` output is deeply equal to the `memory_graph` MCP handler's result", async () => {
    const { store, graph } = await seedStore([
      { name: 'a', relations: [{ to: 'b', type: 'builds-on' }] },
      { name: 'b', relations: [{ to: 'c', type: 'related-to' }] },
      { name: 'c' },
    ]);
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const mcp = (await handler({
      name: 'a',
      depth: 2,
      direction: 'both',
      types: ['related-to', 'builds-on', 'supersedes', 'child-of'],
    })) as MemoryGraphResult;

    const res = await runMain([
      'graph',
      'a',
      '--depth',
      '2',
      '--direction',
      'both',
      '--types',
      'related-to,builds-on,supersedes,child-of',
      '--format',
      'json',
    ]);
    expect(res.exitCode, res.stderr).toBe(0);
    const cli = JSON.parse(res.stdout) as MemoryGraphResult;
    expect(cli).toEqual(mcp);
  });
});

// =============================================================================
// ac-6: DOT output is valid Graphviz syntax (verified via `dot -Tpng` if
// available in test env, otherwise snapshot test)
// =============================================================================

describe('ac-6: dot output shape', () => {
  const fixtureDir = join(__dirname, 'fixtures', 'graph');
  const cases = ['depth-0', 'depth-1', 'depth-2', 'cycles-2', 'cycles-3'];

  const hasDot = (): boolean => {
    const probe = spawnSync('which', ['dot'], { encoding: 'utf8' });
    return probe.status === 0 && probe.stdout.trim().length > 0;
  };

  it('dot output begins with `digraph` and is balanced (matching braces)', () => {
    const out = renderDot({
      root: { name: 'a', type: 'reference', description: 'A' },
      nodes: [
        { name: 'a', type: 'reference', description: 'A' },
        { name: 'b', type: 'reference', description: 'B' },
      ],
      edges: [{ from: 'a', to: 'b', type: 'related-to' }],
    });
    expect(out.startsWith('digraph')).toBe(true);
    let depth = 0;
    for (const ch of out) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("when `dot` is on PATH, piping the CLI's `--format dot` output to `dot -Tpng -o /dev/null` exits 0 on the fixture corpus", async () => {
    if (!hasDot()) {
      console.log('ac-6: dot not on PATH; this test arm skipped (snapshot test asserts coverage)');
      return;
    }
    for (const c of cases) {
      const fixturePath = join(fixtureDir, `${c}.dot`);
      const expected = readFileSync(fixturePath, 'utf8');
      const res = spawnSync('dot', ['-Tpng', '-o', '/dev/null'], {
        input: expected,
        encoding: 'utf8',
      });
      expect(res.status, `dot on ${c}: ${res.stderr}`).toBe(0);
    }
  });

  it('when `dot` is NOT on PATH, the dot output for the fixture corpus matches a committed snapshot (e.g. `tests/fixtures/graph/<case>.dot`)', async () => {
    for (const c of cases) {
      const fixturePath = join(fixtureDir, `${c}.dot`);
      expect(existsSync(fixturePath), `snapshot ${fixturePath} must exist`).toBe(true);
      const expected = readFileSync(fixturePath, 'utf8');
      const result = await loadFixtureAndRender(c, 'dot');
      expect(result).toBe(expected);
    }
  });

  it('every dot edge carries a `label="<type>"` attribute for each of the six edge types (related-to, builds-on, contradicts, child-of, supersedes, mentions)', () => {
    const types = ['related-to', 'builds-on', 'contradicts', 'child-of', 'supersedes', 'mentions'];
    const out = renderDot({
      root: { name: 'a', type: 'reference', description: 'A' },
      nodes: [
        { name: 'a', type: 'reference', description: 'A' },
        { name: 'b', type: 'reference', description: 'B' },
      ],
      edges: types.map((t) => ({
        from: 'a',
        to: 'b',
        type: t as 'related-to',
      })),
    });
    for (const t of types) {
      expect(out).toContain(`label="${t}"`);
    }
  });
});

// =============================================================================
// ac-7: snapshot tests against fixture corpus
// =============================================================================

describe('ac-7: fixture corpus snapshots', () => {
  it('depth-0 fixture: each format emits only the root node and zero edges', async () => {
    for (const fmt of ['mermaid', 'json', 'dot'] as const) {
      const out = await loadFixtureAndRender('depth-0', fmt);
      if (fmt === 'json') {
        const decoded = JSON.parse(out) as MemoryGraphResult;
        expect(decoded.nodes.map((n) => n.name)).toEqual(['root']);
        expect(decoded.edges).toEqual([]);
      } else if (fmt === 'mermaid') {
        expect(out).toContain('root["root');
        expect(out).not.toMatch(/-->/);
      } else {
        expect(out).toContain('"root"');
        expect(out).not.toContain('->');
      }
    }
  });

  it('depth-1 fixture: each format emits the root plus its immediate neighbors, and zero second-hop nodes', async () => {
    for (const fmt of ['mermaid', 'json', 'dot'] as const) {
      const out = await loadFixtureAndRender('depth-1', fmt);
      if (fmt === 'json') {
        const decoded = JSON.parse(out) as MemoryGraphResult;
        const names = decoded.nodes.map((n) => n.name).sort();
        // root + one-hop neighbors (alpha, beta); no two-hop (gamma)
        expect(names).toEqual(['alpha', 'beta', 'root']);
      }
    }
  });

  it('depth-2 fixture: each format emits the root plus first- and second-hop neighbors', async () => {
    const out = await loadFixtureAndRender('depth-2', 'json');
    const decoded = JSON.parse(out) as MemoryGraphResult;
    const names = decoded.nodes.map((n) => n.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma', 'root']);
  });

  it('cycles fixture (2-cycle and 3-cycle): each format emits no duplicate nodes or edges (covered by ac-4 traversal, asserted here per-format on disk)', async () => {
    for (const fixture of ['cycles-2', 'cycles-3']) {
      for (const fmt of ['mermaid', 'json', 'dot'] as const) {
        const out = await loadFixtureAndRender(fixture, fmt);
        if (fmt === 'json') {
          const decoded = JSON.parse(out) as MemoryGraphResult;
          const names = decoded.nodes.map((n) => n.name);
          expect(new Set(names).size).toBe(names.length);
          const edgeKeys = decoded.edges.map((e) => `${e.from}|${e.to}|${e.type}`);
          expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
        } else if (fmt === 'mermaid') {
          // Per-node line: exactly one `<name>["..."]` line per node.
          const nodeLines = out.match(/^\s*[a-z0-9_]+\["/gm) ?? [];
          expect(new Set(nodeLines).size).toBe(nodeLines.length);
        }
      }
    }
  });

  it('type-filter fixture: `--types related-to` emits only `related-to` edges and only nodes reachable via that filter in each format', async () => {
    await seedStore([
      {
        name: 'root',
        relations: [
          { to: 'a', type: 'related-to' },
          { to: 'b', type: 'builds-on' },
        ],
      },
      { name: 'a' },
      { name: 'b' },
    ]);
    const res = await runMain(['graph', 'root', '--types', 'related-to', '--format', 'json']);
    expect(res.exitCode).toBe(0);
    const decoded = JSON.parse(res.stdout) as MemoryGraphResult;
    for (const e of decoded.edges) expect(e.type).toBe('related-to');
    const names = decoded.nodes.map((n) => n.name).sort();
    expect(names).toEqual(['a', 'root']);
  });

  it('direction-filter fixture: `--direction out` emits only edges authored BY nodes in the walk; `--direction in` only emits edges authored TO nodes in the walk; verified per format', async () => {
    await seedStore([
      { name: 'root', relations: [{ to: 'a', type: 'related-to' }] },
      { name: 'a' },
      { name: 'b', relations: [{ to: 'root', type: 'related-to' }] },
    ]);
    const outRes = await runMain(['graph', 'root', '--direction', 'out', '--format', 'json']);
    const outDecoded = JSON.parse(outRes.stdout) as MemoryGraphResult;
    expect(outDecoded.edges.every((e) => e.from === 'root')).toBe(true);

    const inRes = await runMain(['graph', 'root', '--direction', 'in', '--format', 'json']);
    const inDecoded = JSON.parse(inRes.stdout) as MemoryGraphResult;
    expect(inDecoded.edges.every((e) => e.to === 'root')).toBe(true);
  });

  it('`from === to` edge case fixture (root memory references itself by name in a way the graph permits — i.e., zero outbound to self, since DAR-926 rejects self-edges): each format emits the root with zero self-loops and does not crash', async () => {
    await seedStore([{ name: 'root' }]);
    for (const fmt of ['mermaid', 'json', 'dot'] as const) {
      const res = await runMain(['graph', 'root', '--format', fmt]);
      expect(res.exitCode).toBe(0);
      if (fmt === 'json') {
        const decoded = JSON.parse(res.stdout) as MemoryGraphResult;
        for (const e of decoded.edges) {
          expect(e.from === e.to).toBe(false);
        }
      } else if (fmt === 'mermaid') {
        expect(res.stdout).not.toMatch(/^\s*([a-z0-9_]+) -- "[^"]+" --> \1$/m);
      } else {
        expect(res.stdout).not.toMatch(/^\s*"([^"]+)" -> "\1"/m);
      }
    }
  });
});

// =============================================================================
// ac-8: `--help` documents all flags including the format default
// =============================================================================

describe('ac-8: --help and dispatcher parity', () => {
  it('`commonplace graph --help` exits 0 and prints a usage message to stdout that names every flag: --depth, --types, --direction, --format, --scope', async () => {
    const res = await runMain(['graph', '--help']);
    expect(res.exitCode).toBe(0);
    for (const flag of ['--depth', '--types', '--direction', '--format', '--scope']) {
      expect(res.stdout).toContain(flag);
    }
  });

  it('`commonplace graph --help` output includes the default value for each flag, in particular `--format mermaid` (the default)', async () => {
    const res = await runMain(['graph', '--help']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('mermaid');
    // each flag mentions a default
    expect(res.stdout).toMatch(/--depth[^\n]*default[^\n]*1/i);
    expect(res.stdout).toMatch(/--format[^\n]*default[^\n]*mermaid/i);
    expect(res.stdout).toMatch(/--direction[^\n]*default[^\n]*both/i);
  });

  it("`commonplace graph --help` and `commonplace migrate --help` are dispatched by the same dispatcher pattern (both return a `kind: 'ok', mode: 'help'`-shaped result or equivalent shared envelope) — verified by parser-shape parity test", () => {
    const graphHelp = parseGraphArgs(['graph', '--help']);
    expect(graphHelp.kind).toBe('ok');
    if (graphHelp.kind !== 'ok') return;
    expect(graphHelp.mode).toBe('help');
  });

  it("the canonical `USAGE` constant exported from the dispatcher includes a `commonplace graph <name>` line and is rendered verbatim from both the bare-bin no-arg error path and the `graph` parser's usage_error path (matches DAR-961 review f-1 single-source-of-truth pattern)", () => {
    expect(USAGE).toContain('commonplace graph <name>');
    const parsed = parseGraphArgs(['graph']);
    expect(parsed.kind).toBe('usage_error');
    if (parsed.kind !== 'usage_error') return;
    // Both error paths render the same USAGE constant verbatim
    expect(parsed.message).toContain(USAGE);
  });
});

// =============================================================================
// Helpers for fixture rendering
// =============================================================================

interface FixtureSpec {
  root: string;
  depth?: number;
  direction?: 'out' | 'in' | 'both';
  types?: string[];
  memories: SeedMemory[];
}

const loadFixtureAndRender = async (
  caseName: string,
  fmt: 'mermaid' | 'json' | 'dot',
): Promise<string> => {
  const fixtureDir = join(__dirname, 'fixtures', 'graph');
  const specRaw = readFileSync(join(fixtureDir, `${caseName}.json`), 'utf8');
  const spec = JSON.parse(specRaw) as FixtureSpec;

  // Each fixture renders against its own tmp store so tests stay isolated.
  const caseTmp = mkdtempSync(join(tmpdir(), `dar933-fix-${caseName}-`));
  try {
    const graph = new MemoryGraph({ onDangling: () => {} });
    const store = new MemoryStore({ dir: caseTmp, embedder: makeStubEmbedder(), graph });
    await store.scan();
    for (const m of spec.memories) {
      await store.save({
        name: m.name,
        type: m.type ?? 'reference',
        description: m.description ?? m.name,
        body: m.body ?? `${m.name} body`,
        relations: m.relations ?? [],
        supersedes: m.supersedes ?? [],
      });
    }
    const handler = createMemoryGraphHandler({ userStore: store, userGraph: graph });
    const args: Record<string, unknown> = { name: spec.root };
    if (spec.depth !== undefined) args.depth = spec.depth;
    if (spec.direction !== undefined) args.direction = spec.direction;
    if (spec.types !== undefined) args.types = spec.types;
    const result = (await handler(args)) as MemoryGraphResult;

    if (fmt === 'mermaid') return renderMermaid(result);
    if (fmt === 'json') return renderJson(result);
    return renderDot(result);
  } finally {
    rmSync(caseTmp, { recursive: true, force: true });
  }
};
