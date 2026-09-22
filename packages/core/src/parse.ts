// Parsing approach adapted from usepolder/reach's scanner. Current owns this
// copy outright: Reach walks import graphs to measure adoption in a consuming
// app, Current introspects a library's own source, so the two diverge from
// here and a shared dependency would only couple their release cycles.
import { parse, type ParserOptions } from '@babel/parser';
import { ParseError } from './errors';

export const BABEL_OPTIONS: ParserOptions = {
  plugins: ['typescript', 'jsx'],
  sourceType: 'module',
  errorRecovery: true,
};

export type Ast = ReturnType<typeof parse>;

/**
 * Parse a component source file. Unlike Reach's scanner this throws rather
 * than returning null: Current only ever parses files a human explicitly
 * named in `components:`, so a parse failure is a real problem with a file
 * someone cares about, not one bad file among thousands in a repo walk.
 */
export function parseSource(fileContent: string, filePath: string): Ast {
  try {
    return parse(fileContent, BABEL_OPTIONS);
  } catch (err) {
    const loc = (err as { loc?: { line: number; column: number } }).loc;
    throw new ParseError(
      filePath,
      (err as Error).message.replace(/\s*\(\d+:\d+\)$/, ''),
      loc?.line,
      loc === undefined ? undefined : loc.column + 1,
    );
  }
}
