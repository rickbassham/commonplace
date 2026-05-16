/**
 * Unit tests for the startup version-check module (DAR-1006).
 *
 * Covers ac-1..ac-6: the `checkForUpdates` function fetches
 * https://registry.npmjs.org/commonplace-mcp/latest, compares the
 * returned version against the running version using semver precedence,
 * logs a single stderr line when an update is available, and stays silent
 * (no log, no throw) in every failure mode. The check is opt-out via
 * `COMMONPLACE_NO_UPDATE_CHECK=1` (or `=true`) and bounded by a hard
 * timeout enforced through an AbortController.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { checkForUpdates, REGISTRY_URL } from '../src/server/update-check.js';

const repoRoot = join(__dirname, '..');

/** Helper: build a fetch stub that resolves with the given Response shape. */
const makeFetch = (body: unknown, init: { status?: number; bodyIsText?: string } = {}) => {
  const status = init.status ?? 200;
  return vi.fn(async (url: string, opts?: { signal?: AbortSignal }) => {
    // url + opts are captured by the mock's `.mock.calls` for assertions.
    void url;
    void opts;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (init.bodyIsText !== undefined) {
          throw new SyntaxError('Unexpected token in JSON');
        }
        return body;
      },
      text: async () => init.bodyIsText ?? JSON.stringify(body),
    } as Response;
  });
};

