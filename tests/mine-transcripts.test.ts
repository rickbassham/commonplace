/**
 * Tests for the transcript-mining module under `scripts/mine-transcripts.ts`.
 *
 * The module extracts `memory_search` tool-call records (and optionally the
 * adjacent tool_result + agent follow-up) from Claude Code transcript JSONL
 * files at `~/.claude/projects/<slug>/*.jsonl`. The reusable mining API
 * powers both the DAR-1034 retrieval benchmark (this issue) and the
 * DAR-1026 dreaming/consolidation spike, so it must be importable from
 * another script -- not only callable as a CLI side-effect.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  mineTranscripts,
  defaultTranscriptsRoot,
  type MinedSearchCall,
} from '../scripts/mine-transcripts.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dar1034-mine-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write a fixture transcript JSONL containing the given line objects. */
const writeTranscript = (relPath: string, lines: unknown[]): string => {
  const full = join(tmp, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return full;
};

describe('defaultTranscriptsRoot', () => {
  it('defaults to ~/.claude/projects (relative to the current user home)', () => {
    const root = defaultTranscriptsRoot();
    expect(root).toMatch(/\.claude\/projects$/);
  });
});

describe('mineTranscripts (ac-1)', () => {
  it('emits one record per memory_search tool_use, capturing query and returned names', async () => {
    const useUuid = 'use-1';
    const useId = 'toolu_test_1';
    writeTranscript('proj-a/session-1.jsonl', [
      {
        // Unrelated user message -- should be ignored.
        type: 'user',
        uuid: 'u0',
        message: { role: 'user', content: 'hello' },
      },
      {
        // The memory_search tool_use.
        type: 'assistant',
        uuid: useUuid,
        timestamp: '2026-05-17T10:00:00.000Z',
        sessionId: 'session-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: useId,
              name: 'mcp__commonplace__memory_search',
              input: { query: 'fsync apfs perf', scope: 'project' },
            },
          ],
        },
      },
      {
        // The paired tool_result -- structured-content shape.
        type: 'user',
        uuid: 'r1',
        parentUuid: useUuid,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: useId,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    matches: [
                      { name: 'macos_apfs_fsync_test_perf', score: 0.6 },
                      { name: 'commonplace_app_structure', score: 0.3 },
                    ],
                  }),
                },
              ],
            },
          ],
        },
      },
    ]);

    const calls = await mineTranscripts({ root: tmp });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.query).toBe('fsync apfs perf');
    expect(call.scope).toBe('project');
    expect(call.returnedNames).toEqual(['macos_apfs_fsync_test_perf', 'commonplace_app_structure']);
    expect(call.toolUseId).toBe(useId);
    expect(call.sessionId).toBe('session-1');
  });

  it('ignores non-memory_search tool_use entries and unrelated lines', async () => {
    writeTranscript('proj-b/session.jsonl', [
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_other', name: 'Read', input: { path: '/tmp/x' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'just a chat' },
      },
    ]);

    const calls = await mineTranscripts({ root: tmp });
    expect(calls).toHaveLength(0);
  });

  it('does not crash on malformed JSON lines, logs a warning, and continues', async () => {
    const useId = 'toolu_recover';
    const path = join(tmp, 'proj-c', 'session.jsonl');
    mkdirSync(join(path, '..'), { recursive: true });
    const goodLine = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      sessionId: 's1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: useId,
            name: 'mcp__commonplace__memory_search',
            input: { query: 'recover ok', scope: 'user' },
          },
        ],
      },
    });
    writeFileSync(path, ['{ not json', goodLine, '{"also":incomplete'].join('\n') + '\n');

    const warnings: string[] = [];
    const calls = await mineTranscripts({
      root: tmp,
      onWarn: (msg) => warnings.push(msg),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toBe('recover ok');
    // At least one malformed-line warning was emitted (we don't assert on
    // the exact wording, only that the channel was used).
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('captures returned names when tool_result content is a JSON string instead of structured array', async () => {
    // Older transcript shape: `content` is a plain string (the legacy
    // `tool_result` rendering). The miner should still parse it.
    const useId = 'toolu_legacy';
    writeTranscript('proj-d/session.jsonl', [
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: useId,
              name: 'mcp__commonplace__memory_search',
              input: { query: 'legacy string content' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'r1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: useId,
              content: JSON.stringify({
                matches: [{ name: 'one' }, { name: 'two' }],
              }),
            },
          ],
        },
      },
    ]);

    const calls: MinedSearchCall[] = await mineTranscripts({ root: tmp });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.returnedNames).toEqual(['one', 'two']);
  });

  it('returns deterministic ordering across multiple transcripts (sorted by session+timestamp+toolUseId)', async () => {
    writeTranscript('proj-e/b.jsonl', [
      {
        type: 'assistant',
        uuid: 'a',
        timestamp: '2026-05-17T10:00:00Z',
        sessionId: 'b-session',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_b1',
              name: 'mcp__commonplace__memory_search',
              input: { query: 'q-b1' },
            },
          ],
        },
      },
    ]);
    writeTranscript('proj-e/a.jsonl', [
      {
        type: 'assistant',
        uuid: 'a',
        timestamp: '2026-05-17T11:00:00Z',
        sessionId: 'a-session',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_a1',
              name: 'mcp__commonplace__memory_search',
              input: { query: 'q-a1' },
            },
          ],
        },
      },
    ]);

    const calls1 = await mineTranscripts({ root: tmp });
    const calls2 = await mineTranscripts({ root: tmp });
    expect(calls1.map((c) => c.query)).toEqual(calls2.map((c) => c.query));
    // a-session sorts before b-session lexically.
    expect(calls1.map((c) => c.sessionId)).toEqual(['a-session', 'b-session']);
  });

  it('exposes mineTranscripts as an importable module function (not only a CLI side-effect)', () => {
    expect(typeof mineTranscripts).toBe('function');
    expect(typeof defaultTranscriptsRoot).toBe('function');
  });
});

describe('mining script CLI (ac-1)', () => {
  it('the mine-transcripts.ts script exists at the documented path', () => {
    // The mining CLI is documented in docs/retrieval-benchmark.md as
    // `pnpm exec tsx scripts/mine-transcripts.ts [<root>]`. The script
    // file must exist for that invocation to work.
    expect(existsSync(join(__dirname, '..', 'scripts', 'mine-transcripts.ts'))).toBe(true);
  });
});
