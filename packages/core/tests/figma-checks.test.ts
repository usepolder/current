import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERACTION_STATES,
  DESIGN_CHECKS,
  INTERACTION_STATES,
  STATE_SYNONYMS,
  checkDocSection,
  extractHtmlHeadings,
  figmaPropertyNames,
  headingMatches,
  isDocsUrl,
  statesNamed,
  type DocsFacts,
  type FigmaNode,
} from '@usepolder/current-core';

function component(overrides: Partial<FigmaNode> = {}): FigmaNode {
  return { id: '1:1', name: 'Button', type: 'COMPONENT', ...overrides };
}

describe('design.auto-layout', () => {
  const check = DESIGN_CHECKS['design.auto-layout'];

  it('answers Yes when layoutMode is set', () => {
    const r = check({ componentName: 'Button', node: component({ layoutMode: 'HORIZONTAL' }) });
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('HORIZONTAL');
  });

  it('answers No when layoutMode is NONE', () => {
    expect(
      check({ componentName: 'Button', node: component({ layoutMode: 'NONE' }) }).answer,
    ).toBe('No');
  });

  it('answers No when layoutMode is absent entirely', () => {
    expect(check({ componentName: 'Button', node: component() }).answer).toBe('No');
  });

  it('requires every variant of a component set to use auto layout', () => {
    const set = component({
      type: 'COMPONENT_SET',
      children: [
        component({ id: '1:2', layoutMode: 'VERTICAL' }),
        component({ id: '1:3', layoutMode: 'NONE' }),
      ],
    });
    const r = check({ componentName: 'Button', node: set });
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('1 of 2');
  });
});

