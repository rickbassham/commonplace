/**
 * Memory `.md` file I/O with typed YAML frontmatter.
 *
 * A "memory" is a single markdown file whose YAML frontmatter carries a
 * baseline shape plus optional typed graph fields:
 *
 * ```yaml
 * ---
 * name: feedback_scope
 * description: Don't shrink scope unilaterally
 * type: feedback   # one of: user | feedback | project | reference
 * relations:       # optional, defaults to []
 *   - to: other_name
 *     type: builds-on
 * supersedes:      # optional, defaults to []
 *   - old_name
 * ---
 * <body>
 * ```
 *
 * The markdown file is the source of truth -- any sidecar (e.g. the binary
 * `.embedding`) is derived from this content and the `contentSha` exported
 * here. Critically, `contentSha` is canonicalised over the baseline
 * frontmatter only (`type`, `name`, `description`) plus the body. The graph
 * fields (`relations`, `supersedes`) MUST NOT change the sha; adding or
 * removing graph edges does not invalidate the embedding.
 *
 * Out of scope for this module:
 *   - verifying that referenced memory names exist on disk
 *   - building the in-memory adjacency list / graph
 *   - `[[name]]` body mention extraction
 *   - `memory_link` / `memory_unlink` MCP edit tools
 *   - atomic writes / advisory locks
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** The four allowed memory `type` values. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

/** Union type of the four allowed memory `type` values. */
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * The four allowed `relations[].type` values.
 *
 * `mentions` is intentionally absent: implicit `[[name]]` mentions in body
 * content are extracted by the mention tokenizer, not authored as typed
 * edges.
 */
export const RELATION_TYPES = ['related-to', 'builds-on', 'contradicts', 'child-of'] as const;

/** Union type of the four allowed relation types. */
export type RelationType = (typeof RELATION_TYPES)[number];

/** A single typed outgoing edge from a memory to another memory by name. */
export interface Relation {
  to: string;
  type: RelationType;
}

/**
 * A memory's canonical data: the four fields that participate in
 * `contentSha` plus the two graph-metadata arrays which do NOT participate in
 * the sha. The graph fields are optional on input -- absent / empty values
 * round-trip identically -- but always present on {@link ReadMemory} as
 * arrays (possibly empty).
 */
export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** Outgoing typed edges. Excluded from `contentSha`. Defaults to `[]`. */
  relations?: Relation[];
  /** Names of memories this one replaces. Excluded from `contentSha`. Defaults to `[]`. */
  supersedes?: string[];
  /**
   * Whether this memory should be surfaced in the MCP server's startup
   * `instructions` recall pack. Optional on input; defaults to `false`.
   * Excluded from `contentSha` -- toggling does not invalidate sidecars.
   */
  pinned?: boolean;
}

/**
 * Result of {@link readMemory}: the canonical fields plus the raw bytes read
 * from disk. The graph fields are always populated as arrays here (empty when
 * absent on disk), unlike on the input-side {@link Memory}.
 */
export interface ReadMemory extends Memory {
  /** Exact file contents as read from disk; no normalisation. */
  raw: string;
  relations: Relation[];
  supersedes: string[];
  /** Always populated as a boolean -- defaults to `false` when absent on disk. */
  pinned: boolean;
}

const isMemoryType = (v: unknown): v is MemoryType =>
  typeof v === 'string' && (MEMORY_TYPES as readonly string[]).includes(v);

const isRelationType = (v: unknown): v is RelationType =>
  typeof v === 'string' && (RELATION_TYPES as readonly string[]).includes(v);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `^[a-z0-9_]+$` -- lowercase letters, digits, underscore. No path separators.
 *
 * Exported so the `[[name]]` body-tokenizer can share the exact same
 * acceptance pattern as memory filenames; the tokenizer and the filename
 * validator must accept the same strings.
 */
export const NAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * Throw if `name` is not a well-formed memory reference: must be a non-empty
 * string matching `^[a-z0-9_]+$`. The character class excludes path
 * separators and uppercase letters by construction, but we mention path
 * separators explicitly in the error so the failure mode is easy to
 * recognise.
 *
 * Exported so the mention-tokenizer parity tests can assert that the same
 * strings accepted as memory names are also accepted as mention targets,
 * and vice versa.
 */
