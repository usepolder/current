import * as fs from 'fs';
import * as path from 'path';
import type { CurrentReport } from './report';

export const HISTORY_DIR = '.current';
export const HISTORY_FILE = 'history.jsonl';

export interface HistoryEntry {
  ts: string;
  overall: number | null;
  code: number | null;
  design: number | null;
  documentation: number | null;
  components: number;
  /** Metric-set fingerprint. A change here breaks trend comparability. */
  metricsHash: string;
  commit?: string;
}

/**
 * Fingerprint of the enabled metric ids. When it changes between runs the
 * trend line is comparing two different rubrics, so the report draws a break
 * rather than pretending the numbers are continuous.
 */
export function metricsHash(metricIds: readonly string[]): string {
  const joined = [...metricIds].sort().join(',');
  let hash = 0;
  for (let i = 0; i < joined.length; i += 1) {
    hash = (hash * 31 + joined.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function entryFromReport(
  report: CurrentReport,
  metricIds: readonly string[],
  commit?: string,
): HistoryEntry {
  return {
    ts: report.generatedAt,
    overall: report.totals.overall,
    code: report.totals.code,
    design: report.totals.design,
    documentation: report.totals.documentation,
    components: report.components.length,
    metricsHash: metricsHash(metricIds),
    ...(commit === undefined ? {} : { commit }),
  };
}

export function historyPath(repoRoot: string): string {
  return path.join(repoRoot, HISTORY_DIR, HISTORY_FILE);
}

export function readHistory(repoRoot: string): HistoryEntry[] {
  const file = historyPath(repoRoot);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as HistoryEntry;
      } catch {
        // One malformed line should not throw away the rest of the history.
        return null;
      }
    })
    .filter((e): e is HistoryEntry => e !== null);
}

export function appendHistory(repoRoot: string, entry: HistoryEntry): void {
  const file = historyPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function lastEntry(entries: readonly HistoryEntry[]): HistoryEntry | null {
  return entries.length === 0 ? null : entries[entries.length - 1];
}
