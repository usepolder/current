import type { CheckResult } from './code-checks';
import type { FigmaNode } from './figma-client';

export interface DesignFacts {
  componentName: string;
  node: FigmaNode;
}

type Params = Record<string, unknown>;

/**
 * A check reads the component's Figma node, plus the `params` its norm
 * configured — the same shape as `CodeCheck`.
 */
export type DesignCheck = (facts: DesignFacts, params?: Params) => CheckResult;

/** Every node in the subtree, the component itself first. */
export function flatten(node: FigmaNode): FigmaNode[] {
  const out: FigmaNode[] = [];
  const visit = (n: FigmaNode): void => {
    out.push(n);
    for (const child of n.children ?? []) visit(child);
  };
  visit(node);
  return out;
}

/**
 * Node types that are Figma's own presentation chrome, never part of what a
 * component ships.
 *
 * Figma paints a component set's wrapper with a `#9747FF` stroke, lays its
 * variants out with raw `itemSpacing`, and gives it a corner radius. A
 * `SECTION` gets the same purple by default. None of that was designed, none
 * of it renders anywhere a user can see, and none of it appears in code or in
 * a design that consumes the component. What ships is the variants inside.
 *
 * `SLICE` is here for a different reason: it is an export region, not a
 * rendered layer, so it has no appearance to be tokenised in the first place.
 *
 * `checkAutoLayout` has always known this about component sets — "a component
 * set delegates layout to its variants" — and the token checks simply never
 * adopted it. Measuring the wrapper was especially costly there because
 * `DEFAULT_MIN_BOUND` is 100: a single chrome node flipped a norm to No on a
 * component whose every real layer bound a token.
 *
 * Exclusion is by node TYPE and never by paint value. A `#9747FF` blocklist
 * would be shorter and is the wrong trade: the value is a changeable Figma
 * default, not a constant, so blocking it would suppress a genuine raw colour
 * inside a real layer. That is a false Yes, which is strictly worse than the
 * false No it replaces, because nobody goes looking for it.
 */
export const UNSHIPPED_NODE_TYPES: readonly string[] = ['COMPONENT_SET', 'SECTION', 'SLICE'];

/**
 * Every node in the subtree that is part of what the component ships.
 *
 * Chrome nodes are skipped but still descended into, so a component inside a
 * `SECTION` is measured while the section's own paint is not. For a component
 * set that means the population is its `COMPONENT` children and their
 * subtrees, with the set node itself left out.
 *
 * This is the denominator the token norms score against. It is deliberately
 * not a threshold: a team hitting the wrapper bug will reach for
 * `min_bound: 80` and it will appear to work, while forgiving real raw values
 * at the same rate. The threshold sweep in #3 settled that the default stays
 * at 100.
 */
export function flattenShipped(node: FigmaNode): FigmaNode[] {
  return flatten(node).filter((n) => !UNSHIPPED_NODE_TYPES.includes(n.type));
}

function boundKeys(node: FigmaNode): string[] {
  return Object.keys(node.boundVariables ?? {});
}

function styleKeys(node: FigmaNode): string[] {
  return Object.keys(node.styles ?? {});
}

/**
 * The share of relevant layers that must bind a token for a token norm to
 * answer Yes.
 *
 * 100 means every one of them, which is what these checks have always done.
 * It is a threshold either way; this names it so it can be read and re-tuned
 * instead of being an unwritten property of the code.
 */
export const DEFAULT_MIN_BOUND = 100;

/** The params key a token norm re-tunes its threshold with. */
export const MIN_BOUND_KEY = 'min_bound';

/** `min_bound` off a norm's params, or the default. Validated in config.ts. */
function minBoundFrom(params?: Record<string, unknown>): number {
  const raw = params?.[MIN_BOUND_KEY];
  return typeof raw === 'number' ? raw : DEFAULT_MIN_BOUND;
}

