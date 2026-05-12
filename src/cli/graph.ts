/**
 * Graph visualization CLI (DAR-933) — exposes
 *
 *   `commonplace graph <name> [--depth N] [--types T,T] [--direction d] [--format f] [--scope s]`
 *
 * as a subcommand of the `commonplace` bin (alongside `migrate`). The
 * command walks the same per-scope {@link MemoryGraph} the `memory_graph`
 * MCP tool uses and emits one of three renderings:
 *
 *   - `mermaid` (default) -- a fenced ```` ```mermaid\nflowchart LR ```` block.
 *   - `json` -- the `memory_graph` MCP response shape verbatim (`{ root,
 *     nodes, edges }`), so callers can pipe it into other tools.
 *   - `dot` -- Graphviz DOT, for archival or very-large-graph workflows
 *     where mermaid's auto-layout slows down.
 *
 * The CLI walks the same `createMemoryGraphHandler` traversal helper that
 * the MCP tool uses, so cycle handling, depth/types/direction filters, and
 * dangling-edge skipping behave identically. The renderers operate on the
 * handler's typed result shape -- they do not re-walk the graph.
 *
 * # Scope flag
 *
 * `--scope user|project|both` maps to the underlying handler's `scope`
 * argument. The handler's `scope` type today is `'user' | 'project'`;
 * `--scope both` maps to `undefined` (i.e. "let the handler search both
 * stores and pick whichever holds the name"). That contract is documented
 * in the DAR-933 envelope's explicit-non-goals (we are not widening the
 * `Scope` type just to fit this CLI flag).
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

import { detectScope } from '../bin/scope.js';
import {
  createMemoryGraphHandler,
  DEFAULT_GRAPH_TYPES,
  GRAPH_DIRECTIONS,
  GRAPH_EDGE_TYPES,
  type GraphDirection,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryGraphResult,
  type Scope,
} from '../server/handlers.js';
import { MemoryGraph } from '../store/graph.js';
import { MemoryStore, type Embedder } from '../store/memory-store.js';
import type { EdgeType } from '../store/graph.js';
import { USAGE, USAGE_GRAPH_LINE } from './migrate.js';

// ---------------------------------------------------------------------------
// Public USAGE additions
// ---------------------------------------------------------------------------

/**
 * Re-export of {@link USAGE_GRAPH_LINE} so existing graph-CLI consumers
 * (parser usage_error path, fixture generator, tests) can import it from
 * the graph module without reaching across into `migrate.ts`. The
 * canonical declaration lives in `migrate.ts` (where `USAGE` is composed)
 * to avoid a circular import; this re-export preserves the single source
 * of truth (DAR-961 review f-1 / DAR-933 review f-1).
 */
export { USAGE_GRAPH_LINE };

// ---------------------------------------------------------------------------
// Output formats
// ---------------------------------------------------------------------------

