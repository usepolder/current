import {
  QUADRANT_LABELS,
  axesNotFullyCovered,
  fixFirst,
  type CurrentReport,
} from '@usepolder/current-core';

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
  const partial = axesNotFullyCovered(report).map(
    (b) => `${b.category} over ${b.contributing}/${b.total}`,
  );
  if (partial.length > 0) {
    lines.push(`  (${partial.join(', ')} — the rest had too little to measure)`);
  }
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

  if (report.usage !== null) {
    lines.push('');
    const first = fixFirst(report);
    if (first.length === 0) {
      lines.push('Fix first: nothing in use is below the threshold.');
    } else {
      lines.push('Fix first (weakest of code/design, weighted by use):');
      const nameWidth = Math.max(...first.map((e) => e.name.length));
      first.forEach((e, i) => {
        lines.push(
          `  ${i + 1}. ${pad(e.name, nameWidth)}  ` +
            `${pad(`${e.axis} ${e.score.toFixed(1)}%`, 13)}  ` +
            `${e.uses} use${e.uses === 1 ? '' : 's'}` +
            `${e.share === null ? '' : ` (${e.share.toFixed(1)}% of DS usage)`}  ` +
            `priority ${e.priority.toFixed(1)}`,
        );
      });
    }
    const top = report.usage.unmatched.slice(0, 3);
    if (top.length > 0) {
      lines.push(
        '  In use but not mapped in .polder.yml: ' +
          `${top.map((u) => `${u.name} (${u.uses})`).join(', ')}` +
          `${report.usage.unmatched.length > top.length ? `, +${report.usage.unmatched.length - top.length} more` : ''}`,
      );
    }
  }

  if (reportPath !== null) {
    lines.push('');
    lines.push(`Report written to ${reportPath}`);
  }

  return lines.join('\n');
}
