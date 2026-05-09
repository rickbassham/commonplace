/**
 * Atomic write-temp-then-rename helper (DAR-923).
 *
 * Multi-process safety primitive used by `MemoryStore` for every `.md` and
 * `.embedding` write. The helper:
 *
 *   1. Picks a tmpfile path colocated with `target` (same directory) so the
 *      subsequent `rename(2)` is an atomic intra-filesystem operation.
 *   2. Verifies the target directory and the tmpfile path resolve to the
 *      same filesystem device id. Cross-filesystem renames return `EXDEV`
 *      and are not atomic; we fail loudly instead.
 *   3. Writes the bytes, `fsync`s the file descriptor, closes it, then
 *      `rename(2)`s over the target.
 *   4. Opens the target's containing directory and `fsync`s the directory
 *      descriptor for true durability per POSIX (so a power loss does not
 *      lose the rename even though the inode itself was fsynced).
 *   5. Closes the directory descriptor.
 *
 * Failure modes:
 *
 *   - cross-filesystem straddle -- thrown with a clear message; the
 *     leftover tmpfile is removed best-effort.
 *   - any underlying I/O error (write / fsync / rename) -- propagated to
 *     the caller; tmpfile cleanup is best-effort.
 *
 * # Scope
 *
 * This module owns ONLY the helper. Per-name advisory locks
 * (`proper-lockfile`) live in `MemoryStore.save` / `delete`; the
 * mtime-based external-writer rescan also lives in `MemoryStore`.
 */

import { randomBytes } from 'node:crypto';
import * as realFs from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

/**
 * Internal test seam: the `fs.promises`-shaped dependency the helper uses.
 *
 * Tests reassign `__atomicWriteHooks.fs` to inject a fake (e.g. one that
 * returns crafted `dev` ids from `stat()` for the cross-filesystem guard
 * test, or one that records call ordering for fsync/rename ordering tests).
 *
 * Production code uses the real `node:fs/promises` module; nothing in the
 * helper exports the seam to runtime callers other than tests.
 */
export const __atomicWriteHooks: { fs: typeof realFs } = {
  fs: realFs,
};

/**
 * Atomically write `data` to `target` using the write-temp + fsync + rename
 * sequence documented at the top of this file.
 *
 * The tmpfile is named `<basename>.<random>.tmp` and lives in the same
 * directory as `target`. Callers MUST ensure the target's containing
 * directory exists (the helper does not `mkdir -p`).
 */
export const atomicWrite = async (target: string, data: Buffer | Uint8Array): Promise<void> => {
  const fs = __atomicWriteHooks.fs;
  const dir = dirname(target);
  const base = basename(target);
  // 16 hex chars of entropy -- ample to avoid collisions across racing
  // writers in the same dir without inflating filename length.
  const tmpName = `${base}.${randomBytes(8).toString('hex')}.tmp`;
  const tmpPath = join(dir, tmpName);

  // Same-filesystem guard: stat the target's directory and the tmpPath's
  // parent and require matching `dev`. They are by construction the same
  // path here, but stat both so a future change that points the tmp dir
  // elsewhere surfaces the cross-fs straddle.
  const targetDirStat = await fs.stat(dir);
  const tmpDirStat = await fs.stat(dirname(tmpPath));
  if (targetDirStat.dev !== tmpDirStat.dev) {
    throw new Error(
      `atomicWrite: refusing to rename across filesystems (target dir dev=${String(targetDirStat.dev)}, tmpfile dir dev=${String(tmpDirStat.dev)}); rename(2) is not atomic across filesystems`,
    );
  }

  let fileHandle: realFs.FileHandle | null = null;
  let dirHandle: realFs.FileHandle | null = null;
  try {
    fileHandle = await fs.open(tmpPath, 'w', 0o644);
    await fileHandle.writeFile(data);
    // Re-stat to detect any cross-fs straddle that only the tmpfile reveals
    // (e.g. some future change creates the tmp file via a path that resolves
    // to a different filesystem mount than its parent dir's stat suggests).
    const tmpStat = await fs.stat(tmpPath);
    if (tmpStat.dev !== targetDirStat.dev) {
      throw new Error(
        `atomicWrite: refusing to rename across filesystems (target dir dev=${String(targetDirStat.dev)}, tmpfile dev=${String(tmpStat.dev)}); rename(2) is not atomic across filesystems`,
      );
    }
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;

    await fs.rename(tmpPath, target);

    // fsync the containing directory so the rename hits the platter.
    dirHandle = await fs.open(dir, 'r');
    await dirHandle.sync();
    await dirHandle.close();
    dirHandle = null;
  } catch (err) {
    // Best-effort cleanup so we don't leave orphan tmpfiles around when a
    // write fails partway through.
    try {
      if (fileHandle !== null) await fileHandle.close();
    } catch {
      // swallow -- the original error is what the caller cares about
    }
    try {
      if (dirHandle !== null) await dirHandle.close();
    } catch {
      // swallow -- the original error is what the caller cares about
    }
    try {
      await fs.unlink(tmpPath);
    } catch {
      // tmpfile may already be gone (e.g. successful rename then failure)
      // or never created -- either way swallow
    }
    throw err;
  }
};
