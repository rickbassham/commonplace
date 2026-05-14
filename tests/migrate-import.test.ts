/**
 * Contract tests for the auto-migration importer:
 *
 *   - `commonplace migrate` (no args) detects Claude Code project-memory
 *     directories at `~/.claude/projects/*\/memory/` and reports counts
 *     without writing anything.
 *   - `commonplace migrate --from claude-code` copies each compatible
 *     `.md` to `<user-dir>/<name>.md`, then runs the existing scan/embed
 *     pass so each imported file gets its `.embedding` sidecar.
 *   - Conflict policy is skip-and-report (default), preserving existing
 *     target files byte-identical.
 *   - `--dry-run` reports what would be imported without writing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectImportSources,
  detectImportSourcesDetailed,
  parseMigrateArgs,
  runImportFromClaudeCode,
} from '../src/cli/migrate.js';
import { writeMemory, type Memory } from '../src/store/memory.js';
import type { Embedder } from '../src/store/memory-store.js';

let home: string;
let userDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dar961-home-'));
  userDir = mkdtempSync(join(tmpdir(), 'dar961-user-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

const makeStubEmbedder = (modelId = 'Xenova/bge-base-en-v1.5', dim = 4): Embedder => {
  let callCount = 0;
  return {
    modelId,
    dim,
    embed: vi.fn(async (): Promise<Float32Array> => {
      callCount += 1;
      const out = new Float32Array(dim);
      out[0] = callCount;
      return out;
    }),
  };
};

const makeMemory = (name: string, body = `body of ${name}`): Memory => ({
  name,
  description: `description for ${name}`,
  type: 'reference',
  body,
});

/**
 * Lay down a Claude Code-style project memory dir at
 * `<home>/.claude/projects/<slug>/memory/` with the given memories.
 * Returns the absolute path to the created memory dir.
 */
const writeClaudeCodeProject = (slug: string, memories: Memory[]): string => {
  const memDir = join(home, '.claude', 'projects', slug, 'memory');
  mkdirSync(memDir, { recursive: true });
  for (const m of memories) {
    writeMemory(join(memDir, `${m.name}.md`), m);
  }
  return memDir;
};

// -------------------------------------------------------------------------
// ac-1: detection (no flags)
// -------------------------------------------------------------------------

describe('ac-1: detection (`commonplace migrate` with no args)', () => {
  it('reports detected Claude Code project-memory dirs and per-dir candidate file counts on stdout', () => {
    writeClaudeCodeProject('-Users-rick-Projects-foo', [makeMemory('alpha'), makeMemory('bravo')]);
    writeClaudeCodeProject('-Users-rick-Projects-bar', [makeMemory('charlie')]);

    const sources = detectImportSources({ home });

    expect(sources.length).toBe(2);
    const total = sources.reduce((acc, s) => acc + s.fileCount, 0);
    expect(total).toBe(3);
    // Each source carries the source name so the CLI can render
    // "claude-code" rather than the raw path.
    for (const src of sources) {
      expect(src.source).toBe('claude-code');
      expect(src.fileCount).toBeGreaterThan(0);
    }
  });

  it('reports zero detected sources when no `~/.claude/projects/*/memory/` directories exist', () => {
    const sources = detectImportSources({ home });
    expect(sources).toEqual([]);
  });

  it('writes nothing to the user store and creates no sidecars (detection-only)', () => {
    writeClaudeCodeProject('-Users-rick-Projects-foo', [makeMemory('alpha')]);

    detectImportSources({ home });

    // user dir is untouched
    expect(existsSync(join(userDir, 'alpha.md'))).toBe(false);
    expect(existsSync(join(userDir, 'alpha.embedding'))).toBe(false);
  });

  it('detectImportSourcesDetailed returns an empty warnings list on the happy path', () => {
    writeClaudeCodeProject('-Users-rick-Projects-foo', [makeMemory('alpha')]);
    const detail = detectImportSourcesDetailed({ home });
    expect(detail.sources.length).toBe(1);
    expect(detail.warnings).toEqual([]);
  });

  it('detectImportSourcesDetailed surfaces a warning when a project-memory dir cannot be enumerated, and detection still returns the readable sources', () => {
    if (process.platform === 'win32') return; // POSIX-mode test
    if (process.getuid?.() === 0) return; // root bypasses chmod

    // Two project dirs; one has its memory dir made unreadable, the
    // other is a normal happy-path source.
    const readableDir = writeClaudeCodeProject('-readable', [makeMemory('alpha')]);
    const blockedDir = writeClaudeCodeProject('-blocked', [makeMemory('bravo')]);
    // Strip read perms on the blocked memory dir so readdirSync throws.
    chmodSync(blockedDir, 0o000);

    try {
      const detail = detectImportSourcesDetailed({ home });

      // The readable source still shows up.
      const readableHit = detail.sources.find((s) => s.dir === readableDir);
      expect(readableHit).toBeDefined();

      // The blocked source produced a warning, not a throw, and is
      // absent from sources.
      const blockedHit = detail.sources.find((s) => s.dir === blockedDir);
      expect(blockedHit).toBeUndefined();
      expect(detail.warnings.length).toBeGreaterThanOrEqual(1);
      expect(detail.warnings.some((w) => w.path === blockedDir)).toBe(true);
      // Warning message is non-empty -- carries the OS error so the
      // user can debug the failure.
      for (const w of detail.warnings) {
        expect(w.message.length).toBeGreaterThan(0);
      }
    } finally {
      // Restore perms so afterEach can rmSync without EACCES.
      chmodSync(blockedDir, 0o755);
    }
  });

  it('globs `~/.claude/projects/*/memory/*.md` rather than parsing the project slug, so an arbitrary slug shape still resolves', () => {
    // Slugs unlike Claude Code's typical `-Users-...` shape; the importer
    // must not parse them and must still find the files.
    writeClaudeCodeProject('weirdSlug-with-mixed-case', [makeMemory('alpha')]);
    writeClaudeCodeProject('123-numeric', [makeMemory('bravo')]);

    const sources = detectImportSources({ home });

    expect(sources.length).toBe(2);
    const names = sources.flatMap((s) => s.files.map((f) => f.name)).sort();
    expect(names).toEqual(['alpha', 'bravo']);
  });
});

