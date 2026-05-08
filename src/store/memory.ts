/**
 * Memory `.md` file I/O with typed YAML frontmatter (DAR-911).
 *
 * A "memory" is a single markdown file whose YAML frontmatter carries a
 * baseline shape:
 *
 * ```yaml
 * ---
 * name: feedback_scope
 * description: Don't shrink scope unilaterally
 * type: feedback   # one of: user | feedback | project | reference
 * ---
 * <body>
 * ```
 *
 * The markdown file is the source of truth -- any sidecar (e.g. the binary
 * `.embedding` produced by DAR-910) is derived from this content and the
 * `contentSha` exported here. Critically, `contentSha` is canonicalised over
 * the v0.1 baseline frontmatter only (`type`, `name`, `description`) plus the
 * body. Forward-compatibility frontmatter fields (`relations`, `supersedes`
 * from DAR-925, or any future unknown keys) MUST NOT change the sha; adding
 * or removing graph edges does not invalidate the embedding.
 *
 * Out of scope for DAR-911:
 *   - parsing/validating `relations` / `supersedes` (DAR-925)
 *   - directory scan, in-memory index, lazy re-embed (DAR-916)
 *   - atomic writes / advisory locks (DAR-923)
 *   - filename validation, name/filename cross-checks (DAR-919/DAR-916)
 *   - the binary `.embedding` sidecar format (DAR-910)
 *   - the embedding model itself (DAR-912)
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** The four allowed memory `type` values. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

/** Union type of the four allowed memory `type` values. */
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * A memory's canonical data: the four fields that participate in
 * `contentSha`. Unknown / forward-compat frontmatter fields are intentionally
 * not represented here -- DAR-911 owns only the v0.1 baseline shape.
 */
export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/** Result of {@link readMemory}: the canonical fields plus the raw bytes read from disk. */
export interface ReadMemory extends Memory {
  /** Exact file contents as read from disk; no normalisation. */
  raw: string;
}

const isMemoryType = (v: unknown): v is MemoryType =>
  typeof v === 'string' && (MEMORY_TYPES as readonly string[]).includes(v);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Split a memory file's raw text into its frontmatter YAML and its body.
 *
 * Recognises the standard `---\n...\n---\n` (or `\r\n`) block at the very
 * start of the file. Throws when the delimiters are missing or the closing
 * delimiter is not found.
 */
const splitFrontmatter = (raw: string): { yaml: string; body: string } => {
  // Accept either LF or CRLF line endings around the opening delimiter.
  const openMatch = /^---[ \t]*\r?\n/.exec(raw);
  if (openMatch === null) {
    throw new Error('memory file is missing opening `---` frontmatter delimiter');
  }
  const afterOpen = openMatch[0].length;
  // Find the closing `---` on its own line.
  const rest = raw.slice(afterOpen);
  const closeMatch = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (closeMatch === null) {
    throw new Error('memory file is missing closing `---` frontmatter delimiter');
  }
  const closeStart = closeMatch.index + (closeMatch[1] ?? '').length;
  const closeEnd = closeMatch.index + closeMatch[0].length;
  const yaml = rest.slice(0, closeStart);
  const body = rest.slice(closeEnd);
  return { yaml, body };
};

/**
 * Read a memory file and return its parsed canonical fields plus the raw
 * source. Throws when the file lacks frontmatter delimiters, when the
 * frontmatter YAML is malformed, when a required field (`name`,
 * `description`, `type`) is missing, or when `type` is not one of the four
 * allowed values.
 *
 * Unknown / extra frontmatter fields are tolerated for forward compatibility
 * (DAR-925's `relations` / `supersedes` and any later additions). They are
 * intentionally ignored here and do not appear on the returned object.
 */
export const readMemory = (path: string): ReadMemory => {
  const raw = readFileSync(path, 'utf8');
  const { yaml, body } = splitFrontmatter(raw);

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`memory file frontmatter is not valid YAML: ${cause}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error('memory file frontmatter must be a YAML mapping');
  }

  const { name, description, type } = parsed;

  if (typeof name !== 'string') {
    throw new Error('memory frontmatter is missing required field `name` (string)');
  }
  if (typeof description !== 'string') {
    throw new Error('memory frontmatter is missing required field `description` (string)');
  }
  if (!isMemoryType(type)) {
    throw new Error(
      `memory frontmatter \`type\` must be one of ${MEMORY_TYPES.join(', ')}; got ${JSON.stringify(type)}`,
    );
  }

  return { name, description, type, body, raw };
};

/**
 * Serialise a memory back to canonical markdown form and write it to disk.
 *
 * The canonical form is exactly:
 *
 * ```
 * ---
 * name: <name>
 * description: <description>
 * type: <type>
 * ---
 * <body>
 * ```
 *
 * Two guarantees:
 *
 * 1. **Round-trip** -- `readMemory(p)` after `writeMemory(p, m)` returns the
 *    same `{ name, description, type, body }` as `m`.
 * 2. **Byte-idempotent on canonical files** -- calling
 *    `writeMemory(p, readMemory(p))` on a file already in canonical form
 *    leaves the file bytes unchanged.
 *
 * Throws when `memory.type` is not one of the four allowed values.
 *
 * Note: this issue intentionally uses a plain `fs.writeFileSync`. Atomic
 * write-temp+rename and advisory locking are owned by DAR-923. The caller is
 * responsible for ensuring the parent directory exists; `writeMemory` does
 * not `mkdir -p`.
 */
export const writeMemory = (path: string, memory: Memory): void => {
  if (!isMemoryType(memory.type)) {
    throw new Error(
      `memory.type must be one of ${MEMORY_TYPES.join(', ')}; got ${JSON.stringify(memory.type)}`,
    );
  }
  const fmObject: Record<string, string> = {
    name: memory.name,
    description: memory.description,
    type: memory.type,
  };
  // `yaml.stringify` emits a trailing newline by default; the resulting YAML
  // ends with `\n`, so the framing reads:
  //   ---\n<yaml>\n---\n<body>
  const fmYaml = stringifyYaml(fmObject);
  const out = `---\n${fmYaml}---\n${memory.body}`;
  writeFileSync(path, out, 'utf8');
};

/**
 * Compute the sha256 hex digest of a memory's canonical content:
 * `${type}\n${name}\n${description}\n${body}`.
 *
 * The sha is deliberately scoped to the v0.1 baseline frontmatter plus the
 * body. Forward-compat frontmatter fields (`relations`, `supersedes`, future
 * unknown keys) DO NOT participate in the sha -- adding or removing graph
 * edges must not invalidate the corresponding embedding sidecar.
 *
 * Returns a 64-character lowercase hex string.
 */
export const contentSha = (memory: Memory): string =>
  createHash('sha256')
    .update(`${memory.type}\n${memory.name}\n${memory.description}\n${memory.body}`, 'utf8')
    .digest('hex');
