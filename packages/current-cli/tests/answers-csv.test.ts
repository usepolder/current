import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildExportRows,
  mergeAnswers,
  parseCsv,
  readImportRows,
  run,
  toCsv,
} from '../src/index';
import { parseAnswers, type CurrentReport } from '@usepolder/current-core';

const FIXTURE = path.join(__dirname, '..', '..', 'core', 'tests', 'fixtures', 'ds');
const temps: string[] = [];

function tempCopyOfFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-csv-'));
  temps.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  while (temps.length > 0) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

async function invoke(argv: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await run(argv, {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    env: {},
    version: '0.1.0-test',
    cwd,
  });
  return { code, out, err };
}

describe('parseCsv', () => {
  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('a,"b,c",d\n')).toEqual([['a', 'b,c', 'd']]);
  });

  it('unescapes a doubled quote', () => {
    expect(parseCsv('a,"say ""hi""",c\n')).toEqual([['a', 'say "hi"', 'c']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('a,"two\nlines",c\n')).toEqual([['a', 'two\nlines', 'c']]);
  });

  it('handles CRLF, which is what a spreadsheet exports', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('does not invent an empty row from the trailing newline', () => {
    expect(parseCsv('a,b\n')).toHaveLength(1);
  });

  it('refuses a file that ends inside a quoted field', () => {
    expect(() => parseCsv('a,"unterminated\n')).toThrow(/ends inside a quoted field/);
  });

  it('round-trips everything toCsv escapes', () => {
    const rows = [
      {
        component: 'Button',
        metric: 'CO1',
        category: 'code',
        subcategory: 'A11y',
        guideline: 'Is it focusable, operable, and does it say "what" it is?',
        answer: '',
        evidence: 'CO2 Yes: none found | CO5 No: 3 values, one at src/a.tsx:7',
      },
    ];
    const parsed = parseCsv(toCsv(rows));
    expect(parsed[1][4]).toBe(rows[0].guideline);
    expect(parsed[1][6]).toBe(rows[0].evidence);
  });
});

const report = (metrics: unknown[]): CurrentReport =>
  ({
    components: [{ name: 'Button', metrics }],
  }) as unknown as CurrentReport;

const metric = (
  metricId: string,
  source: string,
  category = 'code',
  evidence: string | null = null,
  answer = 'N/A',
) => ({ metricId, source, category, subcategory: 'A11y', guideline: `${metricId}?`, evidence, answer });

describe('buildExportRows', () => {
  it('exports only the metrics still waiting on a person', () => {
    const rows = buildExportRows(
      report([metric('CO1', 'unanswered'), metric('CO2', 'auto'), metric('CO3', 'manual')]),
    );
    expect(rows.map((r) => r.metric)).toEqual(['CO1']);
  });

  // The point of the feature: the reviewer sees what the machine worked out.
  it('carries the automated evidence for the same axis', () => {
    const rows = buildExportRows(
      report([
        metric('CO1', 'unanswered', 'code'),
        metric('CO2', 'auto', 'code', 'no hardcoded colours', 'Yes'),
        metric('CO5', 'auto', 'code', '3 px values', 'No'),
      ]),
    );
    expect(rows[0].evidence).toBe('CO2 Yes: no hardcoded colours | CO5 No: 3 px values');
  });

  it('does not borrow evidence from a different axis', () => {
    const rows = buildExportRows(
      report([metric('CO1', 'unanswered', 'code'), metric('DE1', 'auto', 'design', 'layers named', 'Yes')]),
    );
    expect(rows[0].evidence).toBe('');
  });

  it('leaves the answer column empty for the reviewer', () => {
    expect(buildExportRows(report([metric('CO1', 'unanswered')]))[0].answer).toBe('');
  });
});

describe('readImportRows', () => {
  const header = 'component,metric,category,subcategory,guideline,answer,automated_evidence\n';

  it('reads a filled-in answer', () => {
    expect(readImportRows(`${header}Button,CO1,code,A11y,q,Yes,\n`)).toEqual([
      { component: 'Button', metric: 'CO1', answer: 'Yes' },
    ]);
  });

  // An empty cell means "not answered yet". Treating it as N/A would claim a
  // person made a judgement they did not make.
  it('skips a blank answer instead of recording N/A', () => {
    expect(readImportRows(`${header}Button,CO1,code,A11y,q,,\n`)).toEqual([]);
  });

  it('still accepts an explicit N/A', () => {
    expect(readImportRows(`${header}Button,CO1,code,A11y,q,N/A,\n`)[0].answer).toBe('N/A');
  });

  it('accepts what a person actually types', () => {
    const rows = readImportRows(
      `${header}Button,CO1,code,A11y,q,yes,\nButton,CO3,code,A11y,q,  no  ,\n`,
    );
    expect(rows.map((r) => r.answer)).toEqual(['Yes', 'No']);
  });

  it('reads columns by name, so reordering them is safe', () => {
    const reordered = 'answer,metric,component\nYes,CO1,Button\n';
    expect(readImportRows(reordered)).toEqual([
      { component: 'Button', metric: 'CO1', answer: 'Yes' },
    ]);
  });

  it('refuses a typo rather than coercing it', () => {
    expect(() => readImportRows(`${header}Button,CO1,code,A11y,q,Probably,\n`)).toThrow(
      /not a valid answer/,
    );
  });

  it('names the row number when it refuses', () => {
    expect(() => readImportRows(`${header}Button,CO1,code,A11y,q,maybe,\n`)).toThrow(/Row 2/);
  });

  it('says which column is missing', () => {
    expect(() => readImportRows('component,metric\nButton,CO1\n')).toThrow(/no answer column/);
  });
});

