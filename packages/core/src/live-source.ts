import { CurrentError } from './errors';
import { silentLogger, type Logger } from './logger';
import {
  PROBE_VIEWPORT_HEIGHT,
  type LiveProbe,
  type ScreenReaderProbe,
  type ExpansionProbe,
  type ScreenReaderStop,
  type StateProbe,
} from './live-checks';

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
  /**
   * Source of the virtual screen reader's browser bundle, resolved lazily so
   * `@guidepup/virtual-screen-reader` stays optional too. Returning null is
   * "not installed", which `checkScreenReader` reports as a clean N/A.
   */
  loadScreenReader?: () => Promise<string | null>;
  /** Give up after this many Tab presses. */
  maxTabStops?: number;
  /** Elements to force pointer states on. Bounds the CDP round trips. */
  maxStateTargets?: number;
  /** Virtual-cursor moves before giving up on the screen-reader walk. */
  maxReaderStops?: number;
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
 * Pseudo-localize every text run in the preview, and report what was touched.
 *
 * Two things happen to each word: its letters are swapped for accented
 * look-alikes, and it grows by about 40%. Both matter, and for different
 * reasons. The accents make the substitution obvious at a glance in a
 * screenshot, so nobody mistakes the output for real content. The growth is
 * the actual stressor: German, Finnish and Russian run 30-40% longer than
 * English, and it is LONGER WORDS rather than more of them that breaks a
 * layout, which is why the padding goes inside each word instead of adding
 * new ones.
 *
 * Wrapped in brackets, as pseudo-localization conventionally is: if the
 * closing bracket is missing from a screenshot, the string was truncated.
 * The check measures that geometrically rather than reading it, but the
 * brackets cost two characters and make the evidence legible to a human
 * looking at the same page.
 *
 * The expanded text nodes are stashed on `window` so the measurement pass can
 * ask each one how much room it actually needs. Same reasoning as
 * COLLECT_SCRIPT stashing rather than tagging the DOM: a probe that adds
 * attributes to the page can change what it is measuring.
 *
 * Single-character words are left at their own length. A one-letter word has
 * no plausible longer translation, and padding it would be inventing a
 * stressor rather than simulating one.
 */
const EXPAND_SCRIPT = (ratio: number, mark: boolean): string => `
(() => {
  const MAP = {
    a:'à', b:'ƃ', c:'ć', d:'ď', e:'é', f:'ƒ', g:'ĝ',
    h:'ĥ', i:'î', j:'ĵ', k:'ķ', l:'ļ', m:'ḿ', n:'ń',
    o:'ó', p:'ṕ', q:'ǫ', r:'ř', s:'ś', t:'ţ', u:'û',
    v:'ṽ', w:'ŵ', x:'ẋ', y:'ý', z:'ž',
    A:'À', B:'Ɓ', C:'Ć', D:'Ď', E:'É', F:'Ƒ', G:'Ĝ',
    H:'Ĥ', I:'Î', J:'Ĵ', K:'Ķ', L:'Ļ', M:'Ḿ', N:'Ń',
    O:'Ó', P:'Ṕ', Q:'Ǫ', R:'Ř', S:'Ś', T:'Ţ', U:'Û',
    V:'Ṽ', W:'Ŵ', X:'Ẋ', Y:'Ý', Z:'Ž'
  };
  const FILLER = 'àéîóû';
  const word = (w) => {
    const accented = [...w].map((ch) => MAP[ch] === undefined ? ch : MAP[ch]).join('');
    if (w.length < 2) return accented;
    const extra = Math.ceil(w.length * ${ratio});
    let pad = '';
    for (let i = 0; i < extra; i++) pad += FILLER[i % FILLER.length];
    return accented + pad;
  };
  const expand = (text) =>
    '[' + text.split(/(\\s+)/).map((p) => (/^\\s+$/.test(p) ? p : word(p))).join('') + ']';

  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TITLE: 1 };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode()) !== null) {
    if (n.parentElement && SKIP[n.parentElement.tagName]) continue;
    if (String(n.nodeValue).trim() === '') continue;
    nodes.push(n);
  }
  window.__polderExpanded = nodes;

  let chars = 0;
  for (const node of nodes) {
    chars += String(node.nodeValue).length;
    ${mark ? '' : 'node.nodeValue = expand(node.nodeValue);'}
  }
  ${
    mark
      ? ''
      : `for (const el of document.querySelectorAll('[placeholder]')) {
    el.setAttribute('placeholder', expand(el.getAttribute('placeholder') || ''));
  }`
  }
  return { textNodes: nodes.length, chars: chars };
})()
`;

