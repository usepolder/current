import { execFile } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  CurrentError,
  createPlaywrightProber,
  createPlaywrightRenderer,
  type Logger,
  type PageProber,
  type PageRenderer,
} from '@usepolder/current-core';

/**
 * Exact, not a range: this is fetched from npm at run time on the user's
 * runner, so the version that is fetched is the version that was reviewed.
 */
export const PLAYWRIGHT_CORE_VERSION = '1.63.0';

/** Same rule as PLAYWRIGHT_CORE_VERSION: pinned, so what runs is what was reviewed. */
export const VIRTUAL_SCREEN_READER_VERSION = '0.33.0';

const execFileAsync = promisify(execFile);

/** Everything that touches the machine, injectable so tests never install or launch anything. */
export interface RuntimeDeps {
  /** Directory the browser driver is installed into. */
  dir: string;
  run: (cmd: string, args: string[]) => Promise<void>;
  /** `require(id)` as resolved from `dir` — not from the bundle. */
  requireFrom: (dir: string, id: string) => unknown;
  exists: (file: string) => boolean;
  /** Read a file as UTF-8. Only the screen reader's bundle, so far. */
  readFile: (file: string) => string;
  warn: (message: string) => void;
}

export class BrowserSetupError extends CurrentError {}

export function defaultDeps(warn: (message: string) => void): RuntimeDeps {
  return {
    dir: path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'current-playwright'),
    run: async (cmd, args) => {
      try {
        await execFileAsync(cmd, args, { maxBuffer: 10 * 1024 * 1024 });
      } catch (err) {
        const e = err as { stderr?: string; message: string };
        throw new Error((e.stderr ?? '').trim().split('\n').slice(-3).join(' | ') || e.message);
      }
    },
    // createRequire, not `require(path)`: ncc rewrites the latter into a
    // bundle lookup that cannot see a package installed after the build.
    requireFrom: (dir, id) => createRequire(path.join(dir, 'noop.js'))(id),
    exists: fs.existsSync,
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    warn,
  };
}

interface Chromium {
  launch(opts: Record<string, unknown>): Promise<unknown>;
}

/**
 * Get a browser driver onto the runner and hand back something shaped like the
 * `playwright` module.
 *
 * The bundled Action cannot carry Playwright (it is external to ncc), and
 * requiring it for every user would put a download on runs that never look at
 * a hosted page. So it is fetched here, the first time a URL-mapped docs page
 * needs it: `playwright-core` alone, which is a couple of megabytes and
 * downloads no browser. For the browser it prefers the Chrome that GitHub's
 * runner images already ship, and only downloads Chromium when that is absent.
 */
export function createBrowserLoader(deps: RuntimeDeps): () => Promise<unknown> {
  return async () => {
    const pkg = path.join(deps.dir, 'node_modules', 'playwright-core', 'package.json');
    if (!deps.exists(pkg)) {
      deps.warn(`Current: installing playwright-core@${PLAYWRIGHT_CORE_VERSION} to render hosted pages`);
      try {
        await deps.run('npm', [
          'install',
          '--prefix',
          deps.dir,
          `playwright-core@${PLAYWRIGHT_CORE_VERSION}`,
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          '--loglevel=error',
        ]);
      } catch (err) {
        throw new BrowserSetupError(
          `could not install playwright-core on the runner (${(err as Error).message}), so hosted pages were not read`,
        );
      }
    }

    const mod = deps.requireFrom(deps.dir, 'playwright-core') as { chromium?: Chromium };
    if (mod.chromium === undefined) {
      throw new BrowserSetupError('the installed playwright-core has no chromium driver');
    }
    const chromium = mod.chromium;

    return {
      chromium: {
        launch: async (opts: Record<string, unknown>) => {
          try {
            return await chromium.launch({ ...opts, channel: 'chrome' });
          } catch {
            // No system Chrome (a self-hosted runner, typically): download Chromium.
          }
          try {
            await deps.run('node', [
              path.join(deps.dir, 'node_modules', 'playwright-core', 'cli.js'),
              'install',
              'chromium',
            ]);
            return await chromium.launch(opts);
          } catch (err) {
            throw new BrowserSetupError(
              `no Chrome on the runner and Chromium could not be installed (${(err as Error).message}), so hosted pages were not read`,
            );
          }
        },
      },
    };
  };
}

/**
 * Get the virtual screen reader's browser bundle onto the runner and hand
 * back its source.
 *
 * Returns null rather than throwing on every failure path, because
 * `checkScreenReader` turns null into a clean N/A with an install hint and a
 * missing screen reader must never read as an inaccessible component. That is
 * the one way this differs from `createBrowserLoader`, which throws: a
 * docs page that could not be rendered is reported as an error on the run,
 * while CO4 has a verdict that already means "we could not look".
 *
 * The bundle is read off disk rather than required. It is an ES module built
 * for a browser, so requiring it into Node would fail even here, where the
 * package is installed — and it is only ever evaluated inside the page.
 */
export function createScreenReaderLoader(deps: RuntimeDeps): () => Promise<string | null> {
  const bundlePath = (): string =>
    path.join(
      deps.dir,
      'node_modules',
      '@guidepup',
      'virtual-screen-reader',
      'lib',
      'esm',
      'index.browser.js',
    );

  return async () => {
    if (!deps.exists(bundlePath())) {
      deps.warn(
        `Current: installing @guidepup/virtual-screen-reader@${VIRTUAL_SCREEN_READER_VERSION} to score CO4`,
      );
      try {
        await deps.run('npm', [
          'install',
          '--prefix',
          deps.dir,
          `@guidepup/virtual-screen-reader@${VIRTUAL_SCREEN_READER_VERSION}`,
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          '--loglevel=error',
        ]);
      } catch (err) {
        deps.warn(
          `Current: could not install the virtual screen reader (${(err as Error).message}) — CO4 reports N/A`,
        );
        return null;
      }
    }
    try {
      return deps.readFile(bundlePath());
    } catch {
      return null;
    }
  };
}

/**
 * Renderer and prober off ONE loader.
 *
 * A single loader instance matters: it is what makes the on-demand install
 * happen at most once per run. Two loaders would each check and each warn,
 * and a repo with both hosted docs and a hosted preview would tell the user
 * twice that a driver is being installed.
 */
export function createActionBrowsers(
  logger: Logger,
  deps: RuntimeDeps,
): { renderer: PageRenderer; prober: PageProber } {
  const load = createBrowserLoader(deps);
  const loadScreenReader = createScreenReaderLoader(deps);
  return {
    renderer: createPlaywrightRenderer({ logger, load }),
    prober: createPlaywrightProber({ logger, load, loadScreenReader }),
  };
}
