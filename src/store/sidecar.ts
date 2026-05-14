/**
 * Binary `.embedding` sidecar format.
 *
 * Each memory `.md` file pairs with a binary sidecar carrying the embedding
 * vector and just enough header metadata for the consumer to detect
 * staleness automatically:
 *
 * - **content edits** — `content_sha` no longer matches the source `.md`.
 * - **model swaps**   — `model_id` no longer matches the configured model.
 * - **dim mismatch**  — `dim` no longer matches the configured model's dim.
 *
 * # Wire format (little-endian)
 *
 * ```
 * offset  size                 field
 * 0       4                    magic        "CMEM" (ASCII)
 * 4       1                    version      0x01
 * 5       1                    model_len    utf-8 byte length of model_id
 * 6       model_len            model_id     utf-8 bytes
 * 6+L     4                    dim          uint32 LE
 * 10+L    32                   content_sha  raw sha256 (decoded from hex)
 * 42+L    dim*4                vector       float32 LE values in order
 * ```
 *
 * Total size = 4 + 1 + 1 + model_len + 4 + 32 + dim*4
 *            = 42 + model_len + dim*4 bytes.
 *
 * For bge-base (model_id "Xenova/bge-base-en-v1.5", dim 768), this is ~3 KB.
 *
 * # Scope
 *
 * This module owns ONLY the wire format: pure `Buffer`-in / `Buffer`-out
 * encode and decode. Filesystem I/O (atomic writes, locks, directory scan)
 * lives in `./memory-store.ts`. Computing `content_sha` from markdown
 * content lives in `./memory.ts`. This module accepts `contentSha` as an
 * opaque 64-char lowercase hex string.
 *
 * The format is little-endian only by design (issue spec). All currently
 * supported targets (x86_64, arm64) are LE.
 */

/**
 * The 4-byte ASCII magic at the start of every sidecar: `"CMEM"`.
 *
 * Exported for diagnostics and tests. Decoders MUST reject buffers whose
 * first 4 bytes do not match these exact bytes.
 */
export const MAGIC = Buffer.from('CMEM', 'ascii');

/**
 * Current sidecar format version. Encoders always write this byte; decoders
 * MUST reject any other value. There is no backward-compat path -- forward
 * compatibility is a problem for whichever future issue introduces v2.
 */
export const VERSION = 0x01;

/** Number of raw bytes a sha256 digest occupies (32 bytes = 256 bits). */
const CONTENT_SHA_BYTES = 32;
/** Bytes used to encode `dim` as a uint32 little-endian. */
const DIM_BYTES = 4;
/** Bytes used to encode each vector element as a float32 little-endian. */
const FLOAT32_BYTES = 4;
/** Maximum utf-8 byte length of `model_id` (1-byte `model_len` field). */
const MAX_MODEL_LEN = 0xff;

/** Validates a 64-char lowercase hex string (the canonical `contentSha` form). */
const HEX_64_LC = /^[0-9a-f]{64}$/;

/** Inputs to {@link encodeSidecar}. All fields are required. */
export interface SidecarInput {
  /** Embedding model identifier (utf-8). Must be 0..255 utf-8 bytes long. */
  modelId: string;
  /** Vector dimensionality. Must equal `vector.length`. */
  dim: number;
  /** sha256 of the source markdown's canonical content, as 64-char lowercase hex. */
  contentSha: string;
  /** Embedding vector. Length must equal `dim`. */
  vector: ArrayLike<number>;
}

/** Result of {@link decodeSidecar}. */
export interface DecodedSidecar {
  modelId: string;
  dim: number;
  /** 64-character lowercase hex sha256 (re-encoded from the raw 32 bytes on disk). */
  contentSha: string;
  /** Decoded float32 values; length === `dim`. */
  vector: Float32Array;
}

/**
 * Encode a sidecar payload into the on-disk wire format.
 *
 * Throws when:
 *   - `vector.length !== dim`
 *   - `contentSha` is not a 64-character lowercase hex string
 *   - `modelId` exceeds 255 utf-8 bytes (`model_len` field is one byte)
 *
 * @returns a freshly allocated Buffer of length `42 + model_len + dim*4`.
 */
