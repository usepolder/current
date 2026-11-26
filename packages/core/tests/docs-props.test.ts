import { describe, expect, it } from 'vitest';
import { checkDocumentedProps, documentedProps, type DocsPropsFacts } from '@usepolder/current-core';

const PROPS = ['size', 'isDisabled', 'onPress', 'children', 'className'];

function facts(source: string | null, overrides: Partial<DocsPropsFacts> = {}): DocsPropsFacts {
  return { componentName: 'Button', source, hosted: false, absence: null, codeProps: PROPS, ...overrides };
}

const doc = (rows: string[], heading = '## Props', header = '| Prop | Type | Default |') =>
  [`# Button`, '', 'Some intro.', '', heading, '', header, '| --- | --- | --- |', ...rows, '', '## Usage', ''].join('\n');

const row = (name: string) => `| \`${name}\` | x | — |`;

describe('documentedProps', () => {
  it('reads the first column of the table under a props heading', () => {
    expect(documentedProps(doc([row('size'), '| **isDisabled?** | boolean | false |']))).toEqual([
      'size',
      'isDisabled',
    ]);
  });

  it.each(['## API', '### Properties', '## Component API'])('accepts the heading %s', (h) => {
    expect(documentedProps(doc([row('size')], h))).toEqual(['size']);
  });

  it('ignores a table under any other heading', () => {
    expect(documentedProps(doc([row('size')], '## Tokens'))).toBeNull();
  });

  it('ignores a table whose first column is not a prop column', () => {
    expect(documentedProps(doc([row('size')], '## Props', '| Token | Value | Notes |'))).toBeNull();
  });

  it('accepts alignment colons in the divider', () => {
    const src = ['## Props', '| Name | Type |', '|:---|---:|', '| size | x |'].join('\n');
    expect(documentedProps(src)).toEqual(['size']);
  });
});

describe('docs.props (DO10)', () => {
  it('answers Yes when the table matches the code', () => {
    const r = checkDocumentedProps(facts(doc(['size', 'isDisabled', 'onPress', 'children'].map(row))));
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('4 prop(s)');
  });

  it('answers No for a documented prop the code no longer has', () => {
    const r = checkDocumentedProps(facts(doc(['size', 'isDisabled', 'onPress', 'children', 'variant'].map(row))));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('documented but not in the code: variant');
  });

  it('answers No for a code prop the docs miss', () => {
    const r = checkDocumentedProps(facts(doc(['size', 'isDisabled', 'children'].map(row))));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('in the code but not documented: onPress');
  });

  // Unlike CO9, docs are meant to BE the API: a different name is the bug.
  it('does not pair disabled with isDisabled the way CO9 does', () => {
    const r = checkDocumentedProps(facts(doc(['size', 'disabled', 'onPress', 'children'].map(row))));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('documented but not in the code: disabled');
  });

  it('does not require className, style or ref in the table', () => {
    const r = checkDocumentedProps(
      facts(doc(['size', 'isDisabled', 'onPress', 'children'].map(row)), {
        codeProps: [...PROPS, 'style', 'ref', 'data-testid'],
      }),
    );
    expect(r.answer).toBe('Yes');
  });

  it.each(['<ArgTypes of={Button} />', '<ArgsTable of={Button} />', '<Controls />', '<Props of={Button} />'])(
    'answers Yes for a table generated from the types: %s',
    (tag) => {
      const r = checkDocumentedProps(facts(`# Button\n\n## Props\n\n${tag}\n`));
      expect(r.answer).toBe('Yes');
      expect(r.evidence).toContain('cannot drift');
    },
  );

  it('answers N/A with no props table, pointing at DO6', () => {
    const r = checkDocumentedProps(facts('# Button\n\n## Usage\n\nUse it.\n'));
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('DO6');
  });

  it('answers N/A for hosted docs, which are read for headings only', () => {
    expect(checkDocumentedProps(facts(null, { hosted: true })).answer).toBe('N/A');
  });

  it('answers N/A with no docs, or no code to compare', () => {
    expect(checkDocumentedProps(facts(null, { absence: 'unmapped' })).answer).toBe('N/A');
    expect(checkDocumentedProps(facts(null, { absence: 'missing' })).evidence).toContain('missing on disk');
    expect(checkDocumentedProps(facts(doc([row('size')]), { codeProps: null })).answer).toBe('N/A');
  });
});
