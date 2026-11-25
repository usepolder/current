import { CurrentError } from './errors';
import { silentLogger, type Logger } from './logger';
import { PROBE_VIEWPORT_HEIGHT, type LiveProbe } from './live-checks';

/** `preview:` must be a URL — there is nothing to render about a file path. */
export function isPreviewUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Probes one preview URL. Injected so tests never launch a browser. */
export type PageProber = (url: string, widths: readonly number[]) => Promise<LiveProbe>;

export interface ProberOptions {
  logger?: Logger;
  timeoutMs?: number;
  /** Resolved lazily so playwright stays optional. */
  load?: () => Promise<unknown>;
  /** Give up after this many Tab presses. */
  maxTabStops?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * How far to Tab before giving up.
 *
 * A component preview with more than this many stops is either a whole page
 * mapped as a component or a focus trap, and both want a human. The cap also
 * bounds the probe: each press is a round trip, so an unbounded walk on a
 * misconfigured URL would hang the scan.
 */
const DEFAULT_MAX_TAB_STOPS = 60;

export const PROBER_INSTALL_HINT =
  'Preview probing needs a page renderer. Install it once with `npm i -D playwright` ' +
  'and `npx playwright install chromium`. Components with no `preview:` need nothing.';

/**
 * Elements a keyboard user is expected to reach.
 *
 * Roles are included alongside tags because a design system's own Button may
 * well be a styled div — and if it is, that is precisely the case this check
 * exists to catch.
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="textbox"]',
].join(', ');

const NATIVE_TAGS = ['button', 'a', 'input', 'select', 'textarea', 'summary'];

/**
 * Collect the interactive elements and their RESTING styles, stashed on
 * `window` so the Tab walk can compare each focused element against how it
 * looked before it had focus.
 *
 * Stashing on window rather than tagging the DOM with data-attributes on
 * purpose: a probe that mutates the page it measures can change what it is
 * measuring (attribute selectors, sibling counts), and this check's whole
 * job is to report the page as the user gets it.
 */
const COLLECT_SCRIPT = (selector: string, nativeTags: string[]): string => `
(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
      && el.getAttribute('aria-hidden') !== 'true' && !el.hasAttribute('disabled');
  };
  const style = (el) => {
    const cs = getComputedStyle(el);
    return {
      outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor,
      boxShadow: cs.boxShadow, background: cs.backgroundColor, color: cs.color,
      border: cs.borderColor + ' ' + cs.borderWidth, decoration: cs.textDecorationLine,
    };
  };
  const name = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') || el.value || el.textContent || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 40);
  const describe = (el) => {
    const role = el.getAttribute('role');
    return '<' + el.tagName.toLowerCase() + (role ? '[role=' + role + ']' : '') + '>'
      + (name(el) ? ' "' + name(el) + '"' : '');
  };
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(vis);
  window.__polderProbe = {
    els,
    resting: els.map(style),
    seen: new Set(),
    style,
    name,
    describe,
    native: ${JSON.stringify(nativeTags)},
  };
  return els.length;
})()
`;

/**
 * Read the focused element, and decide whether focus is VISIBLE by comparing
 * it to its own resting style.
 *
 * Comparing against the element's own earlier style, rather than looking for
 * an outline, is what makes this work on real design systems: plenty of them
 * suppress the UA outline and signal focus with a ring shadow, an inverted
 * background or a thicker border. Any of those count. Nothing changing at
 * all does not.
 */
const FOCUS_SCRIPT = `
(() => {
  const p = window.__polderProbe;
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const i = p.els.indexOf(el);
  if (i !== -1) p.seen.add(i);
  const now = p.style(el);
  const was = i === -1 ? null : p.resting[i];
  const outlineDrawn = now.outlineStyle !== 'none' && parseFloat(now.outlineWidth) > 0;
  const changed = was === null
    ? outlineDrawn
    : outlineDrawn || now.boxShadow !== was.boxShadow || now.background !== was.background
      || now.color !== was.color || now.border !== was.border
      || now.decoration !== was.decoration;
  return {
    index: i,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    name: p.name(el),
    focusVisible: changed,
    native: p.native.includes(el.tagName.toLowerCase()) && el.getAttribute('role') === null,
  };
})()
`;

const UNREACHED_SCRIPT = `
(() => {
  const p = window.__polderProbe;
  return p.els.map((el, i) => (p.seen.has(i) ? null : p.describe(el))).filter((x) => x !== null);
})()
`;

/**
 * Measure overflow at the current viewport.
 *
 * `position: fixed` elements are excluded: an overlay or a sticky bar pinned
 * to the viewport legitimately sits at its edge, and counting those produced
 * a "No" on every component that renders a tooltip.
 */
const OVERFLOW_SCRIPT = `
(() => {
  const de = document.documentElement;
  const limit = de.clientWidth;
  const overflowing = [...document.querySelectorAll('body *')]
    .filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') return false;
      return el.getBoundingClientRect().right > limit + 1;
    })
    .slice(0, 5)
    .map((el) => {
      const cls = (el.className && typeof el.className === 'string')
        ? '.' + el.className.trim().split(/\\s+/)[0] : '';
      return el.tagName.toLowerCase() + cls;
    });
  return {
    horizontalScroll: de.scrollWidth > limit + 1,
    scrollWidth: de.scrollWidth,
    clientWidth: limit,
    overflowing: [...new Set(overflowing)],
  };
})()
`;

/**
 * A prober backed by Playwright, loaded lazily — same contract as
 * `createPlaywrightRenderer`, and for the same reason: Playwright and its
 * browser are hundreds of megabytes, and a team with no `preview:` mapped
 * must never be asked to install them.
 *
 * One browser, one context per width. A context per width rather than
 * `setViewportSize` on one page, because a component that reads its width at
 * mount (a JS-driven layout, a container-query polyfill) answers differently
 * on a resized page than on a fresh one at that size — and a fresh one is
 * what the user gets.
 */
export function createPlaywrightProber(opts: ProberOptions = {}): PageProber {
  const logger = opts.logger ?? silentLogger;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStops = opts.maxTabStops ?? DEFAULT_MAX_TAB_STOPS;
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
          throw err instanceof CurrentError ? err : new ProberUnavailableError();
        }
        const chromium = (mod as { chromium?: PlaywrightChromium }).chromium;
        if (chromium === undefined) throw new ProberUnavailableError();
        logger.trace('preview: launching headless chromium');
        return chromium.launch({ headless: true });
      })();
    }
    return browserPromise;
  };

  const probe: PageProber & { close?: () => Promise<void> } = async (url, widths) => {
    const b = await browser();
    const sorted = [...widths].sort((a, c) => a - c);
    // The keyboard walk runs at the widest width: a layout that hides
    // controls behind a burger menu at narrow widths would report them
    // unreachable, which is a responsive-design finding, not a keyboard one.
    const walkWidth = sorted[sorted.length - 1] ?? 1280;

    const viewports: LiveProbe['viewports'] = [];
    let interactiveCount = 0;
    let focusStops: LiveProbe['focusStops'] = [];
    let unreachable: string[] = [];

    for (const width of sorted) {
      const ctx = await b.newContext({
        viewport: { width, height: PROBE_VIEWPORT_HEIGHT },
      });
      const page = await ctx.newPage();
      try {
        logger.trace(`preview: ${url} at ${width}px`);
        await page.goto(url, { waitUntil: 'load', timeout });
        // Web fonts land after load and change every box they touch, so
        // measuring before they do reports overflow that is not there (and
        // misses overflow that is).
        await page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
        const measured = (await page.evaluate(OVERFLOW_SCRIPT)) as Omit<
          LiveProbe['viewports'][number],
          'width' | 'height'
        >;
        viewports.push({ width, height: PROBE_VIEWPORT_HEIGHT, ...measured });

        if (width === walkWidth) {
          const found = (await page.evaluate(
            COLLECT_SCRIPT(INTERACTIVE_SELECTOR, NATIVE_TAGS),
          )) as number;
          interactiveCount = typeof found === 'number' ? found : 0;
          focusStops = await walkTabStops(page, interactiveCount, maxStops);
          unreachable = ((await page.evaluate(UNREACHED_SCRIPT)) as string[]) ?? [];
        }
      } finally {
        await ctx.close().catch(() => undefined);
      }
    }

    return { url, interactiveCount, focusStops, unreachable, viewports };
  };

  probe.close = async () => {
    if (browserPromise === null) return;
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b !== null) await b.close().catch(() => undefined);
  };

  return probe;
}

