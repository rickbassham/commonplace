/**
 * Unit tests for the scope-detection function.
 *
 * Each detection branch (env / roots / cwd / none) is exercised
 * independently of the spawned bin so the priority order can be asserted
 * without booting a real MCP server.
 */

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
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
  // Pre-normalize via realpath so on macOS the `/var/...` vs `/private/var/...`
  // discrepancy doesn't trip the path-equality assertions below; the
  // detector also realpaths its cwd input internally.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dar924-scope-')));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('scope detection: env > roots > cwd > none', () => {
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
      homedir: '/nonexistent-home',
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
      homedir: '/nonexistent-home',
    });
    expect(result.source).toBe('roots');
    expect(result.projectDir).toBe(join(rootPath, PROJECT_MEMORY_DIRNAME));
  });

  it('with env unset, roots empty, and no marker between cwd and $HOME, detection returns user-only mode (no project store constructed)', () => {
    // tmp has no `.git` or `.commonplace` subdir.
    const result = detectScope({
      env: {},
      roots: [],
      cwd: tmp,
      homedir: tmpdir(),
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
      homedir: '/nonexistent-home',
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
      homedir: '/nonexistent-home',
      // Force the exists probe to return false so we'd fall through if env
      // didn't already win -- it must win regardless.
      exists: () => false,
    });
    expect(result.source).toBe('env');
    expect(result.projectDir).toBe(nonexistent);
  });

  it('null roots (request not made / failed) falls through to cwd walk; cwd with .commonplace marker resolves source=cwd', () => {
    mkdirSync(join(tmp, '.commonplace'), { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd: tmp,
      homedir: '/nonexistent-home',
    });
    expect(result.source).toBe('cwd');
    expect(result.projectDir).toBe(join(tmp, PROJECT_MEMORY_DIRNAME));
  });
});

// --------------------------------------------------------------------------
// Upward walk semantics (DAR-1016)
// --------------------------------------------------------------------------

