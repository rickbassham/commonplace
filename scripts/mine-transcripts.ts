/**
 * Transcript-mining module for `memory_search` retrieval evaluation.
 *
 * Walks Claude Code transcript JSONL files (default location:
 * `~/.claude/projects/<project-slug>/*.jsonl`) and extracts one record per
 * `mcp__commonplace__memory_search` tool call. Each record captures:
 *
 *   - the `query` argument the agent passed
 *   - the scope filter (if any)
 *   - the ordered list of memory `name`s the tool returned
 *   - the session id, tool-use id, timestamp, and the index of the
 *     next agent assistant turn (so consumers can inspect what the
 *     agent did with the results -- e.g. cite a name, save a memory,
 *     or get corrected by the operator).
 *
 * The module is deliberately split into a pure mining function and a thin
 * CLI shim at the bottom of the file. The pure function is imported by
 *
 *   - `scripts/build-labeled-set.ts` (this issue, DAR-1034)
 *   - `scripts/run-retrieval-benchmark.ts` (this issue, DAR-1034)
 *   - DAR-1026's dreaming/consolidation spike (when it lands)
 *
 * so the mining logic is reusable rather than only existing as a CLI
 * side-effect.
 *
 * # Determinism
 *
 * `mineTranscripts` returns records sorted lexically by
 * `(sessionId, timestamp, toolUseId)`. Re-running the same input produces
 * the same output order so downstream consumers (e.g. the labeled-set
 * generator) are reproducible.
 *
 * # Robustness
 *
 * Malformed JSONL lines are reported via the optional `onWarn` callback and
 * skipped -- a single bad line does not abort the whole mining pass.
 *
 * Run as a CLI:
 *   pnpm exec tsx scripts/mine-transcripts.ts [<transcripts-root>]
 *
 * When `<transcripts-root>` is omitted the script uses
 * {@link defaultTranscriptsRoot} (`~/.claude/projects`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The MCP tool name we care about. Other tool calls are ignored. */
export const MEMORY_SEARCH_TOOL_NAME = 'mcp__commonplace__memory_search';

/**
 * Type predicate narrowing an `unknown` to a plain (non-array, non-null)
 * object whose properties may be any `unknown`. JSONL lines are parsed as
 * `unknown`; we walk them with this predicate plus per-field `typeof`
 * checks rather than scattering `as Record<string, unknown>` casts.
 */
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Best-effort message extraction for caught errors typed as `unknown`. */
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * How many assistant turns after the `memory_search` tool_use to scan for
 * follow-up signals. Empirically the agent often doesn't text-respond
 * immediately -- it goes through a thinking block, then a Bash/Read, then
 * eventually quotes the returned name in prose or in a `memory_save`
 * input. 6 is enough to cover typical "search -> inspect -> save" flows
 * without straying into unrelated work later in the session.
 */
export const AGENT_FOLLOWUP_TURNS = 6;

/** One mined `memory_search` invocation. */
export interface MinedSearchCall {
  /** Absolute path of the transcript JSONL the record came from. */
  transcript: string;
  /** Session id from the JSONL line (may be empty if absent). */
  sessionId: string;
  /** Tool-use id matching the assistant turn (used to pair with the result). */
  toolUseId: string;
  /** ISO timestamp from the assistant turn (may be empty if absent). */
  timestamp: string;
  /** The `query` argument the agent passed. */
  query: string;
  /** The `scope` argument the agent passed, or null when unspecified. */
  scope: string | null;
  /** Names returned by the tool, in their original ranking order. */
  returnedNames: string[];
  /**
   * Concatenated agent follow-up text after this tool_use. Captures every
   * text block and the stringified `input` of every tool_use across the
   * next {@link AGENT_FOLLOWUP_TURNS} assistant turns (stopping early if
   * another `memory_search` is issued). Empty string when no follow-up
   * turn exists. Used by the labeled-set generator to detect citation /
   * save-follow-up signals (e.g. the agent later calls `memory_save` with
   * a particular `name`, or quotes a returned name in prose).
   */
  agentFollowupText: string;
  /**
   * Plain-text content of the next operator (user-role) turn after the
   * tool_result was received -- excluding tool_result content itself.
   * Empty string when no operator turn follows or the turn carries no
   * text. Used by the labeled-set generator to detect operator
   * corrections.
   */
  operatorFollowupText: string;
}

