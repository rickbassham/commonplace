/**
 * Contract tests for the binary `.embedding` sidecar wire format (v0x02,
 * two-channel):
 * - encodeSidecar({ modelId, dim, contentSha, descriptionVector, bodyVector }): Buffer
 * - decodeSidecar(buf): { modelId, dim, contentSha, descriptionVector, bodyVector }
 *
 * Format (all integers little-endian):
 *
 *   magic        4 bytes   "CMEM"
 *   version      1 byte    0x02
 *   model_len    1 byte    length of model_id in utf-8 bytes
 *   model_id     N bytes   utf-8
 *   dim          4 bytes   uint32 LE
 *   content_sha  32 bytes  raw sha256 (decoded from the 64-char hex string)
 *   desc_vector  dim*4     float32 LE (description-channel embedding)
 *   body_vector  dim*4     float32 LE (body-channel embedding)
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { decodeSidecar, encodeSidecar } from '../src/store/sidecar.js';

const repoRoot = join(__dirname, '..');

const MAGIC = Buffer.from('CMEM', 'ascii');
const VERSION = 0x02;

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

/**
 * Hand-build a v0x01 single-vector sidecar buffer (the pre-DAR-1210 wire
 * format): magic, version 0x01, model_len, model_id, dim, content_sha,
 * single vector of dim*4 bytes. The encoder no longer produces this form,
 * so tests that need a legacy buffer construct it here.
 */
const buildV1Sidecar = (
  modelId: string,
  dim: number,
  contentShaHex: string,
  vector: number[],
): Buffer => {
  const modelBytes = Buffer.from(modelId, 'utf8');
  const out = Buffer.alloc(4 + 1 + 1 + modelBytes.length + 4 + 32 + dim * 4);
  let off = 0;
  MAGIC.copy(out, off);
  off += 4;
  out.writeUInt8(0x01, off);
  off += 1;
  out.writeUInt8(modelBytes.length, off);
  off += 1;
  modelBytes.copy(out, off);
  off += modelBytes.length;
  out.writeUInt32LE(dim, off);
  off += 4;
  Buffer.from(contentShaHex, 'hex').copy(out, off);
  off += 32;
  for (let i = 0; i < dim; i++) {
    out.writeFloatLE(vector[i]!, off);
    off += 4;
  }
  return out;
};

// -------------------------------------------------------------------------
// docs: docs/sidecar-format.md documents the format
// -------------------------------------------------------------------------

describe('docs', () => {
  it('docs/sidecar-format.md exists at the repo-relative path and is non-empty', () => {
    const p = join(repoRoot, 'docs', 'sidecar-format.md');
    expect(existsSync(p)).toBe(true);
    const size = statSync(p).size;
    expect(size).toBeGreaterThan(0);
    const text = readFileSync(p, 'utf8').trim();
    expect(text.length).toBeGreaterThan(0);
  });

  it('docs/sidecar-format.md mentions every header field by name (including both vector channels)', () => {
    const text = readFileSync(join(repoRoot, 'docs', 'sidecar-format.md'), 'utf8');
    for (const term of [
      'magic',
      'version',
      'model_len',
      'model_id',
      'dim',
      'content_sha',
      'desc_vector',
      'body_vector',
      'CMEM',
    ]) {
      expect(text, `docs/sidecar-format.md missing reference to: ${term}`).toContain(term);
    }
  });
});

// -------------------------------------------------------------------------
// encodeSidecar
// -------------------------------------------------------------------------

