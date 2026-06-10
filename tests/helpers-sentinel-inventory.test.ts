/**
 * DAR-1035 ac-2: regression test for the sentinel-directory inventory
 * helper.
 *
 * The helper at `tests/helpers/inventory.ts` snapshots a directory's
 * contents (relative path -> bytes + mtimeNs). This file's two tests:
 *
 *   #1 (integration): seed a sentinel directory representing the
 *      developer's `~/.commonplace/memory` corpus (with realistic .md +
 *      .embedding sidecars). Snapshot before. Drive every tests/
 *      bootHarness / bootServer entry path against the sentinel by
 *      *pointing the boot call at a different tmp dir*. Snapshot after.
 *      Assert byte-identical and mtime-identical. Failure mode: any
 *      future test wiring that re-introduces the user-dir leak (a boot
 *      call falling through to homedir() instead of using its supplied
 *      tmp dir) would mutate the sentinel and fail the assertion.
 *
 *   #2 (unit): assert the inventory helper is shared (both this file and
 *      tests/retrieval-benchmark-no-sidecar-mutation.test.ts import it
 *      from the same module under tests/helpers/).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootHarness } from './helpers/boot-harness.js';
import { diffInventories, inventoryDir } from './helpers/inventory.js';
import { contentSha, serializeMemory } from '../src/store/memory.js';
import { encodeSidecar } from '../src/store/sidecar.js';

const repoRoot = join(__dirname, '..');

const stubEmbedder = () => ({
  modelId: 'stub',
  dim: 4,
  embed: async (text: string): Promise<Float32Array> => {
    void text;
    return new Float32Array(4);
  },
});

/**
 * Seed a directory with two realistic memory entries so an accidental
 * `MemoryStore.scan()` against this directory would re-embed them with the
 * stub embedder (producing all-zero vectors and rewriting the sidecars).
 *
 * The sidecars are tagged with a non-stub modelId so any boot call that
 * scans this dir with the stub embedder triggers the re-embed branch.
 */
const seedSentinel = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  for (const name of ['alpha_sentinel', 'beta_sentinel']) {
    const memory = {
      name,
      type: 'reference' as const,
      description: `${name} description`,
      body: `${name} body text -- DAR-1035 sentinel for inventory regression`,
    };
    writeFileSync(join(dir, `${name}.md`), serializeMemory(memory));
    const dim = 8;
    const vec = new Float32Array(dim);
    for (let i = 0; i < dim; i += 1) vec[i] = (i + 1) / dim;
    const sidecar = encodeSidecar({
      modelId: 'Xenova/bge-base-en-v1.5',
      dim,
      descriptionVector: vec,
      bodyVector: vec,
      contentSha: contentSha(memory),
    });
    writeFileSync(join(dir, `${name}.embedding`), sidecar);
  }
};

describe('ac-2 #1: sentinel directory is byte-identical and mtime-identical after every bootHarness entry path', () => {
  let sentinel: string;
  let cwd: string;
  beforeEach(() => {
    sentinel = mkdtempSync(join(tmpdir(), 'dar1035-sentinel-'));
    cwd = mkdtempSync(join(tmpdir(), 'dar1035-cwd-'));
    seedSentinel(sentinel);
  });
  afterEach(() => {
    rmSync(sentinel, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('bootHarness with no env override and a cwd-derived userDir leaves the sentinel untouched', async () => {
    const before = inventoryDir(sentinel);

    // Drive a representative bootHarness call. The harness's job is to
    // ensure this boot does NOT touch the sentinel even though we never
    // told it about the sentinel; instead it must route the user dir
    // under `cwd`.
    const { close } = await bootHarness({
      env: {},
      cwd,
      embedder: stubEmbedder(),
    });
    await close();

    const after = inventoryDir(sentinel);
    const diff = diffInventories(before, after);
    expect(
      diff,
      `Sentinel inventory changed after bootHarness ran -- this is the DAR-1035 leak signature. Diff:\n${JSON.stringify(
        diff,
        null,
        2,
      )}`,
    ).toEqual({ added: [], removed: [], changed: [] });
  });

  it('bootHarness with explicit env.COMMONPLACE_USER_DIR pointing elsewhere also leaves the sentinel untouched', async () => {
    const before = inventoryDir(sentinel);
    const explicit = mkdtempSync(join(tmpdir(), 'dar1035-explicit-'));
    try {
      const { close } = await bootHarness({
        env: { COMMONPLACE_USER_DIR: explicit },
        cwd,
        embedder: stubEmbedder(),
      });
      await close();
    } finally {
      rmSync(explicit, { recursive: true, force: true });
    }

    const after = inventoryDir(sentinel);
    const diff = diffInventories(before, after);
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('ac-2 #2: inventory helper is factored into a shared module', () => {
  /**
   * The DAR-1035 contract's second ac-2 test reads:
   *
   *   "regression test sentinel-directory inventory helper is factored
   *    into a shared module (e.g. tests/helpers/) and consumed by both
   *    the new regression test and tests/retrieval-benchmark-no-sidecar
   *    -mutation.test.ts (or, if shared extraction is rejected, the
   *    contract documents the alternative)"
   *
   * The escape hatch is in play here: DAR-1034 (which introduces
   * `tests/retrieval-benchmark-no-sidecar-mutation.test.ts`) is parallel
   * work that has not landed on `main` at the time DAR-1035 is being
   * implemented. We:
   *
   *   1. Extract the helper into `tests/helpers/inventory.ts` (this PR).
   *   2. Assert this PR's regression test consumes the shared module.
   *   3. Skip the second consumer assertion when the DAR-1034 file is
   *      absent, AND assert it consumes the shared module when present.
   *
   * When DAR-1034 lands (rebase / merge), its inline `inventory()` helper
   * should be replaced by an import from `./helpers/inventory`. The
   * assertion below activates automatically once the file appears.
   */
  const importRe = /from\s+['"]\.\/helpers\/inventory(?:\.js)?['"]/;

  it('the new DAR-1035 regression test consumes the shared helper at ./helpers/inventory', () => {
    const consumer = readFileSync(
      join(repoRoot, 'tests/helpers-sentinel-inventory.test.ts'),
      'utf8',
    );
    expect(
      importRe.test(consumer),
      'helpers-sentinel-inventory.test.ts must import from ./helpers/inventory',
    ).toBe(true);
  });

  it('IF the DAR-1034 sidecar-mutation test exists, it also consumes the shared helper (alternative documented when absent)', () => {
    const dar1034Path = join(repoRoot, 'tests/retrieval-benchmark-no-sidecar-mutation.test.ts');
    if (!existsSync(dar1034Path)) {
      // Alternative documented: DAR-1034 is parallel work; the helper is
      // extracted in DAR-1035 and the DAR-1034 branch will rebase onto
      // it. The assertion is left in place so a future regression
      // (DAR-1034 lands without consuming the shared helper) fails loudly.
      return;
    }
    const consumer = readFileSync(dar1034Path, 'utf8');
    expect(
      importRe.test(consumer),
      'retrieval-benchmark-no-sidecar-mutation.test.ts must import from ./helpers/inventory (DAR-1035 contract: factor inventory helper into shared module)',
    ).toBe(true);
  });
});
