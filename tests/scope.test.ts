/**
 * DAR-924 ac-2 / ac-7: unit tests for the scope-detection function.
 *
 * Each detection branch (env / roots / cwd / none) is exercised
 * independently of the spawned bin so the priority order can be asserted
 * without booting a real MCP server.
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENV_PROJECT_DIR,
  ENV_USER_DIR,
  ENV_DEPRECATED_MEMORY_DIR,
  PROJECT_MEMORY_DIRNAME,
  defaultUserDir,
  detectScope,
  resolveUserDir,
} from '../src/bin/scope.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar924-scope-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('DAR-924 ac-2 / ac-7: scope detection -- env > roots > cwd > none', () => {
  it('exposes detectScope as a unit-testable export so each branch can be exercised without spawning the bin', () => {
    expect(typeof detectScope).toBe('function');
  });

  it('COMMONPLACE_PROJECT_DIR set takes precedence over a roots response, cwd marker, and no-marker case', () => {
    // Set up a cwd that ALSO has a marker, plus a roots entry, to prove env
    // wins over both.
    mkdirSync(join(tmp, '.commonplace/memory'), { recursive: true });
    const explicit = '/tmp/explicit-project';
    const result = detectScope({
      env: { [ENV_PROJECT_DIR]: explicit },
      roots: [{ uri: pathToFileURL('/some/root').toString() }],
      cwd: tmp,
    });
    expect(result.source).toBe('env');
    expect(result.projectDir).toBe(explicit);
  });

  it('with COMMONPLACE_PROJECT_DIR unset, a roots response containing a file:// root resolves to <root>/.commonplace/memory and wins over cwd', () => {
    // cwd ALSO has a marker; roots must still win.
    mkdirSync(join(tmp, '.commonplace/memory'), { recursive: true });
    const rootPath = join(tmpdir(), 'roots-target-' + Date.now());
    const rootUri = pathToFileURL(rootPath).toString();
    const result = detectScope({
      env: {},
      roots: [{ uri: rootUri }],
      cwd: tmp,
    });
    expect(result.source).toBe('roots');
    expect(result.projectDir).toBe(join(rootPath, PROJECT_MEMORY_DIRNAME));
  });

  it('with env unset and roots empty, a <cwd>/.commonplace/memory directory is detected and used', () => {
    mkdirSync(join(tmp, '.commonplace/memory'), { recursive: true });
    const result = detectScope({
      env: {},
      roots: [],
      cwd: tmp,
    });
    expect(result.source).toBe('cwd');
    expect(result.projectDir).toBe(join(tmp, PROJECT_MEMORY_DIRNAME));
  });

  it('with env unset, roots empty, and no cwd marker, detection returns user-only mode (no project store constructed)', () => {
    // tmp has no `.commonplace/memory` subdir.
    const result = detectScope({
      env: {},
      roots: [],
      cwd: tmp,
    });
    expect(result.source).toBe('none');
    expect(result.projectDir).toBeNull();
  });

  it('non-file:// roots in the roots response are skipped; first file:// root wins', () => {
    const rootPath = join(tmpdir(), 'roots-target-2-' + Date.now());
    const result = detectScope({
      env: {},
      roots: [
        { uri: 'https://example.com/repo' },
        { uri: 'urn:something:else' },
        { uri: pathToFileURL(rootPath).toString() },
      ],
      cwd: tmp,
    });
    expect(result.source).toBe('roots');
    expect(result.projectDir).toBe(join(rootPath, PROJECT_MEMORY_DIRNAME));
  });

  it('COMMONPLACE_PROJECT_DIR pointing at a non-existent path is still honored (project store auto-created on first save per ac-3) and does not fall through', () => {
    const nonexistent = join(tmp, 'never-created-yet');
    const result = detectScope({
      env: { [ENV_PROJECT_DIR]: nonexistent },
      roots: null,
      cwd: tmp,
      // Force the exists probe to return false so we'd fall through if env
      // didn't already win -- it must win regardless.
      exists: () => false,
    });
    expect(result.source).toBe('env');
    expect(result.projectDir).toBe(nonexistent);
  });

  it('null roots (request not made / failed) falls through to cwd', () => {
    mkdirSync(join(tmp, '.commonplace/memory'), { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd: tmp,
    });
    expect(result.source).toBe('cwd');
  });
});

describe('DAR-924: user-dir env resolution', () => {
  it('COMMONPLACE_USER_DIR overrides the default and does not flag the deprecation alias', () => {
    const got = resolveUserDir({ [ENV_USER_DIR]: '/explicit/user/dir' });
    expect(got.userDir).toBe('/explicit/user/dir');
    expect(got.usedDeprecatedMemoryDir).toBe(false);
  });

  it('COMMONPLACE_MEMORY_DIR is honored as a deprecated alias when COMMONPLACE_USER_DIR is unset, and flags the deprecation', () => {
    const got = resolveUserDir({ [ENV_DEPRECATED_MEMORY_DIR]: '/legacy/dir' });
    expect(got.userDir).toBe('/legacy/dir');
    expect(got.usedDeprecatedMemoryDir).toBe(true);
  });

  it('COMMONPLACE_USER_DIR wins over COMMONPLACE_MEMORY_DIR when both are set', () => {
    const got = resolveUserDir({
      [ENV_USER_DIR]: '/explicit',
      [ENV_DEPRECATED_MEMORY_DIR]: '/legacy',
    });
    expect(got.userDir).toBe('/explicit');
    expect(got.usedDeprecatedMemoryDir).toBe(false);
  });

  it('falls back to ~/.commonplace/memory when neither env var is set', () => {
    const got = resolveUserDir({});
    expect(got.userDir).toBe(defaultUserDir());
    expect(got.usedDeprecatedMemoryDir).toBe(false);
  });
});