/**
 * Measure how the stashed text runs and their containers are sitting.
 *
 * Run twice — once before the expansion and once after — and only the
 * difference is reported. That is what keeps the check honest: measured
 * against real markup, a flex row whose children already spilled and a button
 * whose label was already clipped both showed up, and charging CO10 for
 * breakage that pre-dates the expansion would be reporting another norm's bug
 * under this one.
 *
 * Text is measured with a Range rather than from `scrollWidth`, because
 * `scrollWidth` reports the padding box for an element whose overflow is
 * `visible` — so text spilling visibly out of a `white-space: nowrap` box,
 * which is the single most common expansion failure, is invisible to it. A
 * Range over the text node reports where the glyphs actually are.
 *
 * A container that scrolls is never a finding: `overflow: auto` is the author
 * saying the content may be larger than the box. Nor is one that declares a
 * limit — `text-overflow: ellipsis`, a line clamp, a `max-width` or a
 * `max-height` — because a declared limit is CO10 being satisfied. That is
 * the norm's own wording: the bounds are *defined*.
 */
const EXPANSION_MEASURE_SCRIPT = `
(() => {
  const de = document.documentElement;
  const limit = de.clientWidth;
  const label = (el) => {
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\\s+/)[0] : '';
    return el.tagName.toLowerCase() + cls;
  };
  const clips = (cs) =>
    cs.overflowX === 'hidden' || cs.overflowX === 'clip' ||
    cs.overflowY === 'hidden' || cs.overflowY === 'clip';
  const scrolls = (cs) =>
    cs.overflowX === 'auto' || cs.overflowX === 'scroll' ||
    cs.overflowY === 'auto' || cs.overflowY === 'scroll';
  const bounded = (cs) =>
    cs.textOverflow === 'ellipsis' ||
    (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') ||
    cs.maxWidth !== 'none' || cs.maxHeight !== 'none';
  const gone = (cs) =>
    cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed';
  const inner = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      right: r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
      bottom: r.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom),
    };
  };

  const clipped = [];
  const spilling = [];

  // Each expanded run against the box that is supposed to hold it.
  for (const node of (window.__polderExpanded || [])) {
    const host = node.parentElement;
    if (!host) continue;
    const cs = getComputedStyle(host);
    if (gone(cs) || scrolls(cs)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const t = range.getBoundingClientRect();
    if (t.width === 0 && t.height === 0) continue;
    const box = inner(host);
    if (t.right <= box.right + 1 && t.bottom <= box.bottom + 1) continue;
    if (clips(cs)) {
      if (!bounded(cs)) clipped.push(label(host));
    } else {
      spilling.push(label(host));
    }
  }

  // Elements pushed out of an ancestor that neither clips nor scrolls. Catches
  // the layout failures the text measurement cannot see, such as a flex row
  // whose children refuse to shrink. Absolutely positioned elements are out:
  // they are placed relative to something else by design.
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (gone(cs) || cs.position === 'absolute') continue;
    const parent = el.parentElement;
    if (!parent || parent === document.body) continue;
    const pcs = getComputedStyle(parent);
    if (scrolls(pcs) || clips(pcs) || bounded(pcs)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > inner(parent).right + 1) spilling.push(label(el));
  }

  const overflowing = [...document.querySelectorAll('body *')]
    .filter((el) => {
      const cs = getComputedStyle(el);
      if (gone(cs)) return false;
      return el.getBoundingClientRect().right > limit + 1;
    })
    .slice(0, 5)
    .map(label);

  return {
    horizontalScroll: de.scrollWidth > limit + 1,
    overflowBy: Math.max(de.scrollWidth - limit, 0),
    overflowing: [...new Set(overflowing)],
    clipped: [...new Set(clipped)],
    spilling: [...new Set(spilling)],
  };
})()
`;