/** Shared shape: are enough nodes in the subtree binding this kind of token? */
function tokenCheck(
  node: FigmaNode,
  opts: {
    label: string;
    boundVariableKeys: readonly string[];
    styleKeys?: readonly string[];
    /** Nodes this metric applies to at all; empty means N/A. */
    applies: (n: FigmaNode) => boolean;
    /** Percent of relevant layers that must bind; 100 means all of them. */
    minBound: number;
  },
): CheckResult {
  const nodes = flattenShipped(node).filter(opts.applies);
  if (nodes.length === 0) {
    return { answer: 'N/A', evidence: `no layers in this component use ${opts.label}` };
  }
  const bound = nodes.filter(
    (n) =>
      boundKeys(n).some((k) => opts.boundVariableKeys.includes(k)) ||
      styleKeys(n).some((k) => (opts.styleKeys ?? []).includes(k)),
  );
  const pct = (bound.length / nodes.length) * 100;
  const met = pct >= opts.minBound;
  // Only a non-default threshold is named, so the evidence a reader has seen
  // on every run so far does not change wording underneath them.
  const tail =
    opts.minBound === DEFAULT_MIN_BOUND
      ? ''
      : ` (${pct.toFixed(0)}% ${met ? '≥' : '<'} ${opts.minBound}% threshold)`;

  if (bound.length === nodes.length) {
    return {
      answer: 'Yes',
      evidence: `all ${nodes.length} relevant layer(s) bind ${opts.label}`,
    };
  }
  if (met) {
    return {
      answer: 'Yes',
      evidence: `${bound.length} of ${nodes.length} layer(s) bind ${opts.label}${tail}`,
    };
  }
  if (bound.length === 0) {
    return {
      answer: 'No',
      evidence: `none of the ${nodes.length} relevant layer(s) bind ${opts.label} — raw values only${tail}`,
    };
  }
  return {
    answer: 'No',
    evidence: `${nodes.length - bound.length} of ${nodes.length} layer(s) use raw ${opts.label} instead of a token${tail}`,
  };
}

/** DE1 — colour tokens (bound variables or a shared fill/stroke style). */
export function checkColorTokens(facts: DesignFacts, params?: Params): CheckResult {
  return tokenCheck(facts.node, {
    minBound: minBoundFrom(params),
    label: 'colour tokens',
    boundVariableKeys: ['fills', 'strokes'],
    styleKeys: ['fill', 'fills', 'stroke', 'strokes'],
    applies: (n) => (n.fills?.length ?? 0) > 0 || (n.strokes?.length ?? 0) > 0,
  });
}

/** DE3 — typography tokens on text layers. */
export function checkTypeTokens(facts: DesignFacts, params?: Params): CheckResult {
  return tokenCheck(facts.node, {
    minBound: minBoundFrom(params),
    label: 'typography tokens',
    // `fontStyle` is how Figma reports a bound weight/style; `fontWeight` is
    // accepted too but the REST API has not been observed using it.
    boundVariableKeys: [
      'fontSize',
      'fontFamily',
      'fontStyle',
      'fontWeight',
      'lineHeight',
      'letterSpacing',
    ],
    styleKeys: ['text'],
    applies: (n) => n.type === 'TEXT',
  });
}

/** DE4 — spacing tokens on auto-layout frames. */
export function checkSpacingTokens(facts: DesignFacts, params?: Params): CheckResult {
  return tokenCheck(facts.node, {
    minBound: minBoundFrom(params),
    label: 'spacing tokens',
    boundVariableKeys: [
      'itemSpacing',
      'paddingLeft',
      'paddingRight',
      'paddingTop',
      'paddingBottom',
      'counterAxisSpacing',
    ],
    applies: (n) =>
      n.layoutMode !== undefined &&
      n.layoutMode !== 'NONE' &&
      [n.itemSpacing, n.paddingLeft, n.paddingRight, n.paddingTop, n.paddingBottom].some(
        (v) => typeof v === 'number' && v > 0,
      ),
  });
}

/**
 * The keys Figma reports a bound corner radius under.
 *
 * `rectangleCornerRadii` is the one the REST API actually uses when a radius is
 * bound to a variable — it holds the per-corner aliases
 * (`RECTANGLE_TOP_LEFT_CORNER_RADIUS` and friends). The singular names are kept
 * because a scalar binding is cheap to accept and costs nothing if it never
 * appears.
 */
const RADIUS_BOUND_KEYS = [
  'cornerRadius',
  'rectangleCornerRadii',
  'topLeftRadius',
  'topRightRadius',
  'bottomLeftRadius',
  'bottomRightRadius',
] as const;

/** DE5 — border radius tokens. */
export function checkRadiusTokens(facts: DesignFacts, params?: Params): CheckResult {
  return tokenCheck(facts.node, {
    minBound: minBoundFrom(params),
    label: 'radius tokens',
    boundVariableKeys: RADIUS_BOUND_KEYS,
    // A node with per-corner radii carries no scalar `cornerRadius` at all —
    // Figma omits the geometry and exposes only the binding — so binding a
    // radius variable is itself proof the node uses a radius. Without this a
    // fully tokenised component reports N/A, "no layers use radius tokens".
    applies: (n) =>
      (typeof n.cornerRadius === 'number' && n.cornerRadius > 0) ||
      boundKeys(n).some((k) => (RADIUS_BOUND_KEYS as readonly string[]).includes(k)),
  });
}