export const OUTPUT_FORMATS = ['mermaid', 'json', 'dot'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * The CLI-visible `--scope` choices. The handler's underlying `Scope` is
 * `'user' | 'project'`; the CLI adds the literal `'both'` which maps to
 * `undefined` at handler-call time (i.e. "do not constrain by scope").
 */
export const SCOPE_FLAGS = ['user', 'project', 'both'] as const;
export type ScopeFlag = (typeof SCOPE_FLAGS)[number];

/**
 * Default `--types` filter when the caller omits it. Mirrors the
 * `memory_graph` MCP handler's {@link DEFAULT_GRAPH_TYPES} so the CLI's
 * default behaviour is identical to a `memory_graph` call with no `types`
 * argument.
 */
export const DEFAULT_TYPES: readonly EdgeType[] = DEFAULT_GRAPH_TYPES;

const isOutputFormat = (v: string): v is OutputFormat =>
  (OUTPUT_FORMATS as readonly string[]).includes(v);
const isDirection = (v: string): v is GraphDirection =>
  (GRAPH_DIRECTIONS as readonly string[]).includes(v);
const isScopeFlag = (v: string): v is ScopeFlag => (SCOPE_FLAGS as readonly string[]).includes(v);
const isEdgeType = (v: string): v is EdgeType =>
  (GRAPH_EDGE_TYPES as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Render a {@link MemoryGraphResult} as a Mermaid `flowchart LR` block
 * wrapped in a `mermaid` code fence. Output ends with a trailing newline so
 * it composes cleanly into stdout / markdown.
 *
 * Node labels are `<name> (<type>)`; the memory description is intentionally
 * omitted to keep the rendered chart readable (issue body explicitly
 * specifies this format).
 */
export const renderMermaid = (result: MemoryGraphResult): string => {
  const lines: string[] = [];
  lines.push('```mermaid');
  lines.push('flowchart LR');
  for (const node of result.nodes) {
    lines.push(`  ${node.name}["${node.name} (${node.type})"]`);
  }
  for (const edge of result.edges) {
    lines.push(`  ${edge.from} -- "${edge.type}" --> ${edge.to}`);
  }
  lines.push('```');
  return `${lines.join('\n')}\n`;
};

/**
 * Render a {@link MemoryGraphResult} as a Graphviz `digraph` block. Each
 * edge carries a `label="<type>"` attribute so the rendered image shows
 * the edge type.
 */
export const renderDot = (result: MemoryGraphResult): string => {
  const lines: string[] = [];
  lines.push('digraph commonplace {');
  lines.push('  rankdir=LR;');
  for (const node of result.nodes) {
    lines.push(`  "${node.name}" [label="${node.name} (${node.type})"];`);
  }
  for (const edge of result.edges) {
    lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.type}"];`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
};

/**
 * Render a {@link MemoryGraphResult} as pretty-printed JSON. Output ends
 * with a trailing newline. The shape is byte-identical to the
 * `memory_graph` MCP handler's return value -- `{ root, nodes, edges }`
 * with no extra keys.
 */
export const renderJson = (result: MemoryGraphResult): string => {
  const ordered = {
    root: shapeNode(result.root),
    nodes: result.nodes.map(shapeNode),
    edges: result.edges.map(shapeEdge),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
};

const shapeNode = (n: MemoryGraphNode): { name: string; type: string; description: string } => ({
  name: n.name,
  type: n.type,
  description: n.description,
});

const shapeEdge = (e: MemoryGraphEdge): { from: string; to: string; type: string } => ({
  from: e.from,
  to: e.to,
  type: e.type,
});

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

/** Result of {@link parseGraphArgs}. */
export type ParsedGraphArgs =
  | {
      kind: 'ok';
      mode: 'graph';
      name: string;
      depth: number;
      types: EdgeType[];
      direction: GraphDirection;
      format: OutputFormat;
      scope: Scope | undefined;
    }
  | {
      kind: 'ok';
      mode: 'help';
    }
  | {
      kind: 'usage_error';
      message: string;
    }
  | {
      kind: 'unknown_subcommand';
      message: string;
    };

/**
 * The canonical usage string for the `commonplace graph` subcommand. Used
 * by `parseGraphArgs`'s usage_error path AND by the dispatcher's bare-bin
 * no-arg error path. The dispatcher's `USAGE` constant additionally
 * includes the migrate lines; this constant is the graph-specific
 * `--help` body.
 */
export const GRAPH_HELP =
  'Usage: commonplace graph <name> [options]\n' +
  '\n' +
  'Visualize the local graph neighborhood of a memory.\n' +
  '\n' +
  'Options:\n' +
  '  --depth N                  Traversal depth in hops (default: 1)\n' +
  '  --types T,T,T              Comma-separated edge types to traverse\n' +
  `                             (default: ${[...DEFAULT_TYPES].join(',')};\n` +
  `                              valid: ${[...GRAPH_EDGE_TYPES].join(',')})\n` +
  '  --direction out|in|both    Edge direction to walk (default: both)\n' +
  '  --format mermaid|json|dot  Output format (default: mermaid)\n' +
  '  --scope user|project|both  Which store to look in (default: both)\n' +
  '  --help                     Show this help and exit';

/**
 * Parse the argv tail for the `graph` subcommand. Like `parseMigrateArgs`,
 * returns a discriminated result so the dispatcher can render an
 * appropriate stderr message and exit code without sprinkling
 * `process.exit` calls into the parser.
 */
export const parseGraphArgs = (argv: readonly string[]): ParsedGraphArgs => {
  if (argv.length === 0) {
    return {
      kind: 'usage_error',
      message: `commonplace: missing subcommand.\n${GRAPH_HELP}`,
    };
  }
  const [head, ...rest] = argv;
  if (head !== 'graph') {
    return {
      kind: 'unknown_subcommand',
      message: `commonplace: unknown subcommand \`${head ?? ''}\`.\n${GRAPH_HELP}`,
    };
  }

  let name: string | null = null;
  let depth = 1;
  let types: EdgeType[] = [...DEFAULT_TYPES];
  let direction: GraphDirection = 'both';
  let format: OutputFormat = 'mermaid';
  let scopeFlag: ScopeFlag = 'both';
  let helpRequested = false;

  const it = rest[Symbol.iterator]();
  for (let step = it.next(); !step.done; step = it.next()) {
    const token = step.value;
    if (token === '--help' || token === '-h') {
      helpRequested = true;
      continue;
    }
    if (token === '--depth') {
      const next = it.next();
      if (next.done) {
        return usageError('--depth requires an integer value');
      }
      const parsed = Number.parseInt(next.value, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== next.value) {
        return usageError(
          `--depth must be a non-negative integer; got ${JSON.stringify(next.value)}`,
        );
      }
      depth = parsed;
      continue;
    }
    if (token === '--types') {
      const next = it.next();
      if (next.done) {
        return usageError('--types requires a comma-separated list of edge types');
      }
      const parts = next.value
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const parsedTypes: EdgeType[] = [];
      for (const p of parts) {
        if (!isEdgeType(p)) {
          return usageError(
            `--types entry \`${p}\` is not a valid edge type; supported: ${[...GRAPH_EDGE_TYPES].join(',')}`,
          );
        }
        parsedTypes.push(p);
      }
      if (parsedTypes.length === 0) {
        return usageError('--types must list at least one edge type');
      }
      types = parsedTypes;
      continue;
    }
    if (token === '--direction') {
      const next = it.next();
      if (next.done) {
        return usageError('--direction requires a value');
      }
      if (!isDirection(next.value)) {
        return usageError(
          `--direction must be one of ${[...GRAPH_DIRECTIONS].join(',')}; got ${JSON.stringify(next.value)}`,
        );
      }
      direction = next.value;
      continue;
    }
    if (token === '--format') {
      const next = it.next();
      if (next.done) {
        return usageError('--format requires a value');
      }
      if (!isOutputFormat(next.value)) {
        return usageError(
          `--format must be one of ${[...OUTPUT_FORMATS].join(',')}; got ${JSON.stringify(next.value)}`,
        );
      }
      format = next.value;
      continue;
    }
    if (token === '--scope') {
      const next = it.next();
      if (next.done) {
        return usageError('--scope requires a value');
      }
      if (!isScopeFlag(next.value)) {
        return usageError(
          `--scope must be one of ${[...SCOPE_FLAGS].join(',')}; got ${JSON.stringify(next.value)}`,
        );
      }
      scopeFlag = next.value;
      continue;
    }
    if (token.startsWith('--')) {
      return usageError(`unknown flag \`${token}\`. See \`commonplace graph --help\`.`);
    }
    if (name === null) {
      name = token;
    } else {
      return usageError(
        `unexpected positional argument \`${token}\`. See \`commonplace graph --help\`.`,
      );
    }
  }

  if (helpRequested) {
    return { kind: 'ok', mode: 'help' };
  }
  if (name === null) {
    return usageError('missing positional argument <name>');
  }

  // Map --scope both to undefined; explicit user/project pass through.
  // Explicit narrowing (rather than a `scopeFlag as Scope` assertion)
  // lets TypeScript flow-analyze `scopeFlag` to `'user' | 'project'` --
  // which is exactly `Scope` -- so no type coercion is required.
  let scope: Scope | undefined;
  if (scopeFlag === 'user' || scopeFlag === 'project') {
    scope = scopeFlag;
  }

  return {
    kind: 'ok',
    mode: 'graph',
    name,
    depth,
    types,
    direction,
    format,
    scope,
  };
};

/**
 * Build a usage_error result. The message body includes BOTH the
 * graph-specific `--help` text and the dispatcher-level `USAGE` constant
 * so the error surface lists every subcommand the operator could have
 * meant. This matches the DAR-961 review f-1 single-source-of-truth
 * pattern: the dispatcher's USAGE is the canonical list, and any
 * subcommand-level usage error renders it verbatim alongside its own
 * detailed help.
 */
const usageError = (msg: string): ParsedGraphArgs => ({
  kind: 'usage_error',
  message: `commonplace graph: ${msg}\n${GRAPH_HELP}\n\n${USAGE}`,
});

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/** Inputs to {@link graphMain}. */
export interface GraphMainOptions {
  /** Argv tail (skip `node <bin>`). */
  argv: readonly string[];
  /** Embedder factory. The bin passes a real embedder; tests pass a stub. */
  embedderFactory: () => Embedder;
  /** Stdout writer. */
  stdout: (chunk: string) => void;
  /** Stderr writer. */
  stderr: (chunk: string) => void;
  /** Process env (for scope detection). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Working directory (for cwd-marker scope detection). Defaults to `process.cwd()`. */
  cwd?: string;
}

/** Result of {@link graphMain}. */
export interface GraphMainResult {
  /** Process exit code: 0 on success, 2 on usage error, 1 on runtime error. */
  exitCode: number;
}

/**
 * Bin entry for the `graph` subcommand. Parses argv, resolves the user
 * (and optional project) memory dir from env using the same priority order
 * the MCP server uses, loads the memories via `MemoryStore`, and dispatches
 * to the requested renderer.
 *
 * Returns an exit code rather than calling `process.exit` directly so tests
 * can drive the function without spawning a child process.
 */
export const graphMain = async (opts: GraphMainOptions): Promise<GraphMainResult> => {
  const parsed = parseGraphArgs(opts.argv);
  if (parsed.kind === 'usage_error' || parsed.kind === 'unknown_subcommand') {
    opts.stderr(`${parsed.message}\n`);
    return { exitCode: 2 };
  }
  if (parsed.mode === 'help') {
    opts.stdout(`${GRAPH_HELP}\n`);
    return { exitCode: 0 };
  }

  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  // Resolve user + optional project dir from env / cwd. The CLI does not
  // perform an MCP `roots/list` round-trip (no transport here), so pass
  // `roots: null` and rely on the env / cwd fallback chain.
  const scope = detectScope({ env, roots: null, cwd });

  // Ensure the user dir exists; the project dir is best-effort (an
  // ENOENT here is fine — MemoryStore.scan handles missing directories).
  try {
    await mkdir(scope.userDir, { recursive: true });
  } catch (err) {
    opts.stderr(
      `commonplace graph: could not create user dir \`${scope.userDir}\`: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { exitCode: 1 };
  }

  const embedder = opts.embedderFactory();

  const userGraph = new MemoryGraph({ onDangling: () => {} });
  const userStore = new MemoryStore({ dir: scope.userDir, embedder, graph: userGraph });
  await userStore.scan();

  let projectStore: MemoryStore | undefined;
  let projectGraph: MemoryGraph | undefined;
  if (scope.projectDir !== null && existsSync(scope.projectDir)) {
    projectGraph = new MemoryGraph({ onDangling: () => {} });
    projectStore = new MemoryStore({
      dir: scope.projectDir,
      embedder,
      graph: projectGraph,
    });
    await projectStore.scan();
  }

  const handler = createMemoryGraphHandler({
    userStore,
    ...(projectStore !== undefined ? { projectStore } : {}),
    userGraph,
    ...(projectGraph !== undefined ? { projectGraph } : {}),
  });

  const handlerArgs: Record<string, unknown> = {
    name: parsed.name,
    depth: parsed.depth,
    direction: parsed.direction,
    types: parsed.types,
  };
  if (parsed.scope !== undefined) handlerArgs.scope = parsed.scope;

  let result: MemoryGraphResult;
  try {
    result = (await handler(handlerArgs)) as MemoryGraphResult;
  } catch (err) {
    opts.stderr(`commonplace graph: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 1 };
  }

  if (parsed.format === 'mermaid') {
    opts.stdout(renderMermaid(result));
  } else if (parsed.format === 'json') {
    opts.stdout(renderJson(result));
  } else {
    opts.stdout(renderDot(result));
  }
  return { exitCode: 0 };
};
