import { describe, expect, it } from 'vitest';
import {
  DESIGN_CHECKS,
  checkDocSection,
  extractHtmlHeadings,
  figmaPropertyNames,
  headingMatches,
  isDocsUrl,
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