/**
 * Press Tab until focus comes back round, leaves the document, or the cap is
 * hit, recording each stop.
 *
 * Stopping on a repeat is what makes the walk terminate on a focus trap
 * without special-casing one: a trap cycles, and a cycle is a repeat. The
 * budget is `stops + a small margin`, so a preview whose first Tab lands on
 * browser chrome still gets a chance to enter the document.
 */
async function walkTabStops(
  page: PlaywrightPage,
  interactiveCount: number,
  maxStops: number,
): Promise<LiveProbe['focusStops']> {
  const budget = Math.min(maxStops, Math.max(interactiveCount * 2 + 4, 8));
  const stops: LiveProbe['focusStops'] = [];
  const visited = new Set<number>();

  for (let i = 0; i < budget; i++) {
    await page.keyboard.press('Tab');
    const stop = (await page.evaluate(FOCUS_SCRIPT)) as
      | (LiveProbe['focusStops'][number] & { index: number })
      | null;
    if (stop === null) {
      // Focus is on the document body or browser chrome. Keep going: the
      // next press may enter the page. If it never does, `unreachable`
      // reports every element, which is the honest answer.
      continue;
    }
    if (stop.index === -1) {
      // Focusable, but not one of the elements we catalogued and took a
      // resting style for — an iframe's chrome, a native media control. With
      // no baseline to compare against, "is focus visible here" would be a
      // guess, and a guess must not become a No. Walk past it.
      continue;
    }
    if (visited.has(stop.index)) break;
    visited.add(stop.index);
    const { index: _index, ...rest } = stop;
    stops.push(rest);
    if (visited.size === interactiveCount) break;
  }
  return stops;
}

