import type { CheckResult } from './code-checks';

/**
 * Checks that need the component RENDERED, not read.
 *
 * CO3 (keyboard) and CO6 (breakpoints) were deliberately manual because
 * neither can be answered from source. "No onKeyDown" is not "not keyboard
 * accessible" — a `<button>` needs no handler at all — and no amount of CSS
 * reading tells you whether a component overflows at 320px, because that
 * depends on the fonts, the content and the container it ends up in.
 *
 * A browser answers both, so these checks take a probe of a running preview
 * rather than an AST. That is a different input contract from every other
 * check in this tool: it needs a URL per component that renders it in
 * isolation, which in practice means a Storybook (or equivalent) build. No
 * preview URL is a clean N/A, exactly like an unmapped Figma node — never a
 * No, because "we could not look" and "we looked and it fails" are different
 * claims and only one of them should cost a team points.
 *
 * What these checks deliberately do NOT claim:
 *   - That Space/Enter/arrow keys *do the right thing*. Reachability and a
 *     visible focus ring are objective; "the arrow keys move between tabs in
 *     the way this component intends" is not, without knowing the intent.
 *     Native controls come with activation semantics, so a preview whose
 *     interactive elements are all native is fully answered. One with custom
 *     widgets is answered N/A — verified reachable, activation still a
 *     human's call. Same reasoning as `checkAriaAttributes` returning N/A on
 *     spread props: a partial look is reported as partial.
 *   - That a layout is *good* at a given width. Only that nothing overflows
 *     the viewport, which is the part a machine can see.
 */

/** One Tab stop, in the order the browser visited it. */
export interface FocusStop {
  /** Lowercase tag name, e.g. "button". */
  tag: string;
  role: string | null;
  /** Accessible-ish name, trimmed for evidence. */
  name: string;
  /**
   * The focused element looks different from its resting state — an outline
   * is drawn, or a shadow/colour/border/text-decoration changed. WCAG 2.4.7.
   */
  focusVisible: boolean;
  /** A native control (button, a[href], input, select, textarea, summary). */
  native: boolean;
}

/** One viewport the preview was measured at. */
export interface ViewportProbe {
  width: number;
  height: number;
  /** The document scrolls sideways at this width. */
  horizontalScroll: boolean;
  scrollWidth: number;
  clientWidth: number;
  /** A few elements whose right edge sits past the viewport, for evidence. */
  overflowing: string[];
}

/** What one preview URL yielded. */
export interface LiveProbe {
  url: string;
  /** Visible, enabled interactive elements found in the preview. */
  interactiveCount: number;
  /** Tab stops, in order. */
  focusStops: FocusStop[];
  /** Interactive elements Tab never reached, described for evidence. */
  unreachable: string[];
  viewports: ViewportProbe[];
}

/**
 * Why there is no probe, when there is none. Mirrors `DocsFacts.absence`:
 * each reason reads differently in the report, and none of them is a No.
 */
export type LiveAbsence = 'unmapped' | 'no-prober' | 'unreachable';

export interface LiveFacts {
  componentName: string;
  /** The probe, or null when there was nothing to look at. */
  probe: LiveProbe | null;
  absence: LiveAbsence | null;
  /** Detail for the absence, e.g. the navigation error. */
  absenceDetail?: string;
}

type Params = Record<string, unknown>;

export type LiveCheck = (facts: LiveFacts, params?: Params) => CheckResult;

/** `params: { widths: [...] }` on a breakpoints norm. */
export const WIDTHS_KEY = 'widths';

/**
 * Widths probed when a norm names none.
 *
 * Chosen to bracket the common CSS breakpoints rather than to sit on them:
 * 320 is the narrowest viewport WCAG 1.4.10 expects to work, 1920 is the
 * widest common desktop, and the rest are the phone / tablet / laptop sizes
 * most systems already name. Teams with their own scale should set
 * `params: { widths: [...] }` — the point is to probe the edges of each of
 * YOUR breakpoints, since a layout breaks at the boundary, not in the middle
 * of a range.
 */
export const DEFAULT_BREAKPOINT_WIDTHS: readonly number[] = [320, 375, 768, 1024, 1280, 1920];

/** Viewport height used for every width. Tall enough not to force scroll. */
export const PROBE_VIEWPORT_HEIGHT = 900;

export function requestedWidths(params?: Params): number[] {
  const raw = params?.[WIDTHS_KEY];
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_BREAKPOINT_WIDTHS];
  return [...new Set(raw.filter((w): w is number => typeof w === 'number' && w > 0))].sort(
    (a, b) => a - b,
  );
}