/**
 * The interaction states DE6 can recognise, and the words a design system
 * might use for each one.
 *
 * Keys are the canonical names a `params: { states: [...] }` list is written
 * in. DE6's guideline lists nine states; this table holds seven, because
 * "default" is not a state a component can be missing (every component has a
 * resting appearance) and "active" is folded into "pressed", which is the
 * name CO1 uses for the same claim on the code side.
 *
 * Synonyms are an explicit list, never a prefix or substring match. The docs
 * checks learned this the hard way: substring matching scored Button's "Icon
 * Usage" as usage guidelines. A variant option is a short string with no
 * grammar to lean on, so the only safe rule is equality against a word.
 *
 * Four words that name a state in some systems are deliberately NOT here,
 * because in a Figma file they far more often name something else:
 *
 *   - "danger" and "destructive" name a colour tone. `Tone=Danger` on a
 *     Button is not an error state. Same lesson as DO7 refusing a bare
 *     "tone" heading.
 *   - "down" names a direction. `Icon=Down`, `Chevron=Down`.
 *   - "on" names visibility. `Icon=On` means the icon is shown, not that the
 *     component is selected.
 *   - "pending" names a status. A Badge with `Status=Pending` is displaying
 *     someone else's state, not reacting to a pointer.
 *
 * Each of those would have produced a confident wrong answer on a component
 * that models no interaction state at all, which is the one thing DE6 must
 * not do.
 */
export const STATE_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  hover: ['hover', 'hovered'],
  pressed: ['pressed', 'press', 'active'],
  focus: ['focus', 'focused'],
  disabled: ['disabled', 'disable'],
  loading: ['loading', 'busy'],
  selected: ['selected', 'checked', 'toggled'],
  error: ['error', 'invalid'],
};

/**
 * Canonical state names. The order is the order evidence lines list them in,
 * and the order a configured `states` list is normalised to, so two configs
 * naming the same set read identically in a report.
 */
export const INTERACTION_STATES: readonly string[] = Object.keys(STATE_SYNONYMS);

/**
 * The states DE6 asks for when a norm names none.
 *
 * Three, not all seven. Most components legitimately need only some of the
 * states the guideline lists — a Divider needs none, a Badge needs none, a
 * Tooltip needs none — and asking for all of them would report a No on
 * nearly every component in a healthy system. These three are the ones any
 * component a pointer can act on has to have: it responds to the pointer, it
 * responds to the press, and it can be turned off.
 *
 * Focus is not among them on purpose. In Figma a focus ring is very often a
 * shared overlay or an annotation rather than a variant, so requiring a
 * `Focus` option would report a No on systems that do have one. Focus is also
 * the one state of the three a browser can force, so CO1 already reports it
 * from the side where it is actually visible. A team that models focus as a
 * variant can add it: `params: { states: [hover, pressed, focus, disabled] }`.
 */
export const DEFAULT_INTERACTION_STATES: readonly string[] = ['hover', 'pressed', 'disabled'];

/** The params key a DE6-style norm names its states with. */
export const STATES_KEY = 'states';

/** `states` off a norm's params, or the default. Validated in config.ts. */
function statesFrom(params?: Params): readonly string[] {
  const raw = params?.[STATES_KEY];
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_INTERACTION_STATES;
  const named = raw.filter((x): x is string => typeof x === 'string');
  return named.length === 0 ? DEFAULT_INTERACTION_STATES : named;
}

/**
 * The words in a Figma name, for matching against `STATE_SYNONYMS`.
 *
 * Drops the `#1:2` suffix Figma puts on property keys — observed on every
 * real file this project has seen, documented nowhere in the OpenAPI spec,
 * so it is stripped when present and never required. Splits camelCase so
 * `isDisabled` yields `disabled`, and splits on everything that is not a
 * letter or digit so `State=Hover`, `focus-visible` and `Has Error` all come
 * apart into words.
 */
