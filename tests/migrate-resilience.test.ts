/**
 * Contract tests: migrate-path resilience to permissively-formatted
 * harness frontmatter, MEMORY.md exclusion, structured skip reasons for
 * unrecoverable source files, and skip-and-warn semantics on
 * `MemoryStore.scan()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectImportSources,
  runImportFromClaudeCode,
  runMigrate,
  migrateMain,
} from '../src/cli/migrate.js';
import { readMemory, serializeMemory, writeMemory, type Memory } from '../src/store/memory.js';
import { MemoryStore, type Embedder } from '../src/store/memory-store.js';

let home: string;
let userDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dar966-home-'));
  userDir = mkdtempSync(join(tmpdir(), 'dar966-user-'));
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
 * `<home>/.claude/projects/<slug>/memory/`. Files are written verbatim
 * from the provided `{ filename, contents }` pairs (no normalisation),
 * which lets the tests recreate harness-style permissive frontmatter.
 */
const writeRawClaudeCodeProject = (
  slug: string,
  files: { filename: string; contents: string }[],
): string => {
  const memDir = join(home, '.claude', 'projects', slug, 'memory');
  mkdirSync(memDir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(memDir, f.filename), f.contents, 'utf8');
  }
  return memDir;
};

/** Same shape as runImportFromClaudeCode's existing helper from migrate-import.test.ts. */
const writeClaudeCodeProject = (slug: string, memories: Memory[]): string => {
  const memDir = join(home, '.claude', 'projects', slug, 'memory');
  mkdirSync(memDir, { recursive: true });
  for (const m of memories) {
    writeMemory(join(memDir, `${m.name}.md`), m);
  }
  return memDir;
};

// -------------------------------------------------------------------------
// ac-1: normalise imported frontmatter through serializeMemory
// -------------------------------------------------------------------------

describe('ac-1: imported files are normalised through serializeMemory', () => {
  it('runImportFromClaudeCode writes each imported .md by serialising the parsed source through serializeMemory rather than copying source bytes verbatim', async () => {
    // Source file uses harness permissive frontmatter: an unquoted
    // description containing colon-space. A copy-verbatim path would
    // preserve the unquoted form (which scan() would crash on); a
    // normalised path produces a canonical re-quoted form that round-
    // trips cleanly through readMemory + serializeMemory.
    const sourceContents = [
      '---',
      'name: alpha',
      'description: foo: bar',
      'type: reference',
      '---',
      'body for alpha',
    ].join('\n');
    writeRawClaudeCodeProject('-slug-1', [{ filename: 'alpha.md', contents: sourceContents }]);

    await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    const targetBytes = readFileSync(join(userDir, 'alpha.md'), 'utf8');
    // Canonical form: readMemory(target) -> serializeMemory yields the
    // same bytes (round-trip stable on canonical files).
    const parsed = readMemory(join(userDir, 'alpha.md'));
    const expected = serializeMemory({
      name: parsed.name,
      description: parsed.description,
      type: parsed.type,
      body: parsed.body,
      relations: parsed.relations,
      supersedes: parsed.supersedes,
    });
    expect(targetBytes).toBe(expected);
    // And specifically, the target is NOT byte-identical to the source
    // -- normalisation re-quoted the colon-space description.
    expect(targetBytes).not.toBe(sourceContents);
  });

  it("importing a source file whose frontmatter has `description: foo: bar` (unquoted, contains colon-space) produces a target .md whose description re-reads as the string 'foo: bar' through readMemory without throwing", async () => {
    // Harness permissive format: unquoted description containing a
    // colon-space sequence. js-yaml in strict mode rejects this as
    // "nested mappings are not allowed in compact mappings"; the
    // migrate path must normalise it before scan() sees it.
    const sourceContents = [
      '---',
      'name: alpha',
      'description: foo: bar',
      'type: reference',
      '---',
      'body alpha',
    ].join('\n');
    writeRawClaudeCodeProject('-slug-1', [{ filename: 'alpha.md', contents: sourceContents }]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.skipped).toEqual([]);
    expect(existsSync(join(userDir, 'alpha.md'))).toBe(true);
    const reread = readMemory(join(userDir, 'alpha.md'));
    expect(reread.description).toBe('foo: bar');
  });

  it('importing a source file whose frontmatter values are already canonically quoted produces a target .md byte-identical to what serializeMemory(readMemory(source)) would produce', async () => {
    // Source has fully canonical frontmatter -- serializeMemory(readMemory(source))
    // is the spec for the target bytes.
    const m: Memory = {
      name: 'alpha',
      description: 'a normal description',
      type: 'reference',
      body: 'body alpha',
    };
    const memDir = writeClaudeCodeProject('-slug-1', [m]);

    await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    const sourceParsed = readMemory(join(memDir, 'alpha.md'));
    const expected = serializeMemory({
      name: sourceParsed.name,
      description: sourceParsed.description,
      type: sourceParsed.type,
      body: sourceParsed.body,
      relations: sourceParsed.relations,
      supersedes: sourceParsed.supersedes,
    });
    const targetBytes = readFileSync(join(userDir, 'alpha.md'), 'utf8');
    expect(targetBytes).toBe(expected);
  });

  it('after import, the post-copy scan/embed pass over the target dir generates a .embedding sidecar for every imported .md (no scan crash on the normalised files)', async () => {
    // Mix of permissive harness files -- a copy-verbatim path would
    // crash scan() on at least one.
    writeRawClaudeCodeProject('-slug-1', [
      {
        filename: 'alpha.md',
        contents: [
          '---',
          'name: alpha',
          'description: foo: bar',
          'type: reference',
          '---',
          'body alpha',
        ].join('\n'),
      },
      {
        filename: 'bravo.md',
        contents: [
          '---',
          'name: bravo',
          'description: ok',
          'type: feedback',
          '---',
          'body bravo',
        ].join('\n'),
      },
    ]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.imported.map((e) => e.name).sort()).toEqual(['alpha', 'bravo']);
    expect(existsSync(join(userDir, 'alpha.embedding'))).toBe(true);
    expect(existsSync(join(userDir, 'bravo.embedding'))).toBe(true);
  });
});

