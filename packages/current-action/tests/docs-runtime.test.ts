import { describe, expect, it } from 'vitest';
import { scanRepo, parseConfig } from '@usepolder/current-core';
import {
  BrowserSetupError,
  PLAYWRIGHT_CORE_VERSION,
  createActionRenderer,
  createBrowserLoader,
  type RuntimeDeps,
} from '../src/docs-runtime';

function deps(over: Partial<RuntimeDeps> & { launches?: Array<Record<string, unknown>> } = {}) {
  const calls: Array<[string, string[]]> = [];
  const launches = over.launches ?? [];
  let installed = false;
  const d: RuntimeDeps = {
    dir: '/tmp/cp',
    run: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'npm') installed = true;
    },
    requireFrom: () => ({
      chromium: {
        launch: async (opts: Record<string, unknown>) => {
          launches.push(opts);
          return { browser: true, opts };
        },
      },
    }),
    exists: () => installed,
    warn: () => {},
    ...over,
  };
  return { d, calls, launches };
}

describe('createBrowserLoader', () => {
  it('installs the pinned playwright-core once, without running install scripts', async () => {
    const { d, calls } = deps();
    const load = createBrowserLoader(d);
    await load();
    await load();
    const installs = calls.filter(([c]) => c === 'npm');
    expect(installs).toHaveLength(1);
    expect(installs[0][1]).toContain(`playwright-core@${PLAYWRIGHT_CORE_VERSION}`);
    expect(installs[0][1]).toContain('--ignore-scripts');
  });

  it('skips the install when the driver is already on disk', async () => {
    const { d, calls } = deps({ exists: () => true });
    await createBrowserLoader(d)();
    expect(calls).toEqual([]);
  });

  it('prefers the runner’s own Chrome and downloads nothing', async () => {
    const { d, calls, launches } = deps();
    const mod = (await createBrowserLoader(d)()) as {
      chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
    };
    await mod.chromium.launch({ headless: true });
    expect(launches).toEqual([{ headless: true, channel: 'chrome' }]);
    expect(calls.some(([, a]) => a.includes('chromium'))).toBe(false);
  });

  it('downloads Chromium only when there is no system Chrome', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { d, calls } = deps({
      requireFrom: () => ({
        chromium: {
          launch: async (opts: Record<string, unknown>) => {
            seen.push(opts);
            if (opts.channel === 'chrome') throw new Error('Chromium distribution chrome is not found');
            return {};
          },
        },
      }),
    });
    const mod = (await createBrowserLoader(d)()) as {
      chromium: { launch: (o: Record<string, unknown>) => Promise<unknown> };
    };
    await mod.chromium.launch({ headless: true });
    expect(calls.at(-1)![1]).toEqual(expect.arrayContaining(['install', 'chromium']));
    expect(seen.at(-1)).toEqual({ headless: true });
  });

  it('says why when the install fails, instead of blaming a missing package', async () => {
    const { d } = deps({
      run: async () => {
        throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
      },
    });
    await expect(createBrowserLoader(d)()).rejects.toThrow(/ENOTFOUND/);
    await expect(createBrowserLoader(d)()).rejects.toBeInstanceOf(BrowserSetupError);
  });
});

describe('hosted docs through the Action renderer', () => {
  it('reports the setup failure as unread docs, not as undocumented', async () => {
    const { d } = deps({
      run: async () => {
        throw new Error('offline');
      },
    });
    const config = parseConfig(
      'current:\n  version: 1\n  components:\n    Badge:\n      docs: "https://styleguide.test/badge"\n',
    );
    const report = await scanRepo({
      repoRoot: '/tmp',
      config,
      answers: new Map(),
      renderDocs: createActionRenderer({ trace: () => {} } as never, d),
    });
    const doc = report.components[0].metrics.filter((m) => m.category === 'documentation' && m.source === 'auto');
    expect(doc.length).toBeGreaterThan(0);
    for (const m of doc) {
      expect(m.answer).toBe('N/A');
      expect(m.evidence).toContain('offline');
    }
  });
});