describe('cwd-marker upward walk (DAR-1016): .git/.commonplace markers, $HOME-exclusive stop', () => {
  // ac-1: cwd contains .git marker -> projectDir is <cwd>/.commonplace/memory.
  it('detectScope: cwd contains .git marker -> projectDir is <cwd>/.commonplace/memory and source is cwd', () => {
    mkdirSync(join(tmp, '.git'), { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd: tmp,
      homedir: '/nonexistent-home',
    });
    expect(result.source).toBe('cwd');
    expect(result.projectDir).toBe(join(tmp, PROJECT_MEMORY_DIRNAME));
  });

  // ac-1: cwd contains .commonplace marker (no .git) -> projectDir is
  // <cwd>/.commonplace/memory.
  it('detectScope: cwd contains .commonplace marker (no .git) -> projectDir is <cwd>/.commonplace/memory and source is cwd', () => {
    mkdirSync(join(tmp, '.commonplace'), { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd: tmp,
      homedir: '/nonexistent-home',
    });
    expect(result.source).toBe('cwd');
    expect(result.projectDir).toBe(join(tmp, PROJECT_MEMORY_DIRNAME));
  });

  // ac-1: cwd contains both .git and .commonplace markers -> single
  // resolution; projectDir is <cwd>/.commonplace/memory.
  it('detectScope: cwd contains both .git and .commonplace markers -> projectDir is <cwd>/.commonplace/memory (single resolution, no duplication)', () => {
    mkdirSync(join(tmp, '.git'), { recursive: true });
    mkdirSync(join(tmp, '.commonplace'), { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd: tmp,
      homedir: '/nonexistent-home',
    });
    expect(result.source).toBe('cwd');
    expect(result.projectDir).toBe(join(tmp, PROJECT_MEMORY_DIRNAME));
  });

  // ac-2: walk stops before $HOME even when $HOME contains .git.
  it('detectScope: walk stops before $HOME even when $HOME contains .git -> returns null projectDir', () => {
    // Fake home with .git inside; cwd is a sibling of home (so walking up
    // never enters home), but we want to assert the walk does NOT inspect
    // home itself. Construct: home = tmp/home, cwd = tmp/home/no-markers.
    const fakeHome = join(tmp, 'home');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(fakeHome, '.git'), { recursive: true });
    const cwd = join(fakeHome, 'no-markers');
    mkdirSync(cwd, { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd,
      homedir: fakeHome,
    });
    expect(result.source).toBe('none');
    expect(result.projectDir).toBeNull();
  });

  // ac-2: walk stops before $HOME even when $HOME contains .commonplace.
  it('detectScope: walk stops before $HOME even when $HOME contains .commonplace -> returns null projectDir', () => {
    const fakeHome = join(tmp, 'home');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(fakeHome, '.commonplace'), { recursive: true });
    const cwd = join(fakeHome, 'no-markers');
    mkdirSync(cwd, { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd,
      homedir: fakeHome,
    });
    expect(result.source).toBe('none');
    expect(result.projectDir).toBeNull();
  });

  // ac-2: walk terminates when parent === current (filesystem root) without
  // finding a marker -> null. Use a homedir well outside the walk path so it
  // doesn't short-circuit before we hit the root.
  it('detectScope: walk reaches filesystem root without finding a marker -> returns null projectDir (no infinite loop, terminates when parent === current)', () => {
    // cwd is a real directory under tmp with no markers; homedir is set to
    // a path that is neither equal to nor an ancestor of cwd, so the only
    // termination condition that fires is parent === current at the
    // filesystem root.
    const cwd = join(tmp, 'a/b/c');
    mkdirSync(cwd, { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd,
      homedir: '/nonexistent-home-outside-tmp',
    });
    expect(result.source).toBe('none');
    expect(result.projectDir).toBeNull();
  });

  // ac-3: cwd=$HOME/some-project with .git -> detected.
  it('detectScope: cwd=$HOME/some-project with .git marker -> projectDir is $HOME/some-project/.commonplace/memory and source is cwd', () => {
    const fakeHome = join(tmp, 'home');
    const project = join(fakeHome, 'some-project');
    mkdirSync(join(project, '.git'), { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd: project,
      homedir: fakeHome,
    });
    expect(result.source).toBe('cwd');
    expect(result.projectDir).toBe(join(project, PROJECT_MEMORY_DIRNAME));
  });

  // ac-4: cwd=$HOME/some-project/sub/dir with .git at $HOME/some-project.
  it('detectScope: cwd=$HOME/some-project/sub/dir with .git only at $HOME/some-project -> walk ascends and resolves projectDir to $HOME/some-project/.commonplace/memory', () => {
    const fakeHome = join(tmp, 'home');
    const project = join(fakeHome, 'some-project');
    mkdirSync(join(project, '.git'), { recursive: true });
    const cwd = join(project, 'sub', 'dir');
    mkdirSync(cwd, { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd,
      homedir: fakeHome,
    });
    expect(result.source).toBe('cwd');
    expect(result.projectDir).toBe(join(project, PROJECT_MEMORY_DIRNAME));
  });

  // ac-5: cwd=$HOME/no-markers-here with $HOME/.commonplace present but no
  // nested markers -> projectDir null.
  it('detectScope: cwd=$HOME/no-markers-here with $HOME/.commonplace present but no nested markers -> projectDir is null and source is none (HOME .commonplace must not be matched)', () => {
    const fakeHome = join(tmp, 'home');
    mkdirSync(join(fakeHome, '.commonplace'), { recursive: true });
    const cwd = join(fakeHome, 'no-markers-here');
    mkdirSync(cwd, { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd,
      homedir: fakeHome,
    });
    expect(result.source).toBe('none');
    expect(result.projectDir).toBeNull();
  });

  // ac-6: cwd === $HOME -> null.
  it('detectScope: cwd=$HOME exactly -> projectDir is null and source is none (walk does not inspect $HOME for markers)', () => {
    const fakeHome = join(tmp, 'home');
    mkdirSync(join(fakeHome, '.git'), { recursive: true });
    mkdirSync(join(fakeHome, '.commonplace'), { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd: fakeHome,
      homedir: fakeHome,
    });
    expect(result.source).toBe('none');
    expect(result.projectDir).toBeNull();
  });

  // ac-7: cwd outside $HOME, marker at an ancestor that is not $HOME.
  it('detectScope: cwd outside $HOME (/opt/work/foo/bar) with .git at /opt/work -> walk ascends past intermediate dirs and resolves projectDir to /opt/work/.commonplace/memory', () => {
    // Simulate /opt/work under tmp; homedir is unrelated.
    const workRoot = join(tmp, 'opt', 'work');
    const cwd = join(workRoot, 'foo', 'bar');
    mkdirSync(join(workRoot, '.git'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const fakeHome = join(tmp, 'home');
    mkdirSync(fakeHome, { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd,
      homedir: fakeHome,
    });
    expect(result.source).toBe('cwd');
    expect(result.projectDir).toBe(join(workRoot, PROJECT_MEMORY_DIRNAME));
  });

  // ac-8: cwd=$HOME/.commonplace/memory with no markers in cwd or
  // ~/.commonplace -> walk halts before $HOME and returns null.
  it('detectScope: cwd=$HOME/.commonplace/memory with no markers in cwd or ~/.commonplace -> walk halts before $HOME and returns null projectDir', () => {
    const fakeHome = join(tmp, 'home');
    const userMem = join(fakeHome, '.commonplace', 'memory');
    mkdirSync(userMem, { recursive: true });
    // Note: neither `userMem` nor `<fakeHome>/.commonplace` contain `.git`
    // or a nested `.commonplace` directory, so the walk visits both,
    // finds no markers, and stops before $HOME.
    const result = detectScope({
      env: {},
      roots: null,
      cwd: userMem,
      homedir: fakeHome,
    });
    expect(result.source).toBe('none');
    expect(result.projectDir).toBeNull();
  });

  // Symlinked homedir: realpath normalization must match the walk's cwd.
  it('detectScope: when $HOME is a symlink, the walk stops before the realpath of $HOME (no marker false-positive at the symlink target)', () => {
    // Construct: tmp/real-home with .git inside (the would-be "ancestor"
    // marker). tmp/home is a symlink to tmp/real-home. cwd is a real
    // subdir whose parent's realpath is tmp/real-home.
    const realHome = join(tmp, 'real-home');
    mkdirSync(join(realHome, '.git'), { recursive: true });
    const homeSymlink = join(tmp, 'home');
    symlinkSync(realHome, homeSymlink);
    const cwd = join(realHome, 'nested');
    mkdirSync(cwd, { recursive: true });
    const result = detectScope({
      env: {},
      roots: null,
      cwd,
      homedir: homeSymlink,
    });
    expect(result.source).toBe('none');
    expect(result.projectDir).toBeNull();
  });
});

describe('user-dir env resolution', () => {
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