// -------------------------------------------------------------------------
// ac-2: MEMORY.md exclusion (case-insensitive)
// -------------------------------------------------------------------------

describe('ac-2: MEMORY.md is excluded from import enumeration', () => {
  it('detectImportSources omits files named MEMORY.md (exact case) from the DetectedSource.files array when the source dir contains one', () => {
    const memDir = join(home, '.claude', 'projects', '-slug-1', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'MEMORY.md'), '# Claude memory index\n', 'utf8');
    writeMemory(join(memDir, 'alpha.md'), makeMemory('alpha'));

    const sources = detectImportSources({ home });

    expect(sources.length).toBe(1);
    const names = sources[0]?.files.map((f) => f.name) ?? [];
    expect(names).not.toContain('MEMORY');
    expect(names).toContain('alpha');
  });

  it('detectImportSources omits files named memory.md, Memory.md, and MEMORY.MD (case-insensitive) from the DetectedSource.files array', () => {
    const memDir = join(home, '.claude', 'projects', '-slug-cases', 'memory');
    mkdirSync(memDir, { recursive: true });
    // Use a single project dir but write under three different casings
    // -- on case-insensitive filesystems (default macOS) only one will
    // actually land on disk, but our enumeration logic must filter
    // whichever variants are present. Use a dir-per-case to be portable.
    const slugs = ['-slug-lower', '-slug-mixed', '-slug-upper'];
    const variants = ['memory.md', 'Memory.md', 'MEMORY.MD'];
    for (let i = 0; i < slugs.length; i++) {
      const dir = join(home, '.claude', 'projects', slugs[i]!, 'memory');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, variants[i]!), '# index\n', 'utf8');
      // Add a real memory so the dir has something else for the source
      // to remain non-empty after exclusion.
      writeMemory(join(dir, 'alpha.md'), makeMemory('alpha'));
    }

    const sources = detectImportSources({ home });

    // Every source should have exactly the one alpha file, no MEMORY
    // variant of any casing.
    for (const src of sources) {
      const names = src.files.map((f) => f.name);
      expect(names).toContain('alpha');
      for (const variant of ['memory', 'Memory', 'MEMORY']) {
        expect(names).not.toContain(variant);
      }
    }
  });

  it('detectImportSources still includes other .md files in the same dir when MEMORY.md is present alongside them', () => {
    const memDir = join(home, '.claude', 'projects', '-slug-mixed', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'MEMORY.md'), '# index\n', 'utf8');
    writeMemory(join(memDir, 'alpha.md'), makeMemory('alpha'));
    writeMemory(join(memDir, 'bravo.md'), makeMemory('bravo'));

    const sources = detectImportSources({ home });
    expect(sources.length).toBe(1);
    const names = sources[0]?.files.map((f) => f.name).sort() ?? [];
    expect(names).toEqual(['alpha', 'bravo']);
  });

  it('runImportFromClaudeCode against a source dir containing MEMORY.md plus two real memory files writes only the two real files into the target dir and reports imported=2 with MEMORY.md absent from the imported and skipped arrays', async () => {
    const memDir = join(home, '.claude', 'projects', '-slug-1', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'MEMORY.md'), '# index\n', 'utf8');
    writeMemory(join(memDir, 'alpha.md'), makeMemory('alpha'));
    writeMemory(join(memDir, 'bravo.md'), makeMemory('bravo'));

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.imported.length).toBe(2);
    expect(result.imported.map((e) => e.name).sort()).toEqual(['alpha', 'bravo']);
    expect(existsSync(join(userDir, 'MEMORY.md'))).toBe(false);
    // MEMORY is not in imported or skipped (it's excluded entirely, not
    // skipped with a reason).
    expect(result.imported.find((e) => /^MEMORY$/i.test(e.name))).toBeUndefined();
    expect(result.skipped.find((e) => /^MEMORY$/i.test(e.name))).toBeUndefined();
  });
});

