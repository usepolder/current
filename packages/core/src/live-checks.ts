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
 * CO1 (interaction states) is here for a third reason. Its states are a
 * *visual* claim — "displays hover" is not "declares a :hover rule", and the
 * rule itself usually lives in a stylesheet, a Tailwind string or a primitive
 * the component wraps, none of which the component's own AST can see. A
 * browser can force the pointer states and watch what changes, which is the
 * claim the guideline actually makes.
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
 *   - That a component covers ALL the states CO1 lists. Three of the nine
 *     (hover, pressed, focus) can be forced on a rendered element. Loading,
 *     selected, active, error and disabled need the component driven through
 *     its props, which one preview URL cannot do, and *which* states a given
 *     component needs is the judgment the metric is really asking for. So a
 *     clean state probe is an N/A, never a Yes: it can prove a missing state,
 *     not a complete set. See `checkStates`.
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

/**
 * One interactive element's visible response to the states a browser can
 * force on it, each compared against that element's own baseline style —
 * same comparison as `FocusStop.focusVisible`, and for the same reason: a
 * design system may signal hover with a background, a border, a shadow, a
 * lift or an underline, and a probe that looked for one named property would
 * report a No on every system that chose another.
 */
export interface StateProbe {
  /** Lowercase tag name, e.g. "button". */
  tag: string;
  role: string | null;
  /** Accessible-ish name, trimmed for evidence. */
  name: string;
  /** `:hover` changes how it looks. */
  hover: boolean;
  /** `:hover:active` changes how it looks — the pressed state. */
  pressed: boolean;
  /**
   * From the Tab walk, when it reached this element. `null` when it did not:
   * unreachable is CO3's finding to report, and CO1 must not charge a
   * component twice for it.
   */
  focus: boolean | null;
  /**
   * A native form field (`input`, `textarea`, `select`). These are judged on
   * focus alone: the platform styles them, and they signal interaction by
   * focusing rather than by lighting up under the pointer. Judging a text box
   * on its hover feedback would report a No on every form in the system.
   */
  formField: boolean;
}

/**
 * What a screen reader announced for one interactive element.
 *
 * Collected by driving `@guidepup/virtual-screen-reader` over the rendered
 * preview — a screen reader implemented in JavaScript against the
 * accessibility tree, so it needs no OS, no AT install and no platform gate.
 * The fields are deliberately the reader's own output rather than the DOM's:
 * what a screen reader user gets is the announcement, not the markup that
 * produced it.
 */
export interface ScreenReaderStop {
  /** Lowercase tag name, e.g. "button". */
  tag: string;
  /** The `role` attribute, when the element sets one. For evidence. */
  role: string | null;
  /** What the reader announced, verbatim: `button, Save changes`. */
  phrase: string;
  /**
   * The role the reader named, or null when it announced no role at all —
   * which is what a focusable `<div>` with no role sounds like: its text and
   * nothing else.
   */
  spokenRole: string | null;
  /** The accessible name the reader announced; empty when it announced none. */
  name: string;
  /** The reader announced a state for it: `not checked`, `collapsed`. */
  spokenState: boolean;
  /**
   * This element's role carries a state a reader is expected to announce
   * (checkbox, radio, switch, tab, option, a button with a popup). A role
   * with no state to announce — plain `button`, `link` — is false here, and
   * silence about its state is correct rather than a finding.
   */
  expectsState: boolean;
}

/**
 * What the virtual screen reader made of one preview.
 *
 * `null` on `LiveProbe.screenReader` is "we could not look" — the reader is
 * not installed, or the page would not take it — which is an N/A. An empty
 * `stops` array is different: the reader ran and found nothing interactive
 * to announce.
 */
export interface ScreenReaderProbe {
  /** One entry per interactive element the reader announced. */
  stops: ScreenReaderStop[];
  /**
   * Interactive elements the reader never announced, described for evidence.
   * Usually `aria-hidden` over something a pointer can still reach.
   */
  silent: string[];
}

/**
 * What one viewport looked like with the component's text expanded.
 *
 * Every field is a DIFFERENCE against the same measurement taken before the
 * text was touched. That is not a refinement, it is the whole validity of the
 * check: measured against real markup, a flex row whose children already
 * spilled and a button whose label was already clipped both showed up as
 * findings, and charging CO10 for breakage that pre-dates the expansion would
 * be reporting someone else's bug under this norm.
 */