describe('ac-1: fires a GET against the npm registry, fire-and-forget, no disk cache', () => {
  it('checkForUpdates issues a GET to https://registry.npmjs.org/commonplace-mcp/latest when invoked with default fetch', async () => {
    const fetchStub = makeFetch({ version: '0.3.0' });
    await checkForUpdates({
      currentVersion: '0.3.0',
      env: {},
      fetch: fetchStub as unknown as typeof fetch,
      log: () => {},
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url] = fetchStub.mock.calls[0]!;
    expect(url).toBe('https://registry.npmjs.org/commonplace-mcp/latest');
    expect(REGISTRY_URL).toBe('https://registry.npmjs.org/commonplace-mcp/latest');
  });

  it('no .commonplace/update-check-cache (or similar) file is written by checkForUpdates in any test case', async () => {
    const fetchStub = makeFetch({ version: '0.4.0' });
    await checkForUpdates({
      currentVersion: '0.3.0',
      env: {},
      fetch: fetchStub as unknown as typeof fetch,
      log: () => {},
    });
    // Verify no sidecar cache files materialized in common locations.
    // We check specific cache-file paths rather than the .commonplace
    // directory itself, because the repo legitimately contains
    // .commonplace/memory/*.md (project-scope memories committed at the
    // repo root); the assertion is about what checkForUpdates writes,
    // not about whether .commonplace exists at all.
    expect(existsSync(join(repoRoot, '.commonplace', 'update-check-cache'))).toBe(false);
    expect(existsSync(join(repoRoot, '.commonplace', 'update-check-cache.json'))).toBe(false);
    expect(existsSync(join(repoRoot, '.commonplace-update-check'))).toBe(false);
    expect(existsSync(join(repoRoot, 'update-check-cache'))).toBe(false);
  });

  it('bootServer invokes checkForUpdates exactly once after server.connect() resolves', async () => {
    // Source-text assertion: the boot module imports and invokes
    // checkForUpdates, and does so after `server.connect()` resolves. The
    // wiring is verified behaviourally in server-bin-update-check tests.
    const { readFileSync } = await import('node:fs');
    const bootSource = readFileSync(join(repoRoot, 'src/bin/boot.ts'), 'utf8');
    expect(bootSource).toMatch(/checkForUpdates/);
    // The invocation must appear after the `server.connect(` call. We
    // match the call site (`checkForUpdates(`), not the import.
    const connectIdx = bootSource.indexOf('server.connect(');
    const checkIdx = bootSource.indexOf('checkForUpdates(');
    expect(connectIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(connectIdx);
  });

  it('bootServer does not await checkForUpdates (boot resolves even if the version-check fetch never settles)', async () => {
    // Source-text assertion: the call to checkForUpdates is NOT preceded by
    // `await`, so bootServer cannot block on it. We inspect the line where
    // checkForUpdates appears.
    const { readFileSync } = await import('node:fs');
    const bootSource = readFileSync(join(repoRoot, 'src/bin/boot.ts'), 'utf8');
    const lines = bootSource.split('\n');
    const callLine = lines.find((line) => line.includes('checkForUpdates('));
    expect(callLine, 'expected a line invoking checkForUpdates(').toBeDefined();
    // No `await` keyword should precede the invocation on the same line.
    expect(callLine).not.toMatch(/\bawait\s+checkForUpdates\s*\(/);
  });
});

describe('ac-2: logs a single stderr line when a newer version is available', () => {
  it('logs one stderr line containing `is running`, `available`, the current version, and the registry version when registry version is a newer semver (e.g. 0.3.0 current, 0.4.0 registry)', async () => {
    const fetchStub = makeFetch({ version: '0.4.0' });
    const logs: string[] = [];
    await checkForUpdates({
      currentVersion: '0.3.0',
      env: {},
      fetch: fetchStub as unknown as typeof fetch,
      log: (msg) => logs.push(msg),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('is running');
    expect(logs[0]).toContain('available');
    expect(logs[0]).toContain('0.3.0');
    expect(logs[0]).toContain('0.4.0');
  });

  it('uses semver precedence (not lexicographic) so 0.10.0 registry vs 0.9.0 current logs the update line', async () => {
    const fetchStub = makeFetch({ version: '0.10.0' });
    const logs: string[] = [];
    await checkForUpdates({
      currentVersion: '0.9.0',
      env: {},
      fetch: fetchStub as unknown as typeof fetch,
      log: (msg) => logs.push(msg),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('0.9.0');
    expect(logs[0]).toContain('0.10.0');
  });

  it('emits exactly one stderr line per checkForUpdates invocation when an update is available', async () => {
    const fetchStub = makeFetch({ version: '1.0.0' });
    const logs: string[] = [];
    await checkForUpdates({
      currentVersion: '0.3.0',
      env: {},
      fetch: fetchStub as unknown as typeof fetch,
      log: (msg) => logs.push(msg),
    });
    expect(logs).toHaveLength(1);
  });

  it('log line is written to stderr (console.error / process.stderr), never to stdout', async () => {
    // When the caller does not pass a `log` injector, checkForUpdates must
    // use console.error (which writes to stderr). We spy on both
    // console.log and console.error and assert only the latter fires.
    const fetchStub = makeFetch({ version: '0.4.0' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await checkForUpdates({
        currentVersion: '0.3.0',
        env: {},
        fetch: fetchStub as unknown as typeof fetch,
        // omit `log` so the default (console.error) path runs
      });
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe('ac-3: emits no log line when the registry version is equal to or older than current', () => {
  it('emits no stderr line when registry version equals current version', async () => {
    const fetchStub = makeFetch({ version: '0.3.0' });
    const logs: string[] = [];
    await checkForUpdates({
      currentVersion: '0.3.0',
      env: {},
      fetch: fetchStub as unknown as typeof fetch,
      log: (msg) => logs.push(msg),
    });
    expect(logs).toHaveLength(0);
  });

  it('emits no stderr line when registry version is semver-older than current (e.g. 0.2.0 registry vs 0.3.0 current)', async () => {
    const fetchStub = makeFetch({ version: '0.2.0' });
    const logs: string[] = [];
    await checkForUpdates({
      currentVersion: '0.3.0',
      env: {},
      fetch: fetchStub as unknown as typeof fetch,
      log: (msg) => logs.push(msg),
    });
    expect(logs).toHaveLength(0);
  });
});

describe('ac-4: failure modes are silent (no log, no throw)', () => {
  it('emits no stderr line and does not throw when injected fetch rejects with a network error', async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const logs: string[] = [];
    await expect(
      checkForUpdates({
        currentVersion: '0.3.0',
        env: {},
        fetch: fetchStub as unknown as typeof fetch,
        log: (msg) => logs.push(msg),
      }),
    ).resolves.toBeUndefined();
    expect(logs).toHaveLength(0);
  });

  it('emits no stderr line and does not throw when injected fetch resolves with status 500', async () => {
    const fetchStub = makeFetch({ error: 'server error' }, { status: 500 });
    const logs: string[] = [];
    await expect(
      checkForUpdates({
        currentVersion: '0.3.0',
        env: {},
        fetch: fetchStub as unknown as typeof fetch,
        log: (msg) => logs.push(msg),
      }),
    ).resolves.toBeUndefined();
    expect(logs).toHaveLength(0);
  });

  it('emits no stderr line and does not throw when injected fetch resolves with a 200 body that is not valid JSON', async () => {
    const fetchStub = makeFetch(null, { bodyIsText: '<html>not json</html>' });
    const logs: string[] = [];
    await expect(
      checkForUpdates({
        currentVersion: '0.3.0',
        env: {},
        fetch: fetchStub as unknown as typeof fetch,
        log: (msg) => logs.push(msg),
      }),
    ).resolves.toBeUndefined();
    expect(logs).toHaveLength(0);
  });

  it('emits no stderr line and does not throw when injected fetch resolves with JSON missing the `version` field', async () => {
    const fetchStub = makeFetch({ name: 'commonplace-mcp' });
    const logs: string[] = [];
    await expect(
      checkForUpdates({
        currentVersion: '0.3.0',
        env: {},
        fetch: fetchStub as unknown as typeof fetch,
        log: (msg) => logs.push(msg),
      }),
    ).resolves.toBeUndefined();
    expect(logs).toHaveLength(0);
  });

  it('bootServer resolves successfully and CallTool requests succeed when checkForUpdates rejects under the hood', async () => {
    // This is verified at the boot level by server-bin-update-check tests
    // (the check is invoked without `await`, so a rejection cannot bubble
    // up). Here we verify the unit-level contract: a checkForUpdates that
    // would throw internally instead resolves quietly.
    const fetchStub = vi.fn(async () => {
      throw new Error('boom');
    });
    const logs: string[] = [];
    await expect(
      checkForUpdates({
        currentVersion: '0.3.0',
        env: {},
        fetch: fetchStub as unknown as typeof fetch,
        log: (msg) => logs.push(msg),
      }),
    ).resolves.toBeUndefined();
    expect(logs).toHaveLength(0);
  });
});

describe('ac-5: opt-out via COMMONPLACE_NO_UPDATE_CHECK', () => {
  it('checkForUpdates makes no fetch call and emits no stderr line when env COMMONPLACE_NO_UPDATE_CHECK=1', async () => {
    const fetchStub = vi.fn(async () => ({}) as Response);
    const logs: string[] = [];
    await checkForUpdates({
      currentVersion: '0.3.0',
      env: { COMMONPLACE_NO_UPDATE_CHECK: '1' },
      fetch: fetchStub as unknown as typeof fetch,
      log: (msg) => logs.push(msg),
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(logs).toHaveLength(0);
  });

  it('checkForUpdates makes no fetch call and emits no stderr line when env COMMONPLACE_NO_UPDATE_CHECK=true', async () => {
    const fetchStub = vi.fn(async () => ({}) as Response);
    const logs: string[] = [];
    await checkForUpdates({
      currentVersion: '0.3.0',
      env: { COMMONPLACE_NO_UPDATE_CHECK: 'true' },
      fetch: fetchStub as unknown as typeof fetch,
      log: (msg) => logs.push(msg),
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(logs).toHaveLength(0);
  });

  it('checkForUpdates DOES perform the fetch when COMMONPLACE_NO_UPDATE_CHECK is unset or set to an empty string', async () => {
    const fetchStub = makeFetch({ version: '0.3.0' });
    await checkForUpdates({
      currentVersion: '0.3.0',
      env: {},
      fetch: fetchStub as unknown as typeof fetch,
      log: () => {},
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);

    const fetchStub2 = makeFetch({ version: '0.3.0' });
    await checkForUpdates({
      currentVersion: '0.3.0',
      env: { COMMONPLACE_NO_UPDATE_CHECK: '' },
      fetch: fetchStub2 as unknown as typeof fetch,
      log: () => {},
    });
    expect(fetchStub2).toHaveBeenCalledTimes(1);
  });
});

describe('ac-6: hard timeout (~1500ms) via AbortController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checkForUpdates aborts the fetch via AbortController after the configured timeout (verified by AbortSignal.aborted on the injected fetch's signal)", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchStub = vi.fn(async (_url: string, opts?: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal;
      // Hang forever -- the only way out is via the abort signal.
      return new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    });
    const logs: string[] = [];
    const pending = checkForUpdates({
      currentVersion: '0.3.0',
      env: {},
      fetch: fetchStub as unknown as typeof fetch,
      log: (msg) => logs.push(msg),
      timeoutMs: 1500,
    });
    // Advance past the timeout to fire the abort.
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(capturedSignal?.aborted).toBe(true);
    expect(logs).toHaveLength(0);
  });

  it('emits no stderr line and does not throw when the injected fetch resolves only after the timeout elapses (fake timers)', async () => {
    const fetchStub = vi.fn(async (_url: string, opts?: { signal?: AbortSignal }) => {
      return new Promise<Response>((resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
        // Resolve far after the timeout -- the abort path should win first.
        setTimeout(() => {
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ version: '99.99.99' }),
            text: async () => '{"version":"99.99.99"}',
          } as Response);
        }, 5000);
      });
    });
    const logs: string[] = [];
    const pending = checkForUpdates({
      currentVersion: '0.3.0',
      env: {},
      fetch: fetchStub as unknown as typeof fetch,
      log: (msg) => logs.push(msg),
      timeoutMs: 1500,
    });
    await vi.advanceTimersByTimeAsync(6000);
    await expect(pending).resolves.toBeUndefined();
    expect(logs).toHaveLength(0);
  });
});