// -------------------------------------------------------------------------
// ac-2: --from claude-code: import + scan/embed
// -------------------------------------------------------------------------

describe('ac-2: `--from claude-code` import path', () => {
  it('copies each source `.md` to `<user-dir>/<name>.md` preserving body and frontmatter (name, description, type)', async () => {
    writeClaudeCodeProject('-slug-1', [
      { name: 'alpha', description: 'desc-alpha', type: 'reference', body: 'body alpha' },
      { name: 'bravo', description: 'desc-bravo', type: 'feedback', body: 'body bravo' },
    ]);

    await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    // Both files exist in the user dir.
    expect(existsSync(join(userDir, 'alpha.md'))).toBe(true);
    expect(existsSync(join(userDir, 'bravo.md'))).toBe(true);

    const alphaMd = readFileSync(join(userDir, 'alpha.md'), 'utf8');
    expect(alphaMd).toContain('name: alpha');
    expect(alphaMd).toContain('description: desc-alpha');
    expect(alphaMd).toContain('type: reference');
    expect(alphaMd).toContain('body alpha');

    const bravoMd = readFileSync(join(userDir, 'bravo.md'), 'utf8');
    expect(bravoMd).toContain('name: bravo');
    expect(bravoMd).toContain('description: desc-bravo');
    expect(bravoMd).toContain('type: feedback');
    expect(bravoMd).toContain('body bravo');
  });

  it('runs the existing scan/embed pass after copy so each imported `<name>.md` has a matching `<name>.embedding` sidecar on disk', async () => {
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha'), makeMemory('bravo')]);

    await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(existsSync(join(userDir, 'alpha.embedding'))).toBe(true);
    expect(existsSync(join(userDir, 'bravo.embedding'))).toBe(true);
  });

  it('aggregates files across multiple `~/.claude/projects/<slug>/memory/` directories into the single user-dir target', async () => {
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha')]);
    writeClaudeCodeProject('-slug-2', [makeMemory('bravo')]);
    writeClaudeCodeProject('-slug-3', [makeMemory('charlie')]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(existsSync(join(userDir, 'alpha.md'))).toBe(true);
    expect(existsSync(join(userDir, 'bravo.md'))).toBe(true);
    expect(existsSync(join(userDir, 'charlie.md'))).toBe(true);
    expect(result.imported.length).toBe(3);
  });

  it('reports per-source counts (imported / skipped) on stdout and exits 0 on success', async () => {
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha'), makeMemory('bravo')]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.imported.length).toBe(2);
    expect(result.skipped.length).toBe(0);
    // Per-source aggregation: at least one entry, total imported count
    // matches.
    const sourceTotal = result.bySource.reduce((acc, s) => acc + s.imported, 0);
    expect(sourceTotal).toBe(2);
  });
});

// -------------------------------------------------------------------------
// ac-3: conflict policy
// -------------------------------------------------------------------------

describe('ac-3: conflict policy (skip + report)', () => {
  it('skips a source file whose `<name>.md` already exists in `COMMONPLACE_USER_DIR` and leaves the existing file byte-identical', async () => {
    // Existing entry in user dir.
    writeMemory(
      join(userDir, 'alpha.md'),
      makeMemory('alpha', 'EXISTING USER BODY -- DO NOT OVERWRITE'),
    );
    const existingBytes = readFileSync(join(userDir, 'alpha.md'));

    // Conflicting source from Claude Code.
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha', 'incoming body that would clobber')]);

    await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    // Existing user file is byte-identical.
    expect(readFileSync(join(userDir, 'alpha.md')).equals(existingBytes)).toBe(true);
  });

  it('reports each skipped collision by name in the result with a clear `already exists`-style reason', async () => {
    writeMemory(join(userDir, 'alpha.md'), makeMemory('alpha'));
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha'), makeMemory('bravo')]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.imported.map((e) => e.name)).toEqual(['bravo']);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.name).toBe('alpha');
    expect(result.skipped[0]?.reason).toMatch(/already exists/i);
  });

  it('cross-project same-name collision: imports from the first project dir, skips the second with a reason that explicitly identifies the prior source dir', async () => {
    // Two sibling Claude Code project-memory dirs each ship an
    // `architecture.md`. The first is imported; the second must be
    // reported as a within-run cross-project collision -- NOT as an
    // "already exists in <userDir>" entry, because the user dir was
    // empty before this run.
    const firstDir = writeClaudeCodeProject('-Users-rick-Projects-A', [
      makeMemory('architecture', 'project A architecture'),
    ]);
    const secondDir = writeClaudeCodeProject('-Users-rick-Projects-B', [
      makeMemory('architecture', 'project B architecture'),
    ]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    // First wins: the user dir gets project A's bytes.
    expect(result.imported.length).toBe(1);
    expect(result.imported[0]?.name).toBe('architecture');
    const importedFromDir = result.imported[0]?.source ?? '';
    expect([firstDir, secondDir]).toContain(
      importedFromDir.slice(0, importedFromDir.lastIndexOf('/')),
    );

    // Second is skipped with a distinct reason -- not the
    // already-exists-in-userDir wording.
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.name).toBe('architecture');
    expect(result.skipped[0]?.reason).toMatch(/same[-\s]name source already imported/i);
    expect(result.skipped[0]?.reason).not.toMatch(/already exists in/i);
    // The reason must point at the OTHER project's source dir so the
    // user can debug the collision.
    const reason = result.skipped[0]?.reason ?? '';
    const importedSourceDir = importedFromDir.slice(0, importedFromDir.lastIndexOf('/'));
    expect(reason).toContain(importedSourceDir);
  });

  it('produces an exit-code-zero result when every source file collides (skips are not failures)', async () => {
    writeMemory(join(userDir, 'alpha.md'), makeMemory('alpha'));
    writeMemory(join(userDir, 'bravo.md'), makeMemory('bravo'));
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha'), makeMemory('bravo')]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    // Every source skipped -- still success.
    expect(result.imported).toEqual([]);
    expect(result.skipped.length).toBe(2);
  });
});

// -------------------------------------------------------------------------
// ac-4: --dry-run
// -------------------------------------------------------------------------

describe('ac-4: `--dry-run` writes nothing', () => {
  it('reports the would-import file list and counts on stdout but writes no `.md` and no `.embedding` files to `COMMONPLACE_USER_DIR`', async () => {
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha'), makeMemory('bravo')]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
      dryRun: true,
    });

    expect(result.imported.map((e) => e.name).sort()).toEqual(['alpha', 'bravo']);
    expect(existsSync(join(userDir, 'alpha.md'))).toBe(false);
    expect(existsSync(join(userDir, 'bravo.md'))).toBe(false);
    expect(existsSync(join(userDir, 'alpha.embedding'))).toBe(false);
    expect(existsSync(join(userDir, 'bravo.embedding'))).toBe(false);
  });

  it('preserves an existing colliding target file byte-for-byte (no overwrite even in dry-run)', async () => {
    writeMemory(
      join(userDir, 'alpha.md'),
      makeMemory('alpha', 'EXISTING USER BODY -- DO NOT OVERWRITE'),
    );
    const existingBytes = readFileSync(join(userDir, 'alpha.md'));
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha', 'incoming')]);

    await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
      dryRun: true,
    });

    expect(readFileSync(join(userDir, 'alpha.md')).equals(existingBytes)).toBe(true);
  });

  it('reports dryRun=true on the result so the CLI can render a clear banner / suffix distinguishing it from a live run', async () => {
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha')]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
  });
});