export const validateName = (name: unknown, ctx: string): string => {
  if (typeof name !== 'string') {
    throw new Error(`${ctx} must be a string; got ${JSON.stringify(name)}`);
  }
  if (name === '') {
    throw new Error(`${ctx} must be a non-empty string; got an empty string`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(
      `${ctx} must not contain a path separator ('/' or '\\\\'); got ${JSON.stringify(name)}`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `${ctx} must match ^[a-z0-9_]+$ (lowercase letters, digits, underscore); got ${JSON.stringify(name)}`,
    );
  }
  return name;
};

/**
 * Parse + validate a single relations entry. Throws when the entry is not a
 * mapping, when `to` or `type` is missing or has the wrong primitive type,
 * when `type` is not one of the four allowed {@link RELATION_TYPES}, or when
 * `to` is not a well-formed memory name.
 */
const parseRelation = (entry: unknown, ctx: string): Relation => {
  if (!isPlainObject(entry)) {
    throw new Error(
      `${ctx} must be a mapping with \`to\` and \`type\`; got ${JSON.stringify(entry)}`,
    );
  }
  if (!('to' in entry)) {
    throw new Error(`${ctx} is missing required key \`to\``);
  }
  if (!('type' in entry)) {
    throw new Error(`${ctx} is missing required key \`type\``);
  }
  const to = validateName(entry.to, `${ctx}.to`);
  const type = entry.type;
  if (!isRelationType(type)) {
    throw new Error(
      `${ctx}.type must be one of ${RELATION_TYPES.join(', ')}; got ${JSON.stringify(type)}`,
    );
  }
  return { to, type };
};

/**
 * Parse + validate the optional `relations` frontmatter field. Returns `[]`
 * when the field is absent. Throws when present but not a YAML sequence (the
 * `null` form `relations: null` is rejected as not-a-sequence). Validates
 * each entry, then deduplicates entries with identical `(to, type)` pairs
 * preserving first-occurrence order.
 */
const parseRelations = (raw: unknown): Relation[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `relations must be a YAML sequence of {to, type} entries; got ${JSON.stringify(raw)}`,
    );
  }
  const seen = new Set<string>();
  const out: Relation[] = [];
  for (let i = 0; i < raw.length; i++) {
    const rel = parseRelation(raw[i], `relations[${i}]`);
    const key = `${rel.to}\u0000${rel.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rel);
  }
  return out;
};

/**
 * Parse + validate the optional `supersedes` frontmatter field. Returns `[]`
 * when the field is absent. Throws when present but not a YAML sequence of
 * strings (entries that are not strings are rejected). Validates each entry
 * against the name rules, then deduplicates preserving first-occurrence
 * order.
 */
const parseSupersedes = (raw: unknown): string[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`supersedes must be a YAML sequence of names; got ${JSON.stringify(raw)}`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const name = validateName(raw[i], `supersedes[${i}]`);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
};

/**
 * Parse + validate the optional `pinned` frontmatter field. Returns `false`
 * when the field is absent. Throws when present but not a literal boolean
 * (a YAML string `"true"`, a number `1`, etc. are all rejected so callers
 * learn the type contract early).
 */
const parsePinned = (raw: unknown): boolean => {
  if (raw === undefined) return false;
  if (typeof raw !== 'boolean') {
    throw new Error(
      `memory frontmatter \`pinned\` must be a boolean (true or false); got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

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
 * `description`, `type`) is missing, when `type` is not one of the four
 * allowed values, or when the optional graph fields (`relations`,
 * `supersedes`) are present but malformed (see {@link parseRelations} /
 * {@link parseSupersedes} / {@link validateName}).
 *
 * Self-edges are rejected at parse time: if the frontmatter `name` equals
 * any relation's `to` or appears in `supersedes[]`, this throws.
 *
 * Unknown / extra frontmatter fields beyond the documented set are tolerated
 * for forward compatibility.
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

  const relations = parseRelations(parsed.relations);
  const supersedes = parseSupersedes(parsed.supersedes);
  const pinned = parsePinned(parsed.pinned);

  for (const rel of relations) {
    if (rel.to === name) {
      throw new Error(
        `memory \`${name}\` has a self-edge in relations (\`to\` equals frontmatter \`name\`)`,
      );
    }
  }
  for (const sup of supersedes) {
    if (sup === name) {
      throw new Error(
        `memory \`${name}\` has a self-edge in supersedes (entry equals frontmatter \`name\`)`,
      );
    }
  }

  return { name, description, type, body, raw, relations, supersedes, pinned };
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
 * relations:           # only when relations[] is non-empty (post-dedupe)
 *   - to: <name>
 *     type: <type>
 * supersedes:          # only when supersedes[] is non-empty (post-dedupe)
 *   - <name>
 * ---
 * <body>
 * ```
 *
 * Empty `relations[]` or `supersedes[]` are omitted entirely so files that
 * carry no graph metadata stay byte-identical to the pre-graph baseline
 * form.
 *
 * Two guarantees:
 *
 * 1. **Round-trip** -- `readMemory(p)` after `writeMemory(p, m)` returns the
 *    same `{ name, description, type, body, relations, supersedes }` as `m`,
 *    modulo dedupe of duplicate `(to, type)` relations entries and duplicate
 *    `supersedes` names.
 * 2. **Byte-idempotent on canonical files** -- calling
 *    `writeMemory(p, readMemory(p))` on a file already in canonical form
 *    leaves the file bytes unchanged.
 *
 * Throws when `memory.type` is not one of the four allowed values, when any
 * `memory.relations[].type` is not one of the four allowed values, when any
 * relation `to` or supersedes entry is not a well-formed name, or when
 * `memory.name` appears in its own `relations[].to` or `supersedes[]`.
 *
 * Note: this issue intentionally uses a plain `fs.writeFileSync`. Atomic
 * write-temp+rename and advisory locking are owned by the atomic-write
 * helper. The caller is
 * responsible for ensuring the parent directory exists; `writeMemory` does
 * not `mkdir -p`.
 */
export const writeMemory = (path: string, memory: Memory): void => {
  writeFileSync(path, serializeMemory(memory), 'utf8');
};

/**
 * Serialise a memory to its canonical UTF-8 markdown text WITHOUT touching
 * the filesystem. Validates and dedupes the same way {@link writeMemory}
 * does; the round-trip and byte-idempotence guarantees on writeMemory hold
 * for the bytes returned here.
 *
 * Exposed so callers can route the `.md` write through the atomic helper
 * (which takes raw bytes) without duplicating the canonical-form logic.
 */
export const serializeMemory = (memory: Memory): string => {
  if (!isMemoryType(memory.type)) {
    throw new Error(
      `memory.type must be one of ${MEMORY_TYPES.join(', ')}; got ${JSON.stringify(memory.type)}`,
    );
  }

  // Validate + dedupe relations and supersedes so writeMemory enforces the
  // same invariants readMemory does. This means writeMemory(p, readMemory(p))
  // is a no-op on canonical files even when the input contained duplicates.
  const relations = parseRelations(memory.relations);
  const supersedes = parseSupersedes(memory.supersedes);
  for (const rel of relations) {
    if (rel.to === memory.name) {
      throw new Error(
        `memory \`${memory.name}\` has a self-edge in relations (\`to\` equals \`name\`)`,
      );
    }
  }
  for (const sup of supersedes) {
    if (sup === memory.name) {
      throw new Error(
        `memory \`${memory.name}\` has a self-edge in supersedes (entry equals \`name\`)`,
      );
    }
  }

  const fmObject: Record<string, unknown> = {
    name: memory.name,
    description: memory.description,
    type: memory.type,
  };
  if (relations.length > 0) {
    fmObject.relations = relations.map((r) => ({ to: r.to, type: r.type }));
  }
  if (supersedes.length > 0) {
    fmObject.supersedes = supersedes;
  }
  // `pinned: true` is emitted; `pinned: false` (the default) is omitted so
  // files that never opt in stay byte-identical to the legacy form.
  if (memory.pinned === true) {
    fmObject.pinned = true;
  }

  // `yaml.stringify` emits a trailing newline by default; the resulting YAML
  // ends with `\n`, so the framing reads:
  //   ---\n<yaml>\n---\n<body>
  const fmYaml = stringifyYaml(fmObject);
  return `---\n${fmYaml}---\n${memory.body}`;
};

/**
 * Compute the sha256 hex digest of a memory's canonical content:
 * `${type}\n${name}\n${description}\n${body}`.
 *
 * The sha is deliberately scoped to the v0.1 baseline frontmatter plus the
 * body. The graph fields `relations` and `supersedes` DO NOT participate
 * in the sha -- adding or removing graph edges must not invalidate the
 * corresponding embedding sidecar.
 *
 * Returns a 64-character lowercase hex string.
 */
export const contentSha = (memory: Memory): string =>
  createHash('sha256')
    .update(`${memory.type}\n${memory.name}\n${memory.description}\n${memory.body}`, 'utf8')
    .digest('hex');
