/**
 * DAR-910 contract tests.
 *
 * Behavioral tests for the binary `.embedding` sidecar wire format:
 * - encodeSidecar({ modelId, dim, contentSha, vector }): Buffer
 * - decodeSidecar(buf): { modelId, dim, contentSha, vector }
 *
 * Format (all integers little-endian):
 *
 *   magic       4 bytes   "CMEM"
 *   version     1 byte    0x01
 *   model_len   1 byte    length of model_id in utf-8 bytes
 *   model_id    N bytes   utf-8
 *   dim         4 bytes   uint32 LE
 *   content_sha 32 bytes  raw sha256 (decoded from the 64-char hex string)
 *   vector      dim*4     float32 LE
 *
 * Test names mirror the contract envelope on DAR-910 (round 1).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { decodeSidecar, encodeSidecar } from '../src/store/sidecar.js';

const repoRoot = join(__dirname, '..');

const MAGIC = Buffer.from('CMEM', 'ascii');
const VERSION = 0x01;

/** Build a 64-char lowercase hex sha (deterministic, not necessarily a real digest). */
const hexSha = (seed: number): string => {
  // 32 bytes -> 64 hex chars. Use a tiny LCG so the sha varies with seed.
  const bytes = Buffer.alloc(32);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < 32; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    bytes[i] = s & 0xff;
  }
  return bytes.toString('hex');
};

const makeVector = (dim: number, fn: (i: number) => number = (i) => i * 0.5): number[] => {
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) v[i] = fn(i);
  return v;
};

// -------------------------------------------------------------------------
// ac-1: docs/sidecar-format.md documents the format
// -------------------------------------------------------------------------

describe('ac-1: docs', () => {
  it('docs/sidecar-format.md exists at the repo-relative path and is non-empty', () => {
    const p = join(repoRoot, 'docs', 'sidecar-format.md');
    expect(existsSync(p)).toBe(true);
    const size = statSync(p).size;
    expect(size).toBeGreaterThan(0);
    const text = readFileSync(p, 'utf8').trim();
    expect(text.length).toBeGreaterThan(0);
  });

  // The "describes every header field with byte offsets and sizes" assertion
  // is a manual/prose check per the contract envelope (type: "manual"). We
  // include a structural smoke test here that the doc names every field; the
  // human-graded check is whether the offsets in the doc match the
  // implementation -- enforced by review, not this test.
  it('docs/sidecar-format.md mentions every header field by name', () => {
    const text = readFileSync(join(repoRoot, 'docs', 'sidecar-format.md'), 'utf8');
    for (const term of [
      'magic',
      'version',
      'model_len',
      'model_id',
      'dim',
      'content_sha',
      'vector',
      'CMEM',
    ]) {
      expect(text, `docs/sidecar-format.md missing reference to: ${term}`).toContain(term);
    }
  });
});

// -------------------------------------------------------------------------
// ac-2: encodeSidecar
// -------------------------------------------------------------------------

