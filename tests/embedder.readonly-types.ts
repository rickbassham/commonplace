/**
 * Type-level guard that `Embedder.modelId` and `Embedder.dim` are
 * declared `readonly`. This file is not a runtime test -- it participates
 * in `tsc --noEmit` (and therefore `make typecheck`). The
 * `// @ts-expect-error` markers below FAIL the build if either property
 * becomes assignable, which is the readonly contract required.
 *
 * The test runner does not execute this file; it is only here so the
 * compiler sees the intentionally-erroneous assignments.
 */

import { Embedder } from '../src/embedder/index.js';

const e = new Embedder('Xenova/bge-base-en-v1.5');

// The assignments below MUST fail typecheck. `@ts-expect-error` flips that
// expectation: if the assignment compiles, ts will report the unused
// directive as an error. Either direction breaks the build correctly.

// @ts-expect-error -- modelId is readonly
e.modelId = 'something/else';

// @ts-expect-error -- dim is readonly
e.dim = 42;

// Ensure `e` is considered used so the compiler does not emit an unused
// binding warning under strict configurations.
void e;
