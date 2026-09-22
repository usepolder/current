import { describe, expect, it } from 'vitest';
import {
  DESIGN_CHECKS,
  checkDocSection,
  extractHeadings,
  figmaPropertyNames,
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

describe('design.prototyping', () => {
  const check = DESIGN_CHECKS['design.prototyping'];

  it('answers Yes for a component set with variant properties', () => {
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
  it('extracts markdown headings and JSX title props', () => {
    const headings = extractHeadings('# Button\n\n## Usage\n\n<Section title="Accessibility" />');
    expect(headings).toEqual(['Button', 'Usage', 'Accessibility']);
  });

  it('answers Yes on a matching heading', () => {
    const r = checkDocSection({
      componentName: 'Button',
      source: '## Usage\ntext',
      missing: false,
      headings: ['usage'],
    });
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('Usage');
  });

  it('matches a synonym', () => {
    const r = checkDocSection({
      componentName: 'Button',
      source: '## When to use\ntext',
      missing: false,
      headings: ['usage', 'when to use'],
    });
    expect(r.answer).toBe('Yes');
  });

  it('answers No and lists what it did find', () => {
    const r = checkDocSection({
      componentName: 'Button',
      source: '## Anatomy\ntext',
      missing: false,
      headings: ['animation'],
    });
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('Anatomy');
  });

  it('answers N/A when no docs file is mapped', () => {
    const r = checkDocSection({
      componentName: 'Button',
      source: null,
      missing: false,
      headings: ['usage'],
    });
    expect(r.answer).toBe('N/A');
  });

  it('answers No when a docs file is mapped but missing on disk', () => {
    const r = checkDocSection({
      componentName: 'Button',
      source: null,
      missing: true,
      headings: ['usage'],
    });
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('missing on disk');
  });
});