describe('ac-2: encodeSidecar', () => {
  it("encodeSidecar returns a Buffer whose first 4 bytes are the ASCII magic 'CMEM'", () => {
    const buf = encodeSidecar({
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(1),
      vector: [1.0],
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).equals(MAGIC)).toBe(true);
  });

  it('encodeSidecar writes version byte 0x01 at offset 4', () => {
    const buf = encodeSidecar({
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(2),
      vector: [0.0],
    });
    expect(buf[4]).toBe(VERSION);
  });

  it('encodeSidecar writes model_len as the utf-8 byte length of modelId at offset 5, followed by the model_id utf-8 bytes', () => {
    const modelId = 'Xenova/bge-base-en-v1.5';
    const buf = encodeSidecar({
      modelId,
      dim: 1,
      contentSha: hexSha(3),
      vector: [1.5],
    });
    const utf8 = Buffer.from(modelId, 'utf8');
    expect(buf[5]).toBe(utf8.length);
    expect(buf.subarray(6, 6 + utf8.length).equals(utf8)).toBe(true);
  });

  it('encodeSidecar writes dim as a uint32 little-endian immediately after model_id', () => {
    const modelId = 'm';
    const dim = 768;
    const buf = encodeSidecar({
      modelId,
      dim,
      contentSha: hexSha(4),
      vector: makeVector(dim, () => 0.0),
    });
    const utf8 = Buffer.from(modelId, 'utf8');
    const offset = 4 + 1 + 1 + utf8.length;
    expect(buf.readUInt32LE(offset)).toBe(dim);
  });

  it('encodeSidecar writes the 32-byte raw sha256 (decoded from the contentSha hex string) immediately after dim', () => {
    const modelId = 'mm';
    const dim = 2;
    const sha = hexSha(5);
    const buf = encodeSidecar({
      modelId,
      dim,
      contentSha: sha,
      vector: [0.25, -0.5],
    });
    const utf8 = Buffer.from(modelId, 'utf8');
    const shaOffset = 4 + 1 + 1 + utf8.length + 4;
    const shaBytes = buf.subarray(shaOffset, shaOffset + 32);
    expect(shaBytes.toString('hex')).toBe(sha);
  });

  it('encodeSidecar writes vector as dim consecutive float32 little-endian values, in order', () => {
    const modelId = 'm';
    const dim = 4;
    const vec = [0.0, 1.0, -1.5, 3.25];
    const buf = encodeSidecar({
      modelId,
      dim,
      contentSha: hexSha(6),
      vector: vec,
    });
    const utf8 = Buffer.from(modelId, 'utf8');
    const vecOffset = 4 + 1 + 1 + utf8.length + 4 + 32;
    for (let i = 0; i < dim; i++) {
      expect(buf.readFloatLE(vecOffset + i * 4)).toBe(vec[i]);
    }
  });

  it('encodeSidecar total buffer length equals 4 + 1 + 1 + model_len + 4 + 32 + dim*4', () => {
    const modelId = 'Xenova/bge-base-en-v1.5';
    const dim = 768;
    const buf = encodeSidecar({
      modelId,
      dim,
      contentSha: hexSha(7),
      vector: makeVector(dim),
    });
    const utf8 = Buffer.from(modelId, 'utf8');
    expect(buf.length).toBe(4 + 1 + 1 + utf8.length + 4 + 32 + dim * 4);
  });

  it('encodeSidecar throws when vector.length !== dim', () => {
    expect(() =>
      encodeSidecar({
        modelId: 'm',
        dim: 4,
        contentSha: hexSha(8),
        vector: [1, 2, 3],
      }),
    ).toThrow();
    expect(() =>
      encodeSidecar({
        modelId: 'm',
        dim: 2,
        contentSha: hexSha(9),
        vector: [1, 2, 3],
      }),
    ).toThrow();
  });

  it('encodeSidecar throws when contentSha is not a 64-character lowercase hex string', () => {
    const baseVec = [0.0];
    // Wrong length.
    expect(() =>
      encodeSidecar({ modelId: 'm', dim: 1, contentSha: 'abcd', vector: baseVec }),
    ).toThrow();
    // Uppercase hex (must be lowercase).
    expect(() =>
      encodeSidecar({
        modelId: 'm',
        dim: 1,
        contentSha: 'A'.repeat(64),
        vector: baseVec,
      }),
    ).toThrow();
    // Non-hex chars.
    expect(() =>
      encodeSidecar({
        modelId: 'm',
        dim: 1,
        contentSha: 'z'.repeat(64),
        vector: baseVec,
      }),
    ).toThrow();
    // 64 chars but contains a non-hex char.
    expect(() =>
      encodeSidecar({
        modelId: 'm',
        dim: 1,
        contentSha: 'g' + 'a'.repeat(63),
        vector: baseVec,
      }),
    ).toThrow();
  });
});

// -------------------------------------------------------------------------
// ac-3: decodeSidecar
// -------------------------------------------------------------------------

describe('ac-3: decodeSidecar', () => {
  it('decodeSidecar returns { modelId, dim, contentSha, vector } with values equal to the inputs that were encoded', () => {
    const input = {
      modelId: 'Xenova/bge-base-en-v1.5',
      dim: 4,
      contentSha: hexSha(10),
      vector: [0.0, 1.0, -2.5, 0.125],
    };
    const buf = encodeSidecar(input);
    const out = decodeSidecar(buf);
    expect(out.modelId).toBe(input.modelId);
    expect(out.dim).toBe(input.dim);
    expect(out.contentSha).toBe(input.contentSha);
    expect(Array.from(out.vector)).toEqual(input.vector);
  });

  it('decodeSidecar returns contentSha as a 64-character lowercase hex string (not a Buffer)', () => {
    const input = {
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(11),
      vector: [0.0],
    };
    const buf = encodeSidecar(input);
    const out = decodeSidecar(buf);
    expect(typeof out.contentSha).toBe('string');
    expect(out.contentSha).toMatch(/^[0-9a-f]{64}$/);
    expect(out.contentSha).toBe(input.contentSha);
  });

  it('decodeSidecar returns vector as a Float32Array (or number[] per implementation choice) of length dim', () => {
    const dim = 8;
    const vec = makeVector(dim, (i) => (i - 3) * 0.25);
    const buf = encodeSidecar({
      modelId: 'm',
      dim,
      contentSha: hexSha(12),
      vector: vec,
    });
    const out = decodeSidecar(buf);
    // Float32Array OR number[]; either is acceptable per the contract.
    const isF32 = out.vector instanceof Float32Array;
    const isArray = Array.isArray(out.vector);
    expect(isF32 || isArray).toBe(true);
    expect(out.vector.length).toBe(dim);
  });
});

