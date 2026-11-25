import { CurrentError } from './errors';
import { silentLogger, type Logger } from './logger';
import { PROBE_VIEWPORT_HEIGHT, type LiveProbe, type StateProbe } from './live-checks';

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
  /** Elements to force pointer states on. Bounds the CDP round trips. */
  maxStateTargets?: number;
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

/**
 * How many elements to force pointer states on.
 *
 * Each one costs a handful of CDP round trips, and a preview with more than
 * twenty interactive elements is a page, not a component — the first twenty
 * in document order are the component, and the rest is the harness around
 * it. Raise it with `maxStateTargets` if your previews really are that big.
 */
const DEFAULT_MAX_STATE_TARGETS = 20;

/** Native form fields: judged on focus, not hover. See `StateProbe.formField`. */
const FORM_FIELD_TAGS = ['input', 'textarea', 'select'];

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
 * Settle the page before forcing states on it.
 *
 * Two things in the way of a clean reading. Focus is still sitting on
 * whatever the Tab walk left it on, and a focused element's style is not its
 * baseline. And a hover style behind `transition: background 200ms` reads as
 * *unchanged* the instant it is forced, because the transition has not run —
 * so transitions and animations come off, which makes every forced state
 * settle immediately and the whole pass deterministic. Neither mutation
 * touches anything already measured: this runs after the overflow pass, the
 * Tab walk and the unreached sweep, as the last thing the probe does.
 */
const SETTLE_SCRIPT = `
(() => {
  const el = document.activeElement;
  if (el && typeof el.blur === 'function' && el !== document.body) el.blur();
  const style = document.createElement('style');
  style.textContent =
    '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(style);
  return true;
})()
`;

/**
 * Read one element's identity and the style properties a state could change,
 * called with the element as `this` over CDP.
 *
 * The `\\s` is doubled on purpose: this is a template literal, so a single
 * backslash would reach the page as `/s+/g` and quietly eat the letter s out
 * of every element name. Same as COLLECT_SCRIPT.
 *
 * The property list is the focus-visible set plus the ones hover and pressed
 * reach for in practice: a gradient swap (`backgroundImage`), a dim
 * (`opacity`), a lift (`transform`), a tint (`filter`). `cursor` is
 * deliberately absent — `cursor: pointer` is constant, so it says nothing
 * about whether the element reacted.
 */
const STATE_STYLE_FN = `
function () {
  const cs = getComputedStyle(this);
  const r = this.getBoundingClientRect();
  const name = (this.getAttribute('aria-label') || this.getAttribute('title') || this.value
    || this.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
  return {
    visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
      && this.getAttribute('aria-hidden') !== 'true' && !this.hasAttribute('disabled'),
    tag: this.tagName.toLowerCase(),
    role: this.getAttribute('role'),
    name: name,
    style: [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.backgroundColor,
      cs.backgroundImage, cs.color, cs.borderColor, cs.borderWidth, cs.textDecorationLine,
      cs.opacity, cs.transform, cs.filter].join('|'),
  };
}
`;

interface StateReading {
  visible: boolean;
  tag: string;
  role: string | null;
  name: string;
  style: string;
}

/**
 * Force `:hover` and `:hover:active` on each interactive element and record
 * what moved.
 *
 * Forced over CDP (`CSS.forcePseudoState`, the same call DevTools' "force
 * element state" makes) rather than driven with the mouse. A real pointer
 * would mean a `mousedown` to read the pressed state, and a `mousedown`
 * fires the component's own handlers — opening menus, starting drags,
 * navigating — which changes the page the probe is in the middle of
 * measuring. Forcing a pseudo-class dispatches no events at all: it asks the
 * style engine what the element WOULD look like, which is exactly the claim
 * CO1 makes and nothing more.
 *
 * Returns null when the protocol is not there (a non-Chromium renderer, a
 * Playwright without `newCDPSession`, a refused command). That is "we could
 * not look", which `checkStates` reports as N/A — never as a failing state.
 */