function nameWords(name: string): string[] {
  return name
    .split('#')[0]
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/** Every canonical state this one name expresses, case-insensitively. */
export function statesNamed(name: string): string[] {
  const words = nameWords(name);
  return INTERACTION_STATES.filter((state) =>
    words.some((w) => STATE_SYNONYMS[state].includes(w)),
  );
}

/** Where a state was found, for evidence. */
interface StateSource {
  state: string;
  /** How this source reads in the evidence line, e.g. `State variant`. */
  label: string;
}

function propertyType(def: unknown): string | null {
  if (typeof def !== 'object' || def === null) return null;
  const type = (def as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

function variantOptions(def: unknown): string[] | null {
  if (typeof def !== 'object' || def === null) return null;
  const opts = (def as { variantOptions?: unknown }).variantOptions;
  if (!Array.isArray(opts)) return null;
  return opts.filter((x): x is string => typeof x === 'string');
}

/** `COMPONENT` and `COMPONENT_SET` nodes in the subtree — the ones that can declare properties. */
function propertyHolders(node: FigmaNode): FigmaNode[] {
  return flatten(node).filter((n) => n.type === 'COMPONENT' || n.type === 'COMPONENT_SET');
}

/**
 * Every interaction state the component's declared properties express.
 *
 * Two sources, both read off `componentPropertyDefinitions`:
 *
 *   - a `VARIANT` property's `variantOptions`, which is the list of values
 *     that property can take, so a `State` variant hands over
 *     `["Default", "Hover", "Pressed"]` directly;
 *   - a `BOOLEAN` property's key name, because `Disabled` and `Loading` are
 *     routinely modelled as booleans rather than as variant options.
 *
 * `TEXT`, `INSTANCE_SWAP` and `SLOT` properties are ignored: their names
 * describe content, not state. A property whose `type` the API did not
 * report is read only if it carries `variantOptions` — guessing that an
 * untyped `Disabled` key is a boolean would be inventing the one field that
 * decides the answer.
 */
function declaredStates(node: FigmaNode): StateSource[] {
  const out: StateSource[] = [];
  const seen = new Set<string>();
  const add = (state: string, label: string): void => {
    const key = `${state}\u0000${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ state, label });
  };

  for (const holder of propertyHolders(node)) {
    for (const [rawKey, def] of Object.entries(holder.componentPropertyDefinitions ?? {})) {
      const key = rawKey.split('#')[0];
      const type = propertyType(def);
      const options = variantOptions(def);

      if (options !== null) {
        for (const option of options) {
          for (const state of statesNamed(option)) add(state, `${key} variant`);
        }
        continue;
      }
      if (type === 'BOOLEAN') {
        for (const state of statesNamed(key)) add(state, `${key} boolean`);
      }
    }
  }
  return out;
}

/**
 * States read off variant child names — `State=Hover, Size=Large`.
 *
 * A fallback, used only when the property definitions expressed nothing.
 * This naming convention is real and stable in practice but appears nowhere
 * in Figma's published OpenAPI spec, and there is no `variantProperties`
 * field to read instead, so an answer resting on it says so in its evidence.
 */
function childNameStates(node: FigmaNode): StateSource[] {
  if (node.type !== 'COMPONENT_SET') return [];
  const out: StateSource[] = [];
  const seen = new Set<string>();
  for (const child of node.children ?? []) {
    for (const pair of child.name.split(',')) {
      const value = pair.includes('=') ? pair.slice(pair.indexOf('=') + 1) : '';
      for (const state of statesNamed(value)) {
        if (seen.has(state)) continue;
        seen.add(state);
        out.push({ state, label: 'variant child names' });
      }
    }
  }
  return out;
}

/** `hover, pressed via the State variant; disabled via the Disabled boolean` → grouped by source. */
function describeSources(sources: StateSource[]): string {
  const byLabel = new Map<string, string[]>();
  for (const { state, label } of sources) {
    const states = byLabel.get(label) ?? [];
    if (!states.includes(state)) states.push(state);
    byLabel.set(label, states);
  }
  return [...byLabel]
    .map(([label, states]) => `${label} covers ${states.join(', ')}`)
    .join('; ');
}

/** Property keys the node declares, for the evidence of an N/A. */
function declaredPropertyNames(node: FigmaNode): string[] {
  const names: string[] = [];
  for (const holder of propertyHolders(node)) {
    for (const key of Object.keys(holder.componentPropertyDefinitions ?? {})) {
      const name = key.split('#')[0];
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * DE6 — the component declares the interaction states it is asked for.
 *
 * The mirror of CO1, and worth stating why they are not the same question.
 * CO1 forces `:hover` and `:hover:active` on a rendered element and watches
 * what changes; it can prove a state is MISSING but never that the set is
 * complete, because six of the nine states it lists cannot be reached from
 * one URL. Figma is the other way round: a component set *declares* its
 * states as variant options, so the set is enumerable and a complete one can
 * be confirmed. That is why DE6 can answer Yes where CO1 structurally
 * cannot, and why DE6 is read off property definitions rather than pixels.
 *
 * What this check will NOT claim:
 *
 *   - That the states LOOK right. A `State=Hover` variant identical to
 *     `State=Default` satisfies DE6 and should fail CO1. DE6 reads the
 *     declaration; the browser probe reads the rendering, and neither
 *     substitutes for the other.
 *   - That a component expressing no interaction state is wrong. That is the
 *     N/A below, and it is the whole reason this norm was manual: the API
 *     cannot tell a Divider from a Button that forgot its hover state, and
 *     *which* states a given component needs is most of what DE6 is really
 *     asking. So "nothing here names an interaction state" stays a human's
 *     call, flagged `needsHuman` so it keeps its place in the questions
 *     `current export` writes out.
 *   - That a component is wired up. DE6 asks whether the states exist; DE9
 *     asks whether they are connected, and reads prototype interactions that
 *     DE6 deliberately ignores. A hover trigger is DE9's evidence, not this
 *     check's.
 *
 * A No needs at least one of the REQUESTED states present. "It models some
 * interaction state" is not enough on its own: a Badge with
 * `Status=Pending, Error, Success` names two states by this table's words
 * while being a static label, and charging it for a missing hover state
 * would be exactly the No that an N/A exists to prevent. Partial coverage of
 * what was asked for is the confident finding — a component already in the
 * business of having hover states, without the pressed state beside it.
 */
export function checkInteractionStates(facts: DesignFacts, params?: Params): CheckResult {
  const wanted = statesFrom(params);
  const declared = declaredStates(facts.node);
  const sources = declared.length > 0 ? declared : childNameStates(facts.node);
  const expressed = new Set(sources.map((s) => s.state));

  const missing = wanted.filter((s) => !expressed.has(s));
  const covered = wanted.filter((s) => expressed.has(s));

  if (missing.length === 0) {
    return {
      answer: 'Yes',
      evidence: describeSources(sources.filter((s) => wanted.includes(s.state))),
    };
  }

  if (covered.length > 0) {
    return {
      answer: 'No',
      evidence:
        `${describeSources(sources.filter((s) => covered.includes(s.state)))}, but no variant ` +
        `option or boolean property names ${missing.join(', ')}`,
    };
  }

  // Nothing asked for was found. Say what WAS there, so the reader can see
  // whether the component models state at all or simply has none.
  const others = [...expressed];
  const properties = declaredPropertyNames(facts.node);
  const inspected =
    properties.length > 0
      ? `propert(ies) declared: ${properties.join(', ')}`
      : facts.node.type === 'COMPONENT_SET'
        ? 'the component set declares no properties'
        : 'the component declares no properties';
  const aside =
    others.length > 0 ? `; it names ${others.join(', ')}, which was not asked for` : '';
  return {
    answer: 'N/A',
    evidence:
      `nothing names ${wanted.join(', ')} (${inspected}${aside}) — whether this component ` +
      "needs interaction states is a human's call",
    needsHuman: true,
  };
}

const DEFAULT_LAYER_NAME =
  /^(frame|group|rectangle|ellipse|vector|line|polygon|star|slice|component|instance|union|subtract|intersect|exclude)(\s+\d+)?$/i;

/** DE7 — layer names are semantic, not Figma's "Frame 427" defaults. */
export function checkLayerNames(facts: DesignFacts): CheckResult {
  // Skip the component node itself: its name is the component's name, judged
  // by the code-side semantic-name check instead.
  const layers = flatten(facts.node).slice(1);
  if (layers.length === 0) {
    return { answer: 'N/A', evidence: 'component has no child layers' };
  }
  const defaults = layers.filter((n) => DEFAULT_LAYER_NAME.test(n.name.trim()));
  if (defaults.length === 0) {
    return { answer: 'Yes', evidence: `all ${layers.length} child layer(s) are named` };
  }
  const sample = [...new Set(defaults.map((n) => n.name))].slice(0, 5).join(', ');
  return {
    answer: 'No',
    evidence: `${defaults.length} of ${layers.length} layer(s) keep Figma default names (e.g. ${sample})`,
  };
}

/**
 * Prototype triggers that mean an interaction state is wired to something.
 *
 * Spec-declared `Trigger.type` values, minus the ones that fire without a
 * user acting on the component: `AFTER_TIMEOUT`, `ON_MEDIA_HIT` and
 * `ON_MEDIA_END` are animation timing, not interaction state.
 */
const INTERACTION_TRIGGERS: readonly string[] = [
  'ON_CLICK',
  'ON_HOVER',
  'ON_PRESS',
  'ON_DRAG',
  'MOUSE_ENTER',
  'MOUSE_LEAVE',
  'MOUSE_UP',
  'MOUSE_DOWN',
  'ON_KEY_DOWN',
];

/**
 * Does this `interactions` entry respond to a user?
 *
 * Lenient about a shape it cannot read: an entry whose `trigger.type` is
 * absent or not a string counts, because "Figma reported an interaction we
 * could not parse" is not "this component has no interactions". Only a
 * trigger that is legible AND outside `INTERACTION_TRIGGERS` is excluded.
 */
function isInteractionTrigger(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return true;
  const trigger = (entry as { trigger?: unknown }).trigger;
  if (typeof trigger !== 'object' || trigger === null) return true;
  const type = (trigger as { type?: unknown }).type;
  if (typeof type !== 'string') return true;
  return INTERACTION_TRIGGERS.includes(type);
}

/**
 * Words a property KEY uses to say "this property is the interaction state",
 * without saying which state.
 *
 * DE9 only. `State` as a key is strong evidence a component set is built as
 * an Interactive Component, and it survives an API response that omits
 * `variantOptions` — which matters, because those options are spec-declared
 * but unobserved by this project so far. DE6 cannot use this: "there is a
 * State property" is not "it covers pressed", and DE6's whole job is to say
 * which states are there.
 */
const STATE_PROPERTY_WORDS: readonly string[] = ['state', 'states', 'interaction'];

/** Property keys that name the interaction-state axis itself, e.g. `State`. */
function statePropertyKeys(node: FigmaNode): string[] {
  const out: string[] = [];
  for (const holder of propertyHolders(node)) {
    for (const rawKey of Object.keys(holder.componentPropertyDefinitions ?? {})) {
      const key = rawKey.split('#')[0];
      if (out.includes(key)) continue;
      if (nameWords(key).some((w) => STATE_PROPERTY_WORDS.includes(w))) out.push(key);
    }
  }
  return out;
}

/** Layers in the subtree wired to a prototype destination by a user action. */
function wiredLayers(node: FigmaNode): FigmaNode[] {
  return flatten(node).filter(
    (n) =>
      (typeof n.transitionNodeID === 'string' && n.transitionNodeID !== '') ||
      (Array.isArray(n.interactions) && n.interactions.some(isInteractionTrigger)),
  );
}

/**
 * DE9 — interaction states are connected, or the component is built as an
 * interactive component set.
 *
 * This used to answer Yes for ANY `COMPONENT_SET`, which made the guideline's
 * "interaction states" half unenforced: a set whose only property was `Size`
 * satisfied the norm, and printed `component set with 2 propert(ies): Size,
 * Disabled` as its proof that interaction states were connected. Having
 * variants is not having interaction states. Yes now needs one of the two
 * things the guideline actually names — a variant option or boolean property
 * that names an interaction state (Figma's Interactive Components are built
 * out of exactly those), or a prototype interaction a user can trigger. A
 * property whose KEY is the state axis, `State` with no values returned,
 * also counts: see `STATE_PROPERTY_WORDS`.
 *
 * DE9 is not DE6 asked twice. DE6 scores WHICH states a component declares,
 * against the list a team asked for, and reads nothing but property
 * definitions. DE9 scores whether the component is interactive AT ALL, and a
 * single state anywhere settles it — as does prototype wiring, or a bare
 * `State` property, neither of which DE6 will look at. They separate on the
 * components that matter: a Size-only set with a hover interaction is DE9
 * Yes and DE6 N/A; a set with `State=Default, Hover` and nothing else is DE6
 * No (no pressed, no disabled) and DE9 Yes. On a well-built set both read
 * the same field and both answer Yes, which is two different claims that
 * happen to agree, not one claim scored twice.
 *
 * The N/A for a component with no Figma node is upstream, in the scan: a
 * node that was never fetched is "we could not look", and this check is only
 * ever called with one in hand.
 */
export function checkPrototyping(facts: DesignFacts): CheckResult {
  const declared = declaredStates(facts.node);
  const states = declared.length > 0 ? declared : childNameStates(facts.node);
  const wired = wiredLayers(facts.node);

  if (states.length > 0) {
    const named = [...new Set(states.map((s) => s.state))];
    const wiring = wired.length > 0 ? `, and ${wired.length} layer(s) wired` : '';
    return {
      answer: 'Yes',
      evidence: `${describeSources(states)} — interaction state(s) ${named.join(', ')} declared${wiring}`,
    };
  }

  if (wired.length > 0) {
    return {
      answer: 'Yes',
      evidence: `${wired.length} layer(s) have prototype interactions wired`,
    };
  }

  // No readable state value, but a property whose name IS the state axis.
  // Enough for "contains Interactive Components"; not enough for DE6.
  const stateProps = statePropertyKeys(facts.node);
  if (stateProps.length > 0) {
    return {
      answer: 'Yes',
      evidence:
        `propert(ies) ${stateProps.join(', ')} name the interaction-state axis, though the ` +
        'API returned no values for them',
    };
  }

  const properties = declaredPropertyNames(facts.node);
  if (properties.length > 0) {
    return {
      answer: 'No',
      evidence:
        `no propert(y) names an interaction state and no prototype interaction is wired ` +
        `(declared: ${properties.join(', ')})`,
    };
  }
  return {
    answer: 'No',
    evidence: 'no prototype interactions and not an interactive component set',
  };
}

/** DE10 — built with Auto Layout. */
export function checkAutoLayout(facts: DesignFacts): CheckResult {
  const root = facts.node;
  // A component set delegates layout to its variants.
  const subjects =
    root.type === 'COMPONENT_SET' ? (root.children ?? []) : [root];
  if (subjects.length === 0) {
    return { answer: 'N/A', evidence: 'component set has no variants' };
  }
  const withAutoLayout = subjects.filter(
    (n) => typeof n.layoutMode === 'string' && n.layoutMode !== 'NONE',
  );
  if (withAutoLayout.length === subjects.length) {
    return {
      answer: 'Yes',
      evidence:
        subjects.length === 1
          ? `layoutMode is ${subjects[0].layoutMode}`
          : `all ${subjects.length} variant(s) use Auto Layout`,
    };
  }
  return {
    answer: 'No',
    evidence:
      subjects.length === 1
        ? 'layoutMode is NONE'
        : `${subjects.length - withAutoLayout.length} of ${subjects.length} variant(s) do not use Auto Layout`,
  };
}

/** Figma variant/component property names, for the code parity check. */
export function figmaPropertyNames(node: FigmaNode): string[] {
  const defs = node.componentPropertyDefinitions;
  if (defs && typeof defs === 'object') return Object.keys(defs);
  return [];
}

/** The variants of a component: a set's children, or the component itself. */
function variantsOf(root: FigmaNode): FigmaNode[] {
  return root.type === 'COMPONENT_SET' ? (root.children ?? []) : [root];
}

/** A property reference on a layer, read defensively: the API's shapes are loose. */
function propertyReference(node: FigmaNode, field: string): string | null {
  const refs = node.componentPropertyReferences;
  if (typeof refs !== 'object' || refs === null) return null;
  const value = (refs as Record<string, unknown>)[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The layers a designer would want to change, inside one variant: its TEXT
 * layers and the instances nested in it.
 *
 * The walk stops at a nested instance. Text inside an Icon instance belongs
 * to the Icon component, and exposing it is the Icon's own DE12 — counting it
 * here would charge this component for a layer it does not own. Only TEXT
 * and INSTANCE layers are counted, so Figma's chrome never is; its children
 * are still walked, as in the token norms.
 */
function exposableLayers(variant: FigmaNode): FigmaNode[] {
  const out: FigmaNode[] = [];
  const visit = (n: FigmaNode): void => {
    for (const child of n.children ?? []) {
      if (child.type === 'TEXT') {
        out.push(child);
      } else if (child.type === 'INSTANCE') {
        out.push(child);
        continue;
      }
      visit(child);
    }
  };
  visit(variant);
  return out;
}

/**
 * DE12 — the layers a designer would change are exposed as component
 * properties.
 *
 * Detaching an instance is the main way a design system drifts in Figma,
 * and designers detach for one reason: they need to change something the
 * component does not let them change. The label is the usual one, the icon
 * the next. Once detached, the instance never receives another update.
 *
 * So every TEXT layer should be bound to a `TEXT` property (its
 * `componentPropertyReferences.characters`), and every nested instance to an
 * `INSTANCE_SWAP` property (`componentPropertyReferences.mainComponent`).
 *
 * Some nested instances are a fixed part of the component's identity — the
 * spinner inside a loading button — and there is no field that says "fixed
 * on purpose", so this check cannot tell. A team with such parts re-tunes
 * `min_bound` the way the token norms do; the default, 100, asks for every
 * one.
 */
export function checkExposedProperties(facts: DesignFacts, params?: Params): CheckResult {
  const minBound = minBoundFrom(params);
  const variants = variantsOf(facts.node);
  const layers = variants.flatMap(exposableLayers);
  if (layers.length === 0) {
    return { answer: 'N/A', evidence: 'no text layers or nested instances to expose' };
  }

  const isExposed = (n: FigmaNode): boolean =>
    n.type === 'TEXT'
      ? propertyReference(n, 'characters') !== null
      : propertyReference(n, 'mainComponent') !== null;
  const hidden = layers.filter((n) => !isExposed(n));
  const pct = ((layers.length - hidden.length) / layers.length) * 100;
  const tail =
    minBound === DEFAULT_MIN_BOUND
      ? ''
      : ` (${pct.toFixed(0)}% ${pct >= minBound ? '≥' : '<'} ${minBound}% threshold)`;

  if (hidden.length === 0) {
    return {
      answer: 'Yes',
      evidence: `all ${layers.length} text layer(s) and nested instance(s) are exposed as properties`,
    };
  }
  const names = [
    ...new Set(hidden.map((n) => `${n.name} (${n.type === 'TEXT' ? 'text' : 'instance'})`)),
  ];
  return {
    answer: pct >= minBound ? 'Yes' : 'No',
    evidence:
      `${hidden.length} of ${layers.length} layer(s) are not exposed as properties, so changing ` +
      `them means detaching: ${names.slice(0, 5).join(', ')}${tail}`,
  };
}

/** TEXT layers in one variant, stopping at nested instances (they are another component's). */
function textLayers(variant: FigmaNode): FigmaNode[] {
  const out: FigmaNode[] = [];
  const visit = (n: FigmaNode): void => {
    for (const child of n.children ?? []) {
      if (child.type === 'INSTANCE') continue;
      if (child.type === 'TEXT') out.push(child);
      visit(child);
    }
  };
  visit(variant);
  return out;
}

/** A text layer's TypeStyle, where Figma keeps `textAutoResize` and `textTruncation`. */
function typeStyle(node: FigmaNode): Record<string, unknown> {
  return typeof node.style === 'object' && node.style !== null ? node.style : {};
}

/** The author declared what happens to long text: an ellipsis, optionally after N lines. */
function declaresTruncation(node: FigmaNode): boolean {
  const st = typeStyle(node);
  return st.textTruncation === 'ENDING' || st.textAutoResize === 'TRUNCATE';
}

/**
 * How a text layer responds to longer content: it grows sideways, it wraps
 * and grows downward, it is pinned in both directions, or the API gave no way
 * to tell.
 *
 * `textAutoResize` absent means NONE — Figma's spec says the default is that
 * text does not auto-resize — but only once the layer carries auto-layout
 * sizing at all. A layer with no sizing fields of any kind is not judged:
 * reading an absent field as a verdict is how a check ends up wrong on every
 * component it looks at.
 */
function textGrowth(node: FigmaNode): 'sideways' | 'down' | 'fixed' | 'unknown' {
  const st = typeStyle(node);
  const auto = st.textAutoResize;
  const h = node.layoutSizingHorizontal;
  const v = node.layoutSizingVertical;
  if (auto === undefined && h === undefined && v === undefined) return 'unknown';
  if (auto === 'WIDTH_AND_HEIGHT' || h === 'HUG') return 'sideways';
  if (auto === 'HEIGHT' || v === 'HUG') return 'down';
  return 'fixed';
}

/** Does this frame's width follow its content? Newer field first, then the older pair. */
function hugsWidth(node: FigmaNode): boolean {
  if (node.layoutSizingHorizontal !== undefined) return node.layoutSizingHorizontal === 'HUG';
  if (node.layoutMode === 'HORIZONTAL') return node.primaryAxisSizingMode === 'AUTO';
  if (node.layoutMode === 'VERTICAL') return node.counterAxisSizingMode === 'AUTO';
  return false;
}

/**
 * DE13 — the component's layout survives longer content.
 *
 * The Figma side of CO10. A component whose label is pinned to a fixed box
 * breaks the first time a designer types a longer one, and they fix it by
 * detaching and resizing — drift again.
 *
 * Two failures:
 *
 *   1. A text layer that cannot grow in either direction and declares no
 *      truncation. Text that wraps — fixed width, growing downward — is fine:
 *      that is how a paragraph in a card is meant to behave, and calling it a
 *      failure would flag every multi-line layout.
 *   2. A variant whose width hugs its content, containing text that grows
 *      sideways, with no `maxWidth`. Nothing stops it growing without limit.
 *
 * A declared limit satisfies the norm rather than failing it, exactly as in
 * CO10: `textTruncation: ENDING` is the designer saying what happens to long
 * text, and a `maxWidth` is the bound being defined.
 */
export function checkLayoutSurvivesContent(facts: DesignFacts): CheckResult {
  const variants = variantsOf(facts.node);
  const pinned: string[] = [];
  const unbounded: string[] = [];
  let judged = 0;

  for (const variant of variants) {
    const texts = textLayers(variant);
    let growsSideways = false;
    for (const text of texts) {
      const growth = textGrowth(text);
      if (growth === 'unknown') continue;
      judged++;
      if (growth === 'sideways') growsSideways = true;
      if (growth === 'fixed' && !declaresTruncation(text)) pinned.push(text.name);
    }
    if (growsSideways && hugsWidth(variant)) {
      judged++;
      const max = variant.maxWidth;
      if (!(typeof max === 'number' && max > 0)) unbounded.push(variant.name);
    }
  }

  if (judged === 0) {
    return {
      answer: 'N/A',
      evidence: 'no text layer carries sizing the API reports, so there is nothing to judge',
    };
  }
  const problems: string[] = [];
  if (pinned.length > 0) {
    const names = [...new Set(pinned)];
    problems.push(
      `${pinned.length} text layer(s) cannot grow and declare no truncation: ${names.slice(0, 5).join(', ')}`,
    );
  }
  if (unbounded.length > 0) {
    problems.push(
      `${unbounded.length} variant(s) grow with their text and have no maxWidth: ` +
        unbounded.slice(0, 3).join(', '),
    );
  }
  if (problems.length > 0) {
    return { answer: 'No', evidence: problems.join('; ') };
  }
  return {
    answer: 'Yes',
    evidence: `every text layer grows or declares truncation, and no variant grows without a bound`,
  };
}

export const DESIGN_CHECKS: Record<string, DesignCheck> = {
  'design.color-tokens': checkColorTokens,
  'design.type-tokens': checkTypeTokens,
  'design.spacing-tokens': checkSpacingTokens,
  'design.radius-tokens': checkRadiusTokens,
  'design.interaction-states': checkInteractionStates,
  'design.layer-names': checkLayerNames,
  'design.prototyping': checkPrototyping,
  'design.auto-layout': checkAutoLayout,
  'design.exposed-properties': checkExposedProperties,
  'design.layout-survives-content': checkLayoutSurvivesContent,
};