// -------------------------------------------------------------------------
// ac-4: validation in decode + encode dim mismatch
// -------------------------------------------------------------------------

describe('ac-4: throws on bad magic, unknown version, mismatched dim', () => {
  it("decodeSidecar throws when the first 4 bytes are not 'CMEM'", () => {
    const good = encodeSidecar({
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(13),
      vector: [0.0],
    });
    const bad = Buffer.from(good);
    bad.write('XXXX', 0, 4, 'ascii');
    expect(() => decodeSidecar(bad)).toThrow();
  });

  it('decodeSidecar throws when the version byte is not 0x01 (e.g. 0x02, 0xFF)', () => {
    const good = encodeSidecar({
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(14),
      vector: [0.0],
    });
    const v2 = Buffer.from(good);
    v2[4] = 0x02;
    expect(() => decodeSidecar(v2)).toThrow();

    const vff = Buffer.from(good);
    vff[4] = 0xff;
    expect(() => decodeSidecar(vff)).toThrow();
  });

  it('decodeSidecar throws when the remaining vector bytes after the header are not exactly dim*4 bytes', () => {
    const good = encodeSidecar({
      modelId: 'm',
      dim: 4,
      contentSha: hexSha(15),
      vector: [1.0, 2.0, 3.0, 4.0],
    });
    // Drop one byte from the tail (vector now short by 1 byte).
    const short = good.subarray(0, good.length - 1);
    expect(() => decodeSidecar(short)).toThrow();

    // Append one extra byte to the tail (vector now too long by 1 byte).
    const long = Buffer.concat([good, Buffer.from([0x00])]);
    expect(() => decodeSidecar(long)).toThrow();
  });

  it('encodeSidecar throws when vector.length !== dim (mismatched dim at encode time)', () => {
    expect(() =>
      encodeSidecar({
        modelId: 'm',
        dim: 5,
        contentSha: hexSha(16),
        vector: [1, 2, 3],
      }),
    ).toThrow();
  });
});

// -------------------------------------------------------------------------
// ac-5: round-trip property
// -------------------------------------------------------------------------

describe('ac-5: round-trip', () => {
  it('round-trip property: for arbitrary { modelId, dim, contentSha, vector } inputs, decodeSidecar(encodeSidecar(x)) deep-equals x (modelId, dim, contentSha, and per-element vector values)', () => {
    const cases: Array<{
      modelId: string;
      dim: number;
      contentSha: string;
      vector: number[];
    }> = [
      { modelId: 'a', dim: 1, contentSha: hexSha(20), vector: [0.0] },
      { modelId: 'm', dim: 3, contentSha: hexSha(21), vector: [0.0, -1.0, 1.0] },
      {
        modelId: 'Xenova/bge-base-en-v1.5',
        dim: 8,
        contentSha: hexSha(22),
        vector: makeVector(8, (i) => (i - 4) * 0.0625),
      },
      {
        modelId: 'x'.repeat(255), // model_len boundary (1-byte field max)
        dim: 2,
        contentSha: hexSha(23),
        vector: [0.5, -0.5],
      },
    ];
    for (const input of cases) {
      const buf = encodeSidecar(input);
      const out = decodeSidecar(buf);
      expect(out.modelId).toBe(input.modelId);
      expect(out.dim).toBe(input.dim);
      expect(out.contentSha).toBe(input.contentSha);
      expect(out.vector.length).toBe(input.vector.length);
      for (let i = 0; i < input.vector.length; i++) {
        expect(out.vector[i]).toBe(input.vector[i]);
      }
    }
  });

  it('round-trip preserves non-ASCII utf-8 in modelId (e.g. multi-byte characters) without corruption', () => {
    const modelId = 'モデル/日本語-эмбеддинг-🚀';
    const input = {
      modelId,
      dim: 2,
      contentSha: hexSha(24),
      vector: [1.0, -1.0],
    };
    const buf = encodeSidecar(input);
    const out = decodeSidecar(buf);
    expect(out.modelId).toBe(modelId);
    // Sanity: the byte length we stored is the utf-8 byte length, not the
    // code-point count.
    const utf8 = Buffer.from(modelId, 'utf8');
    expect(buf[5]).toBe(utf8.length);
    expect(utf8.length).not.toBe([...modelId].length);
  });

  it('round-trip preserves float32 vector values exactly (no precision loss beyond float32 representation)', () => {
    // Pick values that are exactly representable in float32: powers of two,
    // simple binary fractions, and zero. Float32 stores these exactly.
    const exact = [0.0, 1.0, -1.0, 0.5, -0.25, 0.125, 1024.0, -1024.0];
    const input = {
      modelId: 'm',
      dim: exact.length,
      contentSha: hexSha(25),
      vector: exact,
    };
    const buf = encodeSidecar(input);
    const out = decodeSidecar(buf);
    for (let i = 0; i < exact.length; i++) {
      expect(out.vector[i]).toBe(exact[i]);
    }
  });
});

