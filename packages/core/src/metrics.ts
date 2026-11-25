/**
 * The 28 default metrics, transcribed from a production design system's "Component Health"
 * audit sheet (Template tab). Teams can disable any of them or flip an
 * automated one to manual in `.polder.yml`; this is a starting point, not a
 * fixed rubric.
 *
 * Four of the sheet's norms are not here, and this comment block is the
 * record of why. Ids are never renumbered — DE9 stays DE9 — so existing
 * answer files keep pointing at the norms they were written for, and each gap
 * in the sequence is the record of what was dropped.
 *
 *   - DE8 ("all layers, groups and frames are necessary") is tidiness: no
 *     reader of the quadrant acts on it, and no API field answers it, so it
 *     was a permanent manual question whose only effect was to make the
 *     design axis look unanswered.
 *   - DE11 ("Figma component reflects what's in code") asked exactly what
 *     CO12 asks, from the other side, and a rubric that scores one claim
 *     twice weights it twice; CO12 keeps it, now answered from Code Connect.
 *   - CO11 ("component is usable in all supported languages") is language
 *     testing, which belongs to the design process rather than to a
 *     component-health check. Its own note conceded the point: "can only be
 *     checked in production". A norm that cannot be answered where the audit
 *     runs is not a norm, it is a reminder — and it scored every adopter
 *     anyway. What CO11 orphaned that WAS automatable is i18n key coverage;
 *     that sits in TODOS.md, because being adjacent to a deleted norm does
 *     not earn a metric.
 *   - DO1 ("component statuses are up to date") is a relic of the first
 *     design system this rubric was transcribed from. Status taxonomies are
 *     per-system and plenty of systems have none, so the metric was
 *     inapplicable for most adopters while still scoring them. Its removal
 *     is what takes the documentation axis to fully automated.
 *
 * `check` is the id of an automated check, or null when only a human can
 * answer. Four input contracts are in play: static checks read the
 * component's source, design checks read its Figma node, `code.keyboard` /
 * `code.breakpoints` / `code.states` probe a rendered `preview:` URL in a
 * real browser — the only way to answer those three, and the reason they are
 * no longer null — and `code.figma-connect` reads the repo's Code Connect
 * mappings, which is where the code/design correspondence is actually
 * written down. What is automatable was settled by probing Figma's published
 * OpenAPI spec (figma/rest-api-spec): `AnnotationsTrait` is declared with an
 * empty property bag, so the REST API exposes no accessibility annotations —
 * which is why DE2 stays manual. CO4 escaped that constraint by moving to the
 * side where the evidence lives: a rendered page has an accessibility tree,
 * and a virtual screen reader reads it. `layoutMode`,
 * `boundVariables`, `componentPropertyDefinitions`, `cornerRadius` and
 * `transitionNodeID` ARE returned, so the token/auto-layout/prototyping
 * checks are real.
 *
 * DE6 rests on one more field from the same spec, with a caveat worth
 * recording: `ComponentPropertiesTrait` declares `variantOptions` ("all
 * possible values for this property, only exists on VARIANT properties") on
 * both `ComponentNode` and `ComponentSetNode`, so a `State` variant's options
 * are spec-declared — but this project has not yet seen them on a live file,
 * because the dogfood example has no real Figma file behind it. The `#1:2`
 * suffix on property keys is the opposite case: observed on every real file,
 * documented nowhere, which is why every reader here strips it when present
 * and never requires it. That gap has bitten this codebase once already —
 * the design-axis validation found a check reading bound-variable keys Figma
 * never emits, wrong on every component it looked at — so DE6's first run
 * against a real file is the evidence that still has to be collected.
 */

export type MetricCategory = 'code' | 'design' | 'documentation';

export type Answer = 'Yes' | 'No' | 'N/A';

export interface MetricDef {
  id: string;
  category: MetricCategory;
  subcategory: string;
  guideline: string;
  note?: string;
  /** Automated check id, or null when the metric is human-judgment only. */
  check: string | null;
  /** Check-specific configuration, e.g. which doc headings satisfy it. */
  params?: Record<string, unknown>;
}

