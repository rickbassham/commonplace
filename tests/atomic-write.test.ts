/**
 * DAR-923 contract tests for the atomicWrite helper.
 *
 * Test names mirror the contract envelope on DAR-923 (round 1, approved):
 *   - ac-1: write-temp-then-rename + same-filesystem guard
 *   - ac-2: fsync semantics + descriptor lifecycle
 *
 * The helper writes bytes to a tmp file colocated with the target, fsyncs the
 * tmpfile, renames over the target, then fsyncs the directory. It throws when
 * tmpdir and target dir straddle filesystems and surfaces fsync errors.
 *
 * The helper exposes an internal `__atomicWriteHooks` test seam to inject
 * a fake `fs.promises`-shaped dependency. This avoids the non-configurable
 * descriptor problem on the `fs/promises` namespace and lets us observe the
 * exact fsync / rename / close call ordering deterministically.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import * as realFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWrite, __atomicWriteHooks } from '../src/store/atomic-write.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar923-aw-'));
});

afterEach(() => {
  // Always reset to the real fs.promises after each test.
  __atomicWriteHooks.fs = realFs;
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A FakeFs that delegates to the real fs.promises but records the order of
 * `open` (with mode), `sync`, `close`, and `rename` calls so tests can
 * assert ordering and descriptor balance precisely.
 */
interface Recorder {
  events: string[];
  counts: { open: number; close: number };
}
const makeRecordingFs = (
  hooks: {
    onOpen?: (path: string, flags?: string | number) => void;
    onSync?: (path: string) => void;
    onClose?: (path: string) => void;
    onRename?: (src: string, dst: string) => void;
  } = {},
): { fs: typeof realFs; recorder: Recorder } => {
  const recorder: Recorder = { events: [], counts: { open: 0, close: 0 } };
  const fs: typeof realFs = {
    ...realFs,
    open: (async (path: string | Buffer | URL, flags?: string | number, mode?: string | number) => {
      hooks.onOpen?.(String(path), flags);
      recorder.counts.open += 1;
      recorder.events.push(`open:${String(path)}`);
      const h = await realFs.open(path, flags ?? 'r', mode);
      const wrappedSync = async (): Promise<void> => {
        hooks.onSync?.(String(path));
        recorder.events.push(`fsync:${String(path)}`);
        await h.sync();
      };
      const wrappedClose = async (): Promise<void> => {
        hooks.onClose?.(String(path));
        recorder.events.push(`close:${String(path)}`);
        recorder.counts.close += 1;
        await h.close();
      };
      return new Proxy(h, {
        get(t, k) {
          if (k === 'sync') return wrappedSync;
          if (k === 'close') return wrappedClose;
          return Reflect.get(t, k);
        },
      });
    }) as typeof realFs.open,
    rename: async (src, dst) => {
      hooks.onRename?.(String(src), String(dst));
      recorder.events.push(`rename:${String(dst)}`);
      return realFs.rename(src, dst);
    },
  };
  return { fs, recorder };
};

describe('atomicWrite (ac-1)', () => {
  it('writes bytes to a tmp file in the same directory as the target and renames over the target', async () => {
    const target = join(tmp, 'sample.md');
    const data = Buffer.from('hello world', 'utf8');

    const renameCalls: { src: string; dst: string }[] = [];
    const { fs: fakeFs } = makeRecordingFs({
      onRename: (src, dst) => renameCalls.push({ src, dst }),
    });
    __atomicWriteHooks.fs = fakeFs;

    await atomicWrite(target, data);

    expect(readFileSync(target)).toEqual(data);
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0]!.dst).toBe(target);
    // Source path must be inside the same directory as the target.
    expect(renameCalls[0]!.src.startsWith(tmp + '/')).toBe(true);
    expect(renameCalls[0]!.src).not.toBe(target);
    // After a successful rename, no leftover tmp file in the dir.
    const leftover = readdirSync(tmp).filter((n) => n !== 'sample.md');
    expect(leftover).toEqual([]);
  });

  it('throws a clear error mentioning cross-filesystem when the tmpfile path and target path resolve to different filesystem device ids', async () => {
    const target = join(tmp, 'sample.md');
    const data = Buffer.from('hello', 'utf8');

    const fakeFs: typeof realFs = {
      ...realFs,
      // Patch only stat to return different dev ids for tmp dir vs target dir.
      stat: (async (p: string | Buffer | URL) => {
        const real = await realFs.stat(p);
        const isTmp = String(p).includes('.tmp');
        return new Proxy(real, {
          get(t, k) {
            if (k === 'dev') return isTmp ? 1 : 2;
            return Reflect.get(t, k);
          },
        });
      }) as typeof realFs.stat,
    };
    __atomicWriteHooks.fs = fakeFs;

    await expect(atomicWrite(target, data)).rejects.toThrow(
      /cross-filesystem|cross filesystem|different filesystem/i,
    );
  });
});