/** Options for {@link mineTranscripts}. */
export interface MineOptions {
  /**
   * Transcripts root. Defaults to {@link defaultTranscriptsRoot}. The root
   * may be a single project slug directory or a directory of project
   * slug directories (both shapes occur in practice -- the latter is the
   * default `~/.claude/projects` layout).
   */
  root?: string;
  /**
   * Optional warning sink. Called once per malformed JSONL line. Defaults
   * to a no-op so the CLI can choose to print to stderr while tests can
   * stay quiet.
   */
  onWarn?: (message: string) => void;
}

/**
 * Default transcripts root: `~/.claude/projects` under the current user's
 * home directory.
 */
export const defaultTranscriptsRoot = (): string => join(homedir(), '.claude', 'projects');

/**
 * Walk the transcripts root and return one record per `memory_search`
 * tool call found in any contained `.jsonl` file.
 *
 * Pure function: does not write to disk, does not spawn subprocesses, and
 * does not consult any environment beyond the explicit options.
 */
export const mineTranscripts = async (opts: MineOptions = {}): Promise<MinedSearchCall[]> => {
  const root = opts.root ?? defaultTranscriptsRoot();
  const onWarn = opts.onWarn ?? (() => {});

  const transcripts = collectTranscripts(root, onWarn);
  const out: MinedSearchCall[] = [];

  for (const path of transcripts) {
    const lines = readTranscriptLines(path, onWarn);
    // Pre-compute, per line index, whether the message is an assistant
    // or user turn -- so we can locate the next agent / operator follow-up
    // turn after each `memory_search` tool_use.
    const roles: Array<'assistant' | 'user' | 'other'> = lines.map((l) =>
      l === null ? 'other' : roleOf(l),
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === null || line === undefined) continue;
      const toolUse = extractMemorySearchToolUse(line);
      if (toolUse === null) continue;

      const result = findToolResult(lines, toolUse.id);
      const returnedNames = result === null ? [] : extractReturnedNames(result);

      const nextUserIdx = findNextRoleIndex(roles, i, 'user');

      out.push({
        transcript: path,
        sessionId: typeof line.sessionId === 'string' ? line.sessionId : '',
        toolUseId: toolUse.id,
        timestamp: typeof line.timestamp === 'string' ? line.timestamp : '',
        query: toolUse.query,
        scope: toolUse.scope,
        returnedNames,
        agentFollowupText: collectAgentFollowupText(lines, roles, i),
        operatorFollowupText: nextUserIdx === null ? '' : extractOperatorText(lines[nextUserIdx]),
      });
    }
  }

  // Deterministic ordering: by sessionId, then timestamp, then toolUseId.
  out.sort((a, b) => {
    if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.toolUseId !== b.toolUseId) return a.toolUseId < b.toolUseId ? -1 : 1;
    return 0;
  });

  return out;
};

// --- helpers ----------------------------------------------------------------

/**
 * Find every `.jsonl` file under `root`, walking the directory tree
 * recursively. The Claude Code layout has at least three observed shapes:
 *
 *   - `~/.claude/projects/<slug>/<session>.jsonl` -- top-level session
 *     transcripts (the original layout this miner supported).
 *   - `~/.claude/projects/<slug>/<session>/subagents/<agent>.jsonl` --
 *     subagent transcripts spawned during a session (94% of files on this
 *     dev's machine; missing these caps the labeled-set size hard).
 *   - Any future nesting added by Claude Code releases.
 *
 * Walking recursively means we never silently lose data when the layout
 * grows another level. Symlink loops are guarded by a visited-realpaths
 * set; non-readable directories are skipped with a warning sent to the
 * caller-supplied `onWarn` sink.
 */
