import { describe, expect, it } from 'vitest';
import { ParseError, coerceAnswer, lookupAnswer, parseAnswers } from '@usepolder/current-core';

describe('coerceAnswer', () => {
  it('accepts the canonical spellings', () => {
    expect(coerceAnswer('Yes', 'Button', 'DO2')).toBe('Yes');
    expect(coerceAnswer('No', 'Button', 'DO2')).toBe('No');
    expect(coerceAnswer('N/A', 'Button', 'DO2')).toBe('N/A');
  });

  it('accepts booleans, because some YAML parsers turn yes/no into them', () => {
    expect(coerceAnswer(true, 'Button', 'DO2')).toBe('Yes');
    expect(coerceAnswer(false, 'Button', 'DO2')).toBe('No');
  });

  it('is case and whitespace insensitive', () => {
    expect(coerceAnswer('  yes ', 'Button', 'DO2')).toBe('Yes');
    expect(coerceAnswer('NO', 'Button', 'DO2')).toBe('No');
    expect(coerceAnswer('n/a', 'Button', 'DO2')).toBe('N/A');
    expect(coerceAnswer('na', 'Button', 'DO2')).toBe('N/A');
  });

  it('treats an empty value as N/A', () => {
    expect(coerceAnswer(null, 'Button', 'DO2')).toBe('N/A');
    expect(coerceAnswer('', 'Button', 'DO2')).toBe('N/A');
  });

  it('rejects anything else by name, so the typo is findable', () => {
    expect(() => coerceAnswer('maybe', 'Button', 'DO2')).toThrow(/Button\.DO2.*"maybe"/);
    expect(() => coerceAnswer(42, 'Button', 'DO2')).toThrow(/not a valid answer/);
  });
});

describe('parseAnswers', () => {
  it('reads a nested component → metric → answer mapping', () => {
    const book = parseAnswers(`
Button:
  DO2: Yes
  DO3: No
  CO4: "N/A"
Badge:
  DO2: Yes
`);
    expect(lookupAnswer(book, 'Button', 'DO2')).toBe('Yes');
    expect(lookupAnswer(book, 'Button', 'DO3')).toBe('No');
    expect(lookupAnswer(book, 'Button', 'CO4')).toBe('N/A');
    expect(lookupAnswer(book, 'Badge', 'DO2')).toBe('Yes');
    expect(lookupAnswer(book, 'Badge', 'DO3')).toBeUndefined();
  });

  it('handles an empty file', () => {
    expect(parseAnswers('').size).toBe(0);
  });

  it('handles a component with no answers yet', () => {
    const book = parseAnswers('Button:\n');
    expect(book.get('Button')?.size).toBe(0);
  });

  it('reports malformed YAML with the file and line', () => {
    let thrown: unknown;
    try {
      parseAnswers('Button:\n  DO2: Yes\n \tDO3: No\n');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ParseError);
    expect((thrown as Error).message).toContain('.current.answers.yml:');
  });

  it('rejects a list where a mapping belongs', () => {
    expect(() => parseAnswers('- Button\n- Badge\n')).toThrow(/must be a mapping/);
  });
});
