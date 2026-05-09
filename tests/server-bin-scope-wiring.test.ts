/**
 * DAR-924 ac-5 source-level wiring assertions for the dual-store boot.
 *
 * The dual-store wiring is verified end-to-end by the in-memory transport
 * tests in `server-roots-detection.integration.test.ts` and the spawned-bin
 * tests in `server-bin-scope.integration.test.ts`. These structural source
 * checks are fast and catch obvious regressions (e.g. someone re-introduces
 * a `process.env.COMMONPLACE_MEMORY_DIR` read in the bin, or removes the
 * deprecation warning).
 *
 * The bin entry (`src/bin/commonplace-mcp.ts`) is a thin shell over
 * `bootServer` from `src/bin/boot.ts`; we assert on both files since the
 * wiring contract (env reads, store construction, handler binding) lives
 * in the boot module and the bin only carries the entry-point glue.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');
const binSource = readFileSync(join(repoRoot, 'src/bin/commonplace-mcp.ts'), 'utf8');
const bootSource = readFileSync(join(repoRoot, 'src/bin/boot.ts'), 'utf8');

describe('DAR-924 ac-5: bin / boot module wires user and project stores correctly', () => {
  it('the bin imports bootServer from ./boot.js so detection + store construction lives in a unit-testable module', () => {
    expect(binSource).toMatch(/from\s+['"]\.\/boot\.js['"]/);
    expect(binSource).toMatch(/\bbootServer\b/);
  });

  it('the boot module imports detectScope from ./scope.js', () => {
    expect(bootSource).toMatch(/from\s+['"]\.\/scope\.js['"]/);
    expect(bootSource).toMatch(/\bdetectScope\b/);
  });

  it('the boot module reads the user dir from the resolved scope (defaulting to ~/.commonplace/memory) and constructs exactly one user MemoryStore against it', () => {
    expect(bootSource).toMatch(/userDir/);
    // First MemoryStore construction must use the resolved user dir.
    expect(bootSource).toMatch(/new\s+MemoryStore\s*\(\s*\{[^}]*userDir/s);
  });

  it('when project scope is detected, the boot module constructs a second MemoryStore for the project dir', () => {
    expect(bootSource).toMatch(/projectDir/);
    // A MemoryStore construction referencing projectDir or finalScope.projectDir.
    expect(bootSource).toMatch(
      /new\s+MemoryStore\s*\(\s*\{[^}]*(projectDir|finalScope\.projectDir)/s,
    );
  });

  it('when project scope is NOT detected, the boot module constructs only the user store (the project-store construction is gated on a non-null projectDir)', () => {
    // Look for a conditional referencing projectDir nullability.
    expect(bootSource).toMatch(
      /projectDir\s*!==?\s*null|if\s*\(\s*finalScope\.projectDir|projectDir\s*\?\s*new/,
    );
  });

  it('when COMMONPLACE_MEMORY_DIR is set, the boot module logs a deprecation warning to stderr and the scope module flags the alias', () => {
    expect(bootSource).toMatch(/usedDeprecatedMemoryDir/);
    expect(bootSource).toMatch(/process\.stderr\.write|console\.error/);
    // The bin file (or boot file) must mention the deprecated env var by
    // name in a comment / message so users who grep see what to migrate.
    expect(bootSource + binSource).toMatch(/COMMONPLACE_MEMORY_DIR/);
  });

  it('the handler factory is invoked with { userStore, projectStore? } when project scope is detected', () => {
    expect(bootSource).toMatch(/createDefaultHandlers\s*\(\s*\{[^}]*userStore[^}]*\}/s);
    expect(bootSource).toMatch(/createDefaultHandlers\s*\(\s*\{[^}]*projectStore[^}]*\}/s);
  });

  it('no code path in the bin or boot module still constructs a single store keyed on COMMONPLACE_MEMORY_DIR (the DAR-919 single-store wiring is removed)', () => {
    // The deprecated env var name must not appear inline as an env read.
    expect(binSource).not.toMatch(/process\.env\.COMMONPLACE_MEMORY_DIR/);
    expect(bootSource).not.toMatch(/process\.env\.COMMONPLACE_MEMORY_DIR/);
    expect(binSource).not.toMatch(/env\[\s*['"]COMMONPLACE_MEMORY_DIR['"]/);
    expect(bootSource).not.toMatch(/env\[\s*['"]COMMONPLACE_MEMORY_DIR['"]/);
  });

  it('the boot module issues a roots/list request after server.connect (ac-1 wiring contract)', () => {
    expect(bootSource).toMatch(/server\.connect\s*\(/);
    expect(bootSource).toMatch(/server\.listRoots\s*\(/);
    // The behavioural ordering ("listRoots happens AFTER connect") is
    // verified by the integration test
    // `tests/server-roots-detection.integration.test.ts`. Asserting that
    // ordering structurally on the source text is fragile because
    // helpers (e.g. `requestRoots`) can be defined above the call site
    // even though the call resolves after connect at runtime. We
    // therefore only assert the presence of both call sites here.
  });
});
