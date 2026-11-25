import {
  QUADRANT_LABELS,
  axesNotFullyCovered,
  fixFirst,
  type CurrentReport,
} from '@usepolder/current-core';

/** Hidden marker that makes the comment single: the upsert finds it and edits. */
export const CURRENT_MARKER = '<!-- polder-current -->';

export interface ExistingComment {
  id: number;
  body?: string | null | undefined;
  user?: { login?: string | null | undefined; type?: string | null | undefined } | null | undefined;
}

/**
 * Find the comment to update. Matching on the marker rather than on the
 * author keeps it working across token identities (github-actions[bot] vs a
 * PAT). When several match — a fork, a replay, a hand-copied comment — the
 * OLDEST wins, so the thread keeps one stable comment instead of migrating
 * to a newer duplicate on every run.
 */
export function findExistingComment(
  comments: readonly ExistingComment[],
  marker: string = CURRENT_MARKER,
): ExistingComment | null {
  const matches = comments.filter((c) => (c.body ?? '').includes(marker));
  if (matches.length === 0) return null;
  return matches.reduce((oldest, c) => (c.id < oldest.id ? c : oldest));
}

function fmt(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

/**
 * The figure beside the overall score.
 *
 * A changed rubric SUPPRESSES the delta rather than annotating it. The two
 * numbers were produced by different sets of norms, so their difference is
 * not a movement in quality — and "no change vs `main`" is the worst of the
 * three to print, because it reads as reassurance when nothing is being
 * compared. The run log already carries a warning; nobody reads the log of a
 * green run, and this is the line people do read.
 */
function deltaLine(
  score: number,
  baseScore: number,
  baseRef: string | null,
  rubricChanged: boolean,
): string {
  const vs = baseRef ? `vs \`${baseRef}\`` : 'vs base';
  if (rubricChanged) return `⚠️ rubric changed — not comparable ${vs}`;
  const delta = Math.round((score - baseScore) * 10) / 10;
  if (delta > 0) return `▲ +${delta.toFixed(1)} pts ${vs}`;
  if (delta < 0) return `▼ ${delta.toFixed(1)} pts ${vs}`;
  return `no change ${vs}`;
}

/** Said once, under the score, when the delta was suppressed. */
const RUBRIC_CHANGED_NOTE =
  'The rubric changed in this branch — a norm was added, removed, re-tuned, or flipped ' +
  'between manual and automated (or Current itself now checks one differently). The two ' +
  'scores measure different things, so this is a reset of the trend line, not a regression.';

export function renderComment(
  report: CurrentReport,
  baseScore: number | null,
  baseRef: string | null,
  /** The metric set no longer matches the entry `baseScore` came from. */
  rubricChanged = false,
): string {
  const t = report.totals;
  const q = report.quadrantCounts;
  const lines: string[] = [CURRENT_MARKER, '## Current — component health', ''];

  if (report.components.length === 0) {
    lines.push('No components are mapped under `current.components` in `.polder.yml`.');
    return lines.join('\n');
  }

  // No baseline (or no score) means no claim is made either way, and a note
  // about comparability would be answering a question nobody asked.
  const comparing = baseScore !== null && t.overall !== null;
  const delta = comparing
    ? `   ${deltaLine(t.overall as number, baseScore as number, baseRef, rubricChanged)}`
    : '';
  lines.push(`**Overall: ${fmt(t.overall)}**${delta}`);
  lines.push('');
  if (comparing && rubricChanged) {
    lines.push(RUBRIC_CHANGED_NOTE);
    lines.push('');
  }
  lines.push('| | Code | Design | Docs |');
  lines.push('| --- | ---: | ---: | ---: |');
  lines.push(`| Score | ${fmt(t.code)} | ${fmt(t.design)} | ${fmt(t.documentation)} |`);

  // Say what each figure was computed over when it was not every component.
  // A documentation score averaged over one of three components is a claim
  // about that one component, and a number on its own cannot admit that.
  const partial = axesNotFullyCovered(report);
  if (partial.length > 0) {
    lines.push('');
    lines.push(
      partial
        .map(
          (b) =>
            `${b.category === 'documentation' ? 'Docs' : b.category} over ${b.contributing} of ` +
            `${b.total} components${b.excluded > 0 ? ` (${b.excluded} too thin to count)` : ''}`,
        )
        .join(' · '),
    );
  }

  lines.push('');
  lines.push(
    `${q.healthy} ${QUADRANT_LABELS.healthy.toLowerCase()} · ` +
      `${q.moderate} ${QUADRANT_LABELS.moderate.toLowerCase()} · ` +
      `${q.monitor} ${QUADRANT_LABELS.monitor.toLowerCase()} · ` +
      `${q.critical} ${QUADRANT_LABELS.critical.toLowerCase()}` +
      (q.unplotted > 0 ? ` · ${q.unplotted} not plotted` : ''),
  );

  // Ranked by use, so a broken Button outranks a broken Divider. Names come
  // from the repo's own config, never from the usage file, which a fork's PR
  // controls.
  if (report.usage !== null) {
    const first = fixFirst(report);
    lines.push('');
    if (first.length === 0) {
      lines.push('**Fix first:** nothing in use is below the threshold.');
    } else {
      lines.push('**Fix first** (weakest of code/design, weighted by use)');
      lines.push('');
      lines.push('| Component | Weakest | Uses | Priority |');
      lines.push('| --- | ---: | ---: | ---: |');
      for (const e of first) {
        lines.push(
          `| \`${e.name}\` | ${e.axis} ${e.score.toFixed(1)}% | ${e.uses}` +
            `${e.share === null ? '' : ` (${e.share.toFixed(1)}%)`} | ${e.priority.toFixed(1)} |`,
        );
      }
    }
  }

  const attention = report.components.filter((c) => c.quadrant === 'critical');
  if (attention.length > 0) {
    lines.push('');
    lines.push(
      `**Critical** (design ahead of code): ${attention.map((c) => `\`${c.name}\``).join(', ')}`,
    );
  }

  if (report.figmaUnavailable !== null) {
    lines.push('');
    lines.push(`⚠️ Design metrics unavailable: ${report.figmaUnavailable}`);
  }

  lines.push('');
  lines.push(
    '<sub>[Current](https://github.com/usepolder/current) · ' +
      'score is Yes ÷ (Yes + No) per category, N/A excluded</sub>',
  );

  return lines.join('\n');
}