export interface ExpansionProbe {
  width: number;
  /** Text runs that were expanded. Zero means there was nothing to stress. */
  textNodes: number;
  /** Characters of original text, for the evidence. */
  chars: number;
  /** The document scrolls sideways now and did not before. */
  viewportOverflow: boolean;
  /** How far past the viewport, in points. */
  overflowBy: number;
  /**
   * Elements whose text is now cut off with no declared limit: clipped by
   * `overflow: hidden` with no `text-overflow: ellipsis`, no line clamp and
   * no `max-width`/`max-height`. An author who declared any of those said the
   * text may be truncated, which is CO10 being satisfied rather than failed.
   */
  clipped: string[];
  /** Elements whose content now spills out of a container that does not clip. */
  spilling: string[];
}

/**
 * One text element's contrast verdict, as the engine reported it.
 *
 * `resolved` is the field that matters. Contrast is one of very few
 * accessibility claims with a real arithmetic answer — a computed ratio
 * against a threshold — but only when the effective background can actually
 * be determined. Text over an image, text whose foreground and background
 * resolve to the same colour, text with a shadow: in each case the engine
 * declines to commit rather than guessing, and a guess is the one thing this
 * norm must not do, in either direction.
 */
export interface ContrastFinding {
  /** Lowercase tag name, e.g. "button". */
  tag: string;
  /** The engine's DOM path, for finding the element again. */
  path: string;
  /** Whether the engine could determine the effective background at all. */
  resolved: boolean;
  /** Meets the AA ratio for its size and weight. Only meaningful if resolved. */
  passes: boolean;
  /** The engine's own message, which carries the ratio, size and weight. */
  message: string;
}

/**
 * What the contrast engine made of one preview.
 *
 * `null` is "we could not look" — the engine is not installed, or the page
 * would not take it — which is an N/A. An empty `findings` array is
 * different: the engine ran and the component renders no text.
 */