async function probeStates(
  ctx: PlaywrightContext,
  page: PlaywrightPage,
  focusByIndex: Map<number, boolean>,
  interactiveCount: number,
  maxTargets: number,
  logger: Logger,
): Promise<StateProbe[] | null> {
  if (typeof ctx.newCDPSession !== 'function') {
    logger.trace('preview: renderer exposes no CDP session — interaction states not probed');
    return null;
  }

  let cdp: PlaywrightCDPSession | null = null;
  try {
    cdp = await ctx.newCDPSession(page);
    await page.evaluate(SETTLE_SCRIPT);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1 })) as {
      root: { nodeId: number };
    };
    const { nodeIds } = (await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: INTERACTIVE_SELECTOR,
    })) as { nodeIds: number[] };

    const states: StateProbe[] = [];
    // The same selector and the same visibility filter as COLLECT_SCRIPT, in
    // the same document order, so the nth element measured here is the nth
    // element the Tab walk catalogued. The count check below is what keeps
    // that assumption honest.
    let visible = 0;
    for (const nodeId of nodeIds) {
      const baseline = await readState(cdp, nodeId);
      if (baseline === null || !baseline.visible) continue;
      const index = visible++;
      if (states.length >= maxTargets) continue;

      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      const hovered = await readState(cdp, nodeId);
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover', 'active'] });
      const pressed = await readState(cdp, nodeId);
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });

      states.push({
        tag: baseline.tag,
        role: baseline.role,
        name: baseline.name,
        hover: hovered !== null && hovered.style !== baseline.style,
        // Pressed is compared against the baseline, not against hover: a
        // control that darkens once on hover and no further when pressed has
        // changed from rest, and "it looks different while you hold it down"
        // is the state the guideline asks for.
        pressed: pressed !== null && pressed.style !== baseline.style,
        focus: focusByIndex.get(index) ?? null,
        formField: FORM_FIELD_TAGS.includes(baseline.tag),
      });
    }

    if (visible !== interactiveCount) {
      // The page moved between the two passes, so index k here is not index k
      // there. The states are still good; the focus column is not, and a
      // guessed focus result would be a No charged to the wrong element.
      logger.trace(
        `preview: ${visible} element(s) at the state pass vs ${interactiveCount} at collection — ` +
          'focus results dropped',
      );
      return states.map((s) => ({ ...s, focus: null }));
    }
    return states;
  } catch (err) {
    logger.trace(`preview: interaction states not probed — ${(err as Error).message}`);
    return null;
  } finally {
    if (cdp !== null) await cdp.detach().catch(() => undefined);
  }
}

/** One element's reading, or null when the node has gone away. */
async function readState(
  cdp: PlaywrightCDPSession,
  nodeId: number,
): Promise<StateReading | null> {
  try {
    const resolved = (await cdp.send('DOM.resolveNode', { nodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) return null;
    const called = (await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: STATE_STYLE_FN,
      returnByValue: true,
    })) as { result?: { value?: StateReading } };
    return called.result?.value ?? null;
  } catch {
    return null;
  }
}

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
  const maxStateTargets = opts.maxStateTargets ?? DEFAULT_MAX_STATE_TARGETS;
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
    let states: LiveProbe['states'] = null;

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
          const walk = await walkTabStops(page, interactiveCount, maxStops);
          focusStops = walk.stops;
          unreachable = ((await page.evaluate(UNREACHED_SCRIPT)) as string[]) ?? [];
          // Last, because it blurs the page and kills its transitions. See
          // SETTLE_SCRIPT: everything above is measured on an untouched page.
          states =
            interactiveCount === 0
              ? []
              : await probeStates(
                  ctx,
                  page,
                  walk.focusVisibleByIndex,
                  interactiveCount,
                  maxStateTargets,
                  logger,
                );
        }
      } finally {
        await ctx.close().catch(() => undefined);
      }
    }

    return { url, interactiveCount, focusStops, unreachable, viewports, states };
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
): Promise<{ stops: LiveProbe['focusStops']; focusVisibleByIndex: Map<number, boolean> }> {
  const budget = Math.min(maxStops, Math.max(interactiveCount * 2 + 4, 8));
  const stops: LiveProbe['focusStops'] = [];
  const visited = new Set<number>();
  // Keyed by position in the catalogued element list, so the state pass can
  // put each element's focus result next to its hover and pressed ones.
  const focusVisibleByIndex = new Map<number, boolean>();

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
    const { index, ...rest } = stop;
    stops.push(rest);
    focusVisibleByIndex.set(index, rest.focusVisible);
    if (visited.size === interactiveCount) break;
  }
  return { stops, focusVisibleByIndex };
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
  /** Chromium only, and absent on older Playwright: probeStates degrades. */
  newCDPSession?(page: PlaywrightPage): Promise<PlaywrightCDPSession>;
  close(): Promise<void>;
}
interface PlaywrightCDPSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}
interface PlaywrightBrowser {
  newContext(opts: { viewport: { width: number; height: number } }): Promise<PlaywrightContext>;
  close(): Promise<void>;
}
interface PlaywrightChromium {
  launch(opts: { headless: boolean }): Promise<PlaywrightBrowser>;
}
