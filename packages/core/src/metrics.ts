/**
 * The default metrics. They started as a production design system's
 * "Component Health" audit sheet (Template tab) and have been narrowed to one
 * question: is the design system built robustly enough to be reused without
 * drifting? Teams can disable any of them or flip an automated one to manual
 * in `.polder.yml`; this is a starting point, not a fixed rubric.
 *
 * That question is the line every norm here is held to. A norm stays if it
 * measures the system's structure — tokens, the component API, parity between
 * code, Figma and docs. It goes if it audits the output — what renders, what a
 * screen reader announces, what contrast a pixel has. Whether a component is
 * accessible is real and important, but it is product quality, and axe,
 * Lighthouse and testing with assistive technology answer it better than a
 * rubric can. Scoring it here made the number mean two things at once (#39).
 *
 * Twelve norms are not here, and this comment block is the record of why. Ids are never renumbered — DE9 stays DE9 — so existing
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
 *   - CO1, CO2, CO3, CO4, CO5, CO13, DE2 and DO9 audit accessibility of the
 *     output, under the line drawn above (#39). CO1 forced pointer states on
 *     the rendered page; CO2 and CO5 audited the markup for ARIA and text
 *     alternatives; CO3 tab-walked the page; CO4 read what a screen reader
 *     announces; CO13 measured rendered contrast; DE2 asked about contrast in
 *     the design and was the last manual norm; DO9 asked for accessibility
 *     guidance in the docs. CO13 was not from the sheet at all — it was added
 *     in #35 and retired in #39 before anyone adopted it.
 *
 *     Their CHECKS are not deleted. Every one stays registered, and a custom
 *     norm can name any check, so a team that wants accessibility scored
 *     adds it back in config (the README has the block, with A11Y ids so
 *     these retired ones are never reused). DE6 and DE9 keep the
 *     system-structure half of CO1: whether interaction states are DECLARED.
 *
 *     Two accessibility properties are system structure and could earn a
 *     norm on their own merits later: accessible names enforced by the props
 *     API, and contrast-safe token pairs. Neither is here yet.
 *
 * `check` is the id of an automated check, or null when only a human can
 * answer — though since #39 no default norm is null. Four input contracts
 * are in play: static checks read the component's source, design checks read
 * its Figma node, `code.breakpoints` and `code.text-expansion` probe a
 * rendered `preview:` URL in a real browser, and `code.figma-connect` reads
 * the repo's Code Connect mappings, which is where the code/design
 * correspondence is actually written down. What is automatable on the design
 * side was settled by probing Figma's published OpenAPI spec
 * (figma/rest-api-spec). `layoutMode`,
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

/**
 * Every id that has left the default rubric. Never reused, by a later
 * built-in or by a custom norm: an answers file written for the old norm
 * would otherwise silently answer the new one. The header above records why
 * each one went.
 */
export const RETIRED_METRIC_IDS: readonly string[] = [
  'CO1',
  'CO2',
  'CO3',
  'CO4',
  'CO5',
  'CO11',
  'CO13',
  'DE2',
  'DE8',
  'DE11',
  'DO1',
  'DO9',
];

export const DEFAULT_METRICS: readonly MetricDef[] = [
  // ---- Code (component implementation) ----
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

  {
    id: 'CO16',
    category: 'code',
    subcategory: 'Reusability',
    guideline: 'Component can be extended without forking: ref forwarded, unknown props passed on, className merged',
    // Each of the three is something a product team otherwise rebuilds, by
    // wrapping or copying the component — which is where drift starts. Ref
    // forwarding is judged against the React version the system declares,
    // because a props spread carries a ref on 19 and silently drops it on 18
    // (#41).
    check: 'code.extensible',
  },

  {
    id: 'CO17',
    category: 'code',
    subcategory: 'Reusability',
    guideline: 'Component does not hardcode copy: its text arrives as props, children or messages',
    // A literal "Close" in the markup works for one product, in one language
    // and one tone, and every other product forks the component to change
    // it. Reads only what is rendered, so a prop default or a translation
    // key is not copy (#42).
    check: 'code.no-hardcoded-copy',
  },

  {
    id: 'CO18',
    category: 'code',
    subcategory: 'Reusability',
    guideline: "Component depends only on the system and packages, and on other components through their entry points",
    // An import that climbs out of the design system couples the component
    // to the product it serves; one that reaches into another component's
    // folder depends on how that component is built today rather than what
    // it promises. Aliased imports are counted and left unjudged: resolving
    // them needs the project's config, and a guess would invent findings
    // (#43).
    check: 'code.dependency-direction',
  },

  {
    id: 'CO14',
    category: 'code',
    subcategory: 'Naming',
    guideline: 'Variant values match between code and Figma',
    // CO9 compares property names only, so a `size` on both sides passes
    // while Figma offers `xl` and code cannot build it. This compares the
    // values: Figma's variant options against the code prop's literal union
    // (#40).
    check: 'code.figma-variant-values',
  },
  {
    id: 'CO15',
    category: 'code',
    subcategory: 'Naming',
    guideline: 'Default values match between code and Figma',
    // Same values, different starting state is still drift: designs show
    // one default and code ships another. Variant and boolean properties
    // only, since a TEXT default is placeholder content, not a state (#40).
    check: 'code.figma-default-values',
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

  {
    id: 'DE12',
    category: 'design',
    subcategory: 'Reusability',
    guideline: 'Text layers and nested instances are exposed as component properties',
    // Designers detach an instance when they need to change something the
    // component does not let them change, and a detached instance never
    // updates again. Binding labels to TEXT properties and nested instances
    // to INSTANCE_SWAP properties removes the reason. DE11 is retired, so
    // this is DE12 (#45).
    check: 'design.exposed-properties',
  },

  {
    id: 'DE13',
    category: 'design',
    subcategory: 'Reusability',
    guideline: 'Layout survives longer content: text grows or declares truncation, and growth is bounded',
    // The Figma side of CO10. A label pinned to a fixed box breaks the first
    // time a designer types a longer one, and they detach to fix it. Text
    // that wraps is fine; text that can do neither and declares no
    // truncation is not, and nor is a variant that grows without a maxWidth
    // (#46).
    check: 'design.layout-survives-content',
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
    // Was 'A11y'. It asks whether interaction states are documented, which is
    // about the component's behaviour, not about accessibility; the label
    // came from the audit sheet and outlived the A11y norms around it.
    subcategory: 'Quality',
    guideline: 'Interaction states are documented',
    check: 'docs.section',
    params: { headings: ['states', 'interaction states', 'state'] },
  },
  {
    id: 'DO10',
    category: 'documentation',
    subcategory: 'Quality',
    guideline: 'Documented props match the code',
    // A props table listing a removed prop, or missing an added one, has
    // consumers building against an API that does not exist: drift in the
    // place people learn the system from. A table generated from the types
    // (ArgTypes, Controls) cannot drift and answers Yes (#44).
    check: 'docs.props',
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