/**
 * The outcome of probing one preview: the probe, or why we could not look.
 * Never an empty probe — "no interactive elements" and "never loaded" score
 * differently, and collapsing them would answer CO3 for a component nobody
 * managed to render.
 */
export type ProbedPage = { probe: LiveProbe } | { error: string };

/** Previews probed at once. Low: each one opens a context per width. */
export const DEFAULT_PREVIEW_CONCURRENCY = 2;

/** Probe every preview URL, a couple at a time. Mirrors `renderDocsPages`. */
export async function probeLivePages(
  urls: readonly string[],
  prober: PageProber,
  widths: readonly number[],
  opts: { concurrency?: number; logger?: Logger } = {},
): Promise<Map<string, ProbedPage>> {
  const logger = opts.logger ?? silentLogger;
  const unique = [...new Set(urls)];
  const out = new Map<string, ProbedPage>();
  if (unique.length === 0) return out;

  const limit = Math.max(1, opts.concurrency ?? DEFAULT_PREVIEW_CONCURRENCY);
  logger.trace(
    `preview: probing ${unique.length} URL(s) at ${widths.length} width(s), ` +
      `${Math.min(limit, unique.length)} at a time`,
  );

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < unique.length) {
      const url = unique[next++];
      try {
        out.set(url, { probe: await prober(url, widths) });
      } catch (err) {
        // One preview failing must not abandon the rest — a pool, not
        // Promise.all, for the same reason as renderDocsPages.
        out.set(url, { error: (err as Error).message });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, unique.length) }, worker));
  return out;
}

export class ProberUnavailableError extends CurrentError {
  constructor() {
    super(PROBER_INSTALL_HINT);
  }
}

/** Close a prober if it holds a browser. Safe on any prober. */
export async function closeProber(prober: PageProber | null): Promise<void> {
  const close = (prober as { close?: () => Promise<void> } | null)?.close;
  if (typeof close === 'function') await close();
}

// Minimal structural types so core does not depend on playwright's types.
interface PlaywrightPage {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
  close(): Promise<void>;
}
interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightBrowser {
  newContext(opts: { viewport: { width: number; height: number } }): Promise<PlaywrightContext>;
  close(): Promise<void>;
}
interface PlaywrightChromium {
  launch(opts: { headless: boolean }): Promise<PlaywrightBrowser>;
}
