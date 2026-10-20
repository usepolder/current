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

describe('code.figma-prop-parity: what counts as a prop', () => {
  const check = CODE_CHECKS['code.figma-prop-parity'];
  const figma = ['Size#1:2', 'Loading#5:6'];

  it('does not count a hook’s destructured return value as a prop', () => {
    const r = check(
      facts(
        `
interface ButtonProps { size: string; }
export const Button = ({ size }: ButtonProps) => {
  const { data, isLoading } = useQuery();
  return <button>{isLoading ? '…' : data}</button>;
};
`,
        { figmaPropertyNames: figma },
      ),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('Loading');
  });

  it('does not count destructuring inside nested callbacks or other components', () => {
    const names = collectCodePropNames(
      parseSource(
        `
export const Button = ({ size }: { size: string }) => {
  const items = list.map(({ id, label }) => id);
  return <button />;
};
const Helper = ({ loading }: { loading: boolean }) => <i />;
`,
        'Button.tsx',
      ),
      'Button',
    );
    expect(names).toEqual(['size']);
  });

  it('reads only the named component when a file has several', () => {
    const names = collectCodePropNames(
      parseSource(
        `
export const Button = ({ size }) => <button />;
export const ButtonGroup = ({ spacing }) => <div />;
`,
        'Button.tsx',
      ),
      'Button',
    );
    expect(names).toEqual(['size']);
  });

  it('reads props declared only by type when the parameter is not destructured', () => {
    const names = collectCodePropNames(
      parseSource(
        `
interface BaseProps { tone: string }
interface ButtonProps extends BaseProps { size: string }
export function Button(props: ButtonProps) { return <button />; }
`,
        'Button.tsx',
      ),
      'Button',
    );
    expect(names.sort()).toEqual(['size', 'tone']);
  });

  it('sees through forwardRef, memo and FC type arguments', () => {
    const src = (body: string): string[] =>
      collectCodePropNames(
        parseSource(`interface ButtonProps { size: string; loading: boolean }\n${body}`, 'B.tsx'),
        'Button',
      ).sort();
    expect(src('export const Button = forwardRef<HTMLButtonElement, ButtonProps>((p, ref) => <button />);')).toEqual(
      ['loading', 'size'],
    );
    expect(src('export const Button = React.memo(({ size }: ButtonProps) => <button />);')).toEqual([
      'loading',
      'size',
    ]);
    expect(src('export const Button: React.FC<ButtonProps> = ({ size }) => <button />;')).toEqual([
      'loading',
      'size',
    ]);
  });

  it('follows an intersection and Omit to the local props type', () => {
    const names = collectCodePropNames(
      parseSource(
        `
type Own = { size: string };
export const Button = ({ size }: Own & Omit<Base, 'x'>) => <button />;
interface Base { tone: string }
`,
        'Button.tsx',
      ),
      'Button',
    );
    expect(names.sort()).toEqual(['size', 'tone']);
  });

  it('handles export lists and default exports', () => {
    expect(
      collectCodePropNames(
        parseSource('const Button = ({ size }) => <b />;\nexport { Button };\n', 'B.tsx'),
        'Button',
      ),
    ).toEqual(['size']);
    expect(
      collectCodePropNames(
        parseSource('export default function Button({ size }) { return <b />; }\n', 'B.tsx'),
        'Button',
      ),
    ).toEqual(['size']);
  });

  it('falls back to Props types, never destructuring, when no component is found', () => {
    const names = collectCodePropNames(
      parseSource('type BadgeProps = { tone: string };\nconst { a } = obj;\n', 'Badge.tsx'),
    );
    expect(names).toEqual(['tone']);
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

describe('custom-norm checks: code.contains / code.forbids', () => {
  const contains = (src: string, text: string[], o: Partial<CodeFacts> = {}) =>
    CODE_CHECKS['code.contains'](facts(src, o), { text });
  const forbids = (src: string, text: string[], o: Partial<CodeFacts> = {}) =>
    CODE_CHECKS['code.forbids'](facts(src, o), { text });

  it('contains: Yes on a hit, naming the file, and No on a miss', () => {
    const hit = contains('export const A = forwardRef(() => null);', ['forwardRef']);
    expect(hit).toMatchObject({ answer: 'Yes' });
    expect(hit.evidence).toContain('src/Button.tsx');
    expect(contains('export const A = () => null;', ['forwardRef', 'memo']).answer).toBe('No');
  });

  it('contains: any one of several strings is enough', () => {
    expect(contains('const a = memo(() => null);', ['forwardRef', 'memo']).answer).toBe('Yes');
  });

  it('forbids: No on a hit, Yes when clean', () => {
    const src = 'export const A = () => <div dangerouslySetInnerHTML={{ __html: x }} />;';
    expect(forbids(src, ['dangerouslySetInnerHTML']).answer).toBe('No');
    expect(forbids('export const A = () => <div />;', ['dangerouslySetInnerHTML']).answer).toBe('Yes');
  });

  it('ignores comments, so a note about a pattern is not a use of it', () => {
    const src = '// never use dangerouslySetInnerHTML\n/* or forwardRef */\nexport const A = () => <div />;';
    expect(forbids(src, ['dangerouslySetInnerHTML']).answer).toBe('Yes');
    expect(contains(src, ['forwardRef']).answer).toBe('No');
  });

  it('still sees the pattern in a string, which is code', () => {
    expect(forbids('const s = "dangerouslySetInnerHTML";', ['dangerouslySetInnerHTML']).answer).toBe('No');
  });

  it('matches literally: regex metacharacters are just characters', () => {
    expect(contains('const a = 1;', ['.*']).answer).toBe('No');
    expect(contains('const a = ".*";', ['.*']).answer).toBe('Yes');
  });

  it('also searches the component’s related files, and names which one', () => {
    const related = {
      files: [
        { filePath: 'src/Button.module.css', source: '.a { color: red !important; }', kind: 'style' as const, ast: null },
      ],
      notFollowed: 0,
      unparseable: [],
    };
    const r = forbids('export const A = () => null;', ['!important'], { related });
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('src/Button.module.css');
  });

  it('skips CSS comments in related style files', () => {
    const related = {
      files: [{ filePath: 'a.css', source: '/* no !important */\n.a { color: red; }', kind: 'style' as const, ast: null }],
      notFollowed: 0,
      unparseable: [],
    };
    expect(forbids('export const A = () => null;', ['!important'], { related }).answer).toBe('Yes');
  });

  it('is N/A rather than a guess when no text was configured', () => {
    expect(CODE_CHECKS['code.forbids'](facts('const a = 1;')).answer).toBe('N/A');
  });
});
