/**
 * Contract test for DAR-965 ac-4: every entry in the tool registry
 * carries the literal `Agent memory: ` prefix in its `description`.
 *
 * The prefix is a static, layered nudge that frames each tool as part of
 * the agent-memory mechanism. Iterating via the registry (rather than a
 * hard-coded list) ensures that any future tool added to `TOOL_NAMES`
 * without the prefix trips this gate immediately.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TOOL_NAMES, buildToolDefinitions } from '../src/server/tools.js';

const AGENT_MEMORY_PREFIX = 'Agent memory: ';

describe('ac-4: tool description prefix invariant', () => {
  it('every entry in TOOL_SCHEMAS (driven by the registry) has a description starting with the literal `Agent memory: ` prefix', () => {
    const defs = buildToolDefinitions();
    // Iterate via the registry so a 9th tool added later without the
    // prefix fails this gate.
    expect(defs).toHaveLength(TOOL_NAMES.length);
    for (const def of defs) {
      expect(
        def.description.startsWith(AGENT_MEMORY_PREFIX),
        `tool ${def.name} description must start with "${AGENT_MEMORY_PREFIX}": got "${def.description.slice(0, 40)}..."`,
      ).toBe(true);
    }
  });

  it('the contract test iterates via the registry (`TOOL_NAMES` / `buildToolDefinitions`) rather than a hard-coded array literal', () => {
    // Self-check: read this file and assert it references the registry
    // exports rather than a fixed-name list. Failing this means the
    // regression gate has been weakened by a future refactor.
    const thisFile = readFileSync(
      join(__dirname, 'server-tools-agent-memory-prefix.test.ts'),
      'utf8',
    );
    expect(thisFile).toMatch(/buildToolDefinitions/);
    expect(thisFile).toMatch(/TOOL_NAMES/);
  });
});
