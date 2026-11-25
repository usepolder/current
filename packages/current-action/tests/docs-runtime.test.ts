import { describe, expect, it } from 'vitest';
import { scanRepo, parseConfig } from '@usepolder/current-core';
import {
  BrowserSetupError,
  PLAYWRIGHT_CORE_VERSION,
  VIRTUAL_SCREEN_READER_VERSION,
  createActionBrowsers,
  createBrowserLoader,
  createScreenReaderLoader,
  type RuntimeDeps,
} from '../src/docs-runtime';

/** Stands in for the screen reader's browser bundle. Content is irrelevant. */
const READER_BUNDLE = 'const v=1;export{v as virtual};';

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
    readFile: () => READER_BUNDLE,
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
      renderDocs: createActionBrowsers({ trace: () => {} } as never, d).renderer,
    });
    const doc = report.components[0].metrics.filter((m) => m.category === 'documentation' && m.source === 'auto');
    expect(doc.length).toBeGreaterThan(0);
    for (const m of doc) {
      expect(m.answer).toBe('N/A');
      expect(m.evidence).toContain('offline');
    }
  });
});

describe('createScreenReaderLoader', () => {
  it('installs the pinned virtual screen reader once and returns its bundle', async () => {
    const { d, calls } = deps();
    const load = createScreenReaderLoader(d);
    expect(await load()).toBe(READER_BUNDLE);
    expect(await load()).toBe(READER_BUNDLE);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('npm');
    expect(calls[0][1]).toContain(
      `@guidepup/virtual-screen-reader@${VIRTUAL_SCREEN_READER_VERSION}`,
    );
    expect(calls[0][1]).toContain('--ignore-scripts');
  });

  it('skips the install when the bundle is already there', async () => {
    const { d, calls } = deps({ exists: () => true });
    expect(await createScreenReaderLoader(d)()).toBe(READER_BUNDLE);
    expect(calls).toHaveLength(0);
  });

  // The one place this differs from createBrowserLoader, which throws. CO4
  // already has a verdict for "we could not look", and a screen reader that
  // would not install must never read as an inaccessible component.
  it('returns null rather than throwing when the install fails', async () => {
    const warnings: string[] = [];
    const { d } = deps({
      run: async () => {
        throw new Error('registry unreachable');
      },
      warn: (m) => warnings.push(m),
    });
    expect(await createScreenReaderLoader(d)()).toBeNull();
    expect(warnings.join(' ')).toContain('registry unreachable');
    expect(warnings.join(' ')).toContain('N/A');
  });

  it('returns null rather than throwing when the bundle cannot be read', async () => {
    const { d } = deps({
      exists: () => true,
      readFile: () => {
        throw new Error('EACCES');
      },
    });
    expect(await createScreenReaderLoader(d)()).toBeNull();
  });
});
