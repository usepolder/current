import * as yaml from 'js-yaml';
import {
  ConfigValidationError,
  CurrentError,
  coerceAnswer,
  type Answer,
  type CurrentReport,
} from '@usepolder/current-core';

/** One question for a person, with what the machine already worked out. */
export interface ExportRow {
  component: string;
  metric: string;
  category: string;
  subcategory: string;
  guideline: string;
  answer: string;
  evidence: string;
}

export const CSV_HEADER = [
  'component',
  'metric',
  'category',
  'subcategory',
  'guideline',
  'answer',
  'automated_evidence',
] as const;

/**
 * The rows a person still has to judge.
 *
 * `evidence` carries the automated findings for the same component **on the
 * same axis**, which is the point of the whole exercise: you are not being
 * interrogated, you are being shown what the machine could determine and
 * asked to close the gap. Scoped to the axis rather than the subcategory
 * because most subcategories have no automated sibling at all — CO11
 * (localisation) and CO6 (responsiveness) would otherwise export blank.
 */
export function buildExportRows(report: CurrentReport): ExportRow[] {
  const rows: ExportRow[] = [];
  for (const component of report.components) {
    const automatedByAxis = new Map<string, string[]>();
    for (const m of component.metrics) {
      if (m.source !== 'auto' || m.evidence === null) continue;
      const list = automatedByAxis.get(m.category) ?? [];
      list.push(`${m.metricId} ${m.answer}: ${m.evidence}`);
      automatedByAxis.set(m.category, list);
    }

    for (const m of component.metrics) {
      if (m.source !== 'unanswered') continue;
      rows.push({
        component: component.name,
        metric: m.metricId,
        category: m.category,
        subcategory: m.subcategory,
        guideline: m.guideline,
        answer: '',
        evidence: (automatedByAxis.get(m.category) ?? []).join(' | '),
      });
    }
  }
  return rows;
}

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: readonly ExportRow[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [r.component, r.metric, r.category, r.subcategory, r.guideline, r.answer, r.evidence]
        .map(escapeField)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parse CSV properly rather than splitting on commas.
 *
 * Guidelines contain commas and the evidence column contains quotes, so a
 * naive split silently shifts every later column — and a shifted answer
 * column would write someone's judgement against the wrong metric.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // A trailing newline must not produce a phantom empty row.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== '' || row.length > 0) endRow();
  if (quoted) {
    throw new CurrentError('The CSV ends inside a quoted field. It is probably truncated.');
  }
  return rows;
}

export interface ImportedAnswer {
  component: string;
  metric: string;
  answer: Answer;
}

/**
 * Read back the answer column, by header name rather than position, so a
 * reviewer who reorders or adds columns in a spreadsheet does not corrupt the
 * import.
 */
export function readImportRows(text: string): ImportedAnswer[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CurrentError('That CSV is empty.');

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name);
  const iComponent = col('component');
  const iMetric = col('metric');
  const iAnswer = col('answer');
  const missing = [
    iComponent === -1 ? 'component' : null,
    iMetric === -1 ? 'metric' : null,
    iAnswer === -1 ? 'answer' : null,
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) {
    throw new CurrentError(
      `That CSV has no ${missing.join(', ')} column. Export a fresh one with \`current export\`.`,
    );
  }

  const out: ImportedAnswer[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const component = (cells[iComponent] ?? '').trim();
    const metric = (cells[iMetric] ?? '').trim();
    const raw = (cells[iAnswer] ?? '').trim();
    if (component === '' || metric === '') continue;

    // An empty cell means "still unanswered", NOT "not applicable". Passing it
    // to coerceAnswer would turn every blank into an explicit N/A and claim a
    // person answered when they skipped.
    if (raw === '') continue;

    try {
      out.push({ component, metric, answer: coerceAnswer(raw, component, metric) });
    } catch (err) {
      throw new CurrentError(
        `Row ${r + 1}: ${(err as ConfigValidationError).message}\n` +
          'Leave the cell empty to come back to it later.',
      );
    }
  }
  return out;
}

export interface MergeResult {
  text: string;
  added: number;
  changed: number;
  unchanged: number;
}

/**
 * Fold imported answers into the answers file.
 *
 * Rewritten rather than appended, unlike `.polder.yml`: this file belongs to
 * Current alone, so there are no other tools' keys or comments to preserve.
 */
export function mergeAnswers(existing: string | null, rows: readonly ImportedAnswer[]): MergeResult {
  let book: Record<string, Record<string, string>> = {};
  if (existing !== null && existing.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = yaml.load(existing);
    } catch (err) {
      throw new CurrentError(
        `.polder.answers.yml is not valid YAML, so there is nothing safe to merge into.\n${(err as Error).message}`,
      );
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [component, metrics] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) continue;
        book[component] = {};
        for (const [metric, value] of Object.entries(metrics as Record<string, unknown>)) {
          book[component][metric] = coerceAnswer(value, component, metric);
        }
      }
    }
  }

  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const r of rows) {
    const current = book[r.component]?.[r.metric];
    if (current === undefined) added += 1;
    else if (current !== r.answer) changed += 1;
    else unchanged += 1;
    book[r.component] = { ...(book[r.component] ?? {}), [r.metric]: r.answer };
  }

  const sorted: Record<string, Record<string, string>> = {};
  for (const component of Object.keys(book).sort()) {
    const metrics = book[component];
    sorted[component] = {};
    for (const metric of Object.keys(metrics).sort()) sorted[component][metric] = metrics[metric];
  }
  book = sorted;

  const header =
    '# Answers for the metrics Current cannot check automatically.\n' +
    '# Written by `current import`; safe to edit by hand.\n';
  return {
    text: header + yaml.dump(book, { quotingType: '"', forceQuotes: false, lineWidth: 100 }),
    added,
    changed,
    unchanged,
  };
}