// -------------------------------------------------------------------------
// ac-6: rejects bad magic, truncated buffers, future version
// -------------------------------------------------------------------------

describe('ac-6: validation negative cases', () => {
  it("decodeSidecar throws when given a buffer whose first 4 bytes are not 'CMEM' (e.g. 'XXXX')", () => {
    const good = encodeSidecar({
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(30),
      vector: [0.0],
    });
    const bad = Buffer.from(good);
    bad.write('XXXX', 0, 4, 'ascii');
    expect(() => decodeSidecar(bad)).toThrow();
  });

  it('decodeSidecar throws when given a buffer truncated mid-header (shorter than magic+version+model_len+model_id+dim+content_sha)', () => {
    const good = encodeSidecar({
      modelId: 'Xenova/bge-base-en-v1.5',
      dim: 4,
      contentSha: hexSha(31),
      vector: [1.0, 2.0, 3.0, 4.0],
    });
    const utf8 = Buffer.from('Xenova/bge-base-en-v1.5', 'utf8');
    const headerEnd = 4 + 1 + 1 + utf8.length + 4 + 32;

    // Empty buffer
    expect(() => decodeSidecar(Buffer.alloc(0))).toThrow();
    // 0 bytes
    expect(() => decodeSidecar(Buffer.alloc(3))).toThrow();
    // Just magic, no version/model_len/etc.
    expect(() => decodeSidecar(good.subarray(0, 4))).toThrow();
    // Magic + version, missing model_len.
    expect(() => decodeSidecar(good.subarray(0, 5))).toThrow();
    // Truncated mid-model_id.
    expect(() => decodeSidecar(good.subarray(0, 6 + utf8.length - 1))).toThrow();
    // Truncated before dim.
    expect(() => decodeSidecar(good.subarray(0, 6 + utf8.length))).toThrow();
    // Truncated mid-content_sha.
    expect(() => decodeSidecar(good.subarray(0, headerEnd - 1))).toThrow();
  });

  it('decodeSidecar throws when given a buffer truncated mid-vector (header valid but vector bytes are short of dim*4)', () => {
    const good = encodeSidecar({
      modelId: 'm',
      dim: 4,
      contentSha: hexSha(32),
      vector: [1.0, 2.0, 3.0, 4.0],
    });
    const utf8 = Buffer.from('m', 'utf8');
    const headerEnd = 4 + 1 + 1 + utf8.length + 4 + 32;

    // Header present, no vector bytes at all.
    expect(() => decodeSidecar(good.subarray(0, headerEnd))).toThrow();
    // Header + 1 float (dim says 4).
    expect(() => decodeSidecar(good.subarray(0, headerEnd + 4))).toThrow();
    // Header + 3 floats (dim says 4).
    expect(() => decodeSidecar(good.subarray(0, headerEnd + 12))).toThrow();
    // Off by one byte (not aligned).
    expect(() => decodeSidecar(good.subarray(0, good.length - 1))).toThrow();
  });

  it('decodeSidecar throws when version byte is greater than 0x01 (future version, e.g. 0x02)', () => {
    const good = encodeSidecar({
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(33),
      vector: [0.0],
    });
    for (const v of [0x02, 0x10, 0xff]) {
      const bad = Buffer.from(good);
      bad[4] = v;
      expect(() => decodeSidecar(bad)).toThrow();
    }
  });
});
