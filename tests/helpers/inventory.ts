/**
 * Directory-inventory helpers shared by the DAR-1034 sidecar-mutation
 * test and the DAR-1035 sentinel-directory regression test.
 *
 * The helpers capture a snapshot of every file under a directory (relative
 * path -> bytes + mtimeNs) and diff two snapshots so a failed assertion
 * shows exactly which files mutated.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface InventoryEntry {
  bytes: Buffer;
  mtimeNs: bigint;
}

export type Inventory = Map<string, InventoryEntry>;

/**
 * Walk `dir` recursively and return a map of relative-path -> bytes +
 * mtimeNs for every regular file under it. Symlinks are followed; nested
 * directories are recursed.
 *
 * The function tolerates a missing `dir` (returns an empty inventory) so
 * callers can compare "before" snapshots even when the target directory
 * doesn't exist yet.
 */
export const inventoryDir = (dir: string): Inventory => {
  const out: Inventory = new Map();
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full, { bigint: true });
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(dir, full);
      out.set(rel, {
        bytes: readFileSync(full),
        mtimeNs: st.mtimeNs,
      });
    }
  };
  walk(dir);
  return out;
};

export interface InventoryDiff {
  /** Files present in `after` but not `before`. */
  added: string[];
  /** Files present in `before` but not `after`. */
  removed: string[];
  /**
   * Files present in both, but with different bytes or different mtimeNs.
   * `reasons[]` enumerates what changed for the failing file.
   */
  changed: Array<{ path: string; reasons: Array<'bytes' | 'mtime'> }>;
}

/**
 * Diff two inventories. Returns the symmetric difference (added / removed)
 * and the set of files whose bytes OR mtimeNs differ between the two
 * snapshots.
 */
export const diffInventories = (before: Inventory, after: Inventory): InventoryDiff => {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ path: string; reasons: Array<'bytes' | 'mtime'> }> = [];

  for (const [path, b] of before) {
    const a = after.get(path);
    if (a === undefined) {
      removed.push(path);
      continue;
    }
    const reasons: Array<'bytes' | 'mtime'> = [];
    if (!a.bytes.equals(b.bytes)) reasons.push('bytes');
    if (a.mtimeNs !== b.mtimeNs) reasons.push('mtime');
    if (reasons.length > 0) changed.push({ path, reasons });
  }
  for (const path of after.keys()) {
    if (!before.has(path)) added.push(path);
  }

  added.sort();
  removed.sort();
  changed.sort((x, y) => x.path.localeCompare(y.path));
  return { added, removed, changed };
};