function describe(stop: FocusStop): string {
  const name = stop.name === '' ? '' : ` "${stop.name}"`;
  const role = stop.role === null ? '' : `[role=${stop.role}]`;
  return `<${stop.tag}${role}>${name}`;
}

/** The absence branch both checks share: no probe is never a failing score. */
function noProbe(facts: LiveFacts): CheckResult {
  switch (facts.absence) {
    case 'no-prober':
      return {
        answer: 'N/A',
        evidence:
          'a preview URL is mapped, but no page renderer is installed — run ' +
          '`npm i -D playwright` and `npx playwright install chromium` to score it',
      };
    case 'unreachable':
      return {
        answer: 'N/A',
        evidence: `preview could not be probed: ${facts.absenceDetail ?? 'unknown error'}`,
      };
    default:
      return {
        answer: 'N/A',
        evidence: 'no preview URL mapped for this component — add `preview:` to score it',
      };
  }
}

/**
 * CO3 — the component is reachable and operable by keyboard.
 *
 * Verdict order matters: an unreachable element is a worse failure than a
 * missing focus ring, and reporting the ring first would bury it.
 */
export function checkKeyboardAccess(facts: LiveFacts): CheckResult {
  if (facts.probe === null) return noProbe(facts);
  const { interactiveCount, focusStops, unreachable } = facts.probe;

  if (interactiveCount === 0) {
    return {
      answer: 'N/A',
      evidence: 'preview renders no interactive elements — nothing to reach by keyboard',
    };
  }

  if (unreachable.length > 0) {
    return {
      answer: 'No',
      evidence:
        `${unreachable.length} of ${interactiveCount} interactive element(s) cannot be ` +
        `reached by Tab: ${unreachable.slice(0, 5).join(', ')}`,
    };
  }

  const invisible = focusStops.filter((s) => !s.focusVisible);
  if (invisible.length > 0) {
    return {
      answer: 'No',
      evidence:
        `${invisible.length} of ${focusStops.length} Tab stop(s) show no focus indicator ` +
        `(WCAG 2.4.7): ${invisible.slice(0, 5).map(describe).join(', ')}`,
    };
  }

  const custom = focusStops.filter((s) => !s.native);
  if (custom.length > 0) {
    return {
      answer: 'N/A',
      evidence:
        `all ${focusStops.length} Tab stop(s) are reachable with a visible focus indicator, ` +
        `but ${custom.length} are custom widget(s) — their Space/Enter/arrow handling needs ` +
        `a human: ${custom.slice(0, 5).map(describe).join(', ')}`,
    };
  }

  return {
    answer: 'Yes',
    evidence:
      `all ${focusStops.length} interactive element(s) are Tab-reachable with a visible focus ` +
      'indicator, and all are native controls (so Space/Enter/arrows come from the platform)',
  };
}

/** CO6 — the component survives every breakpoint it is probed at. */
export function checkBreakpoints(facts: LiveFacts, params?: Params): CheckResult {
  if (facts.probe === null) return noProbe(facts);
  const wanted = requestedWidths(params);
  const { viewports } = facts.probe;

  if (viewports.length === 0) {
    return { answer: 'N/A', evidence: 'preview was probed at no widths' };
  }

  const probed = new Set(viewports.map((v) => v.width));
  const missing = wanted.filter((w) => !probed.has(w));
  if (missing.length > 0) {
    return {
      answer: 'N/A',
      evidence: `preview was not probed at ${missing.join(', ')}px — rerun the scan`,
    };
  }

  const failing = viewports.filter(
    (v) => wanted.includes(v.width) && (v.horizontalScroll || v.overflowing.length > 0),
  );

  if (failing.length > 0) {
    const detail = failing
      .slice(0, 4)
      .map((v) => {
        const by = v.scrollWidth - v.clientWidth;
        const culprits = v.overflowing.length > 0 ? ` (${v.overflowing.slice(0, 3).join(', ')})` : '';
        return `${v.width}px: overflows by ${Math.max(by, 0)}px${culprits}`;
      })
      .join('; ');
    return {
      answer: 'No',
      evidence: `content overflows the viewport at ${failing.length} of ${wanted.length} width(s) — ${detail}`,
    };
  }

  return {
    answer: 'Yes',
    evidence: `no horizontal overflow at ${wanted.join(', ')}px`,
  };
}

export const LIVE_CHECKS: Record<string, LiveCheck> = {
  'code.keyboard': checkKeyboardAccess,
  'code.breakpoints': checkBreakpoints,
};
