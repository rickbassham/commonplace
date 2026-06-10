# Sidecar binary format (`.embedding`)

This document specifies the on-disk wire format for the binary `.embedding`
sidecars that pair with each memory `.md` file. The encode and decode
implementations live in [`src/store/sidecar.ts`](../src/store/sidecar.ts).

## Why a sidecar?

The markdown file is the source of truth. Embeddings are derived data — they
can be deleted and rebuilt at any time. Each sidecar carries enough metadata
that the consumer can detect three kinds of staleness automatically:

| What changed                                        | How it's detected      |
| --------------------------------------------------- | ---------------------- |
| The source `.md` content was edited                 | `content_sha` mismatch |
| The configured embedding model was swapped          | `model_id` mismatch    |
| The configured model now produces a different `dim` | `dim` mismatch         |

The sidecar is **not** the source of truth. The consumer is free to delete and
re-embed at any time.

## Wire format

All multi-byte integers and floats are **little-endian**. `model_id` is utf-8.

```
offset           size         field         value
---------------  -----------  ------------  ----------------------------------------
0                4            magic         ASCII "CMEM"  (0x43 0x4D 0x45 0x4D)
4                1            version       0x02
5                1            model_len     utf-8 byte length of model_id (0..255)
6                model_len    model_id      utf-8 bytes (e.g. "Xenova/bge-base-en-v1.5")
6 + L            4            dim           uint32 LE (e.g. 768 for bge-base)
10 + L           32           content_sha   raw sha256 (decoded from the 64-char hex)
42 + L           dim * 4      desc_vector   float32 LE values, in order
42 + L + dim*4   dim * 4      body_vector   float32 LE values, in order
```

Where `L = model_len` (the value of the byte at offset 5).

**Total size** = `4 + 1 + 1 + L + 4 + 32 + 2*dim*4` = `42 + L + 2*dim*4`
bytes. For bge-base (`L = 23`, `dim = 768`), this is `42 + 23 + 6144 = 6209`
bytes (~6 KB).

## Version history

- **0x02** (DAR-1210) — two-channel format. Carries the description-channel
  embedding (`desc_vector`) followed by the body-channel embedding
  (`body_vector`). `memory_search` fuses the two channels at query time
  (`max` of the per-channel cosines), fixing the recall failure mode where a
  memory whose body is a dense fact sheet is unfindable by queries that
  nearly restate its human-written `description`.
- **0x01** (legacy) — single-vector format (body channel only). Decoders
  reject this version; because sidecars are derived data, consumers treat a
  v0x01 sidecar as stale and transparently re-embed it in the current format
  on the next scan. There is no migration tooling and no backward-compat
  decode path by design.

### Field details

- **magic** (4 bytes, offset 0). The four ASCII bytes `CMEM`. A decoder MUST
  reject any buffer whose first four bytes are not exactly these. Acts as a
  cheap file-type check.

- **version** (1 byte, offset 4). The format version number. Always `0x02` for
  this revision. A decoder MUST reject any other value (including the legacy
  `0x01` and any value `> 0x02`). There is no backward-compat reader for other
  versions — older sidecars are re-embedded; a future v3 will own its own
  migration story.

- **model_len** (1 byte, offset 5). The utf-8 byte length of `model_id`. The
  one-byte field caps `model_id` at 255 utf-8 bytes; the encoder MUST throw
  if a longer `model_id` is supplied.

- **model_id** (`model_len` bytes, offset 6). The embedding model identifier
  encoded as utf-8 (e.g. `Xenova/bge-base-en-v1.5`). The format is
  intentionally model-agnostic — the bytes are opaque utf-8. Validating that
  the model is known/installed is the consumer's job.

- **dim** (4 bytes, offset `6 + model_len`). The vector dimensionality, as a
  uint32 little-endian. For bge-base this is `768`. Both channels share the
  same `dim` (they are produced by the same model). The encoder MUST throw if
  either vector's length differs from `dim`.

- **content_sha** (32 bytes, offset `10 + model_len`). The raw sha256 digest
  of the canonical source `.md` content (as defined in `src/store/memory.ts`,
  spanning `type`, `name`, `description`, and `body`). The encode API accepts
  the digest as a 64-character lowercase hex string and writes the decoded 32
  raw bytes; the decode API re-encodes those bytes back to 64-character
  lowercase hex.

- **desc_vector** (`dim * 4` bytes, offset `42 + model_len`). The
  description-channel embedding (the frontmatter `description:` text embedded
  on its own) as `dim` consecutive float32 little-endian values, in vector
  index order.

- **body_vector** (`dim * 4` bytes, offset `42 + model_len + dim*4`). The
  body-channel embedding (the markdown body embedded on its own), same
  layout as `desc_vector`. A decoder MUST reject buffers whose trailing
  vector payload is not exactly `2 * dim * 4` bytes (no shorter, no longer —
  including the v1-sized single-channel payload).

## API summary

```ts
import { encodeSidecar, decodeSidecar } from '../src/store/sidecar.js';

const buf = encodeSidecar({
  modelId: 'Xenova/bge-base-en-v1.5',
  dim: 768,
  contentSha: '<64-char lowercase hex sha256>',
  descriptionVector: descFloat32Array, // length 768
  bodyVector: bodyFloat32Array, // length 768
});

const { modelId, dim, contentSha, descriptionVector, bodyVector } = decodeSidecar(buf);
// Both vectors are Float32Arrays of length `dim`.
```

### Validation contract

`encodeSidecar` throws on:

- `descriptionVector.length !== dim` or `bodyVector.length !== dim`
- `contentSha` not matching `/^[0-9a-f]{64}$/`
- `modelId` utf-8 byte length `> 255`

`decodeSidecar` throws on:

- buffer shorter than the minimum header (magic + version + model_len + zero-
  length model_id + dim + content_sha = 42 bytes)
- magic not equal to ASCII `CMEM`
- version byte not equal to `0x02` (the legacy `0x01` single-vector form
  raises the documented "unsupported version" error — no partial decode)
- buffer truncated before the end of the declared `model_id`, `dim`, or
  `content_sha`
- trailing vector payload not exactly `2 * dim * 4` bytes (truncated or
  trailing garbage)

### Round-trip guarantee

For any well-formed input `x`, `decodeSidecar(encodeSidecar(x))` deep-equals
`x` on `modelId`, `dim`, `contentSha`, and per-element values of both
`descriptionVector` and `bodyVector`. Float32 representation is exact for
values that fit in float32 (powers of two, simple binary fractions, etc.);
other values are rounded to the nearest float32 once during encode and
preserved exactly thereafter.

## Out of scope

This document and the implementing module own only the wire format.

- Filesystem I/O for sidecars (read/write, atomic rename, advisory locking) is
  owned by `src/store/memory-store.ts`.
- Computing `content_sha` from markdown content is owned by
  `src/store/memory.ts`.
- The embedding model itself is owned by `src/embedder/`.
- Staleness-detection logic that consumes the decoded header is owned by
  `MemoryStore`.
- Endianness portability beyond little-endian is explicitly not supported.
- Compression or checksumming of the vector payload is not in scope.