/** How much longer each word gets. ~40% is the English-to-German figure. */
export const TEXT_EXPANSION_RATIO = 0.4;

interface ExpansionMeasurement {
  horizontalScroll: boolean;
  overflowBy: number;
  overflowing: string[];
  clipped: string[];
  spilling: string[];
}

/**
 * Stress one already-loaded page with expanded text and report only what the
 * expansion broke.
 *
 * Destructive: it rewrites the page's text. It therefore runs last at every
 * width, after everything else this tool measures — including the screen
 * reader, whose announcements would otherwise all be pseudo-localized.
 *
 * Returns null on any failure, which `checkTextExpansion` reports as an N/A.
 */
async function probeExpansion(
  page: PlaywrightPage,
  width: number,
  logger: Logger,
): Promise<ExpansionProbe | null> {
  try {
    // Marks the text runs without rewriting them, so the baseline measures
    // exactly the set the expansion will touch.
    await page.evaluate(EXPAND_SCRIPT(TEXT_EXPANSION_RATIO, true));
    const before = (await page.evaluate(
      EXPANSION_MEASURE_SCRIPT,
    )) as ExpansionMeasurement;

    const applied = (await page.evaluate(EXPAND_SCRIPT(TEXT_EXPANSION_RATIO, false))) as {
      textNodes: number;
      chars: number;
    };
    // Expanded glyphs change every box they touch, and a web font that is
    // already loaded still needs a layout pass before the new text is placed.
    await page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
    const after = (await page.evaluate(EXPANSION_MEASURE_SCRIPT)) as ExpansionMeasurement;

    const added = (now: string[], was: string[]): string[] =>
      now.filter((x) => !was.includes(x)).slice(0, 5);

    return {
      width,
      textNodes: applied.textNodes,
      chars: applied.chars,
      viewportOverflow: after.horizontalScroll && !before.horizontalScroll,
      overflowBy: Math.round(after.overflowBy),
      clipped: added(after.clipped, before.clipped),
      spilling: added(after.spilling, before.spilling),
    };
  } catch (err) {
    logger.trace(`preview: text expansion not probed at ${width}px — ${(err as Error).message}`);
    return null;
  }
}

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
 * Announcement segments that are structure rather than a name or a state.
 *
 * The reader interleaves position and relationship information into what it
 * says: `tab, Overview, not selected, position 1, set size 1`, or
 * `combobox, has popup listbox, not expanded`. Everything here was observed
 * coming out of the reader against a real page, not taken from a spec.
 *
 * The list only has to be right in one direction. A segment it does NOT
 * recognise is counted as a state announcement, which makes the check stay
 * quiet; a segment it wrongly recognises would make the check report a state
 * as missing when the user does hear it. So an unknown segment fails toward
 * silence, which is the same bias as every other N/A in this tool.
 */
const SPOKEN_STRUCTURE: readonly RegExp[] = [
  /^position \d+$/i,
  /^set size \d+$/i,
  /^level \d+$/i,
  /^\d+ (control|controls|item|items|column|columns|row|rows)$/i,
  /^has popup\b/i,
  /^end of\b/i,
  /^orientation\b/i,
  /^clickable$/i,
];

/**
 * Attributes whose whole purpose is to tell a screen reader user which way a
 * control is currently set.
 *
 * This list, and NOT a list of stateful roles, is what makes the state clause
 * mean something. Measured against the reader: a `role="switch"` with no
 * `aria-checked` is still announced `switch, Dark mode, not checked`, and a
 * bare `role="tab"` as `tab, Overview, not selected` — the reader supplies
 * the implicit default, so the state does reach the user and there is nothing
 * to report. Keying off the role would therefore have found nothing, while
 * looking plausible.
 *
 * What it does catch is the author declaring a state on a role that cannot
 * carry one, where the reader drops it silently. All of these were observed:
 * `role="link" aria-pressed="true"` announces `link, More`,
 * `role="button" aria-checked="true"` announces `button, Toggle`, and
 * `role="img" aria-expanded="false"` announces `image, Logo`. In each case
 * the author built a toggle and the user cannot hear whether it is on, which
 * is the real and common bug this clause exists for.
 */
