import { describe, expect, it } from 'vitest';
import {
  CODE_CHECKS,
  ParseError,
  collectCodePropNames,
  normalisePropName,
  parseSource,
  type CodeFacts,
} from '@usepolder/current-core';

function facts(source: string, overrides: Partial<CodeFacts> = {}): CodeFacts {
  return {
    componentName: 'Button',
    filePath: 'src/Button.tsx',
    source,
    ast: parseSource(source, 'src/Button.tsx'),
    figmaPropertyNames: null,
    ...overrides,
  };
}

describe('parseSource', () => {
  it('reports a syntax error with file and line, not a raw babel dump', () => {
    let thrown: unknown;
    try {
      parseSource('export const A = (<div>\n', 'src/Broken.tsx');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ParseError);
    expect((thrown as Error).message).toMatch(/^src\/Broken\.tsx:\d+/);
  });

  it('parses TSX with generics and satisfies', () => {
    expect(() =>
      parseSource(
        'const f = <T,>(x: T): T => x;\nexport const A = () => <div id="a" />;\n',
        'a.tsx',
      ),
    ).not.toThrow();
  });
});

describe('code.aria-attributes', () => {
  const check = CODE_CHECKS['code.aria-attributes'];

  it('answers Yes when a host element carries aria-*', () => {
    const r = check(facts('export const B = () => <button aria-label="Close">x</button>;'));
    expect(r.answer).toBe('Yes');
  });

  it('answers Yes for a role attribute', () => {
    expect(check(facts('export const B = () => <div role="alert">hi</div>;')).answer).toBe('Yes');
  });

  it('answers No when host elements carry none', () => {
    const r = check(facts('export const B = () => <button onClick={f}>x</button>;'));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('no aria-');
  });

  it('answers N/A when the component renders only other components', () => {
    const r = check(facts('export const B = () => <Card><Text>hi</Text></Card>;'));
    expect(r.answer).toBe('N/A');
  });

  it('answers N/A rather than No when props are spread onto a host element', () => {
    const r = check(facts('export const B = (p) => <button {...p}>x</button>;'));
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('spread');
  });
});

describe('code.text-alternatives', () => {
  const check = CODE_CHECKS['code.text-alternatives'];

  it('answers N/A when there is no non-text content', () => {
    expect(check(facts('export const B = () => <span>hi</span>;')).answer).toBe('N/A');
  });

  it('answers Yes when every image has alt text', () => {
    expect(check(facts('export const B = () => <img src="a.png" alt="A" />;')).answer).toBe('Yes');
  });

  it('answers Yes for a decorative icon marked aria-hidden', () => {
    expect(check(facts('export const B = () => <svg aria-hidden="true" />;')).answer).toBe('Yes');
  });

  it('answers No and names the offenders', () => {
    const r = check(facts('export const B = () => <div><img src="a.png" /><svg /></div>;'));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('<img>');
    expect(r.evidence).toContain('<svg>');
  });

  it('treats icon components as non-text content', () => {
    expect(check(facts('export const B = () => <Icon name="x" />;')).answer).toBe('No');
    expect(check(facts('export const B = () => <Icon name="x" aria-label="Close" />;')).answer).toBe(
      'Yes',
    );
  });
});

describe('code.token-usage', () => {
  const check = CODE_CHECKS['code.token-usage'];

  it('answers Yes when there are no hardcoded values', () => {
    const r = check(facts('export const B = () => <div className="btn">x</div>;'));
    expect(r.answer).toBe('Yes');
  });

  it('answers No for a hardcoded hex colour', () => {
    const r = check(facts('const s = { color: "#ff0000" };\nexport const B = () => <div style={s} />;'));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('#ff0000');
  });

  it('answers No for hardcoded px values, including in template literals', () => {
    const r = check(
      facts('const s = styled.div`padding: 12px;`;\nexport const B = () => <s.div />;'),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('12px');
  });
});

describe('code.semantic-name', () => {
  const check = CODE_CHECKS['code.semantic-name'];
  const src = 'export const X = () => <div />;';

  it('accepts a descriptive name', () => {
    expect(check(facts(src, { componentName: 'Button' })).answer).toBe('Yes');
  });

  it('rejects generic placeholders', () => {
    for (const name of ['Wrapper', 'Container', 'Thing', 'Temp', 'Component']) {
      expect(check(facts(src, { componentName: name })).answer).toBe('No');
    }
  });

  it('rejects a versioned duplicate', () => {
    expect(check(facts(src, { componentName: 'Button2' })).answer).toBe('No');
  });

  it('rejects a name too short to mean anything', () => {
    expect(check(facts(src, { componentName: 'Bt' })).answer).toBe('No');
  });
});

describe('code.figma-prop-parity', () => {
  const check = CODE_CHECKS['code.figma-prop-parity'];
  const src = `
interface ButtonProps { size: string; isDisabled?: boolean; }
export const Button = ({ size, isDisabled }: ButtonProps) => <button />;
`;

  it('answers N/A when there is no Figma side to compare against', () => {
    expect(check(facts(src)).answer).toBe('N/A');
  });

  it('answers N/A when the Figma component declares no properties', () => {
    expect(check(facts(src, { figmaPropertyNames: [] })).answer).toBe('N/A');
  });

  it('answers Yes when every Figma property has a code counterpart', () => {
    const r = check(facts(src, { figmaPropertyNames: ['Size#1:2', 'Disabled#3:4'] }));
    expect(r.answer).toBe('Yes');
  });

  it('answers No and names the Figma properties with no code counterpart', () => {
    const r = check(facts(src, { figmaPropertyNames: ['Size#1:2', 'Loading#5:6'] }));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('Loading');
    expect(r.evidence).not.toContain('#5:6');
  });
});

describe('prop-name helpers', () => {
  it('strips Figma id suffixes, boolean prefixes, casing and punctuation', () => {
    expect(normalisePropName('Size#1:2')).toBe('size');
    expect(normalisePropName('isDisabled')).toBe('disabled');
    expect(normalisePropName('has-icon')).toBe('icon');
    expect(normalisePropName('Show Label')).toBe('label');
  });

  it('collects prop names from an interface and from destructuring', () => {
    const ast = parseSource(
      `
interface CardProps { title: string; }
type OtherProps = { ignored: string };
export const Card = ({ title, onClose }: CardProps) => <div />;
`,
      'Card.tsx',
    );
    const names = collectCodePropNames(ast);
    expect(names).toContain('title');
    expect(names).toContain('onClose');
  });

  it('collects prop names from a Props type alias', () => {
    const ast = parseSource('type BadgeProps = { tone: string };\n', 'Badge.tsx');
    expect(collectCodePropNames(ast)).toContain('tone');
  });
});
