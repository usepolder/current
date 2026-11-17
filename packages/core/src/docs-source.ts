import { CurrentError } from './errors';
import { silentLogger, type Logger } from './logger';

/** `docs:` is a URL when it looks like one; anything else is a repo path. */
export function isDocsUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Renders a URL to HTML. Injected so tests never launch a browser. */
export type PageRenderer = (url: string) => Promise<string>;

export interface RendererOptions {
  logger?: Logger;
  /** Give up on a page after this long. */
  timeoutMs?: number;
  /** Resolved lazily so playwright stays optional. */
  load?: () => Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export const RENDERER_INSTALL_HINT =
  'Hosted documentation needs a page renderer. Install it once with `npm i -D playwright` ' +
  'and `npx playwright install chromium`. Local markdown docs need nothing.';

/**
 * A renderer backed by Playwright, loaded lazily.
 *
 * Playwright is an OPTIONAL dependency on purpose. It and its browser are
 * hundreds of megabytes, and most of what Current does — code scanning, Figma,
 * local markdown — needs none of it. Requiring it for everyone would trade the
 * `npx and go` install, which is the whole reason this tool is adoptable, for
 * a feature only teams with hosted docs use. So: absent renderer is a clean
 * N/A with an install hint, never a crash and never a wrong score.
 *
 * Documentation sites are fetched over the network, the same way the Figma
 * file is. Both are services the user points Current at; nothing is sent to
 * anyone else.
 */
export function createPlaywrightRenderer(opts: RendererOptions = {}): PageRenderer {
  const logger = opts.logger ?? silentLogger;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const load =
    opts.load ??
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('playwright') as unknown;
    });

  let browserPromise: Promise<PlaywrightBrowser> | null = null;

  const browser = async (): Promise<PlaywrightBrowser> => {
    if (browserPromise === null) {
      browserPromise = (async () => {
        let mod: unknown;
        try {
          mod = await load();
        } catch (err) {
          // A host that knows why it could not provide a browser (the Action,
          // when its on-demand install fails) says so; the generic install
          // hint would send that user to fix the wrong thing.
          throw err instanceof CurrentError ? err : new RendererUnavailableError();
        }
        const chromium = (mod as { chromium?: PlaywrightChromium }).chromium;
        if (chromium === undefined) throw new RendererUnavailableError();
        logger.trace('docs: launching headless chromium');
        return chromium.launch({ headless: true });
      })();
    }
    return browserPromise;
  };

  const render: PageRenderer & { close?: () => Promise<void> } = async (url: string) => {
    const b = await browser();
    const page = await b.newPage();
    try {
      logger.trace(`docs: rendering ${url}`);
      await page.goto(url, { waitUntil: 'networkidle', timeout });
      // Client-rendered docs sites serve an empty shell and paint later, so
      // waiting for real headings is the only reliable signal the page is up.
      //
      // This failing is an ERROR, deliberately. Swallowing it and returning
      // the shell yields zero headings, which scores every documentation
      // metric "No" — a confident claim that a documented component is
      // undocumented. "We could not look" has to stay distinguishable from
      // "we looked and found nothing".
      try {
        await page.waitForSelector('h1, h2, h3', { timeout: Math.min(timeout, 15_000) });
      } catch {
        throw new Error(
          `no headings appeared within ${Math.min(timeout, 15_000)}ms — the page may be slow, ` +
            'rate limiting, or behind a login',
        );
      }

      // The first heading is not the last. A single-page app paints its title
      // before the body sections, and capturing there reads a half-rendered
      // page as a component missing sections it documents perfectly well.
      // Observed directly: the same styleguide scored 59.5%, 62.0% and 63.8%
      // across three runs before this settle existed. A score that changes
      // run to run is worse than no score.
      await waitForStableHeadings(page, Math.min(timeout, 10_000));

      return await page.content();
    } finally {
      await page.close().catch(() => undefined);
    }
  };

  render.close = async () => {
    if (browserPromise === null) return;
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b !== null) await b.close().catch(() => undefined);
  };

  return render;
}

/**
 * Poll the heading count until it stops changing, so a page is captured once
 * it has finished painting rather than the moment it starts.
 */
async function waitForStableHeadings(page: PlaywrightPage, budgetMs: number): Promise<void> {
  const started = Date.now();
  let previous = -1;
  let stableFor = 0;
  while (Date.now() - started < budgetMs) {
    const count = await page.evaluate('document.querySelectorAll("h1,h2,h3").length');
    if (typeof count === 'number' && count === previous) {
      stableFor += 1;
      // Two consecutive identical readings, 300ms apart, is enough: the
      // alternative is waiting out the whole budget on every page.
      if (stableFor >= 2) return;
    } else {
      stableFor = 0;
      previous = typeof count === 'number' ? count : -1;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * The outcome of rendering one page: either HTML, or why we could not look.
 *
 * Never "empty HTML". A page we failed to reach and a page that genuinely
 * documents nothing have to stay distinguishable all the way through, because
 * the second scores a component No and the first must score it N/A.
 */
export type RenderedPage = { html: string } | { error: string };

/**
 * How many pages to render at once.
 *
 * Four, not more: the pages share one browser process, and the hosted runner
 * this most often runs on has two cores. Past the point where the bottleneck
 * stops being the network and starts being paint, more concurrency buys
 * nothing and makes each page's settle poll noisier.
 */
export const DEFAULT_DOCS_CONCURRENCY = 4;

/**
 * Render every URL-mapped docs page, a few at a time.
 *
 * Rendering used to happen inside the per-component loop, one page at a time,
 * which made the slowest path in the tool scale linearly with the number of
 * documented components — the number you want to be high. A 31-component
 * system with 24 pages took over two minutes, nearly all of it waiting.
 *
 * Two things fall out of hoisting it here. Duplicate URLs are rendered once,
 * which a per-component loop could not do. And a failure stays attached to
 * its URL rather than to whichever component happened to ask first, so each
 * component still reports its own reason.
 */
export async function renderDocsPages(
  urls: readonly string[],
  renderer: PageRenderer,
  opts: { concurrency?: number; logger?: Logger } = {},
): Promise<Map<string, RenderedPage>> {
  const logger = opts.logger ?? silentLogger;
  const unique = [...new Set(urls)];
  const out = new Map<string, RenderedPage>();
  if (unique.length === 0) return out;

  const limit = Math.max(1, opts.concurrency ?? DEFAULT_DOCS_CONCURRENCY);
  logger.trace(
    `docs: rendering ${unique.length} page(s), ${Math.min(limit, unique.length)} at a time`,
  );

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < unique.length) {
      const url = unique[next++];
      try {
        out.set(url, { html: await renderer(url) });
      } catch (err) {
        // One page failing must not abandon the others, which is why this is
        // a pool of workers and not Promise.all — a rejection there would
        // leave the remaining pages unrendered and the components that map to
        // them indistinguishable from components nobody documented.
        out.set(url, { error: (err as Error).message });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, unique.length) }, worker));
  return out;
}

export class RendererUnavailableError extends CurrentError {
  constructor() {
    super(RENDERER_INSTALL_HINT);
  }
}

/** Close a renderer if it holds a browser. Safe on any renderer. */
export async function closeRenderer(renderer: PageRenderer | null): Promise<void> {
  const close = (renderer as { close?: () => Promise<void> } | null)?.close;
  if (typeof close === 'function') await close();
}

// Minimal structural types so core does not depend on playwright's types.
interface PlaywrightPage {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForSelector(selector: string, opts: { timeout: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}
interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightChromium {
  launch(opts: { headless: boolean }): Promise<PlaywrightBrowser>;
}