const STATE_ATTRIBUTES: readonly string[] = [
  'aria-expanded',
  'aria-pressed',
  'aria-checked',
  'aria-selected',
  'aria-current',
];

export const SCREEN_READER_INSTALL_HINT =
  'Screen-reader probing needs a virtual screen reader. Install it once with ' +
  '`npm i -D @guidepup/virtual-screen-reader`. Components with no `preview:` need nothing.';

/** How many virtual-cursor moves to make before giving up. See the walk. */
const DEFAULT_MAX_READER_STOPS = 400;

/**
 * Turn the screen reader's ES-module bundle into a classic script that
 * exposes itself on `window`.
 *
 * This looks like a hack and is the one approach that works. The bundle is
 * self-contained ESM ending in a single `export{jo as Virtual,X$ as virtual}`,
 * so it cannot be run as a classic script, and `virtual` is an export name
 * rather than a binding — appending `window.x = virtual` to it is a
 * ReferenceError.
 *
 * The two alternatives were tried and both fail where it matters. A
 * `<script type="module">` added to the page, and a dynamic `import()` of a
 * blob URL, are both subject to the page's Content-Security-Policy: measured
 * against `script-src 'self'` they fail outright, and a deployed Storybook
 * routinely sends one. `page.evaluate` goes through the debugging protocol
 * instead, which CSP does not govern — so rewriting the export into an
 * assignment and evaluating that works on a page with any policy.
 *
 * Returns null if the export statement is not where it is expected, which
 * makes the whole check a clean N/A rather than a wrong answer. That is the
 * right failure: this transform is tied to one bundler's output shape, and a
 * future version that emits something else must degrade to "we could not
 * look", never to a No.
 */
export function toClassicScript(bundle: string, global: string): string | null {
  let replaced = false;
  const out = bundle.replace(/export\s*\{([^}]*)\}\s*;/, (_whole, body: string) => {
    replaced = true;
    const pairs = body
      .split(',')
      .map((part) => {
        const [local, exported] = part.split(/\s+as\s+/).map((x) => x.trim());
        return `${JSON.stringify(exported ?? local)}:${local}`;
      })
      .join(',');
    return `window[${JSON.stringify(global)}]={${pairs}};`;
  });
  return replaced ? out : null;
}

/** Where the bundle parks itself. Namespaced so a page's own globals are safe. */
const READER_GLOBAL = '__polderScreenReader';

/**
 * Drive the virtual screen reader over the preview and record what it said
 * about each interactive element.
 *
 * The walk terminates on a repeated (node, phrase) pair rather than on a stop
 * count. The reader wraps around — after `end of document` it returns to the
 * top — so a count alone would either stop early on a big preview or spin
 * through the same elements several times on a small one. Same reasoning as
 * `walkTabStops` stopping on a repeat to terminate on a focus trap.
 *
 * Announcements are attributed to the nearest interactive ancestor-or-self,
 * because the reader stops on the TEXT NODE inside a bare `<div tabindex=0>`
 * — the div's own announcement is its text and nothing else, which is
 * precisely the finding, and reading it off the text node would lose the
 * element it belongs to.
 */
/** One element as the reader left it: what was said, and what it is. */
export interface ReaderReading {
  tag: string;
  role: string | null;
  /** `lastSpokenPhrase()` — the whole announcement. */
  phrase: string;
  /** `itemText()` — the accessible name on its own. */
  itemText: string;
  /** The element declares one of `STATE_ATTRIBUTES`. */
  declaresState: boolean;
}

/**
 * Turn one reading into the stop `checkScreenReader` scores.
 *
 * In TypeScript rather than in the page script on purpose. The page script
 * collects; this decides. That is the same split as everywhere else here —
 * `live-source` gathers facts and `live-checks` judges them — and it is what
 * makes the derivation testable, which matters more here than anywhere: every
 * rule below was wrong in an earlier draft and was corrected against what a
 * real reader actually says. Those phrases are the test cases.
 */