describe('encodeSidecar', () => {
  it("returns a Buffer whose first 4 bytes are the ASCII magic 'CMEM'", () => {
    const buf = encodeSidecar({
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(1),
      descriptionVector: [0.5],
      bodyVector: [1.0],
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).equals(MAGIC)).toBe(true);
  });

  it('writes version byte 0x02 at offset 4', () => {
    const buf = encodeSidecar({
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(2),
      descriptionVector: [0.0],
      bodyVector: [0.0],
    });
    expect(buf[4]).toBe(VERSION);
  });

  it('writes model_len as the utf-8 byte length of modelId at offset 5, followed by the model_id utf-8 bytes', () => {
    const modelId = 'Xenova/bge-base-en-v1.5';
    const buf = encodeSidecar({
      modelId,
      dim: 1,
      contentSha: hexSha(3),
      descriptionVector: [0.5],
      bodyVector: [1.5],
    });
    const utf8 = Buffer.from(modelId, 'utf8');
    expect(buf[5]).toBe(utf8.length);
    expect(buf.subarray(6, 6 + utf8.length).equals(utf8)).toBe(true);
  });

  it('writes dim as a uint32 little-endian immediately after model_id', () => {
    const modelId = 'm';
    const dim = 768;
    const buf = encodeSidecar({
      modelId,
      dim,
      contentSha: hexSha(4),
      descriptionVector: makeVector(dim, () => 0.0),
      bodyVector: makeVector(dim, () => 0.0),
    });
    const utf8 = Buffer.from(modelId, 'utf8');
    const offset = 4 + 1 + 1 + utf8.length;
    expect(buf.readUInt32LE(offset)).toBe(dim);
  });

  it('writes the 32-byte raw sha256 (decoded from the contentSha hex string) immediately after dim', () => {
    const modelId = 'mm';
    const dim = 2;
    const sha = hexSha(5);
    const buf = encodeSidecar({
      modelId,
      dim,
      contentSha: sha,
      descriptionVector: [0.5, -1.0],
      bodyVector: [0.25, -0.5],
    });
    const utf8 = Buffer.from(modelId, 'utf8');
    const shaOffset = 4 + 1 + 1 + utf8.length + 4;
    const shaBytes = buf.subarray(shaOffset, shaOffset + 32);
    expect(shaBytes.toString('hex')).toBe(sha);
  });

  it('writes desc_vector then body_vector as dim consecutive float32 little-endian values each, in order', () => {
    const modelId = 'm';
    const dim = 4;
    const desc = [0.5, -0.5, 2.0, -2.25];
    const body = [0.0, 1.0, -1.5, 3.25];
    const buf = encodeSidecar({
      modelId,
      dim,
      contentSha: hexSha(6),
      descriptionVector: desc,
      bodyVector: body,
    });
    const utf8 = Buffer.from(modelId, 'utf8');
    const descOffset = 4 + 1 + 1 + utf8.length + 4 + 32;
    const bodyOffset = descOffset + dim * 4;
    for (let i = 0; i < dim; i++) {
      expect(buf.readFloatLE(descOffset + i * 4)).toBe(desc[i]);
      expect(buf.readFloatLE(bodyOffset + i * 4)).toBe(body[i]);
    }
  });

  it('total buffer length equals 4 + 1 + 1 + model_len + 4 + 32 + 2*dim*4', () => {
    const modelId = 'Xenova/bge-base-en-v1.5';
    const dim = 768;
    const buf = encodeSidecar({
      modelId,
      dim,
      contentSha: hexSha(7),
      descriptionVector: makeVector(dim),
      bodyVector: makeVector(dim),
    });
    const utf8 = Buffer.from(modelId, 'utf8');
    expect(buf.length).toBe(4 + 1 + 1 + utf8.length + 4 + 32 + 2 * dim * 4);
  });

  it('throws when descriptionVector.length !== dim or bodyVector.length !== dim', () => {
    expect(() =>
      encodeSidecar({
        modelId: 'm',
        dim: 4,
        contentSha: hexSha(8),
        descriptionVector: [1, 2, 3],
        bodyVector: [1, 2, 3, 4],
      }),
    ).toThrow();
    expect(() =>
      encodeSidecar({
        modelId: 'm',
        dim: 2,
        contentSha: hexSha(9),
        descriptionVector: [1, 2],
        bodyVector: [1, 2, 3],
      }),
    ).toThrow();
  });

  it('throws when contentSha is not a 64-character lowercase hex string', () => {
    const baseVec = [0.0];
    // Wrong length.
    expect(() =>
      encodeSidecar({
        modelId: 'm',
        dim: 1,
        contentSha: 'abcd',
        descriptionVector: baseVec,
        bodyVector: baseVec,
      }),
    ).toThrow();
    // Uppercase hex (must be lowercase).
    expect(() =>
      encodeSidecar({
        modelId: 'm',
        dim: 1,
        contentSha: 'A'.repeat(64),
        descriptionVector: baseVec,
        bodyVector: baseVec,
      }),
    ).toThrow();
    // Non-hex chars.
    expect(() =>
      encodeSidecar({
        modelId: 'm',
        dim: 1,
        contentSha: 'z'.repeat(64),
        descriptionVector: baseVec,
        bodyVector: baseVec,
      }),
    ).toThrow();
  });
});

