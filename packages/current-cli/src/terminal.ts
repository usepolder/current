import { QUADRANT_LABELS, type CurrentReport } from '@usepolder/current-core';

const SCORE_WIDTH = 6;

function pct(axis: { score: number | null; degraded: boolean }): string {
  const text = axis.score !== null ? `${axis.score.toFixed(1)}%` : axis.degraded ? 'n/m' : '—';
  return text.padStart(SCORE_WIDTH);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

/** The at-a-glance summary, in the shape Reach's CLI established. */
export function renderTerminal(report: CurrentReport, reportPath: string | null): string {
  const lines: string[] = ['Current — component health', ''];
  const t = report.totals;

  lines.push(
    `Overall: ${t.overall === null ? '—' : `${t.overall.toFixed(1)}%`}   ` +
      `(code ${t.code === null ? '—' : `${t.code.toFixed(1)}%`}, ` +
      `design ${t.design === null ? '—' : `${t.design.toFixed(1)}%`}, ` +
      `docs ${t.documentation === null ? '—' : `${t.documentation.toFixed(1)}%`})`,
  );
  lines.push('');

  const q = report.quadrantCounts;
  lines.push(
    `  ${String(q.healthy).padStart(3)} healthy    ` +
      `${String(q.moderate).padStart(3)} moderate`,
  );
  lines.push(
    `  ${String(q.critical).padStart(3)} critical   ` +
      `${String(q.monitor).padStart(3)} monitor`,
  );
  if (q.unplotted > 0) {
    // Name the actual cause: "not enough answered metrics" is wrong when a
    // whole side was unavailable, and sends people to fix the wrong thing.
    const reason =
      report.figmaUnavailable !== null
        ? 'design side not measured'
        : 'not enough answered metrics';
    lines.push(`  ${String(q.unplotted).padStart(3)} not plotted (${reason})`);
  }
  lines.push('');

  if (report.figmaUnavailable !== null) {
    lines.push(`! Design metrics unavailable: ${report.figmaUnavailable}`);
    lines.push('  Design shows n/m (not measured) rather than a score from the manual answers alone.');
    lines.push('');
  }

  // Every score cell is exactly SCORE_WIDTH wide, so the header and the rows
  // line up whatever mix of numbers, dashes and "n/m" a run produces.
  const width = Math.max(9, ...report.components.map((c) => c.name.length));
  const col = (label: string): string => label.padStart(SCORE_WIDTH);
  lines.push(
    `  ${pad('Component', width)}  ${col('Code')}  ${col('Design')}  ${col('Docs')}  Quadrant`,
  );
  for (const c of report.components) {
    const flags: string[] = [];
    if (c.presence.code === 'missing') flags.push('code missing');
    if (c.presence.figma === 'missing') flags.push('figma missing');
    if (c.presence.docs === 'missing') flags.push('docs missing');
    if (c.scores.code.lowConfidence || c.scores.design.lowConfidence) flags.push('low confidence');
    lines.push(
      `  ${pad(c.name, width)}  ${pct(c.scores.code)}  ${pct(c.scores.design)}  ` +
        `${pct(c.scores.documentation)}  ${
          c.quadrant === null ? 'not plotted' : QUADRANT_LABELS[c.quadrant]
        }${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}`,
    );
  }

  if (reportPath !== null) {
    lines.push('');
    lines.push(`Report written to ${reportPath}`);
  }

  return lines.join('\n');
}