describe('design token checks', () => {
  it('answers Yes when every filled layer binds a colour variable', () => {
    const node = component({
      fills: [{ type: 'SOLID' }],
      boundVariables: { fills: [{ id: 'V:1' }] },
    });
    expect(DESIGN_CHECKS['design.color-tokens']({ componentName: 'B', node }).answer).toBe('Yes');
  });

  it('accepts a shared style as a token too', () => {
    const node = component({ fills: [{ type: 'SOLID' }], styles: { fill: 'S:1' } });
    expect(DESIGN_CHECKS['design.color-tokens']({ componentName: 'B', node }).answer).toBe('Yes');
  });

  it('answers No when a filled layer uses a raw colour', () => {
    const node = component({ fills: [{ type: 'SOLID' }] });
    const r = DESIGN_CHECKS['design.color-tokens']({ componentName: 'B', node });
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('raw');
  });

  it('answers N/A when nothing in the component has a fill', () => {
    expect(
      DESIGN_CHECKS['design.color-tokens']({ componentName: 'B', node: component() }).answer,
    ).toBe('N/A');
  });

  it('checks typography tokens only on text layers', () => {
    const withText = component({
      children: [{ id: '1:2', name: 'Label', type: 'TEXT', styles: { text: 'S:2' } }],
    });
    expect(DESIGN_CHECKS['design.type-tokens']({ componentName: 'B', node: withText }).answer).toBe(
      'Yes',
    );
    expect(
      DESIGN_CHECKS['design.type-tokens']({ componentName: 'B', node: component() }).answer,
    ).toBe('N/A');
  });

  // Figma reports a bound weight/style as `fontStyle`, not `fontWeight`.
  it('counts a text layer binding only fontStyle as tokenised', () => {
    const node = component({
      children: [
        {
          id: '1:2',
          name: 'Label',
          type: 'TEXT',
          boundVariables: { fontStyle: { type: 'VARIABLE_ALIAS', id: 'VariableID:2' } },
        },
      ],
    });
    expect(DESIGN_CHECKS['design.type-tokens']({ componentName: 'B', node }).answer).toBe('Yes');
  });

  it('checks spacing tokens only on auto-layout frames with real spacing', () => {
    const spaced = component({ layoutMode: 'HORIZONTAL', itemSpacing: 8 });
    expect(DESIGN_CHECKS['design.spacing-tokens']({ componentName: 'B', node: spaced }).answer).toBe(
      'No',
    );
    const bound = component({
      layoutMode: 'HORIZONTAL',
      itemSpacing: 8,
      boundVariables: { itemSpacing: { id: 'V:3' } },
    });
    expect(DESIGN_CHECKS['design.spacing-tokens']({ componentName: 'B', node: bound }).answer).toBe(
      'Yes',
    );
  });

  it('checks radius tokens only where a radius is actually set', () => {
    expect(
      DESIGN_CHECKS['design.radius-tokens']({ componentName: 'B', node: component() }).answer,
    ).toBe('N/A');
    const rounded = component({ cornerRadius: 4 });
    expect(
      DESIGN_CHECKS['design.radius-tokens']({ componentName: 'B', node: rounded }).answer,
    ).toBe('No');
  });

  // Figma reports a bound radius under `rectangleCornerRadii`, holding the
  // per-corner aliases. Reading only the singular names made every tokenised
  // component answer No with the evidence "raw values only".
  it('counts a radius bound under rectangleCornerRadii as bound', () => {
    const node = component({
      cornerRadius: 4,
      boundVariables: {
        rectangleCornerRadii: {
          RECTANGLE_TOP_LEFT_CORNER_RADIUS: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' },
          RECTANGLE_TOP_RIGHT_CORNER_RADIUS: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' },
        },
      },
    });
    const r = DESIGN_CHECKS['design.radius-tokens']({ componentName: 'B', node });
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('bind radius tokens');
  });

  // A node with per-corner radii carries no scalar `cornerRadius`, so the old
  // `applies` predicate skipped it and a fully tokenised component came back
  // N/A, claiming no layer used a radius at all.
  it('treats a bound radius as proof the node uses a radius, with no scalar cornerRadius', () => {
    const node = component({
      boundVariables: {
        rectangleCornerRadii: {
          RECTANGLE_TOP_LEFT_CORNER_RADIUS: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' },
        },
      },
    });
    const r = DESIGN_CHECKS['design.radius-tokens']({ componentName: 'B', node });
    expect(r.answer).toBe('Yes');
    expect(r.evidence).not.toContain('no layers');
  });

  // The all-or-nothing rule was always a 100% threshold; these pin that the
  // default still behaves exactly that way, and that naming it lets a norm
  // re-tune it without touching the code.
  describe('min_bound', () => {
    /** Two of three relevant layers bind: 66.7%. */
    function twoOfThree(): FigmaNode {
      const bound = (id: string): FigmaNode => ({
        id,
        name: 'L',
        type: 'RECTANGLE',
        cornerRadius: 4,
        boundVariables: { rectangleCornerRadii: { RECTANGLE_TOP_LEFT_CORNER_RADIUS: { id: 'V:1' } } },
      });
      return component({
        cornerRadius: 4,
        children: [bound('1:2'), bound('1:3')],
      });
    }

    const check = DESIGN_CHECKS['design.radius-tokens'];

    it('defaults to requiring every relevant layer, with no threshold in the evidence', () => {
      const r = check({ componentName: 'B', node: twoOfThree() });
      expect(r.answer).toBe('No');
      expect(r.evidence).toBe('1 of 3 layer(s) use raw radius tokens instead of a token');
      expect(r.evidence).not.toContain('threshold');
    });

    it('answers Yes once the bound share reaches an explicit threshold', () => {
      const r = check({ componentName: 'B', node: twoOfThree() }, { min_bound: 60 });
      expect(r.answer).toBe('Yes');
      expect(r.evidence).toBe('2 of 3 layer(s) bind radius tokens (67% ≥ 60% threshold)');
    });

    it('still answers No below the threshold, and says by how much', () => {
      const r = check({ componentName: 'B', node: twoOfThree() }, { min_bound: 90 });
      expect(r.answer).toBe('No');
      expect(r.evidence).toContain('67% < 90% threshold');
    });

    it('names no threshold when the override happens to equal the default', () => {
      const r = check({ componentName: 'B', node: twoOfThree() }, { min_bound: 100 });
      expect(r.answer).toBe('No');
      expect(r.evidence).not.toContain('threshold');
    });

    it('applies to every token norm, not just radius', () => {
      const text = (id: string, bound: boolean): FigmaNode => ({
        id,
        name: 'T',
        type: 'TEXT',
        ...(bound ? { boundVariables: { fontSize: { id: 'V:9' } } } : {}),
      });
      const node = component({ children: [text('1:2', true), text('1:3', false)] });
      expect(DESIGN_CHECKS['design.type-tokens']({ componentName: 'B', node }).answer).toBe('No');
      expect(
        DESIGN_CHECKS['design.type-tokens']({ componentName: 'B', node }, { min_bound: 50 }).answer,
      ).toBe('Yes');
    });

    it('never answers Yes for a component binding nothing', () => {
      const none = component({ cornerRadius: 4 });
      // 1 is the lowest a config may set, so 0% bound can never clear it.
      expect(check({ componentName: 'B', node: none }, { min_bound: 1 }).answer).toBe('No');
    });
  });

  it('still reports the raw-value ratio when only some layers bind a radius', () => {
    const bound = component({
      id: '1:2',
      cornerRadius: 4,
      boundVariables: { rectangleCornerRadii: { RECTANGLE_TOP_LEFT_CORNER_RADIUS: { id: 'V:1' } } },
    });
    const raw = component({ id: '1:3', cornerRadius: 8 });
    const r = DESIGN_CHECKS['design.radius-tokens']({
      componentName: 'B',
      node: component({ cornerRadius: 4, children: [bound, raw] }),
    });
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('of 3 layer(s) use raw radius tokens');
  });
});