// -------------------------------------------------------------------------
// ac-5: fixture: two compatible files imported, sidecars regenerated
// -------------------------------------------------------------------------

describe('ac-5: fixture with two compatible files yields both imported with sidecars', () => {
  it('two-compatible-files fixture results in both files imported under `COMMONPLACE_USER_DIR/<name>.md` with valid `<name>.embedding` sidecars', async () => {
    writeClaudeCodeProject('-Users-rick-fixture', [makeMemory('note_one'), makeMemory('note_two')]);

    await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    for (const name of ['note_one', 'note_two']) {
      expect(existsSync(join(userDir, `${name}.md`))).toBe(true);
      expect(existsSync(join(userDir, `${name}.embedding`))).toBe(true);
      // Sidecar bytes have the CMEM magic.
      const buf = readFileSync(join(userDir, `${name}.embedding`));
      expect(buf.subarray(0, 4).toString('ascii')).toBe('CMEM');
    }
  });
});

// -------------------------------------------------------------------------
// ac-6: collision fixture + dry-run on each fixture
// -------------------------------------------------------------------------

describe('ac-6: collision fixture and dry-run fixtures', () => {
  it('one-source-collides fixture yields the source skipped with a clear collision message and the existing `<user-dir>/<name>.md` byte-identical', async () => {
    writeMemory(join(userDir, 'alpha.md'), makeMemory('alpha', 'pre-existing user content'));
    const beforeBytes = readFileSync(join(userDir, 'alpha.md'));
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha', 'incoming source')]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.imported).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.name).toBe('alpha');
    expect(result.skipped[0]?.reason).toMatch(/already exists/i);
    expect(readFileSync(join(userDir, 'alpha.md')).equals(beforeBytes)).toBe(true);
  });

  it('applying `--dry-run` to the two-compatible-files fixture writes no `.md` or `.embedding` to `COMMONPLACE_USER_DIR`', async () => {
    writeClaudeCodeProject('-Users-rick-fixture', [makeMemory('note_one'), makeMemory('note_two')]);

    await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
      dryRun: true,
    });

    expect(existsSync(join(userDir, 'note_one.md'))).toBe(false);
    expect(existsSync(join(userDir, 'note_two.md'))).toBe(false);
    expect(existsSync(join(userDir, 'note_one.embedding'))).toBe(false);
    expect(existsSync(join(userDir, 'note_two.embedding'))).toBe(false);
  });

  it('applying `--dry-run` to the collision fixture writes nothing and leaves the existing `<user-dir>/<name>.md` byte-identical', async () => {
    writeMemory(join(userDir, 'alpha.md'), makeMemory('alpha', 'pre-existing'));
    const beforeBytes = readFileSync(join(userDir, 'alpha.md'));
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha', 'incoming')]);

    await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
      dryRun: true,
    });

    expect(readFileSync(join(userDir, 'alpha.md')).equals(beforeBytes)).toBe(true);
    // No sidecar written either.
    expect(existsSync(join(userDir, 'alpha.embedding'))).toBe(false);
  });
});

