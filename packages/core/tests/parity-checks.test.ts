import { describe, expect, it } from 'vitest';
import { CODE_CHECKS, collectCodePropShapes, parseSource, type CodeFacts } from '@usepolder/current-core';

const values = CODE_CHECKS['code.figma-variant-values'];
const defaults = CODE_CHECKS['code.figma-default-values'];

function facts(source: string, defs: Record<string, unknown> | null): CodeFacts {
  return {
    componentName: 'Button',
    filePath: 'src/Button.tsx',
    source,
    ast: parseSource(source, 'src/Button.tsx'),
    figmaPropertyNames: defs === null ? null : Object.keys(defs),
    figmaPropertyDefinitions: defs,
  };
}

const variant = (options: string[], defaultValue = options[0]) => ({
  type: 'VARIANT',
  variantOptions: options,
  defaultValue,
});
const bool = (defaultValue: boolean) => ({ type: 'BOOLEAN', defaultValue });

describe('collectCodePropShapes', () => {
  it('reads literal unions, aliases, booleans, optionality and both kinds of default', () => {
    const shapes = collectCodePropShapes(
      parseSource(
        `
        type Size = 'sm' | 'md' | 'lg';
        export interface ButtonProps {
          size?: Size;
          tone: 'neutral' | 'danger' | undefined;
          label: string;
          isDisabled?: boolean;
          count?: 1 | 2;
        }
        export function Button({ size = 'md', isDisabled = false, ...rest }: ButtonProps) { return null; }
        Button.defaultProps = { tone: 'neutral' };
        `,
        'b.tsx',
      ),
      'Button',
    );
    expect(shapes.get('size')).toMatchObject({ values: ['sm', 'md', 'lg'], optional: true, defaultValue: 'md' });
    expect(shapes.get('tone')).toMatchObject({ values: ['neutral', 'danger'], defaultValue: 'neutral' });
    expect(shapes.get('label')).toMatchObject({ values: null });
    expect(shapes.get('isDisabled')).toMatchObject({ boolean: true, defaultValue: false });
    expect(shapes.get('count')).toMatchObject({ values: ['1', '2'] });
  });

  it('follows forwardRef type arguments to the props type', () => {
    const shapes = collectCodePropShapes(
      parseSource(
        `type P = { size: 'a' | 'b' };
         export const Button = forwardRef<HTMLButtonElement, P>((props, ref) => null);`,
        'b.tsx',
      ),
      'Button',
    );
    expect(shapes.get('size')?.values).toEqual(['a', 'b']);
  });
});

describe('code.figma-variant-values (CO14)', () => {
  const src = `export function Button({ size }: { size: 'sm' | 'md' | 'lg' }) { return null; }`;

  it('answers Yes when the values agree, ignoring case and punctuation', () => {
    const r = values(facts(src, { 'Size#1:2': variant(['SM', 'Md', 'lg']) }));
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('Size');
    expect(r.evidence).not.toContain('#1:2');
  });

  // The drift CO9 cannot see: the name matches, the values do not.
  it('answers No when Figma offers a value code does not accept', () => {
    const r = values(facts(src, { Size: variant(['sm', 'md', 'lg', 'xl']) }));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('Figma has xl that code does not accept');
  });

  it('answers No, naming both sides, when each has values the other lacks', () => {
    const r = values(facts(src, { Size: variant(['sm', 'md', 'xl']) }));
    expect(r.evidence).toContain('Figma has xl');
    expect(r.evidence).toContain('code accepts lg');
  });

  // A value only matches a value.
  it('does not guess that lg means large', () => {
    const r = values(facts(src, { Size: variant(['sm', 'md', 'large']) }));
    expect(r.answer).toBe('No');
  });

  it('treats a True/False variant and a boolean prop as agreeing', () => {
    const r = values(
      facts(`export function Button({ isDisabled }: { isDisabled?: boolean }) { return null; }`, {
        Disabled: variant(['False', 'True']),
      }),
    );
    expect(r.answer).toBe('Yes');
  });

  it('leaves out a prop whose type is open, rather than calling it a mismatch', () => {
    const r = values(
      facts(`export function Button({ size }: { size: string }) { return null; }`, { Size: variant(['sm', 'md']) }),
    );
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('closed set of values');
  });

  // A missing counterpart is CO9's finding, not this one's.
  it('does not compare a Figma property with no code counterpart', () => {
    const r = values(facts(src, { Size: variant(['sm', 'md', 'lg']), Tone: variant(['a', 'b']) }));
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('all 1 variant');
  });

  it('answers N/A with no Figma node', () => {
    expect(values(facts(src, null)).answer).toBe('N/A');
  });

  it('ignores non-variant properties', () => {
    const r = values(facts(src, { Size: { type: 'TEXT', defaultValue: 'x' } }));
    expect(r.answer).toBe('N/A');
  });
});

describe('code.figma-default-values (CO15)', () => {
  it('answers Yes when the defaults agree', () => {
    const r = defaults(
      facts(
        `export function Button({ size = 'md', isDisabled = false }: { size?: 'sm' | 'md'; isDisabled?: boolean }) { return null; }`,
        { Size: variant(['sm', 'md'], 'Md'), Disabled: bool(false) },
      ),
    );
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('2 compared');
  });

  it('answers No when Figma and code open in different states', () => {
    const r = defaults(
      facts(`export function Button({ size = 'md' }: { size?: 'sm' | 'md' }) { return null; }`, {
        Size: variant(['sm', 'md'], 'sm'),
      }),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('Figma defaults to sm, code to md');
  });

  it('reads defaultProps as well as destructuring defaults', () => {
    const r = defaults(
      facts(
        `export function Button({ size }: { size?: 'sm' | 'md' }) { return null; }
         Button.defaultProps = { size: 'sm' };`,
        { Size: variant(['sm', 'md'], 'md') },
      ),
    );
    expect(r.answer).toBe('No');
  });

  // An absent boolean is false, so this is a real disagreement.
  it('treats an undeclared boolean default as false, and says so', () => {
    const r = defaults(
      facts(`export function Button({ isLoading }: { isLoading?: boolean }) { return null; }`, {
        Loading: bool(true),
      }),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('no default declared, so false');
  });

  // The component may fall back internally; guessing which would invent it.
  it('leaves out a variant prop with no declared default', () => {
    const r = defaults(
      facts(`export function Button({ size }: { size?: 'sm' | 'md' }) { return null; }`, {
        Size: variant(['sm', 'md'], 'md'),
      }),
    );
    expect(r.answer).toBe('N/A');
  });

  // TEXT defaults are placeholder content, not a state.
  it('does not compare TEXT property defaults', () => {
    const r = defaults(
      facts(`export function Button({ label = 'Go' }: { label?: string }) { return null; }`, {
        Label: { type: 'TEXT', defaultValue: 'Button label' },
      }),
    );
    expect(r.answer).toBe('N/A');
  });

  it('answers N/A with no Figma node', () => {
    expect(defaults(facts(`export function Button() { return null; }`, null)).answer).toBe('N/A');
  });
});
