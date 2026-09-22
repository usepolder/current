import * as yaml from 'js-yaml';
import { ConfigValidationError, ParseError } from './errors';
import type { Answer } from './metrics';

/** component name → metric id → answer */
export type AnswerBook = Map<string, Map<string, Answer>>;

/**
 * Accepts what a human actually types. YAML 1.1 parsers turn `yes`/`no` into
 * booleans and js-yaml 4 does not, so a file that round-trips through an
 * editor or another tool can arrive as either — both are coerced here rather
 * than rejected, because a config that breaks on `DO2: yes` is a bad joke in
 * a tool whose answers are literally Yes/No.
 */
export function coerceAnswer(value: unknown, component: string, metric: string): Answer {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'yes' || v === 'y' || v === 'true') return 'Yes';
    if (v === 'no' || v === 'n' || v === 'false') return 'No';
    if (v === 'n/a' || v === 'na' || v === '-' || v === '') return 'N/A';
  }
  throw new ConfigValidationError(
    `${component}.${metric}: "${String(value)}" is not a valid answer. Use Yes, No, or "N/A".`,
  );
}

export function parseAnswers(raw: string, filePath = '.current.answers.yml'): AnswerBook {
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    const mark = (err as { mark?: { line: number; column: number } }).mark;
    throw new ParseError(
      filePath,
      (err as Error).message.split('\n')[0],
      mark ? mark.line + 1 : undefined,
      mark ? mark.column + 1 : undefined,
    );
  }

  const book: AnswerBook = new Map();
  if (parsed === undefined || parsed === null) return book;

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigValidationError(
      `${filePath} must be a mapping of component name to { metricId: Yes|No|"N/A" }`,
    );
  }

  for (const [component, metrics] of Object.entries(parsed as Record<string, unknown>)) {
    if (metrics === null || metrics === undefined) {
      book.set(component, new Map());
      continue;
    }
    if (typeof metrics !== 'object' || Array.isArray(metrics)) {
      throw new ConfigValidationError(
        `${filePath}: ${component} must be a mapping of metric id to Yes|No|"N/A"`,
      );
    }
    const entries = new Map<string, Answer>();
    for (const [metric, value] of Object.entries(metrics as Record<string, unknown>)) {
      entries.set(metric, coerceAnswer(value, component, metric));
    }
    book.set(component, entries);
  }
  return book;
}

export function lookupAnswer(
  book: AnswerBook,
  component: string,
  metricId: string,
): Answer | undefined {
  return book.get(component)?.get(metricId);
}