describe('design.layer-names', () => {
  const check = DESIGN_CHECKS['design.layer-names'];

  it('answers N/A for a component with no child layers', () => {
    expect(check({ componentName: 'B', node: component() }).answer).toBe('N/A');
  });

  it('answers Yes when children are named', () => {
    const node = component({
      children: [{ id: '1:2', name: 'Label', type: 'TEXT' }],
    });
    expect(check({ componentName: 'B', node }).answer).toBe('Yes');
  });

  it('answers No for Figma default names and names the offenders', () => {
    const node = component({
      children: [
        { id: '1:2', name: 'Frame 427', type: 'FRAME' },
        { id: '1:3', name: 'Rectangle 3', type: 'RECTANGLE' },
        { id: '1:4', name: 'Label', type: 'TEXT' },
      ],
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('Frame 427');
    expect(r.evidence).toContain('2 of 3');
  });

  it('ignores the component node’s own name', () => {
    const node = component({ name: 'Frame 1', children: [{ id: '1:2', name: 'Label', type: 'TEXT' }] });
    expect(check({ componentName: 'B', node }).answer).toBe('Yes');
  });
});

/** A VARIANT property definition, the shape the REST API declares. */
function variant(options: string[], defaultValue = options[0]): Record<string, unknown> {
  return { type: 'VARIANT', defaultValue, variantOptions: options };
}

/** A BOOLEAN property definition. */
function boolean(defaultValue = false): Record<string, unknown> {
  return { type: 'BOOLEAN', defaultValue };
}

describe('statesNamed', () => {
  it('maps a variant option to its canonical state', () => {
    expect(statesNamed('Hover')).toEqual(['hover']);
    expect(statesNamed('Pressed')).toEqual(['pressed']);
    expect(statesNamed('Disabled')).toEqual(['disabled']);
  });

  it('matches synonyms, case-insensitively', () => {
    expect(statesNamed('HOVERED')).toEqual(['hover']);
    expect(statesNamed('Active')).toEqual(['pressed']);
    expect(statesNamed('Busy')).toEqual(['loading']);
    expect(statesNamed('Checked')).toEqual(['selected']);
    expect(statesNamed('Invalid')).toEqual(['error']);
    expect(statesNamed('Focused')).toEqual(['focus']);
  });

  it('splits camelCase, separators and Figma’s key suffix', () => {
    expect(statesNamed('isDisabled')).toEqual(['disabled']);
    expect(statesNamed('Has Error')).toEqual(['error']);
    expect(statesNamed('focus-visible')).toEqual(['focus']);
    expect(statesNamed('Disabled#3:4')).toEqual(['disabled']);
  });

  it('names every state a compound value expresses', () => {
    expect(statesNamed('Hover + Selected')).toEqual(['hover', 'selected']);
  });

  it('matches whole words only, never a substring', () => {
    // The docs checks learned this: substring matching scored "Icon Usage" as
    // usage guidelines. A variant option is too short a string to guess at.
    expect(statesNamed('Pressure')).toEqual([]);
    expect(statesNamed('Hovercraft')).toEqual([]);
    expect(statesNamed('Terror')).toEqual([]);
  });

  it('does not read a tone, a direction, a visibility toggle or a badge status as a state', () => {
    // Each of these would have produced a confident wrong answer on a
    // component that models no interaction state at all.
    expect(statesNamed('Danger')).toEqual([]);
    expect(statesNamed('Destructive')).toEqual([]);
    expect(statesNamed('Down')).toEqual([]);
    expect(statesNamed('On')).toEqual([]);
    expect(statesNamed('Pending')).toEqual([]);
  });

  it('does not treat the word "state" itself as naming a state', () => {
    // A `State` property says there is a state axis, not which states exist.
    expect(statesNamed('State')).toEqual([]);
    expect(statesNamed('Default')).toEqual([]);
  });

  it('covers every canonical state in the synonym table', () => {
    for (const state of INTERACTION_STATES) {
      for (const synonym of STATE_SYNONYMS[state]) {
        expect(statesNamed(synonym)).toContain(state);
      }
    }
  });
});

describe('design.interaction-states', () => {
  const check = DESIGN_CHECKS['design.interaction-states'];

  it('defaults to hover, pressed and disabled — not all nine', () => {
    expect([...DEFAULT_INTERACTION_STATES]).toEqual(['hover', 'pressed', 'disabled']);
  });

  it('answers Yes when a variant and a boolean between them cover every state asked for', () => {
    const node = component({
      type: 'COMPONENT_SET',
      componentPropertyDefinitions: {
        'Size#1:2': variant(['large', 'small']),
        'State#2:3': variant(['Default', 'Hover', 'Pressed']),
        'Disabled#3:4': boolean(),
      },
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toBe('State variant covers hover, pressed; Disabled boolean covers disabled');
  });

  it('names which property expressed what, and ignores properties that express nothing', () => {
    const node = component({
      type: 'COMPONENT_SET',
      componentPropertyDefinitions: {
        'Tone#1:2': variant(['Neutral', 'Danger']),
        'State#2:3': variant(['Default', 'Hover', 'Pressed', 'Disabled']),
      },
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toBe('State variant covers hover, pressed, disabled');
    expect(r.evidence).not.toContain('Tone');
  });

  it('answers No when some of the states asked for are there and some are not', () => {
    const node = component({
      type: 'COMPONENT_SET',
      componentPropertyDefinitions: { 'State#1:2': variant(['Default', 'Hover']) },
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('State variant covers hover');
    expect(r.evidence).toContain('pressed, disabled');
  });

  it('reads a component that models state entirely as booleans', () => {
    const node = component({
      componentPropertyDefinitions: {
        'Hovered#1:2': boolean(),
        'Pressed#2:3': boolean(),
        'Disabled#3:4': boolean(),
      },
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('Hovered boolean covers hover');
    expect(r.evidence).toContain('Disabled boolean covers disabled');
  });

  it('reads property definitions on a COMPONENT, not only on a COMPONENT_SET', () => {
    // `ComponentPropertiesTrait` is part of both node types in the spec.
    const node = component({
      type: 'COMPONENT',
      componentPropertyDefinitions: {
        'State#1:2': variant(['Default', 'Hover', 'Pressed']),
        'Disabled#3:4': boolean(),
      },
    });
    expect(check({ componentName: 'B', node }).answer).toBe('Yes');
  });

  it('answers N/A when nothing names an interaction state, and says what it inspected', () => {
    const node = component({
      type: 'COMPONENT_SET',
      componentPropertyDefinitions: { 'Size#1:2': variant(['large', 'small']) },
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('N/A');
    expect(r.needsHuman).toBe(true);
    expect(r.evidence).toContain('Size');
    expect(r.evidence).toContain("human's call");
  });

  it('answers N/A for a component with no properties at all', () => {
    const r = check({ componentName: 'B', node: component() });
    expect(r.answer).toBe('N/A');
    expect(r.needsHuman).toBe(true);
    expect(r.evidence).toContain('declares no properties');
  });

  // A Badge with Status=Pending, Error, Success names a state by the words in
  // the table while being a static label. Charging it for a missing hover
  // state is exactly the No an N/A exists to prevent.
  it('answers N/A, not No, when the only states named are ones nobody asked for', () => {
    const node = component({
      type: 'COMPONENT_SET',
      componentPropertyDefinitions: { 'Status#1:2': variant(['Success', 'Error', 'Invalid']) },
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('error');
    expect(r.evidence).toContain('not asked for');
  });

  it('answers against the states a norm asked for', () => {
    const node = component({
      type: 'COMPONENT_SET',
      componentPropertyDefinitions: { 'State#1:2': variant(['Default', 'Loading']) },
    });
    expect(check({ componentName: 'B', node }, { states: ['loading'] }).answer).toBe('Yes');
    const r = check({ componentName: 'B', node }, { states: ['loading', 'error'] });
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('error');
  });

  it('falls back to variant child names when no property definitions came back', () => {
    // `State=Hover, Size=Large` is a real convention and a documented-nowhere
    // one, so an answer resting on it says which source answered.
    const node = component({
      type: 'COMPONENT_SET',
      children: [
        component({ id: '1:2', name: 'State=Default, Size=Large' }),
        component({ id: '1:3', name: 'State=Hover, Size=Large' }),
        component({ id: '1:4', name: 'State=Pressed, Size=Large' }),
        component({ id: '1:5', name: 'State=Disabled, Size=Large' }),
      ],
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('variant child names covers hover, pressed, disabled');
  });

  it('prefers property definitions over child names when both are present', () => {
    const node = component({
      type: 'COMPONENT_SET',
      componentPropertyDefinitions: { 'State#1:2': variant(['Default', 'Hover']) },
      children: [component({ id: '1:3', name: 'State=Pressed' })],
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('No');
    expect(r.evidence).not.toContain('child names');
  });

  // The suffix is observed everywhere and documented nowhere, so a key
  // without it has to work too.
  it('reads a boolean key with no #id suffix', () => {
    const node = component({
      componentPropertyDefinitions: {
        Hover: boolean(),
        Pressed: boolean(),
        Disabled: boolean(),
      },
    });
    expect(check({ componentName: 'B', node }).answer).toBe('Yes');
  });

  // Guessing that an untyped `Disabled` key is a boolean would be inventing
  // the one field that decides the answer.
  it('does not read a key name off a property whose type the API did not report', () => {
    const node = component({
      componentPropertyDefinitions: { 'Disabled#3:4': {}, 'State#1:2': {} },
    });
    expect(check({ componentName: 'B', node }).answer).toBe('N/A');
  });

  it('does not read a TEXT or INSTANCE_SWAP property key as a state', () => {
    const node = component({
      componentPropertyDefinitions: {
        'Error message#1:2': { type: 'TEXT', defaultValue: '' },
        'Loading icon#2:3': { type: 'INSTANCE_SWAP', defaultValue: '1:9' },
      },
    });
    expect(check({ componentName: 'B', node }, { states: ['error', 'loading'] }).answer).toBe('N/A');
  });
});

describe('design.prototyping', () => {
  const check = DESIGN_CHECKS['design.prototyping'];

  it('answers Yes for a component set whose variant options name a state', () => {
    const node = component({
      type: 'COMPONENT_SET',
      componentPropertyDefinitions: { 'State#1:2': variant(['Default', 'Hover']) },
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('State');
    expect(r.evidence).toContain('hover');
  });

  // The old check answered Yes for ANY component set, and printed "component
  // set with 2 propert(ies): Size, Disabled" as its proof that interaction
  // states were connected. Having variants is not having interaction states.
  it('no longer answers Yes for a set whose only property is Size', () => {
    const node = component({
      type: 'COMPONENT_SET',
      componentPropertyDefinitions: { 'Size#1:2': variant(['large', 'small']) },
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('Size');
    expect(r.evidence).toContain('no prototype interaction');
  });

  it('answers Yes for a set with a Disabled boolean and no wiring', () => {
    const node = component({
      type: 'COMPONENT_SET',
      componentPropertyDefinitions: { 'Size#1:2': variant(['large']), 'Disabled#3:4': boolean() },
    });
    expect(check({ componentName: 'B', node }).answer).toBe('Yes');
  });

  // `variantOptions` is spec-declared but unobserved by this project on a
  // live file. A `State` property with no values still says the component
  // set is built as an Interactive Component.
  it('accepts a property whose key is the state axis even with no values returned', () => {
    const node = component({
      type: 'COMPONENT_SET',
      componentPropertyDefinitions: { 'State#1:2': {} },
    });
    const r = check({ componentName: 'B', node });
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('State');
  });

  it('answers Yes when a layer has a prototype transition', () => {
    const node = component({ children: [{ id: '1:2', name: 'Hit', type: 'FRAME', transitionNodeID: '1:9' }] });
    expect(check({ componentName: 'B', node }).answer).toBe('Yes');
  });

  it('answers Yes on a hover or press trigger', () => {
    for (const type of ['ON_HOVER', 'ON_PRESS', 'MOUSE_ENTER', 'ON_CLICK']) {
      const node = component({
        children: [{ id: '1:2', name: 'Hit', type: 'FRAME', interactions: [{ trigger: { type } }] }],
      });
      expect(check({ componentName: 'B', node }).answer).toBe('Yes');
    }
  });

  it('does not count a timed or media trigger as an interaction state', () => {
    const node = component({
      children: [
        { id: '1:2', name: 'Hit', type: 'FRAME', interactions: [{ trigger: { type: 'AFTER_TIMEOUT' } }] },
      ],
    });
    expect(check({ componentName: 'B', node }).answer).toBe('No');
  });

  // "Figma reported an interaction we could not parse" is not "there are no
  // interactions", so an unreadable trigger counts rather than costing a Yes.
  it('counts an interaction whose trigger shape it cannot read', () => {
    const node = component({
      children: [{ id: '1:2', name: 'Hit', type: 'FRAME', interactions: [{}] }],
    });
    expect(check({ componentName: 'B', node }).answer).toBe('Yes');
  });

  it('answers No when nothing is wired', () => {
    expect(check({ componentName: 'B', node: component() }).answer).toBe('No');
  });
});

describe('figmaPropertyNames', () => {
  it('returns the declared property keys', () => {
    expect(figmaPropertyNames(component({ componentPropertyDefinitions: { 'Size#1:2': {} } }))).toEqual(
      ['Size#1:2'],
    );
  });

  it('returns an empty list when there are none', () => {
    expect(figmaPropertyNames(component())).toEqual([]);
  });
});

describe('docs.section', () => {
  const facts = (over: Partial<DocsFacts> = {}): DocsFacts => ({
    componentName: 'Button',
    headings: ['Overview', 'Usage', 'States'],
    absence: null,
    wanted: ['usage'],
    ...over,
  });

  it('answers Yes on a matching heading', () => {
    const r = checkDocSection(facts());
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('Usage');
  });

  it('matches a synonym', () => {
    const r = checkDocSection(
      facts({ headings: ['When to use'], wanted: ['usage', 'when to use'] }),
    );
    expect(r.answer).toBe('Yes');
  });

  it('answers No and lists what it did find', () => {
    const r = checkDocSection(facts({ headings: ['Anatomy'], wanted: ['animation'] }));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('Anatomy');
  });

  it('answers No when the doc has no headings at all', () => {
    const r = checkDocSection(facts({ headings: [] }));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('no headings');
  });

  it('answers N/A when no docs are mapped', () => {
    const r = checkDocSection(facts({ headings: null, absence: 'unmapped' }));
    expect(r.answer).toBe('N/A');
  });

  it('answers No when docs are mapped but missing on disk', () => {
    const r = checkDocSection(facts({ headings: null, absence: 'missing' }));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('missing on disk');
  });

  it('answers N/A, not No, when a hosted page has no renderer', () => {
    // "We could not look" is not "we looked and it is undocumented".
    const r = checkDocSection(facts({ headings: null, absence: 'no-renderer' }));
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('playwright');
  });

  it('answers N/A, not No, when a hosted page could not be read', () => {
    const r = checkDocSection(
      facts({ headings: null, absence: 'unreadable', absenceDetail: 'timeout after 20000ms' }),
    );
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('timeout');
  });
});

describe('headingMatches', () => {
  it('matches a heading that is exactly the synonym', () => {
    expect(headingMatches('Usage', 'usage')).toBe(true);
  });

  it('matches a heading that starts with the synonym', () => {
    expect(headingMatches('Usage guidelines', 'usage')).toBe(true);
    expect(headingMatches('Content & tone', 'content')).toBe(true);
  });

  it('does not match a synonym buried mid-heading', () => {
    // Button documents "Icon Usage", which is guidance about icons, not the
    // component's usage guidelines. Substring matching scored that as a pass.
    expect(headingMatches('Icon Usage', 'usage')).toBe(false);
  });

  it('does not match a longer word that merely starts the same', () => {
    expect(headingMatches('Stateful behaviour', 'state')).toBe(false);
    expect(headingMatches('Variants', 'variant')).toBe(true);
  });

  it('is case and whitespace insensitive', () => {
    expect(headingMatches('  ACCESSIBILITY  ', 'accessibility')).toBe(true);
  });

  it('matches either side of a compound heading', () => {
    // A real styleguide heads one section "Behaviour / States". That section
    // documents interaction states, so DO8 must not score it a No.
    expect(headingMatches('Behaviour / States', 'states')).toBe(true);
    expect(headingMatches('Behaviour / States', 'behaviour')).toBe(true);
    expect(headingMatches('Usage & Content', 'content')).toBe(true);
    expect(headingMatches('Anatomy and variants', 'variant')).toBe(true);
    expect(headingMatches('Motion — transitions', 'transition')).toBe(true);
  });

  it('still anchors each segment', () => {
    expect(headingMatches('Behaviour / Icon usage', 'usage')).toBe(false);
    expect(headingMatches('Usage / Stateful behaviour', 'state')).toBe(false);
  });
});

describe('extractHtmlHeadings', () => {
  it('pulls headings out of rendered HTML', () => {
    const html = '<div><h1>Button</h1><h2 class="x">Anatomy</h2><h3>States</h3></div>';
    expect(extractHtmlHeadings(html)).toEqual(['Button', 'Anatomy', 'States']);
  });

  it('strips nested markup and decodes entities', () => {
    const html = '<h2><span>Do</span> &amp; <em>Don&#39;t</em></h2>';
    expect(extractHtmlHeadings(html)).toEqual(["Do & Don't"]);
  });

  it('ignores empty headings', () => {
    expect(extractHtmlHeadings('<h2></h2><h2>  </h2><h2>Real</h2>')).toEqual(['Real']);
  });
});

describe('isDocsUrl', () => {
  it('recognises http and https', () => {
    expect(isDocsUrl('https://styleguide.example.com/x/p/y')).toBe(true);
    expect(isDocsUrl('http://localhost:3000/docs')).toBe(true);
  });

  it('treats everything else as a repo path', () => {
    expect(isDocsUrl('docs/button.mdx')).toBe(false);
    expect(isDocsUrl('./docs/button.mdx')).toBe(false);
  });
});