const collectTranscripts = (root: string, onWarn: (msg: string) => void): string[] => {
  let stat;
  try {
    stat = statSync(root);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];

  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (dir: string): void => {
    let realDir: string;
    try {
      realDir = statSync(dir).isDirectory() ? dir : '';
    } catch {
      return;
    }
    if (realDir === '' || visited.has(realDir)) return;
    visited.add(realDir);

    let entries: ReadonlyArray<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      onWarn(`mine-transcripts: cannot read directory ${dir}: ${errMessage(err)}`);
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        out.push(p);
      } else if (ent.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(root);
  out.sort();
  return out;
};

/**
 * Parse a transcript JSONL file into an array of parsed objects, with `null`
 * placeholders for malformed lines (so downstream index-based lookups stay
 * stable). Empty lines are also `null`. Warnings about malformed lines are
 * routed through `onWarn`.
 */
const readTranscriptLines = (
  path: string,
  onWarn: (msg: string) => void,
): Array<Record<string, unknown> | null> => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    onWarn(`mine-transcripts: cannot read ${path}: ${errMessage(err)}`);
    return [];
  }
  const lines = raw.split('\n');
  const out: Array<Record<string, unknown> | null> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '') {
      out.push(null);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObject(parsed)) {
        out.push(parsed);
      } else {
        out.push(null);
      }
    } catch {
      onWarn(`mine-transcripts: malformed JSON at ${path}:${i + 1}`);
      out.push(null);
    }
  }
  return out;
};

/**
 * Classify a transcript line by message role (so consumers can locate the
 * next assistant or user turn after a tool_use).
 */
const roleOf = (line: Record<string, unknown>): 'assistant' | 'user' | 'other' => {
  const type = line.type;
  if (type === 'assistant') return 'assistant';
  if (type === 'user') return 'user';
  return 'other';
};

const findNextRoleIndex = (
  roles: Array<'assistant' | 'user' | 'other'>,
  from: number,
  target: 'assistant' | 'user',
): number | null => {
  for (let i = from + 1; i < roles.length; i++) {
    if (roles[i] === target) return i;
  }
  return null;
};

/**
 * If `line` is an assistant turn that contains a `memory_search` tool_use,
 * return the extracted `{ id, query, scope }`. Otherwise return null.
 */
const extractMemorySearchToolUse = (
  line: Record<string, unknown>,
): { id: string; query: string; scope: string | null } | null => {
  if (line.type !== 'assistant') return null;
  const message = line.message;
  if (!isObject(message)) return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;

  for (const item of content) {
    if (!isObject(item)) continue;
    if (item.type !== 'tool_use') continue;
    if (item.name !== MEMORY_SEARCH_TOOL_NAME) continue;
    const id = item.id;
    if (typeof id !== 'string') continue;
    const input = item.input;
    if (!isObject(input)) continue;
    const query = input.query;
    if (typeof query !== 'string') continue;
    const scope = typeof input.scope === 'string' ? input.scope : null;
    return { id, query, scope };
  }
  return null;
};

/**
 * Find the tool_result line paired with `toolUseId`. Searches across all
 * lines in the same transcript (the result line is typically the next
 * user turn after the tool_use, but we don't assume positional adjacency).
 */
const findToolResult = (
  lines: Array<Record<string, unknown> | null>,
  toolUseId: string,
): Record<string, unknown> | null => {
  for (const line of lines) {
    if (line === null) continue;
    if (line.type !== 'user') continue;
    const message = line.message;
    if (!isObject(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!isObject(item)) continue;
      if (item.type !== 'tool_result') continue;
      if (item.tool_use_id !== toolUseId) continue;
      return item;
    }
  }
  return null;
};

/**
 * Extract the ordered `matches[].name` array from a `tool_result` line. The
 * `tool_result.content` field can take several shapes in practice:
 *
 *   - an array of content blocks (`[{ type: 'text', text: '<json>' }, ...]`)
 *   - a single JSON string with the result payload
 *
 * We try to parse a `{ matches: [{ name }] }` payload out of either form.
 * Anything else (errors, plain prose, ...) yields an empty array.
 */