describe('atomicWrite fsync + descriptor lifecycle (ac-2)', () => {
  it('calls fsync on the tmpfile descriptor before invoking rename', async () => {
    const target = join(tmp, 'sample.md');
    const data = Buffer.from('payload', 'utf8');

    const { fs: fakeFs, recorder } = makeRecordingFs();
    __atomicWriteHooks.fs = fakeFs;

    await atomicWrite(target, data);

    const events = recorder.events;
    const renameIdx = events.findIndex((e) => e.startsWith('rename:'));
    // At least one fsync event before rename must reference a path that is
    // NOT the target's containing directory (i.e. it's the tmpfile).
    const beforeRenameFsync = events.slice(0, renameIdx).find((e) => e.startsWith('fsync:'));
    expect(beforeRenameFsync).toBeTruthy();
    expect(beforeRenameFsync).not.toBe(`fsync:${tmp}`);
  });

  it('calls fsync on the containing directory descriptor after rename', async () => {
    const target = join(tmp, 'sample2.md');
    const data = Buffer.from('payload', 'utf8');

    const { fs: fakeFs, recorder } = makeRecordingFs();
    __atomicWriteHooks.fs = fakeFs;

    await atomicWrite(target, data);

    const events = recorder.events;
    const renameIdx = events.findIndex((e) => e.startsWith('rename:'));
    expect(renameIdx).toBeGreaterThan(-1);
    const dirFsyncAfterRename = events.slice(renameIdx + 1).some((e) => e === `fsync:${tmp}`);
    expect(dirFsyncAfterRename).toBe(true);
  });

  it('closes both file and directory descriptors after fsync (no descriptor leak under repeated calls)', async () => {
    const target = join(tmp, 'leak.md');
    const data = Buffer.from('xyz', 'utf8');

    const { fs: fakeFs, recorder } = makeRecordingFs();
    __atomicWriteHooks.fs = fakeFs;

    // Run several iterations. If descriptors leak, openCount > closeCount
    // after the loop -- the assertion below catches that.
    for (let i = 0; i < 20; i++) {
      await atomicWrite(target, data);
    }

    expect(recorder.counts.open).toBeGreaterThan(0);
    expect(recorder.counts.close).toBe(recorder.counts.open);
  });

  it('surfaces fsync errors to the caller rather than swallowing them', async () => {
    const target = join(tmp, 'err.md');
    const data = Buffer.from('boom', 'utf8');

    const fakeFs: typeof realFs = {
      ...realFs,
      open: (async (
        path: string | Buffer | URL,
        flags?: string | number,
        mode?: string | number,
      ) => {
        const handle = await realFs.open(path, flags ?? 'r', mode);
        return new Proxy(handle, {
          get(t, k) {
            if (k === 'sync') {
              return async (): Promise<void> => {
                if (String(path).includes('.tmp')) {
                  throw new Error('synthetic fsync failure');
                }
              };
            }
            return Reflect.get(t, k);
          },
        });
      }) as typeof realFs.open,
    };
    __atomicWriteHooks.fs = fakeFs;

    await expect(atomicWrite(target, data)).rejects.toThrow(/synthetic fsync failure/);
  });
});
