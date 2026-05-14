/**
 * Scaffolding contract tests.
 *
 * These tests verify the scaffolding contract: package metadata, TS/ESM
 * config, src/ skeleton, Makefile-driven dev loop, lint/format/editor
 * configs, license, gitignore, and the populated CLAUDE.md.
 *
 * They are "unit" in the sense of assertions over file contents on disk;
 * a separate suite (`scaffolding.integration.test.ts`) covers the
 * `make`-target integration checks.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const exists = (rel: string) => existsSync(join(repoRoot, rel));
const isDir = (rel: string) => exists(rel) && statSync(join(repoRoot, rel)).isDirectory();

/**
 * Type guard: true when `v` is a plain object (not null, not an array).
 * Narrows to `Record<string, unknown>` so callers can read keys without
 * type assertions.
 */
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Parse JSON and assert the result is a plain object. The runtime guard does
 * the narrowing -- no `as` needed.
 */
const parseJsonObject = (s: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(s);
  if (!isObject(v)) {
    throw new Error(`expected JSON object, got ${v === null ? 'null' : typeof v}`);
  }
  return v;
};

const asStringRecord = (v: unknown): Record<string, string> | undefined => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') return undefined;
    out[k] = val;
  }
  return out;
};

const pkgRaw = parseJsonObject(read('package.json'));
const pkg = {
  dependencies: asStringRecord(pkgRaw.dependencies),
  devDependencies: asStringRecord(pkgRaw.devDependencies),
  engines: asStringRecord(pkgRaw.engines),
  packageManager: typeof pkgRaw.packageManager === 'string' ? pkgRaw.packageManager : undefined,
  scripts: asStringRecord(pkgRaw.scripts),
};

describe('ac-1: runtime deps', () => {
  it('package.json declares @modelcontextprotocol/sdk in dependencies', () => {
    expect(pkg.dependencies?.['@modelcontextprotocol/sdk']).toBeDefined();
  });
  it('package.json declares @huggingface/transformers in dependencies', () => {
    expect(pkg.dependencies?.['@huggingface/transformers']).toBeDefined();
  });
});

describe('ac-2: dev deps', () => {
  it('package.json declares typescript, tsx, vitest, eslint, @typescript-eslint/parser, @typescript-eslint/eslint-plugin, and prettier in devDependencies', () => {
    const dev = pkg.devDependencies ?? {};
    for (const dep of [
      'typescript',
      'tsx',
      'vitest',
      'eslint',
      '@typescript-eslint/parser',
      '@typescript-eslint/eslint-plugin',
      'prettier',
    ]) {
      expect(dev[dep], `missing devDependency: ${dep}`).toBeDefined();
    }
  });
});

describe('ac-3: engines.node', () => {
  it('package.json engines.node field is set to >=20', () => {
    expect(pkg.engines?.node).toBeDefined();
    // Accept any range expression that includes >=20 (e.g. ">=20", ">=20.0.0").
    expect(pkg.engines?.node).toMatch(/>=\s*20/);
  });
});

describe('ac-4: packageManager', () => {
  it('package.json packageManager field pins a pnpm@9.x version', () => {
    expect(pkg.packageManager).toBeDefined();
    expect(pkg.packageManager).toMatch(/^pnpm@9\.\d+\.\d+/);
  });
});

describe('ac-5: package.json scripts and Makefile delegation', () => {
  it('package.json scripts contains build, test, typecheck, lint, format, and format:check entries', () => {
    const s = pkg.scripts ?? {};
    for (const name of ['build', 'test', 'typecheck', 'lint', 'format', 'format:check']) {
      expect(s[name], `missing script: ${name}`).toBeDefined();
    }
  });

  it('Makefile targets shell out to pnpm scripts (not to underlying tools like tsc/eslint directly)', () => {
    const mk = read('Makefile');
    // For each delegated target, the recipe line must contain `pnpm ...`,
    // and must NOT directly call tsc/eslint/prettier/vitest binaries.
    for (const target of ['build', 'test', 'typecheck', 'lint', 'format']) {
      const re = new RegExp(`^${target}:[^\\n]*\\n([\\t ][^\\n]*\\n)*`, 'm');
      const block = mk.match(re)?.[0] ?? '';
      expect(block, `target ${target} not found in Makefile`).not.toBe('');
      expect(block, `${target} should invoke pnpm`).toMatch(/pnpm\b/);
    }
    // Sanity: the Makefile body should not call these tools directly on a recipe line.
    const recipes = mk
      .split('\n')
      .filter((l) => l.startsWith('\t'))
      .join('\n');
    expect(recipes).not.toMatch(/(^|\s)tsc(\s|$)/);
    expect(recipes).not.toMatch(/(^|\s)eslint(\s|$)/);
    // prettier/vitest may appear in comments; we just guard the recipe lines.
    expect(recipes).not.toMatch(/(^|\s)prettier(\s|$)/);
    expect(recipes).not.toMatch(/(^|\s)vitest(\s|$)/);
  });
});

