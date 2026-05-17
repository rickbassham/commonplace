/**
 * Extract the first substantive user-typed message from each Claude Code
 * session transcript. Each such message is the "task description" for that
 * session -- a real, in-the-wild task statement that wasn't written with
 * any specific memory in mind. These task descriptions are the seed for
 * the realistic synthetic benchmark (DAR-1034 v2): no information leak
 * from memory bodies, real distribution of dev intent.
 *
 * One task per transcript. Skips:
 *  - non-user messages
 *  - tool_result-only messages (no operator text)
 *  - very short messages (<= 40 chars, likely "yes" / "ok" / "continue")
 *  - command-meta artefacts (`<command-name>` / `<command-message>` wrappers)
 *
 * Output: JSON array `[{ sessionId, transcript, task }, ...]` printed to
 * stdout (or written to the path passed as argv[2]).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { defaultTranscriptsRoot } from './mine-transcripts.js';
import { readdirSync, statSync } from 'node:fs';

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const MIN_TASK_LENGTH = 40;
const MAX_TASK_LENGTH = 2000;

interface TaskRecord {
  sessionId: string;
  transcript: string;
  task: string;
}

const collectTranscripts = (root: string): string[] => {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (dir: string): void => {
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      return;
    }
    if (!isDir || visited.has(dir)) return;
    visited.add(dir);
    let entries: ReturnType<typeof readdirSync> = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(p);
      else if (ent.isDirectory()) walk(p);
    }
  };
  walk(root);
  out.sort();
  return out;
};

const extractFirstUserText = (path: string): string | null => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    if (parsed.type !== 'user') continue;
    const message = parsed.message;
    if (!isObject(message)) continue;
    const content = message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (!isObject(item)) continue;
        if (item.type !== 'text') continue;
        if (typeof item.text === 'string') text += item.text + '\n';
      }
    }
    text = text.trim();
    // Skip command-meta wrappers (slash-command echoes).
    if (text.startsWith('<command-name>') || text.startsWith('<local-command-')) continue;
    // Skip caveats / system-reminders that appear as user-type messages.
    if (text.startsWith('<system-reminder>')) continue;
    if (text.length < MIN_TASK_LENGTH) continue;
    if (text.length > MAX_TASK_LENGTH) text = text.slice(0, MAX_TASK_LENGTH);
    return text;
  }
  return null;
};

const main = async (): Promise<void> => {
  const root = process.argv[2] ?? defaultTranscriptsRoot();
  const outPath = process.argv[3];

  const transcripts = collectTranscripts(root);
  const tasks: TaskRecord[] = [];
  const seenTasks = new Set<string>();

  for (const path of transcripts) {
    const task = extractFirstUserText(path);
    if (task === null) continue;
    // Dedupe -- many sessions resume the same task across restarts.
    const key = task.slice(0, 200);
    if (seenTasks.has(key)) continue;
    seenTasks.add(key);

    const sessionId = path.split('/').pop()?.replace(/\.jsonl$/, '') ?? '';
    tasks.push({ sessionId, transcript: path, task });
  }

  const json = JSON.stringify(tasks, null, 2);
  if (outPath !== undefined) {
    writeFileSync(outPath, json + '\n', 'utf8');
    process.stderr.write(`mine-user-tasks: wrote ${tasks.length} tasks to ${outPath}\n`);
  } else {
    process.stdout.write(json + '\n');
    process.stderr.write(`mine-user-tasks: ${tasks.length} tasks\n`);
  }
};

const isCliEntry = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
};

if (isCliEntry()) {
  main().catch((err) => {
    process.stderr.write(
      `mine-user-tasks: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}

export { collectTranscripts, extractFirstUserText, MIN_TASK_LENGTH };