export interface ContrastProbe {
  findings: ContrastFinding[];
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
  /**
   * One entry per interactive element, or `null` when the renderer could not
   * force pseudo-states at all (no CDP session, a protocol that refused).
   * Null is "we could not look", which is an N/A, not a No.
   */
  states: StateProbe[] | null;
  /**
   * What a virtual screen reader announced, or `null` when it could not be
   * run — same contract as `states`, and for the same reason.
   */
  screenReader: ScreenReaderProbe | null;
  /**
   * One entry per width, with the component's text pseudo-localized, or
   * `null` when the page could not be stressed at all. Same contract again.
   */
  expansion: ExpansionProbe[] | null;
  /**
   * Text contrast as a WCAG engine measured it, or `null` when the engine
   * could not be run. Same contract again.
   */
  contrast: ContrastProbe | null;
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

function describe(el: { tag: string; role: string | null; name: string }): string {
  const name = el.name === '' ? '' : ` "${el.name}"`;
  const role = el.role === null ? '' : `[role=${el.role}]`;
  return `<${el.tag}${role}>${name}`;
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

/** Evidence lists are capped: five named elements is enough to act on. */
const EVIDENCE_LIMIT = 5;

/**
 * CO1 — the component visibly responds to the interaction states a browser
 * can put it in.
 *
 * Verdict order follows how much each absence costs a user. No hover
 * feedback leaves a pointer user unsure the thing is interactive at all. No
 * focus indicator is the same for a keyboard user, and is also CO3's finding
 * (deliberately: the audit sheet lists focus under CO1's own note, and a
 * component with no focus ring is failing both norms, not one). A missing
 * pressed state is a real gap in the list this metric names, but the control
 * has already told the user it is live, so it reports last.
 *
 * A clean probe answers N/A, not Yes, and the evidence says why: six of the
 * nine states this metric lists cannot be reached from one preview URL, so
 * "nothing missing in what we could force" is not "all necessary states are
 * present". A human answer in `.polder.answers.yml` still wins over any of
 * this, which is how a team records the full judgment.
 */
export function checkStates(facts: LiveFacts): CheckResult {
  // Every N/A below is "could not settle", not "does not apply" — except the
  // one for a preview with nothing interactive in it, which is settled: a
  // component nobody can interact with displays no interaction states.
  if (facts.probe === null) return { ...noProbe(facts), needsHuman: true };
  const { interactiveCount, states } = facts.probe;

  if (interactiveCount === 0) {
    return {
      answer: 'N/A',
      evidence: 'preview renders no interactive elements — no interaction states to display',
    };
  }

  if (states === null) {
    return {
      answer: 'N/A',
      evidence:
        'the renderer could not force :hover / :active on this preview, so no interaction ' +
        'state could be measured',
      needsHuman: true,
    };
  }

  if (states.length === 0) {
    return {
      answer: 'N/A',
      evidence: `none of the ${interactiveCount} interactive element(s) could be measured for states`,
      needsHuman: true,
    };
  }

  // Native form fields are judged on focus alone — see `StateProbe.formField`.
  const controls = states.filter((s) => !s.formField);

  const flat = controls.filter((s) => !s.hover);
  if (flat.length > 0) {
    return {
      answer: 'No',
      evidence:
        `${flat.length} of ${controls.length} control(s) look identical on hover: ` +
        flat.slice(0, EVIDENCE_LIMIT).map(describe).join(', '),
    };
  }

  const unfocused = states.filter((s) => s.focus === false);
  if (unfocused.length > 0) {
    return {
      answer: 'No',
      evidence:
        `${unfocused.length} of ${states.length} element(s) show no focus state (WCAG 2.4.7): ` +
        unfocused.slice(0, EVIDENCE_LIMIT).map(describe).join(', '),
    };
  }

  const unpressed = controls.filter((s) => !s.pressed);
  if (unpressed.length > 0) {
    return {
      answer: 'No',
      evidence:
        `${unpressed.length} of ${controls.length} control(s) look identical while pressed: ` +
        unpressed.slice(0, EVIDENCE_LIMIT).map(describe).join(', '),
    };
  }

  const verified =
    controls.length > 0
      ? `hover and pressed are visible on all ${controls.length} control(s)`
      : `all ${states.length} element(s) are native form fields, judged on focus alone`;
  const focused = states.filter((s) => s.focus === true).length;
  const focusNote = focused > 0 ? `, and focus on ${focused} of them` : '';

  return {
    answer: 'N/A',
    evidence:
      `${verified}${focusNote} — the states one preview cannot reach (loading, selected, ` +
      "active, error, disabled) stay a human's call",
    needsHuman: true,
  };
}

/**
 * CO4 — the component is accessible by screen reader.
 *
 * This check can prove a component is NOT screen-reader accessible. It
 * cannot prove it is. Both halves of that matter.
 *
 * The No cases are objective and are the component's own fault. An
 * interactive element that reaches the accessibility tree with no accessible
 * name is announced as a bare "button", which tells a screen reader user
 * there is something here and nothing about what it does. An element with
 * interaction wired to it but no role is announced as its text and nothing
 * else — a focusable `<div>` sounds exactly like a paragraph. A control that
 * declares a state the reader never announces is a toggle whose user cannot
 * hear whether it is on. Each of those costs a real user something, and
 * currently nothing in this tool looks for them on either axis.
 *
 * That third one is narrower than it first appears, and the narrowing is the
 * point. It does NOT fire on a control that simply omits its state attribute:
 * a `role="switch"` with no `aria-checked` is still announced
 * `switch, Dark mode, not checked`, because the reader supplies the implicit
 * default, so the state does reach the user. It fires where the author
 * declared a state on a role that cannot carry one and the reader drops it
 * silently — `<a href aria-pressed="true">` announces `link, More`,
 * `<div role="button" aria-checked="true">` announces `button, Toggle`. The
 * attribute is in the markup, the intent is obvious, and none of it is
 * audible. See `STATE_ATTRIBUTES` for the measurements.
 *
 * The clean case is **N/A and never Yes**, for the same reason `checkStates`
 * is: the metric asks whether a screen reader user can *use* the component,
 * and a virtual reader walking a tree cannot establish that. Guidepup's own
 * virtual reader says it is not a substitute for testing with real
 * assistive technology. Announcing Yes off it would be this tool claiming a
 * verdict it did not earn, which is the failure mode #1 and #3 were about.
 * Real NVDA and VoiceOver are the only thing that can turn that N/A into a
 * Yes; that is #33, a second driver behind this same check id, off by
 * default because it needs a Windows or macOS runner.
 *
 * Verdict order follows what each failure costs. An unnamed control is the
 * worst: the user cannot tell what it is. A missing role is next: the user
 * does not know it is a control at all, though at least hears the text. A
 * missing state is last: the user knows what the control is and can act on
 * it, but not what it is currently set to.
 */
export function checkScreenReader(facts: LiveFacts): CheckResult {
  // Like checkStates, every N/A here is "could not settle" rather than "does
  // not apply", except the one for a preview with nothing interactive in it.
  if (facts.probe === null) return { ...noProbe(facts), needsHuman: true };
  const { interactiveCount, screenReader } = facts.probe;

  if (interactiveCount === 0) {
    return {
      answer: 'N/A',
      evidence: 'preview renders no interactive elements — nothing for a screen reader to operate',
    };
  }

  if (screenReader === null) {
    return {
      answer: 'N/A',
      evidence:
        'no virtual screen reader is installed — run ' +
        '`npm i -D @guidepup/virtual-screen-reader` to score it',
      needsHuman: true,
    };
  }

  const { stops, silent } = screenReader;

  if (stops.length === 0) {
    return {
      answer: 'N/A',
      evidence:
        `the screen reader announced none of the ${interactiveCount} interactive element(s), ` +
        'so nothing could be measured',
      needsHuman: true,
    };
  }

  const unnamed = stops.filter((s) => s.name === '');
  if (unnamed.length > 0) {
    return {
      answer: 'No',
      evidence:
        `${unnamed.length} of ${stops.length} interactive element(s) reach the accessibility ` +
        `tree with no accessible name: ${describeStops(unnamed)}`,
    };
  }

  const unroled = stops.filter((s) => s.spokenRole === null);
  if (unroled.length > 0) {
    return {
      answer: 'No',
      evidence:
        `${unroled.length} of ${stops.length} interactive element(s) are announced with no ` +
        `role, so a screen reader user cannot tell they are controls: ${describeStops(unroled)}`,
    };
  }

  const stateless = stops.filter((s) => s.expectsState && !s.spokenState);
  if (stateless.length > 0) {
    return {
      answer: 'No',
      evidence:
        `${stateless.length} of ${stops.length} control(s) declare a state the screen reader ` +
        `never announces, so a user cannot tell which way they are set — usually an aria-* ` +
        `state on a role that does not carry one: ${describeStops(stateless)}`,
    };
  }

  // aria-hidden over something a pointer can still reach. Reported, not
  // scored: hiding a control from the AT is sometimes deliberate (a
  // duplicate of one already announced), and this check cannot tell which.
  const hidden =
    silent.length > 0
      ? `; ${silent.length} interactive element(s) were never announced (${silent
          .slice(0, EVIDENCE_LIMIT)
          .join(', ')}) — check whether that is deliberate`
      : '';

  return {
    answer: 'N/A',
    evidence:
      `all ${stops.length} interactive element(s) announce a role and a name` +
      `${hidden} — whether a screen reader user can actually complete the task is a ` +
      "human's call, or #33's real NVDA/VoiceOver run",
    needsHuman: true,
  };
}

/** `<button> "Save"` for each, capped. Phrase-aware: names what was heard. */
function describeStops(stops: readonly ScreenReaderStop[]): string {
  return stops
    .slice(0, EVIDENCE_LIMIT)
    .map((s) => {
      const role = s.role === null ? '' : `[role=${s.role}]`;
      const heard = s.phrase === '' ? 'nothing announced' : `announced "${s.phrase}"`;
      return `<${s.tag}${role}> ${heard}`;
    })
    .join(', ');
}

/**
 * CO10 — the component declares its bounds, and they hold when the text grows.
 *
 * CO10 was manual with no reason recorded against it, unlike CO4 and DE2
 * whose manual status was forced by what an API exposed. It was manual
 * because nobody had built the check.
 *
 * Pseudo-localization is the check. Render the component with its text
 * replaced by accented, expanded content — `[Śàṽéàé ćĥàńĝéśàéî]`, about 40%
 * longer — and the failures this norm is really about become visible: a label
 * that overflows its container, a button that grows past the viewport, text
 * clipped at a limit nobody declared, a layout that only ever held together
 * because English is short.
 *
 * This is not a localisation metric, and the distinction matters because CO11
 * was removed for being a language question. Pseudo-localization never tests
 * a language — its output is not a language. It is a text-expansion stress
 * test, and text expansion is exactly the force that reveals whether min and
 * max dimensions were declared. The claim stays "the component declares its
 * bounds", which is CO10's claim; the pseudo-locale is only the lever that
 * makes an undeclared bound observable.
 *
 * This is the first live check with a genuine **Yes**, and it is defensible
 * where CO1's and CO4's would not be. "Does this component hold at +40% text"
 * is an objective question with an observable answer, unlike "are all
 * necessary states present" or "can a screen reader user succeed". CO6
 * already measures overflow in the browser; this is the same measurement
 * under a different stressor, which is a good sign the check belongs where it
 * is going.
 *
 * What it deliberately does NOT claim:
 *
 *   - That the bounds are the RIGHT bounds. Only that bounds exist and hold.
 *   - That the component is translated, translatable or RTL-safe. Mirroring
 *     is a different check and is not in scope; if it is ever wanted it is
 *     its own norm, not a quiet extension of this one.
 *   - Anything about text the CONSUMER supplies. A component handed a
 *     400-character label by its caller is not failing CO10, which is part of
 *     why the expansion is proportional to the text that is actually there.
 */
export function checkTextExpansion(facts: LiveFacts): CheckResult {
  if (facts.probe === null) return noProbe(facts);
  const { expansion } = facts.probe;

  if (expansion === null) {
    return {
      answer: 'N/A',
      evidence: 'the preview could not be re-rendered with expanded text, so no bound was tested',
    };
  }
  if (expansion.length === 0) {
    return { answer: 'N/A', evidence: 'preview was not probed at any width' };
  }

  const widths = expansion.map((e) => e.width);
  const expanded = expansion.filter((e) => e.textNodes > 0);
  if (expanded.length === 0) {
    // Settled, not "could not look": a component with no text cannot have a
    // text-expansion failure, and asking a human to judge one would be
    // asking about something that is not there.
    return {
      answer: 'N/A',
      evidence: 'preview renders no text, so there is no text expansion to withstand',
    };
  }

  const chars = Math.max(...expanded.map((e) => e.chars));

  // Verdict order follows how much of the component each failure takes with
  // it. Pushing the viewport sideways breaks the page around the component.
  // Spilling out of a container breaks the component's own layout. Clipping
  // keeps the layout and loses the words, which is the smallest of the three
  // and still a No.
  const overflowed = expansion.filter((e) => e.viewportOverflow);
  if (overflowed.length > 0) {
    const detail = overflowed
      .slice(0, 4)
      .map((e) => `${e.width}px: overflows by ${e.overflowBy}px`)
      .join('; ');
    return {
      answer: 'No',
      evidence:
        `with text expanded by ~40%, content overflows the viewport at ${overflowed.length} ` +
        `of ${widths.length} width(s) — ${detail}`,
    };
  }

  const spilling = expansion.filter((e) => e.spilling.length > 0);
  if (spilling.length > 0) {
    const detail = spilling
      .slice(0, 4)
      .map((e) => `${e.width}px: ${e.spilling.slice(0, 3).join(', ')}`)
      .join('; ');
    return {
      answer: 'No',
      evidence:
        `with text expanded by ~40%, content spills out of its container at ` +
        `${spilling.length} of ${widths.length} width(s) — ${detail}`,
    };
  }

  const clipped = expansion.filter((e) => e.clipped.length > 0);
  if (clipped.length > 0) {
    const detail = clipped
      .slice(0, 4)
      .map((e) => `${e.width}px: ${e.clipped.slice(0, 3).join(', ')}`)
      .join('; ');
    return {
      answer: 'No',
      evidence:
        `with text expanded by ~40%, text is cut off with no declared limit at ` +
        `${clipped.length} of ${widths.length} width(s) — no ellipsis, line clamp or max-* ` +
        `says it may truncate: ${detail}`,
    };
  }

  return {
    answer: 'Yes',
    evidence:
      `${chars} character(s) of text expanded by ~40% with no overflow, spill or undeclared ` +
      `truncation at ${widths.join(', ')}px`,
  };
}

/**
 * CO13 — text contrast meets WCAG AA in the rendered component.
 *
 * This norm was added rather than converted, and it is the one place in this
 * rubric where that was the right move: contrast is the most common real
 * accessibility defect in a design system, and until now no norm looked for
 * it on the code side at all.
 *
 * **It is not DE2, and must never be described as answering DE2.** DE2 is a
 * design norm, scored against the component's Figma node, asking whether the
 * contrast in the DESIGN passes AA. Every engine in this family audits
 * rendered HTML in a browser; none of them can read a Figma node. Pointing
 * one at DE2 would not automate DE2, it would silently replace a design-axis
 * measurement with a code-axis one — and the quadrant IS the product. X is
 * code health, Y is design health, and Critical is the top-left: strong in
 * Figma, weak in code. Answering DE2 from the implementation puts a
 * measurement of X inside Y, and hides exactly the failure the quadrant
 * exists to surface: a designer's variant using a raw grey that a developer
 * already fixed with a token would score DE2 Yes with the design debt
 * invisible. For a design system that is the common direction of drift, not
 * an edge case. #29 settled the governing principle — a claim belongs on the
 * side where the evidence lives — which is why DE11 was folded into CO12.
 * Contrast evidence from a browser lives on the code side, so it gets a code
 * norm, and DE2 stays manual.
 *
 * Scoped to contrast and nothing else, which is the real trap here. An
 * unscoped run of a WCAG engine returns a full audit, and this rubric already
 * has norms for most of what comes back: CO2 owns ARIA attributes, CO3 owns
 * keyboard reachability and focus, CO5 owns text alternatives, CO4 owns what
 * reaches the AT. Scoring everything the engine reports would re-answer four
 * existing norms from a second source — the DE11/CO12 duplication again, four
 * times over — and would quietly reweight the A11y subcategory against
 * everything else, which the README explicitly forbids as a way to make
 * something matter more. The engine's other output is diagnostics for a
 * human, not score input.
 *
 * Text only, and the title says so. The engine has no WCAG 1.4.11 rule, so
 * non-text contrast — an icon against its background, a focus ring against
 * the surface it sits on — is not covered by anything here. Naming this norm
 * for icons as well would be claiming a measurement that does not exist.
 */
export function checkContrast(facts: LiveFacts): CheckResult {
  if (facts.probe === null) return { ...noProbe(facts), needsHuman: true };
  const { contrast } = facts.probe;

  if (contrast === null) {
    return {
      answer: 'N/A',
      evidence:
        'no contrast engine is installed — run `npm i -D accessibility-checker-engine` to score it',
      needsHuman: true,
    };
  }

  const { findings } = contrast;
  if (findings.length === 0) {
    // Settled: a component with no text cannot have a text-contrast defect.
    return {
      answer: 'N/A',
      evidence: 'preview renders no text, so there is no text contrast to measure',
    };
  }

  const failing = findings.filter((f) => f.resolved && !f.passes);
  if (failing.length > 0) {
    return {
      answer: 'No',
      evidence:
        `${failing.length} of ${findings.length} text element(s) fail the WCAG AA contrast ` +
        `ratio: ${failing.slice(0, EVIDENCE_LIMIT).map(describeContrast).join('; ')}`,
    };
  }

  // Some text passed and some could not be measured, so "all text meets AA"
  // is not established. Partial looks are reported as partial here as
  // everywhere else: `checkAriaAttributes` does the same on spread props.
  const unresolved = findings.filter((f) => !f.resolved);
  if (unresolved.length > 0) {
    const passed = findings.length - unresolved.length;
    return {
      answer: 'N/A',
      evidence:
        `${passed} of ${findings.length} text element(s) meet the WCAG AA contrast ratio, but ` +
        `the effective background of ${unresolved.length} could not be determined: ` +
        `${unresolved.slice(0, EVIDENCE_LIMIT).map(describeContrast).join('; ')}`,
      needsHuman: true,
    };
  }

  return {
    answer: 'Yes',
    evidence: `all ${findings.length} text element(s) meet the WCAG AA contrast ratio`,
  };
}

/** `<button> Text contrast of 1.61 …` — the engine's own words, which carry the ratio. */
function describeContrast(f: ContrastFinding): string {
  return `<${f.tag}> ${f.message}`;
}

export const LIVE_CHECKS: Record<string, LiveCheck> = {
  'code.keyboard': checkKeyboardAccess,
  'code.breakpoints': checkBreakpoints,
  'code.states': checkStates,
  'code.screenreader': checkScreenReader,
  'code.text-expansion': checkTextExpansion,
  'code.contrast': checkContrast,
};