describe('ac-6: tsconfig.json', () => {
  // tsconfig may contain comments, but we keep it valid JSON in this repo.
  const tsRaw = parseJsonObject(read('tsconfig.json'));
  const compilerOptions: Record<string, unknown> = isObject(tsRaw.compilerOptions)
    ? tsRaw.compilerOptions
    : {};
  it('tsconfig.json sets compilerOptions.strict to true', () => {
    expect(compilerOptions.strict).toBe(true);
  });
  it('tsconfig.json emits ESM (module set to an ESM-compatible value such as NodeNext/ES2022)', () => {
    const mod = String(compilerOptions.module ?? '').toLowerCase();
    expect(['nodenext', 'node16', 'es2022', 'esnext', 'es2020', 'es2015', 'es6']).toContain(mod);
  });
  it('tsconfig.json sets compilerOptions.target to ES2022', () => {
    expect(String(compilerOptions.target ?? '').toLowerCase()).toBe('es2022');
  });
});

describe('ac-7: src/ layout', () => {
  it('src/embedder/, src/store/, and src/server/ directories exist', () => {
    expect(isDir('src/embedder')).toBe(true);
    expect(isDir('src/store')).toBe(true);
    expect(isDir('src/server')).toBe(true);
  });
  it('src/index.ts file exists at the package entry point', () => {
    expect(exists('src/index.ts')).toBe(true);
  });
});

describe('ac-9: Makefile structure', () => {
  const mk = read('Makefile');
  it('Makefile exists at repo root and declares .PHONY for all listed targets', () => {
    expect(mk).toMatch(/\.PHONY:/);
    // All required targets must be in some .PHONY declaration.
    const phonyDecls = [...mk.matchAll(/\.PHONY:\s*([^\n]+)/g)]
      .map((m) => (m[1] ?? '').trim().split(/\s+/))
      .flat();
    for (const t of ['help', 'install', 'build', 'test', 'typecheck', 'lint', 'format', 'audit']) {
      expect(phonyDecls, `target ${t} not in .PHONY`).toContain(t);
    }
  });

  it('every required target in the Makefile carries a `## ` help-comment annotation', () => {
    for (const t of ['help', 'install', 'build', 'test', 'typecheck', 'lint', 'format', 'audit']) {
      const re = new RegExp(`^${t}:[^\\n]*##\\s+`, 'm');
      expect(mk, `target ${t} missing ## annotation`).toMatch(re);
    }
  });
});