describe('mergeAnswers', () => {
  const row = (component: string, metric: string, answer: 'Yes' | 'No' | 'N/A') => ({
    component,
    metric,
    answer,
  });

  it('counts what it added, changed and left alone', () => {
    const existing = 'Button:\n  CO1: Yes\n  CO3: No\n';
    const r = mergeAnswers(existing, [
      row('Button', 'CO1', 'Yes'),
      row('Button', 'CO3', 'Yes'),
      row('Button', 'CO4', 'N/A'),
    ]);
    expect({ added: r.added, changed: r.changed, unchanged: r.unchanged }).toEqual({
      added: 1,
      changed: 1,
      unchanged: 1,
    });
  });

  it('keeps answers the import did not mention', () => {
    const r = mergeAnswers('Card:\n  CO1: Yes\n', [row('Button', 'CO1', 'No')]);
    expect(r.text).toContain('Card:');
    expect(r.text).toContain('Button:');
  });

  it('writes a file that parses back to the same answers', () => {
    const r = mergeAnswers(null, [row('Button', 'CO1', 'Yes'), row('Button', 'CO3', 'N/A')]);
    const again = mergeAnswers(r.text, []);
    expect(again.text).toBe(r.text);
  });

  it('sorts so an import does not reshuffle the file', () => {
    const r = mergeAnswers(null, [row('Zeta', 'CO3', 'Yes'), row('Alpha', 'CO1', 'No')]);
    expect(r.text.indexOf('Alpha')).toBeLessThan(r.text.indexOf('Zeta'));
  });
});

describe('run export / import', () => {
  it('writes a CSV of the open questions and no HTML report', async () => {
    const dir = tempCopyOfFixture();
    const csv = path.join(dir, 'q.csv');
    const r = await invoke(['export', dir, '--file', csv]);
    expect(r.code).toBe(0);
    const text = fs.readFileSync(csv, 'utf8');
    expect(text.split('\n')[0]).toBe(
      'component,metric,category,subcategory,guideline,answer,automated_evidence',
    );
    expect(r.out).toContain('current import');
    expect(fs.existsSync(path.join(dir, 'current-report.html'))).toBe(false);
  });

  it('round-trips: export, fill one in, import, and it lands in the answers file', async () => {
    const dir = tempCopyOfFixture();
    const csv = path.join(dir, 'q.csv');
    await invoke(['export', dir, '--file', csv]);

    const rows = parseCsv(fs.readFileSync(csv, 'utf8'));
    const answerCol = rows[0].indexOf('answer');
    rows[1][answerCol] = 'Yes';
    const [component, metric] = [rows[1][0], rows[1][1]];
    fs.writeFileSync(
      csv,
      rows.map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'),
    );

    const r = await invoke(['import', dir, '--file', csv]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 added');
    // Parsed rather than string-matched: js-yaml quotes "Yes" on purpose,
    // because an unquoted Yes is a YAML 1.1 boolean.
    const book = parseAnswers(fs.readFileSync(path.join(dir, '.polder.answers.yml'), 'utf8'));
    expect(book.get(component)?.get(metric)).toBe('Yes');
  });

  it('says what to do when there is no CSV yet', async () => {
    const dir = tempCopyOfFixture();
    const r = await invoke(['import', dir, '--file', path.join(dir, 'nope.csv')]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('current export');
  });

  it('changes nothing when every answer cell is still blank', async () => {
    const dir = tempCopyOfFixture();
    const csv = path.join(dir, 'q.csv');
    await invoke(['export', dir, '--file', csv]);
    const before = fs.existsSync(path.join(dir, '.polder.answers.yml'));
    const r = await invoke(['import', dir, '--file', csv]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no filled-in answers');
    expect(fs.existsSync(path.join(dir, '.polder.answers.yml'))).toBe(before);
  });

  it('rejects --file with no value', async () => {
    const r = await invoke(['export', '--file']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--file requires/);
  });
});