export const DEFAULT_METRICS: readonly MetricDef[] = [
  // ---- Code (component implementation) ----
  {
    id: 'CO1',
    category: 'code',
    subcategory: 'A11y',
    guideline: 'Component encompasses and displays all necessary interaction states',
    note: 'Default, hover, pressed, focus, loading, selected, active, error, disabled',
    // "Displays" is a visual claim, and the rules behind it usually sit in a
    // stylesheet, a utility-class string or a wrapped primitive, so the
    // component's own source cannot answer it. A rendered `preview:` can:
    // hover, pressed and focus are forced on each interactive element and
    // compared with its resting style. The other six states need the
    // component driven through its props, and *which* states are "necessary"
    // is the judgment the metric is really asking for — so a clean probe is
    // an N/A, never a Yes. It can prove a missing state, not a complete set.
    check: 'code.states',
  },
  {
    id: 'CO2',
    category: 'code',
    subcategory: 'A11y',
    guideline: 'ARIA attributes are defined',
    check: 'code.aria-attributes',
  },
  {
    id: 'CO3',
    category: 'code',
    subcategory: 'A11y',
    guideline: 'Component is accessible by keyboard',
    note: 'Including space, enter and arrow keys to navigate or interact',
    // Not answerable from source: native elements are keyboard-accessible
    // with no explicit handler, so "no onKeyDown" would produce constant
    // false "No"s. Answered instead by probing a rendered `preview:` — Tab
    // reachability and a visible focus ring. Components with no preview
    // mapped report N/A and stay a human's call.
    check: 'code.keyboard',
  },
  {
    id: 'CO4',
    category: 'code',
    subcategory: 'A11y',
    guideline: 'Component is accessible by screenreader',
    // The note used to read `cmd + f5 to enable the screenreader`, which is
    // an instruction to a human rather than a check. A virtual screen reader
    // reads the accessibility tree of the rendered preview, so the No cases
    // — unnamed control, interaction with no role, a state the reader never
    // announces — are now found by machine. The clean case stays N/A: a
    // virtual AT cannot establish that a screen reader user can USE the
    // component, which is what the guideline asks. Only real NVDA or
    // VoiceOver can, and that is a second driver behind this same check id.
    note: 'Answered from a virtual screen reader against the rendered preview',
    check: 'code.screenreader',
  },
  {
    id: 'CO5',
    category: 'code',
    subcategory: 'A11y',
    guideline:
      'Non-text content (images, icons) have a text alternative that serves the equivalent purpose',
    note: 'WCAG SC 1.1.1',
    check: 'code.text-alternatives',
  },
  {
    id: 'CO6',
    category: 'code',
    subcategory: 'Responsiveness',
    guideline: 'Component is optimised for all breakpoints',
    // Probed, not read: whether a component overflows at 320px depends on
    // its fonts and content, not on anything in its stylesheet. Needs a
    // `preview:` URL; without one this reports N/A.
    check: 'code.breakpoints',
  },
  {
    id: 'CO7',
    category: 'code',
    subcategory: 'Foundations',
    guideline: 'Component makes use of all available tokens',
    note: 'Colour, typography, spacing',
    check: 'code.token-usage',
  },
  {
    id: 'CO8',
    category: 'code',
    subcategory: 'Naming',
    guideline: 'Component name is semantic',
    check: 'code.semantic-name',
  },
  {
    id: 'CO9',
    category: 'code',
    subcategory: 'Naming',
    guideline: 'Naming and properties of components are consistent between code and Figma',
    check: 'code.figma-prop-parity',
  },
  {
    id: 'CO10',
    category: 'code',
    subcategory: 'Quality',
    guideline: 'Min- and max widths/heights and max. amount of characters are defined',
    // Manual until now with no reason recorded against it, unlike CO4 and
    // DE2 whose manual status was forced by what an API exposes. It was
    // manual because nobody had built the check. Pseudo-localization is the
    // check: expand the rendered text by ~40% and an undeclared bound becomes
    // observable. Not a localisation metric — the output is not a language,
    // and CO11 was removed for being a language question.
    note: 'Answered by expanding the rendered text ~40% and measuring what breaks',
    check: 'code.text-expansion',
  },
  {
    id: 'CO12',
    category: 'code',
    subcategory: 'Quality',
    guideline: 'Composition mirrors Figma component',
    note: 'Answered from the repo’s Figma Code Connect mappings',
    // Read from Code Connect, not from the two sides' shape: a
    // `figma.connect(Button, "…?node-id=1-10")` call is the team's own
    // statement that this code implements that node, and the audit can check
    // it names the node being scored. DE11 asked the same question from the
    // Figma side and was dropped: one claim, one norm, and this is the side
    // where the evidence lives.
    check: 'code.figma-connect',
  },

  // ---- Design (Figma) ----
  {
    id: 'DE1',
    category: 'design',
    subcategory: 'Foundations',
    guideline: 'Colour tokens are applied',
    check: 'design.color-tokens',
  },
  {
    id: 'DE2',
    category: 'design',
    subcategory: 'A11y',
    guideline:
      'Sufficient contrast between text/icon and background behind the text/icon (level AA)',
    note: 'WCAG SC 1.4.3 — the REST API exposes no resolved text-over-background pairing',
    check: null,
  },
  {
    id: 'DE3',
    category: 'design',
    subcategory: 'Foundations',
    guideline: 'Typography tokens are applied',
    check: 'design.type-tokens',
  },
  {
    id: 'DE4',
    category: 'design',
    subcategory: 'Foundations',
    guideline: 'Spacing tokens are applied',
    check: 'design.spacing-tokens',
  },
  {
    id: 'DE5',
    category: 'design',
    subcategory: 'Foundations',
    guideline: 'Border radius tokens are applied',
    check: 'design.radius-tokens',
  },
  {
    id: 'DE6',
    category: 'design',
    subcategory: 'Quality',
    guideline:
      'Includes interaction states (default, hover, pressed, focus, loading, selected, active, error, disabled)',
    // The mirror of CO1, and the one of the pair that CAN answer Yes. A
    // Figma component set *declares* its states as variant options, so the
    // set is enumerable: `variantOptions` on a `State` variant hands over
    // ["Default", "Hover", "Pressed"] directly, and a `Disabled` boolean
    // property names its state in its key. CO1 forces states in a browser
    // and can only ever prove one missing.
    //
    // Which states to require is `params: { states: [...] }`, defaulting to
    // hover, pressed and disabled rather than all nine — most components
    // legitimately need only some, which is exactly why this norm was
    // manual. A component naming no interaction state at all is still an
    // N/A: nothing in the API distinguishes a Divider that needs none from a
    // Button that forgot them.
    check: 'design.interaction-states',
  },
  {
    id: 'DE7',
    category: 'design',
    subcategory: 'Quality',
    guideline: 'Layer names are semantic',
    check: 'design.layer-names',
  },
  {
    id: 'DE9',
    category: 'design',
    subcategory: 'Prototyping',
    guideline: 'Interaction states are connected / contains Interactive Components',
    check: 'design.prototyping',
  },
  {
    id: 'DE10',
    category: 'design',
    subcategory: 'Quality',
    guideline: 'Component is built using Auto Layout',
    check: 'design.auto-layout',
  },

  // ---- Documentation ----
  // The doc checks look for a matching heading in the mapped doc file. That
  // proves a section exists, not that it is any good — `--verbose` prints the
  // exact headings searched so the result is never a black box.
  {
    id: 'DO2',
    category: 'documentation',
    subcategory: 'Quality',
    guideline: 'Usage guidelines are documented',
    check: 'docs.section',
    params: { headings: ['usage', 'when to use', 'when not to use', 'do and', "do's"] },
  },
  {
    id: 'DO3',
    category: 'documentation',
    subcategory: 'Quality',
    guideline: 'Behaviour guidelines are documented',
    check: 'docs.section',
    params: { headings: ['behaviour', 'behavior', 'interaction'] },
  },
  {
    id: 'DO4',
    category: 'documentation',
    subcategory: 'Quality',
    guideline: 'Anatomy guidelines are documented',
    check: 'docs.section',
    params: { headings: ['anatomy', 'structure', 'parts'] },
  },
  {
    id: 'DO5',
    category: 'documentation',
    subcategory: 'Quality',
    guideline: 'Animation guidelines are documented',
    check: 'docs.section',
    params: { headings: ['animation', 'motion', 'transition'] },
  },
  {
    id: 'DO6',
    category: 'documentation',
    subcategory: 'Quality',
    guideline: 'Variations and component functionalities are documented',
    check: 'docs.section',
    params: { headings: ['variation', 'variant', 'options', 'props', 'api'] },
  },
  {
    id: 'DO7',
    category: 'documentation',
    subcategory: 'Content',
    guideline: 'Content guidelines are documented',
    check: 'docs.section',
    // Not a bare "tone": in a component library that word usually names a
    // visual variant, not writing guidance. Checked against a real
    // styleguide, "tone" matched Button's "Tone variants" section, which is
    // about colour.
    params: { headings: ['content', 'copy', 'writing', 'wording', 'tone of voice'] },
  },
  {
    id: 'DO8',
    category: 'documentation',
    subcategory: 'A11y',
    guideline: 'Interaction states are documented',
    check: 'docs.section',
    params: { headings: ['states', 'interaction states', 'state'] },
  },
  {
    id: 'DO9',
    category: 'documentation',
    subcategory: 'A11y',
    guideline: 'A11y guidelines are documented',
    check: 'docs.section',
    params: { headings: ['accessibility', 'a11y', 'aria'] },
  },
];