// -------------------------------------------------------------------------
// decodeSidecar
// -------------------------------------------------------------------------

describe('decodeSidecar', () => {
  it('returns { modelId, dim, contentSha, descriptionVector, bodyVector } equal to the encoded inputs', () => {
    const input = {
      modelId: 'Xenova/bge-base-en-v1.5',
      dim: 4,
      contentSha: hexSha(10),
      descriptionVector: [0.5, -1.0, 2.5, -0.125],
      bodyVector: [0.0, 1.0, -2.5, 0.125],
    };
    const buf = encodeSidecar(input);
    const out = decodeSidecar(buf);
    expect(out.modelId).toBe(input.modelId);
    expect(out.dim).toBe(input.dim);
    expect(out.contentSha).toBe(input.contentSha);
    expect(Array.from(out.descriptionVector)).toEqual(input.descriptionVector);
    expect(Array.from(out.bodyVector)).toEqual(input.bodyVector);
  });

  it('returns contentSha as a 64-character lowercase hex string (not a Buffer)', () => {
    const input = {
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(11),
      descriptionVector: [0.0],
      bodyVector: [0.0],
    };
    const buf = encodeSidecar(input);
    const out = decodeSidecar(buf);
    expect(typeof out.contentSha).toBe('string');
    expect(out.contentSha).toMatch(/^[0-9a-f]{64}$/);
    expect(out.contentSha).toBe(input.contentSha);
  });

  it('returns both vectors as Float32Arrays of length dim', () => {
    const dim = 8;
    const buf = encodeSidecar({
      modelId: 'm',
      dim,
      contentSha: hexSha(12),
      descriptionVector: makeVector(dim, (i) => (i - 4) * 0.5),
      bodyVector: makeVector(dim, (i) => (i - 3) * 0.25),
    });
    const out = decodeSidecar(buf);
    expect(out.descriptionVector).toBeInstanceOf(Float32Array);
    expect(out.bodyVector).toBeInstanceOf(Float32Array);
    expect(out.descriptionVector.length).toBe(dim);
    expect(out.bodyVector.length).toBe(dim);
  });
});

// -------------------------------------------------------------------------
// ac-4 (DAR-1210): version handling
// -------------------------------------------------------------------------

describe('ac-4: version handling', () => {
  it('decoding a v0x01 single-vector sidecar buffer raises the documented decode error (does not silently return a partial result)', () => {
    const v1 = buildV1Sidecar('Xenova/bge-base-en-v1.5', 4, hexSha(40), [1.0, 2.0, 3.0, 4.0]);
    expect(() => decodeSidecar(v1)).toThrow(/unsupported version 0x01/);
  });

  it('decodeSidecar throws when the version byte is anything other than 0x02 (e.g. 0x01, 0x03, 0xFF)', () => {
    const good = encodeSidecar({
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(14),
      descriptionVector: [0.0],
      bodyVector: [0.0],
    });
    for (const v of [0x01, 0x03, 0xff]) {
      const bad = Buffer.from(good);
      bad[4] = v;
      expect(() => decodeSidecar(bad)).toThrow(/unsupported version/);
    }
  });
});

// -------------------------------------------------------------------------
// validation in decode
// -------------------------------------------------------------------------