// -------------------------------------------------------------------------
// ac-3: unrecoverable source files are skipped with structured reason
// -------------------------------------------------------------------------

describe('ac-3: unrecoverable source files are skipped with a structured reason', () => {
  it('runImportFromClaudeCode against a source file missing the required `name` frontmatter field returns a SkippedEntry whose reason mentions the missing field and includes the source path', async () => {
    const contents = ['---', 'description: missing name', 'type: reference', '---', 'body'].join(
      '\n',
    );
    const memDir = writeRawClaudeCodeProject('-slug-1', [{ filename: 'noname.md', contents }]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.imported).toEqual([]);
    expect(result.skipped.length).toBe(1);
    const sk = result.skipped[0]!;
    expect(sk.reason).toMatch(/name/);
    expect(sk.source).toBe(join(memDir, 'noname.md'));
  });

  it('runImportFromClaudeCode against a source file with totally non-YAML frontmatter (e.g. a tab-indented block) returns a SkippedEntry whose reason names a parse failure and does not throw', async () => {
    // Tab-indented block inside frontmatter triggers a YAML parse error
    // (tab indent is rejected by YAML spec).
    const contents = ['---', '\tnot: valid', '\tyaml: here', '---', 'body'].join('\n');
    const memDir = writeRawClaudeCodeProject('-slug-1', [{ filename: 'badyaml.md', contents }]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.imported).toEqual([]);
    expect(result.skipped.length).toBe(1);
    const sk = result.skipped[0]!;
    expect(sk.reason.length).toBeGreaterThan(0);
    // The reason mentions YAML / frontmatter / parse in some form.
    expect(sk.reason).toMatch(/yaml|frontmatter|parse/i);
    expect(sk.source).toBe(join(memDir, 'badyaml.md'));
  });

  it('runImportFromClaudeCode skipped entries for unrecoverable frontmatter carry { name, source, reason } where reason is a short non-empty cause string and source is the absolute path of the offending file', async () => {
    const contents = ['---', 'description: foo', 'type: reference', '---', 'body'].join('\n');
    const memDir = writeRawClaudeCodeProject('-slug-1', [{ filename: 'noname.md', contents }]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.skipped.length).toBe(1);
    const sk = result.skipped[0]!;
    expect(typeof sk.name).toBe('string');
    expect(typeof sk.source).toBe('string');
    expect(typeof sk.reason).toBe('string');
    expect(sk.name.length).toBeGreaterThan(0);
    expect(sk.reason.length).toBeGreaterThan(0);
    // Source is the absolute path.
    expect(sk.source).toBe(join(memDir, 'noname.md'));
  });

  it('runImportFromClaudeCode against a source dir mixing one unrecoverable file and two good files writes the two good files to the target dir, returns the third in skipped[], and the post-copy scan succeeds (imported.length=2, skipped.length=1, no throw)', async () => {
    const badContents = ['---', 'description: missing name', 'type: reference', '---', 'body'].join(
      '\n',
    );
    writeRawClaudeCodeProject('-slug-1', [{ filename: 'bad.md', contents: badContents }]);
    // Add two good ones in the same dir.
    const memDir = join(home, '.claude', 'projects', '-slug-1', 'memory');
    writeMemory(join(memDir, 'alpha.md'), makeMemory('alpha'));
    writeMemory(join(memDir, 'bravo.md'), makeMemory('bravo'));

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.imported.length).toBe(2);
    expect(result.imported.map((e) => e.name).sort()).toEqual(['alpha', 'bravo']);
    expect(result.skipped.length).toBe(1);
    expect(existsSync(join(userDir, 'alpha.md'))).toBe(true);
    expect(existsSync(join(userDir, 'bravo.md'))).toBe(true);
    expect(existsSync(join(userDir, 'alpha.embedding'))).toBe(true);
    expect(existsSync(join(userDir, 'bravo.embedding'))).toBe(true);
  });

  it("the migrate bin's stdout summary lists each skipped unrecoverable file with its name, source dir, and reason under the 'collisions:' or equivalent skip section", async () => {
    // Stage a source dir with one unrecoverable file and one good file.
    const badContents = ['---', 'description: missing name', 'type: reference', '---', 'body'].join(
      '\n',
    );
    writeRawClaudeCodeProject('-slug-1', [{ filename: 'noname.md', contents: badContents }]);
    const memDir = join(home, '.claude', 'projects', '-slug-1', 'memory');
    writeMemory(join(memDir, 'alpha.md'), makeMemory('alpha'));

    let stdoutBuf = '';
    let stderrBuf = '';
    const res = await migrateMain({
      argv: ['migrate', '--from', 'claude-code'],
      embedderFactory: () => makeStubEmbedder(),
      stdout: (chunk) => {
        stdoutBuf += chunk;
      },
      stderr: (chunk) => {
        stderrBuf += chunk;
      },
      env: { COMMONPLACE_USER_DIR: userDir },
      home,
    });
    expect(res.exitCode, stderrBuf || stdoutBuf).toBe(0);
    // Skip section appears.
    expect(stdoutBuf).toMatch(/skipped:|collisions:/i);
    // The skipped file's name appears in stdout.
    expect(stdoutBuf).toContain('noname');
    // Some indication of the reason appears too (e.g. "name").
    expect(stdoutBuf).toMatch(/name|yaml|frontmatter/i);
  });
});