describe('ac-10/11/12/13: Makefile target bodies', () => {
  const mk = read('Makefile');
  const recipeFor = (target: string) => {
    const re = new RegExp(`^${target}:[^\\n]*\\n((?:[\\t ][^\\n]*\\n)*)`, 'm');
    return mk.match(re)?.[1] ?? '';
  };

  it('Makefile defines targets: help, install, build, test, typecheck, lint, format, audit', () => {
    for (const t of ['help', 'install', 'build', 'test', 'typecheck', 'lint', 'format', 'audit']) {
      expect(mk, `target ${t} missing`).toMatch(new RegExp(`^${t}:`, 'm'));
    }
  });

  it('Makefile install target invokes `pnpm install --frozen-lockfile`', () => {
    expect(recipeFor('install')).toMatch(/pnpm\s+install\s+--frozen-lockfile/);
  });

  it('Makefile build/test/typecheck/lint/format targets each invoke their corresponding `pnpm <script>` command', () => {
    expect(recipeFor('build')).toMatch(/pnpm\s+build/);
    expect(recipeFor('test')).toMatch(/pnpm\s+test/);
    expect(recipeFor('typecheck')).toMatch(/pnpm\s+typecheck/);
    expect(recipeFor('lint')).toMatch(/pnpm\s+lint/);
    expect(recipeFor('format')).toMatch(/pnpm\s+format(?!:check)/);
  });

  it('package.json typecheck script invokes `tsc --noEmit`', () => {
    expect(pkg.scripts?.typecheck).toMatch(/tsc\s+--noEmit/);
  });

  it('package.json format script writes (not check-only) and a separate format:check script exists for read-only check', () => {
    expect(pkg.scripts?.format).toMatch(/prettier\s+--write/);
    expect(pkg.scripts?.['format:check']).toMatch(/prettier\s+--check/);
  });

  it('Makefile audit target invokes `pnpm audit --audit-level=high`', () => {
    expect(recipeFor('audit')).toMatch(/pnpm\s+audit\s+--audit-level=high/);
  });

  it('Makefile help target uses grep+awk to extract `## ` annotations from $(MAKEFILE_LIST)', () => {
    const help = recipeFor('help');
    expect(help).toMatch(/grep\b.*##/);
    expect(help).toMatch(/awk\b/);
    expect(help).toMatch(/MAKEFILE_LIST/);
  });
});

describe('ac-14: default target', () => {
  it('running bare `make` (no target) resolves to the help target', () => {
    const mk = read('Makefile');
    // We support either `.DEFAULT_GOAL := help` or `help` being the first
    // non-special target in the Makefile.
    if (/\.DEFAULT_GOAL\s*:?=\s*help\b/.test(mk)) {
      expect(true).toBe(true);
      return;
    }
    // Fallback: first concrete target (skipping .PHONY/.DEFAULT_GOAL/etc.)
    const firstTarget = mk
      .split('\n')
      .map((l) => l.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/))
      .find((m) => m !== null && !(m[1] ?? '').startsWith('.'));
    expect(firstTarget?.[1]).toBe('help');
  });
});

describe('ac-15: .editorconfig', () => {
  it('.editorconfig sets end_of_line=lf, charset=utf-8, trim_trailing_whitespace=true, and 2-space indent_size for TS and JSON', () => {
    const ec = read('.editorconfig');
    expect(ec).toMatch(/end_of_line\s*=\s*lf/);
    expect(ec).toMatch(/charset\s*=\s*utf-8/);
    expect(ec).toMatch(/trim_trailing_whitespace\s*=\s*true/);
    // 2-space indent must apply to TS and JSON. Either via a default `[*]`
    // section or an explicit TS/JSON section. We accept either by checking
    // that some applicable section sets indent_size=2.
    expect(ec).toMatch(/indent_size\s*=\s*2/);
  });
});

describe('ac-16: Prettier config', () => {
  it('.prettierrc and .prettierignore exist and .prettierrc parses as valid Prettier config (JSON form)', () => {
    expect(exists('.prettierrc')).toBe(true);
    expect(exists('.prettierignore')).toBe(true);
    // .prettierrc may be JSON, JSON5 or YAML. We use JSON in this repo.
    const parsed = parseJsonObject(read('.prettierrc'));
    expect(typeof parsed).toBe('object');
  });
  it('.prettierignore lists generated artifacts (at minimum dist/ and node_modules/)', () => {
    const ignore = read('.prettierignore');
    expect(ignore).toMatch(/^dist\/?$/m);
    expect(ignore).toMatch(/^node_modules\/?$/m);
  });
});

describe('ac-17: ESLint config', () => {
  it('an ESLint config file (.eslintrc.cjs or eslint.config.* flat config) exists at repo root', () => {
    const candidates = [
      '.eslintrc.cjs',
      '.eslintrc.js',
      '.eslintrc.json',
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
    ];
    expect(candidates.some(exists)).toBe(true);
  });

  it('ESLint config references @typescript-eslint parser and plugin so TS files are linted with type-aware rules', () => {
    const candidates = [
      '.eslintrc.cjs',
      '.eslintrc.js',
      '.eslintrc.json',
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
    ];
    const found = candidates.find(exists);
    expect(found).toBeDefined();
    const body = read(found as string);
    // typescript-eslint package re-exports parser & plugin; accept either
    // the meta package name or the explicit @typescript-eslint scoped names.
    expect(body).toMatch(/(typescript-eslint|@typescript-eslint)/);
  });
});