export const encodeSidecar = (input: SidecarInput): Buffer => {
  const { modelId, dim, contentSha, vector } = input;

  if (!Number.isInteger(dim) || dim < 0) {
    throw new Error(`encodeSidecar: dim must be a non-negative integer; got ${String(dim)}`);
  }

  if (vector.length !== dim) {
    throw new Error(`encodeSidecar: vector.length (${vector.length}) !== dim (${dim})`);
  }

  if (typeof contentSha !== 'string' || !HEX_64_LC.test(contentSha)) {
    throw new Error(
      `encodeSidecar: contentSha must be a 64-character lowercase hex string; got ${JSON.stringify(
        contentSha,
      )}`,
    );
  }

  const modelBytes = Buffer.from(modelId, 'utf8');
  if (modelBytes.length > MAX_MODEL_LEN) {
    throw new Error(
      `encodeSidecar: modelId utf-8 byte length (${modelBytes.length}) exceeds the ${MAX_MODEL_LEN}-byte limit imposed by the 1-byte model_len field`,
    );
  }

  const shaBytes = Buffer.from(contentSha, 'hex');
  // Defence in depth: the regex above already constrains length, but
  // Buffer.from('hex') silently truncates on odd bytes for some inputs.
  if (shaBytes.length !== CONTENT_SHA_BYTES) {
    throw new Error(
      `encodeSidecar: decoded content_sha is ${shaBytes.length} bytes; expected ${CONTENT_SHA_BYTES}`,
    );
  }

  const total =
    MAGIC.length + 1 + 1 + modelBytes.length + DIM_BYTES + CONTENT_SHA_BYTES + dim * FLOAT32_BYTES;
  const out = Buffer.alloc(total);

  let offset = 0;
  MAGIC.copy(out, offset);
  offset += MAGIC.length;

  out.writeUInt8(VERSION, offset);
  offset += 1;

  out.writeUInt8(modelBytes.length, offset);
  offset += 1;

  modelBytes.copy(out, offset);
  offset += modelBytes.length;

  out.writeUInt32LE(dim, offset);
  offset += DIM_BYTES;

  shaBytes.copy(out, offset);
  offset += CONTENT_SHA_BYTES;

  for (let i = 0; i < dim; i++) {
    out.writeFloatLE(Number(vector[i]), offset);
    offset += FLOAT32_BYTES;
  }

  return out;
};

/**
 * Decode a sidecar buffer.
 *
 * Throws when:
 *   - the buffer is shorter than the minimum header (magic + version +
 *     model_len + zero-length model_id + dim + content_sha)
 *   - the magic is not `"CMEM"`
 *   - the version byte is not `0x01`
 *   - the buffer is too short to contain `model_id`, `dim`, `content_sha`
 *   - the trailing vector bytes are not exactly `dim * 4` long
 */
export const decodeSidecar = (buf: Buffer): DecodedSidecar => {
  // Minimum bytes required just to read magic + version + model_len.
  const FIXED_PREFIX = MAGIC.length + 1 + 1; // 6
  if (buf.length < FIXED_PREFIX) {
    throw new Error(
      `decodeSidecar: buffer too short for header prefix (${buf.length} < ${FIXED_PREFIX})`,
    );
  }

  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(
      `decodeSidecar: bad magic; expected 'CMEM' (${MAGIC.toString('hex')}), got ${buf
        .subarray(0, MAGIC.length)
        .toString('hex')}`,
    );
  }

  const version = buf.readUInt8(MAGIC.length);
  if (version !== VERSION) {
    throw new Error(
      `decodeSidecar: unsupported version 0x${version.toString(16).padStart(2, '0')}; this module only decodes 0x01`,
    );
  }

  const modelLen = buf.readUInt8(MAGIC.length + 1);
  const modelStart = FIXED_PREFIX;
  const modelEnd = modelStart + modelLen;
  const dimStart = modelEnd;
  const dimEnd = dimStart + DIM_BYTES;
  const shaStart = dimEnd;
  const shaEnd = shaStart + CONTENT_SHA_BYTES;

  if (buf.length < shaEnd) {
    throw new Error(
      `decodeSidecar: buffer truncated mid-header (${buf.length} bytes; need at least ${shaEnd} for header with model_len=${modelLen})`,
    );
  }

  const modelId = buf.subarray(modelStart, modelEnd).toString('utf8');
  const dim = buf.readUInt32LE(dimStart);
  const contentSha = buf.subarray(shaStart, shaEnd).toString('hex');

  const vectorBytes = buf.length - shaEnd;
  const expectedVectorBytes = dim * FLOAT32_BYTES;
  if (vectorBytes !== expectedVectorBytes) {
    throw new Error(
      `decodeSidecar: vector payload is ${vectorBytes} bytes; expected ${expectedVectorBytes} (dim=${dim} * ${FLOAT32_BYTES})`,
    );
  }

  const vector = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    vector[i] = buf.readFloatLE(shaEnd + i * FLOAT32_BYTES);
  }

  // Defence in depth: the regex check on encode guarantees lowercase hex,
  // but contentSha is round-tripped through raw bytes here, and `toString('hex')`
  // on Node returns lowercase. We assert that invariant explicitly so any
  // future Buffer change surfaces loudly.
  if (!HEX_64_LC.test(contentSha)) {
    throw new Error(
      `decodeSidecar: internal error -- decoded contentSha is not lowercase 64-char hex: ${contentSha}`,
    );
  }

  return { modelId, dim, contentSha, vector };
};