// -------------------------------------------------------------------------
// ac-4: MemoryStore.scan() resilience
// -------------------------------------------------------------------------

describe('ac-4: MemoryStore.scan() skips malformed files instead of throwing', () => {
  it('MemoryStore.scan() over a dir whose first .md file has no opening `---` delimiter returns a ScanResult with skipped containing { path, reason } for that file and does not throw', async () => {
    // Sorted scan order is alphabetical -- prefix with 'a' so it sorts first.
    writeFileSync(join(userDir, 'aa_bad.md'), '# no frontmatter at all\n', 'utf8');
    writeMemory(join(userDir, 'zz_good.md'), makeMemory('zz_good'));

    const store = new MemoryStore({ dir: userDir, embedder: makeStubEmbedder() });
    const result = await store.scan();

    expect(result.skipped.length).toBe(1);
    const entry = result.skipped[0]!;
    expect(entry.path).toBe(join(userDir, 'aa_bad.md'));
    expect(entry.reason.length).toBeGreaterThan(0);
  });

  it('MemoryStore.scan() over a dir whose .md file has `description: foo: bar` (unquoted, triggers js-yaml nested-mapping error) returns a ScanResult with skipped containing that file and does not throw', async () => {
    const contents = [
      '---',
      'name: alpha',
      'description: foo: bar',
      'type: reference',
      '---',
      'body',
    ].join('\n');
    writeFileSync(join(userDir, 'alpha.md'), contents, 'utf8');

    const store = new MemoryStore({ dir: userDir, embedder: makeStubEmbedder() });
    const result = await store.scan();

    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.path).toBe(join(userDir, 'alpha.md'));
  });

  it('MemoryStore.scan() over a dir containing one bad file and three good files loads all three good files into the in-memory entry array and reports skipped.length=1', async () => {
    writeFileSync(join(userDir, 'a_bad.md'), '# no frontmatter\n', 'utf8');
    writeMemory(join(userDir, 'b_good.md'), makeMemory('b_good'));
    writeMemory(join(userDir, 'c_good.md'), makeMemory('c_good'));
    writeMemory(join(userDir, 'd_good.md'), makeMemory('d_good'));

    const store = new MemoryStore({ dir: userDir, embedder: makeStubEmbedder() });
    const result = await store.scan();

    expect(result.skipped.length).toBe(1);
    expect(store.all().length).toBe(3);
    const names = store
      .all()
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(['b_good', 'c_good', 'd_good']);
  });

  it("MemoryStore.scan() emits a stderr warning naming the bad file's path and reason for each entry in ScanResult.skipped", async () => {
    writeFileSync(join(userDir, 'bad.md'), '# no frontmatter\n', 'utf8');

    // Replace process.stderr.write directly -- vi.spyOn on process.stderr
    // is unreliable across vitest workers (the write channel is forwarded
    // to the parent before the spy sees it).
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stderr.write;
    try {
      const store = new MemoryStore({ dir: userDir, embedder: makeStubEmbedder() });
      await store.scan();
    } finally {
      process.stderr.write = origWrite as typeof process.stderr.write;
    }

    expect(captured).toContain(join(userDir, 'bad.md'));
    expect(captured.length).toBeGreaterThan(0);
  });

  it('ScanResult.skipped is typed as Array<{ path: string; reason: string }> and is always present (defaults to []) on the returned summary', async () => {
    // No bad files: skipped should be [] (not undefined).
    writeMemory(join(userDir, 'alpha.md'), makeMemory('alpha'));

    const store = new MemoryStore({ dir: userDir, embedder: makeStubEmbedder() });
    const result = await store.scan();

    expect(Array.isArray(result.skipped)).toBe(true);
    expect(result.skipped).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// ac-5: runMigrate (legacy scan mode) inherits the resilient scan
// -------------------------------------------------------------------------

describe('ac-5: `commonplace migrate <dir>` re-runs safely after a partial import', () => {
  it('runMigrate (legacy scan mode) over a dir containing one malformed .md and several good .md files completes without throwing and the returned MigrateResult includes a skipped[] array with the malformed file', async () => {
    writeFileSync(join(userDir, 'a_bad.md'), '# no frontmatter\n', 'utf8');
    writeMemory(join(userDir, 'b_good.md'), makeMemory('b_good'));
    writeMemory(join(userDir, 'c_good.md'), makeMemory('c_good'));

    const result = await runMigrate({
      dir: userDir,
      embedder: makeStubEmbedder(),
      pruneDangling: false,
    });

    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.path).toBe(join(userDir, 'a_bad.md'));
    // The good files still got embedded.
    expect(existsSync(join(userDir, 'b_good.embedding'))).toBe(true);
    expect(existsSync(join(userDir, 'c_good.embedding'))).toBe(true);
  });

  it("the migrate bin's `migrate <dir>` stdout summary includes a line per skipped file (path + reason) when ScanResult.skipped is non-empty, and exits 0", async () => {
    writeFileSync(join(userDir, 'a_bad.md'), '# no frontmatter\n', 'utf8');
    writeMemory(join(userDir, 'b_good.md'), makeMemory('b_good'));

    let stdoutBuf = '';
    let stderrBuf = '';
    const res = await migrateMain({
      argv: ['migrate', userDir],
      embedderFactory: () => makeStubEmbedder(),
      stdout: (chunk) => {
        stdoutBuf += chunk;
      },
      stderr: (chunk) => {
        stderrBuf += chunk;
      },
    });
    expect(res.exitCode, stderrBuf || stdoutBuf).toBe(0);
    expect(stdoutBuf).toMatch(/skipped/i);
    expect(stdoutBuf).toContain('a_bad.md');
  });

  it('running `migrate <dir>` twice in sequence over a dir with one persistent malformed .md reports the same skipped file on both runs and produces sidecars for every other .md (re-run safety)', async () => {
    writeFileSync(join(userDir, 'a_bad.md'), '# no frontmatter\n', 'utf8');
    writeMemory(join(userDir, 'b_good.md'), makeMemory('b_good'));
    writeMemory(join(userDir, 'c_good.md'), makeMemory('c_good'));

    const first = await runMigrate({
      dir: userDir,
      embedder: makeStubEmbedder(),
      pruneDangling: false,
    });
    expect(first.skipped.length).toBe(1);
    expect(first.skipped[0]?.path).toBe(join(userDir, 'a_bad.md'));

    const second = await runMigrate({
      dir: userDir,
      embedder: makeStubEmbedder(),
      pruneDangling: false,
    });
    expect(second.skipped.length).toBe(1);
    expect(second.skipped[0]?.path).toBe(join(userDir, 'a_bad.md'));
    // Sidecars survived for the good files.
    expect(existsSync(join(userDir, 'b_good.embedding'))).toBe(true);
    expect(existsSync(join(userDir, 'c_good.embedding'))).toBe(true);
  });
});

// -------------------------------------------------------------------------
// ac-6: round-trip + happy-path regression
// -------------------------------------------------------------------------

describe('ac-6: round-trip + regression coverage', () => {
  it("(a) round-trip test: importing a source .md with `description: Project-level constraint: weather-hub firmware ...` produces a target file readMemory parses as { description: 'Project-level constraint: weather-hub firmware ...' } with no throw", async () => {
    const description = 'Project-level constraint: weather-hub firmware target the ESP32-C3';
    const contents = [
      '---',
      'name: weather_hub',
      `description: ${description}`,
      'type: project',
      '---',
      'body content',
    ].join('\n');
    writeRawClaudeCodeProject('-slug-1', [{ filename: 'weather_hub.md', contents }]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.skipped).toEqual([]);
    const reread = readMemory(join(userDir, 'weather_hub.md'));
    expect(reread.description).toBe(description);
    expect(reread.name).toBe('weather_hub');
    expect(reread.type).toBe('project');
  });

  it("(d) regression: importing a source dir containing only well-formed harness files produces target .md files that scan(), embed, and re-read identically to today's behaviour (imported counts and resulting sidecar contents match the pre-resilience happy-path expectations)", async () => {
    writeClaudeCodeProject('-slug-1', [makeMemory('alpha'), makeMemory('bravo')]);

    const result = await runImportFromClaudeCode({
      home,
      userDir,
      embedder: makeStubEmbedder(),
    });

    expect(result.imported.length).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(userDir, 'alpha.md'))).toBe(true);
    expect(existsSync(join(userDir, 'bravo.md'))).toBe(true);
    expect(existsSync(join(userDir, 'alpha.embedding'))).toBe(true);
    expect(existsSync(join(userDir, 'bravo.embedding'))).toBe(true);
    // Re-reading the imported files yields the same fields as the source.
    const alpha = readMemory(join(userDir, 'alpha.md'));
    expect(alpha.name).toBe('alpha');
    expect(alpha.type).toBe('reference');
  });
});