describe('decode validation', () => {
  it("throws when the first 4 bytes are not 'CMEM'", () => {
    const good = encodeSidecar({
      modelId: 'm',
      dim: 1,
      contentSha: hexSha(13),
      descriptionVector: [0.0],
      bodyVector: [0.0],
    });
    const bad = Buffer.from(good);
    bad.write('XXXX', 0, 4, 'ascii');
    expect(() => decodeSidecar(bad)).toThrow();
  });

  it('throws when the trailing vector bytes after the header are not exactly 2*dim*4 bytes', () => {
    const good = encodeSidecar({
      modelId: 'm',
      dim: 4,
      contentSha: hexSha(15),
      descriptionVector: [1.0, 2.0, 3.0, 4.0],
      bodyVector: [5.0, 6.0, 7.0, 8.0],
    });
    // Drop one byte from the tail (payload now short by 1 byte).
    const short = good.subarray(0, good.length - 1);
    expect(() => decodeSidecar(short)).toThrow();

    // Append one extra byte to the tail (payload now too long by 1 byte).
    const long = Buffer.concat([good, Buffer.from([0x00])]);
    expect(() => decodeSidecar(long)).toThrow();

    // Exactly one channel's worth of floats (a v2 header with a v1-sized
    // payload) must also be rejected -- no silent partial decode.
    const utf8 = Buffer.from('m', 'utf8');
    const headerEnd = 4 + 1 + 1 + utf8.length + 4 + 32;
    const oneChannel = good.subarray(0, headerEnd + 4 * 4);
    expect(() => decodeSidecar(oneChannel)).toThrow();
  });

  it('throws when given a buffer truncated mid-header (shorter than magic+version+model_len+model_id+dim+content_sha)', () => {
    const modelId = 'Xenova/bge-base-en-v1.5';
    const good = encodeSidecar({
      modelId,
      dim: 4,
      contentSha: hexSha(31),
      descriptionVector: [1.0, 2.0, 3.0, 4.0],
      bodyVector: [5.0, 6.0, 7.0, 8.0],
    });
    const utf8 = Buffer.from(modelId, 'utf8');
    const headerEnd = 4 + 1 + 1 + utf8.length + 4 + 32;

    // Empty buffer
    expect(() => decodeSidecar(Buffer.alloc(0))).toThrow();
    // 3 bytes
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
});

// -------------------------------------------------------------------------
// ac-4 (DAR-1210): round-trip property
// -------------------------------------------------------------------------

describe('ac-4: round-trip', () => {
  it('round-trips both the description vector and the body vector under the bumped format version (decode(encode(x)) deep-equals x for both channels)', () => {
    const cases: Array<{
      modelId: string;
      dim: number;
      contentSha: string;
      descriptionVector: number[];
      bodyVector: number[];
    }> = [
      {
        modelId: 'a',
        dim: 1,
        contentSha: hexSha(20),
        descriptionVector: [0.5],
        bodyVector: [0.0],
      },
      {
        modelId: 'm',
        dim: 3,
        contentSha: hexSha(21),
        descriptionVector: [0.5, -0.5, 0.25],
        bodyVector: [0.0, -1.0, 1.0],
      },
      {
        modelId: 'Xenova/bge-base-en-v1.5',
        dim: 8,
        contentSha: hexSha(22),
        descriptionVector: makeVector(8, (i) => (i - 2) * 0.125),
        bodyVector: makeVector(8, (i) => (i - 4) * 0.0625),
      },
      {
        modelId: 'x'.repeat(255), // model_len boundary (1-byte field max)
        dim: 2,
        contentSha: hexSha(23),
        descriptionVector: [0.25, -0.25],
        bodyVector: [0.5, -0.5],
      },
    ];
    for (const input of cases) {
      const buf = encodeSidecar(input);
      const out = decodeSidecar(buf);
      expect(out.modelId).toBe(input.modelId);
      expect(out.dim).toBe(input.dim);
      expect(out.contentSha).toBe(input.contentSha);
      expect(Array.from(out.descriptionVector)).toEqual(input.descriptionVector);
      expect(Array.from(out.bodyVector)).toEqual(input.bodyVector);
    }
  });

  it('round-trip preserves non-ASCII utf-8 in modelId (e.g. multi-byte characters) without corruption', () => {
    const modelId = 'モデル/日本語-эмбеддинг-🚀';
    const input = {
      modelId,
      dim: 2,
      contentSha: hexSha(24),
      descriptionVector: [0.5, -0.5],
      bodyVector: [1.0, -1.0],
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

  it('round-trip preserves float32 vector values exactly in both channels (no precision loss beyond float32 representation)', () => {
    // Pick values that are exactly representable in float32: powers of two,
    // simple binary fractions, and zero. Float32 stores these exactly.
    const exact = [0.0, 1.0, -1.0, 0.5, -0.25, 0.125, 1024.0, -1024.0];
    const reversed = exact.slice().reverse();
    const input = {
      modelId: 'm',
      dim: exact.length,
      contentSha: hexSha(25),
      descriptionVector: reversed,
      bodyVector: exact,
    };
    const buf = encodeSidecar(input);
    const out = decodeSidecar(buf);
    for (let i = 0; i < exact.length; i++) {
      expect(out.descriptionVector[i]).toBe(reversed[i]);
      expect(out.bodyVector[i]).toBe(exact[i]);
    }
  });
});