const extractReturnedNames = (result: Record<string, unknown>): string[] => {
  const content = result.content;
  let payloadText: string | null = null;

  if (typeof content === 'string') {
    payloadText = content;
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (!isObject(item)) continue;
      if (item.type !== 'text') continue;
      const text = item.text;
      if (typeof text === 'string') {
        payloadText = text;
        break;
      }
    }
  }

  if (payloadText === null) return [];

  try {
    const parsed: unknown = JSON.parse(payloadText);
    if (!isObject(parsed)) return [];
    const matches = parsed.matches;
    if (!Array.isArray(matches)) return [];
    const names: string[] = [];
    for (const m of matches) {
      if (!isObject(m)) continue;
      const name = m.name;
      if (typeof name === 'string') names.push(name);
    }
    return names;
  } catch {
    return [];
  }
};

/**
 * Walk forward from a `memory_search` tool_use line and concatenate
 * follow-up signal text from the next {@link AGENT_FOLLOWUP_TURNS} assistant
 * turns. For each such turn we capture:
 *
 *   - every `text` block (prose the agent emitted), and
 *   - the JSON-stringified `input` of every `tool_use` block (so the
 *     `memory_save` argument, the Bash command, etc. become searchable for
 *     memory-name citations).
 *
 * Stops early at the next `memory_search` tool_use (a new query is a new
 * unit of work; signals after it belong to that call, not this one).
 */
const collectAgentFollowupText = (
  lines: Array<Record<string, unknown> | null>,
  roles: Array<'assistant' | 'user' | 'other'>,
  from: number,
): string => {
  const parts: string[] = [];
  let seenAssistantTurns = 0;
  for (let j = from + 1; j < lines.length; j++) {
    if (roles[j] !== 'assistant') continue;
    const line = lines[j];
    if (line === undefined || line === null) continue;
    // Stop at the next memory_search -- subsequent text belongs to that
    // call, not this one.
    if (extractMemorySearchToolUse(line) !== null && j !== from) break;
    appendAssistantContent(line, parts);
    seenAssistantTurns += 1;
    if (seenAssistantTurns >= AGENT_FOLLOWUP_TURNS) break;
  }
  return parts.join('\n');
};

/**
 * Append every signal-carrying field of an assistant turn's content blocks
 * to `out`. `text` blocks contribute their text; `tool_use` blocks
 * contribute their JSON-stringified `input` (which lets us detect calls
 * like `memory_save({ name: "feedback_x" })`).
 */
const appendAssistantContent = (line: Record<string, unknown>, out: string[]): void => {
  if (line.type !== 'assistant') return;
  const message = line.message;
  if (!isObject(message)) return;
  const content = message.content;
  if (typeof content === 'string') {
    out.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (!isObject(item)) continue;
    if (item.type === 'text') {
      const text = item.text;
      if (typeof text === 'string') out.push(text);
    } else if (item.type === 'tool_use') {
      const input = item.input;
      if (input !== undefined) {
        try {
          out.push(JSON.stringify(input));
        } catch {
          // Circular / unserialisable inputs: skip.
        }
      }
    }
  }
};

/**
 * Extract the plain-text body of an operator (user-role) turn. Skips
 * `tool_result` content (which carries the tool output, not the operator's
 * intent) so callers see only what the human actually typed.
 */
const extractOperatorText = (line: Record<string, unknown> | null | undefined): string => {
  if (line === null || line === undefined) return '';
  if (line.type !== 'user') return '';
  const message = line.message;
  if (!isObject(message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!isObject(item)) continue;
    // Skip tool_result blocks -- they are the tool's response, not the
    // operator's intent. We only want what a human typed.
    if (item.type !== 'text') continue;
    const text = item.text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
};

// --- CLI --------------------------------------------------------------------

const isCliEntry = (): boolean => {
  // process.argv[1] resolves to the script path; compare with the module's
  // own file URL to detect a direct `tsx scripts/mine-transcripts.ts` run.
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
};

const main = async (): Promise<void> => {
  const argRoot = process.argv[2];
  const root = argRoot ?? process.env.COMMONPLACE_TRANSCRIPTS_ROOT ?? defaultTranscriptsRoot();
  const calls = await mineTranscripts({
    root,
    onWarn: (msg) => process.stderr.write(msg + '\n'),
  });
  process.stdout.write(JSON.stringify(calls, null, 2) + '\n');
};

if (isCliEntry()) {
  main().catch((err) => {
    process.stderr.write(
      `mine-transcripts: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