export function parseAnnouncement(reading: ReaderReading): ScreenReaderStop {
  const said = reading.phrase.trim();
  const name = reading.itemText.trim();
  const segments = said
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

  // Whether a role was announced at all, without needing to know the ARIA
  // vocabulary: the reader says the role, then the name, so a phrase that is
  // NOTHING BUT the name carries no role.
  //
  // Testing segment 0 against a list of role names was the first attempt and
  // it was wrong in a way that mattered. The accessible name is very often a
  // role word — a button labelled "Menu", "Search", "Link" or "Table" — so
  // `<button>Menu</button>`, announced `button, Menu`, has a name segment
  // that is itself a role. Worse, `<div tabindex=0>Menu</div>` announces as
  // just `Menu`, and reading that as a role made an unroled control look
  // roled-but-unnamed: a confident No with the wrong reason on the wrong
  // rule. Comparing against the name the reader itself reports needs no
  // vocabulary and cannot make that mistake.
  const hasRole = said !== '' && said !== name;

  // What is left once the role and the name are accounted for. A state
  // announcement lives in here; so does position and relationship
  // information, which SPOKEN_STRUCTURE removes.
  const extras = segments
    .slice(hasRole ? 1 : 0)
    .filter((seg) => seg !== name && !SPOKEN_STRUCTURE.some((re) => re.test(seg)));

  return {
    tag: reading.tag,
    role: reading.role,
    phrase: said,
    spokenRole: hasRole && segments.length > 0 ? segments[0] : null,
    name,
    spokenState: extras.length > 0,
    expectsState: reading.declaresState,
  };
}

/**
 * Walk the reader over the preview and report what it said about each
 * interactive element.
 *
 * The walk terminates on a repeated (element, phrase) pair rather than on a
 * stop count. The reader wraps around — after `end of document` it returns to
 * the top — so a count alone would either stop early on a big preview or spin
 * through the same elements several times on a small one. Same reasoning as
 * `walkTabStops` stopping on a repeat to terminate on a focus trap.
 *
 * Announcements are attributed to the nearest interactive ancestor-or-self,
 * because the reader stops on the TEXT NODE inside a bare `<div tabindex=0>`
 * — the div's announcement being its text and nothing else is precisely the
 * finding, and reading it off the text node would lose the element it
 * belongs to.
 */
const READER_SCRIPT = (
  global: string,
  selector: string,
  stateAttributes: readonly string[],
  maxStops: number,
): string => `
(async () => {
  const ns = window[${JSON.stringify(global)}];
  if (!ns || !ns.virtual) return null;
  const v = ns.virtual;
  const stateAttrs = ${JSON.stringify(stateAttributes)};

  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
      && !el.hasAttribute('disabled');
  };
  const describe = (el) => {
    const role = el.getAttribute('role');
    const name = (el.getAttribute('aria-label') || el.textContent || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 40);
    return '<' + el.tagName.toLowerCase() + (role ? '[role=' + role + ']' : '') + '>'
      + (name ? ' "' + name + '"' : '');
  };

  // The same selector and visibility rule as COLLECT_SCRIPT, minus its
  // aria-hidden clause: an interactive element hidden from the accessibility
  // tree is the thing this check wants to notice, so it has to stay in the
  // population rather than be filtered out of it.
  const targets = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(vis);
  if (targets.length === 0) return { readings: [], silent: [] };
  const indexOfTarget = (node) => {
    let el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    while (el) {
      const i = targets.indexOf(el);
      if (i !== -1) return i;
      el = el.parentElement;
    }
    return -1;
  };

  await v.start({ container: document.body });
  const found = new Map();
  const seen = new Set();
  try {
    for (let i = 0; i < ${maxStops}; i++) {
      const node = v.activeNode;
      const phrase = await v.lastSpokenPhrase();
      const sig = (node === null ? 'null' : indexOfTarget(node)) + '\\u0000' + phrase;
      if (seen.has(sig)) break;
      seen.add(sig);
      const t = indexOfTarget(node);
      // First announcement wins. The reader stops on a control and then on
      // the text inside it; the control's own stop comes first and is the
      // one that carries its role.
      if (t !== -1 && !found.has(t)) {
        const el = targets[t];
        found.set(t, {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          phrase: String(phrase == null ? '' : phrase),
          itemText: String((await v.itemText()) ?? ''),
          declaresState: stateAttrs.some((a) => el.hasAttribute(a)),
        });
      }
      await v.next();
    }
  } finally {
    await v.stop();
  }

  const silent = targets
    .map((el, i) => (found.has(i) ? null : describe(el)))
    .filter((x) => x !== null);
  return {
    readings: [...found.keys()].sort((a, b) => a - b).map((i) => found.get(i)),
    silent: silent,
  };
})()
`;

