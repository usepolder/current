/**
 * The 32 default metrics, transcribed from a production design system's "Component Health"
 * audit sheet (Template tab). Teams can disable any of them or flip an
 * automated one to manual in `.current.yml`; this is a starting point, not a
 * fixed rubric.
 *
 * `check` is the id of an automated check, or null when only a human can
 * answer. What is automatable was settled by probing Figma's published
 * OpenAPI spec (figma/rest-api-spec): `AnnotationsTrait` is declared with an
 * empty property bag, so the REST API exposes no accessibility annotations —
 * DE2 and the screenreader checks stay manual. `layoutMode`,
 * `boundVariables`, `componentPropertyDefinitions`, `cornerRadius` and
 * `transitionNodeID` ARE returned, so the token/auto-layout/prototyping
 * checks are real.
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
    check: null,
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
    // Deliberately manual: native elements are keyboard-accessible with no
    // explicit handler, so "no onKeyDown" would produce constant false "No"s.
    check: null,
  },
  {
    id: 'CO4',
    category: 'code',
    subcategory: 'A11y',
    guideline: 'Component is accessible by screenreader',
    note: 'cmd + f5 to enable the screenreader',
    check: null,
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
    check: null,
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
    check: null,
  },
  {
    id: 'CO11',
    category: 'code',
    subcategory: 'Localisation',
    guideline: 'Component is usable in all supported languages',
    note: 'Can only be checked in production',
    check: null,
  },
  {
    id: 'CO12',
    category: 'code',
    subcategory: 'Quality',
    guideline: 'Composition mirrors Figma component',
    check: null,
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
    check: null,
  },
  {
    id: 'DE7',
    category: 'design',
    subcategory: 'Quality',
    guideline: 'Layer names are semantic',
    check: 'design.layer-names',
  },
  {
    id: 'DE8',
    category: 'design',
    subcategory: 'Quality',
    guideline: 'All layers, groups, and frames are necessary',
    check: null,
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
    id: 'DE11',
    category: 'design',
    subcategory: 'Quality',
    guideline: "Figma component reflects what's in code",
    check: null,
  },

  // ---- Documentation ----
  // The doc checks look for a matching heading in the mapped doc file. That
  // proves a section exists, not that it is any good — `--verbose` prints the
  // exact headings searched so the result is never a black box.
  {
    id: 'DO1',
    category: 'documentation',
    subcategory: 'Quality',
    guideline: 'Component statuses are up to date',
    check: null,
  },
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
    params: { headings: ['content', 'copy', 'writing', 'tone'] },
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