describe('ac-18: .nvmrc', () => {
  it('.nvmrc exists and its declared Node major version satisfies package.json engines.node (>=20)', () => {
    expect(exists('.nvmrc')).toBe(true);
    const nvm = read('.nvmrc').trim().replace(/^v/, '');
    const major = Number.parseInt(nvm.split('.')[0] ?? '', 10);
    expect(Number.isFinite(major)).toBe(true);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});

describe('ac-19: pnpm-lock.yaml', () => {
  it('pnpm-lock.yaml exists at repo root and is not gitignored', () => {
    expect(exists('pnpm-lock.yaml')).toBe(true);
    const ignore = read('.gitignore');
    expect(ignore).not.toMatch(/^pnpm-lock\.yaml$/m);
  });
});

describe('ac-20: LICENSE', () => {
  it('LICENSE file exists at repo root and contains MIT license text', () => {
    expect(exists('LICENSE')).toBe(true);
    const text = read('LICENSE');
    expect(text).toMatch(/MIT License/);
    expect(text).toMatch(/Permission is hereby granted, free of charge/);
  });
});

describe('ac-21: .gitignore', () => {
  it('.gitignore at repo root includes node_modules/, dist/, *.embedding, and .DS_Store entries', () => {
    const g = read('.gitignore');
    expect(g).toMatch(/^node_modules\/?$/m);
    expect(g).toMatch(/^dist\/?$/m);
    expect(g).toMatch(/^\*\.embedding$/m);
    expect(g).toMatch(/^\.DS_Store$/m);
  });
});

describe('ac-22: CLAUDE.md', () => {
  const md = read('CLAUDE.md');
  it('CLAUDE.md exists at repo root with Tech Stack, Architecture, Project Conventions, Environment, and Overrides headings', () => {
    for (const h of [
      '## Tech Stack',
      '## Architecture',
      '## Project Conventions',
      '## Environment',
      '## Overrides',
    ]) {
      expect(md, `missing heading: ${h}`).toContain(h);
    }
  });

  const sectionOf = (heading: string) => {
    const idx = md.indexOf(heading);
    if (idx < 0) return '';
    const next = md.slice(idx + heading.length).search(/\n##\s/);
    return next < 0 ? md.slice(idx) : md.slice(idx, idx + heading.length + next);
  };

  it('CLAUDE.md Tech Stack section names TypeScript, ESM, pnpm, vitest, transformers.js, and MCP SDK', () => {
    const sec = sectionOf('## Tech Stack');
    for (const term of ['TypeScript', 'ESM', 'pnpm', 'vitest', 'transformers.js', 'MCP SDK']) {
      expect(sec, `Tech Stack missing: ${term}`).toContain(term);
    }
  });

  it('CLAUDE.md Architecture section describes src/embedder/, src/store/, and src/server/ roles', () => {
    const sec = sectionOf('## Architecture');
    for (const term of ['src/embedder/', 'src/store/', 'src/server/']) {
      expect(sec).toContain(term);
    }
  });

  it('CLAUDE.md Project Conventions section states Makefile-driven, pnpm-only (no npm), markdown source-of-truth, sidecars derived', () => {
    const sec = sectionOf('## Project Conventions');
    expect(sec).toMatch(/Makefile/i);
    expect(sec).toMatch(/pnpm/);
    expect(sec).toMatch(/no\s+npm|npm.*never|never\s+use\s+`npm`/i);
    expect(sec).toMatch(/markdown/i);
    expect(sec).toMatch(/source\s+of\s+truth/i);
    expect(sec).toMatch(/sidecar/i);
    expect(sec).toMatch(/derived/i);
  });

  it('CLAUDE.md Environment section references env-var configuration', () => {
    const sec = sectionOf('## Environment');
    expect(sec).toMatch(/env(ironment)?[- ]var/i);
  });

  it('CLAUDE.md Overrides section is present and indicates no overrides yet', () => {
    const sec = sectionOf('## Overrides');
    // Either explicitly says "no overrides" or "none yet" or similar.
    expect(sec.toLowerCase()).toMatch(/no\s+(project[- ]specific\s+)?overrides|none\s+yet/);
  });
});