/**
 * Run the virtual screen reader against an open page.
 *
 * Every failure path returns null, which `checkScreenReader` reports as an
 * N/A with an install hint. Nothing here may produce a No: "the reader would
 * not load" and "the component is not accessible" are different claims, and
 * only one of them should cost a team points.
 */
async function probeScreenReader(
  page: PlaywrightPage,
  loadBundle: () => Promise<string | null>,
  maxStops: number,
  logger: Logger,
): Promise<ScreenReaderProbe | null> {
  let bundle: string | null;
  try {
    bundle = await loadBundle();
  } catch {
    bundle = null;
  }
  if (bundle === null) {
    logger.trace('preview: no virtual screen reader installed — CO4 not probed');
    return null;
  }

  const script = toClassicScript(bundle, READER_GLOBAL);
  if (script === null) {
    logger.trace(
      'preview: the virtual screen reader bundle has an unexpected shape — CO4 not probed',
    );
    return null;
  }

  try {
    await page.evaluate(script);
    const result = (await page.evaluate(
      READER_SCRIPT(READER_GLOBAL, INTERACTIVE_SELECTOR, STATE_ATTRIBUTES, maxStops),
    )) as { readings: ReaderReading[]; silent: string[] } | null;
    if (result === null) return null;
    return {
      stops: (result.readings ?? []).map(parseAnnouncement),
      silent: result.silent ?? [],
    };
  } catch (err) {
    logger.trace(`preview: screen reader not probed — ${(err as Error).message}`);
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
  const maxReaderStops = opts.maxReaderStops ?? DEFAULT_MAX_READER_STOPS;
  const load =
    opts.load ??
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('playwright') as unknown;
    });
  // The bundle is read off disk rather than `require`d: it is an ES module
  // for the browser, so importing it into Node would fail even where the
  // package is installed. Absence is a clean N/A, not an error.
  const loadScreenReader =
    opts.loadScreenReader ??
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('node:fs') as { readFileSync(p: string, enc: string): string };
        const resolved = require.resolve('@guidepup/virtual-screen-reader/browser.js');
        return fs.readFileSync(resolved, 'utf8');
      } catch {
        return null;
      }
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
    let screenReader: LiveProbe['screenReader'] = null;
    const expansion: ExpansionProbe[] = [];
    let expansionFailed = false;

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
          // Last of all. It reads the accessibility tree and moves only its
          // own virtual cursor, so it changes nothing the passes above
          // measured — but it is also the one pass that evaluates a third
          // party's code in the page, and it goes after everything this tool
          // measures itself.
          screenReader =
            interactiveCount === 0
              ? { stops: [], silent: [] }
              : await probeScreenReader(page, loadScreenReader, maxReaderStops, logger);
        }

        // Dead last at every width, because it rewrites the page's text.
        // Everything above is measured on a page nobody has edited — the
        // screen reader especially, whose announcements would otherwise all
        // come back pseudo-localized.
        const stressed = await probeExpansion(page, width, logger);
        if (stressed === null) expansionFailed = true;
        else expansion.push(stressed);
      } finally {
        await ctx.close().catch(() => undefined);
      }
    }

    return {
      url,
      interactiveCount,
      focusStops,
      unreachable,
      viewports,
      states,
      screenReader,
      // One width failing to stress is not a partial answer: the norm asks
      // whether the bounds hold, and an unmeasured width could be the one
      // that breaks. All or nothing, same as `states`.
      expansion: expansionFailed ? null : expansion,
    };
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