export const DEFAULT_METRICS_BY_ID: ReadonlyMap<string, MetricDef> = new Map(
  DEFAULT_METRICS.map((m) => [m.id, m]),
);

/** Categories in the order they appear in reports and on the quadrant axes. */
export const CATEGORIES: readonly MetricCategory[] = ['code', 'design', 'documentation'];

/** Order-independent, so reordering a heading list is not mistaken for a new rubric. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(stable);
    return items.every((x) => typeof x === 'string') ? [...items].sort() : items;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

/** What a metric measures. Wording (guideline, note, subcategory) is not part of it. */
function measures(m: MetricDef): string {
  return JSON.stringify(stable([m.category, m.check, m.params ?? null]));
}

/**
 * One key per metric, for fingerprinting the rubric behind a score.
 *
 * Every key carries what its metric measures — its category, its check and
 * that check's params. Rewording a guideline, a note or a subcategory changes
 * no score and so changes no key, and a reordered heading list is not a new
 * rubric either (see `stable`).
 *
 * This used to emit a BARE id for any metric matching the shipped default, to
 * keep fingerprints stable for history recorded before norms were
 * customisable. That had the fingerprint describe *which* norms were enabled
 * rather than what they measure, and it left one kind of rubric change
 * invisible: the kind Current itself ships. When CO3 went from "a human
 * answers this" to "a browser probes it", every config using the default
 * produced the same bare `CO3` before and after, so the trend line joined a
 * hand-audited score to a probed one as though they were the same measurement.
 * They are not, and the line now breaks there.
 *
 * The cost is one break per repo at the upgrade that introduced this, plus one
 * on any later release that changes what a built-in checks. That is the honest
 * reading: the rubric did change, and a visible reset beats a continuous line
 * through two different measurements.
 */
export function metricKeys(metrics: readonly MetricDef[]): string[] {
  return metrics.map((m) => `${m.id}:${measures(m)}`);
}