// -------------------------------------------------------------------------
// argv parsing for the new modes
// -------------------------------------------------------------------------

describe('argv parsing for the new migrate modes', () => {
  it('parseMigrateArgs accepts `migrate` (no positional, no flags) as a detection-only invocation', () => {
    const parsed = parseMigrateArgs(['migrate']);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok') {
      expect(parsed.mode).toBe('detect');
    }
  });

  it('parseMigrateArgs accepts `migrate --from claude-code` and reports import mode with source `claude-code`', () => {
    const parsed = parseMigrateArgs(['migrate', '--from', 'claude-code']);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok' && parsed.mode === 'import') {
      expect(parsed.from).toBe('claude-code');
      expect(parsed.dryRun).toBe(false);
    }
  });

  it('parseMigrateArgs accepts `--from claude-code --dry-run`', () => {
    const parsed = parseMigrateArgs(['migrate', '--from', 'claude-code', '--dry-run']);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok' && parsed.mode === 'import') {
      expect(parsed.from).toBe('claude-code');
      expect(parsed.dryRun).toBe(true);
    }
  });

  it('parseMigrateArgs accepts `--auto` alongside `--from claude-code`', () => {
    const parsed = parseMigrateArgs(['migrate', '--from', 'claude-code', '--auto']);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok' && parsed.mode === 'import') {
      expect(parsed.auto).toBe(true);
    }
  });

  it('parseMigrateArgs rejects an unknown source for `--from`', () => {
    const parsed = parseMigrateArgs(['migrate', '--from', 'mem0']);
    expect(parsed.kind).toBe('usage_error');
  });

  it('parseMigrateArgs preserves the legacy `migrate <dir>` path unchanged', () => {
    const parsed = parseMigrateArgs(['migrate', '/tmp/foo']);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok' && parsed.mode === 'scan') {
      expect(parsed.dir).toBe('/tmp/foo');
    }
  });
});
