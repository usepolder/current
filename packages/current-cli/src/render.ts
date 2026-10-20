import {
  QUADRANT_LABELS,
  axesNotFullyCovered,
  type ComponentResult,
  type CurrentReport,
  type HistoryEntry,
  type MetricCategory,
} from '@usepolder/current-core';

export interface RenderOptions {
  report: CurrentReport;
  history?: readonly HistoryEntry[];
  title?: string;
}

const PLOT = { size: 560, pad: 48 } as const;

// The plot area covers a little more than 0-100 so a component sitting at
// exactly 100% draws as a whole dot inside the frame rather than half over
// the edge. The mapping stays linear and the axis ticks keep their true
// positions — this is breathing room, not a rescale.
//
// The top is deliberately roomier than the bottom: that band is where the
// quadrant names sit, and a mature design system clusters hard against 100%
// on the design axis, so anything less leaves "Healthy" printed under a pile
// of dots.
const DOMAIN = { min: -4, max: 110 } as const;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(score: number | null): string {
  return score === null ? '—' : `${score.toFixed(1)}%`;
}

/** Documentation health drives the dot colour: red <40, amber 40-70, green >70. */
function docBand(score: number | null): 'none' | 'low' | 'mid' | 'high' {
  if (score === null) return 'none';
  if (score < 40) return 'low';
  if (score <= 70) return 'mid';
  return 'high';
}

const BAND_FILL: Record<string, string> = {
  none: 'var(--dot-none)',
  low: 'var(--dot-low)',
  mid: 'var(--dot-mid)',
  high: 'var(--dot-high)',
};

const BAND_WORD: Record<string, string> = {
  none: 'no documentation score',
  low: 'weak documentation',
  mid: 'moderate documentation',
  high: 'strong documentation',
};

function plotted(report: CurrentReport): ComponentResult[] {
  return report.components.filter((c) => c.quadrant !== null);
}

function unplotted(report: CurrentReport): ComponentResult[] {
  return report.components.filter((c) => c.quadrant === null);
}

function quadrantSvg(report: CurrentReport): string {
  const { size, pad } = PLOT;
  const w = size + pad * 2;
  const h = size + pad * 2;
  const span = DOMAIN.max - DOMAIN.min;
  const x = (score: number): number => pad + ((score - DOMAIN.min) / span) * size;
  const y = (score: number): number => pad + size - ((score - DOMAIN.min) / span) * size;
  const tx = x(report.threshold);
  const ty = y(report.threshold);

  // Labels sit in the outer corners, in the margin the padded domain creates
  // above 100% and below 0%, so a dense cluster of top-scoring components
  // never sits on top of them.
  const zones = [
    { x: pad, y: pad, w: tx - pad, h: ty - pad, cls: 'critical', label: QUADRANT_LABELS.critical, lx: pad + 14, ly: pad + 17, anchor: 'start' },
    { x: tx, y: pad, w: pad + size - tx, h: ty - pad, cls: 'healthy', label: QUADRANT_LABELS.healthy, lx: pad + size - 14, ly: pad + 17, anchor: 'end' },
    { x: pad, y: ty, w: tx - pad, h: pad + size - ty, cls: 'monitor', label: QUADRANT_LABELS.monitor, lx: pad + 14, ly: pad + size - 10, anchor: 'start' },
    { x: tx, y: ty, w: pad + size - tx, h: pad + size - ty, cls: 'moderate', label: QUADRANT_LABELS.moderate, lx: pad + size - 14, ly: pad + size - 10, anchor: 'end' },
  ];

  const zoneSvg = zones
    .map(
      (z) =>
        `<rect class="zone zone-${z.cls}" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="6" />` +
        `<text class="zone-label zone-label-${z.cls}" x="${z.lx}" y="${z.ly}" text-anchor="${z.anchor}">${escapeHtml(
          z.label,
        )}</text>`,
    )
    .join('\n      ');

  // Jitter identical coordinates apart so overlapping components stay clickable.
  const seen = new Map<string, number>();
  const dots = plotted(report)
    .map((c) => {
      const cs = c.scores.code.score as number;
      const ds = c.scores.design.score as number;
      const key = `${cs}:${ds}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const angle = n * 1.1;
      const radius = n === 0 ? 0 : 7 + n * 1.5;
      const cx = x(cs) + Math.cos(angle) * radius;
      const cy = y(ds) + Math.sin(angle) * radius;
      const band = docBand(c.scores.documentation.score);
      // Position confidence and colour confidence are different claims: the
      // dashed outline is about where the dot sits, the label also has to
      // admit when the colour rests on one or two answered metrics.
      const low = c.scores.code.lowConfidence || c.scores.design.lowConfidence;
      const label =
        `${c.name}: code ${fmt(c.scores.code.score)}, design ${fmt(c.scores.design.score)}, ` +
        `${QUADRANT_LABELS[c.quadrant!].toLowerCase()}, ${BAND_WORD[band]}` +
        (low ? ', position from few answered metrics' : '') +
        (c.scores.documentation.lowConfidence ? ', documentation from few answered metrics' : '');
      return (
        `<g class="dot${low ? ' dot-low-confidence' : ''}" data-component="${escapeHtml(c.name)}" ` +
        `tabindex="0" role="listitem" aria-label="${escapeHtml(label)}">` +
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="8" fill="${BAND_FILL[band]}" ` +
        `${low ? 'stroke-dasharray="3 2" ' : ''}/>` +
        `<title>${escapeHtml(label)}</title>` +
        `</g>`
      );
    })
    .join('\n      ');

  const ticks = [0, 20, 40, 60, 80, 100]
    .map(
      (v) =>
        `<text class="tick" x="${x(v).toFixed(1)}" y="${h - pad + 20}" text-anchor="middle">${v}</text>` +
        `<text class="tick" x="${pad - 12}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`,
    )
    .join('\n      ');

  return `<svg viewBox="0 0 ${w} ${h}" class="quadrant" role="list"
       aria-label="Component health quadrant. Horizontal axis code health, vertical axis design health.">
      ${zoneSvg}
      <line class="axis" x1="${pad}" y1="${ty}" x2="${pad + size}" y2="${ty}" />
      <line class="axis" x1="${tx}" y1="${pad}" x2="${tx}" y2="${pad + size}" />
      <rect class="frame" x="${pad}" y="${pad}" width="${size}" height="${size}" rx="6" />
      ${ticks}
      <text class="axis-title" x="${pad + size / 2}" y="${h - 6}" text-anchor="middle">Code health →</text>
      <text class="axis-title" x="14" y="${pad + size / 2}" text-anchor="middle"
            transform="rotate(-90 14 ${pad + size / 2})">Design health →</text>
      ${dots}
    </svg>`;
}

function trendSvg(history: readonly HistoryEntry[]): string {
  const points = history.filter((h) => h.overall !== null);
  if (points.length < 2) return '';
  const w = 720;
  const h = 160;
  const pad = 28;
  const x = (i: number): number => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v: number): number => pad + (1 - v / 100) * (h - pad * 2);

  // A metric-set change means the numbers on either side measure different
  // things. Break the line there rather than implying continuity.
  const segments: string[] = [];
  let run: string[] = [];
  points.forEach((p, i) => {
    if (i > 0 && p.metricsHash !== points[i - 1].metricsHash) {
      if (run.length > 1) segments.push(run.join(' '));
      run = [];
    }
    run.push(`${x(i).toFixed(1)},${y(p.overall as number).toFixed(1)}`);
  });
  if (run.length > 1) segments.push(run.join(' '));

  const lines = segments
    .map((pts) => `<polyline class="trend-line" points="${pts}" />`)
    .join('\n      ');
  const dots = points
    .map(
      (p, i) =>
        `<circle class="trend-dot" cx="${x(i).toFixed(1)}" cy="${y(p.overall as number).toFixed(1)}" r="3">` +
        `<title>${escapeHtml(p.ts)}: ${(p.overall as number).toFixed(1)}%</title></circle>`,
    )
    .join('\n      ');
  const breaks = points
    .map((p, i) =>
      i > 0 && p.metricsHash !== points[i - 1].metricsHash
        ? `<line class="trend-break" x1="${((x(i) + x(i - 1)) / 2).toFixed(1)}" y1="${pad}" ` +
          `x2="${((x(i) + x(i - 1)) / 2).toFixed(1)}" y2="${h - pad}" />`
        : '',
    )
    .join('');

  const first = points[0];
  const last = points[points.length - 1];
  const gridlines = [0, 50, 100]
    .map(
      (v) =>
        `<line class="grid" x1="${pad}" y1="${y(v)}" x2="${w - pad}" y2="${y(v)}" />` +
        `<text class="tick" x="${pad - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`,
    )
    .join('\n        ');

  return `<section class="card">
      <h2>Overall score over time</h2>
      <svg viewBox="0 0 ${w} ${h}" class="trend" role="img"
           aria-label="Overall score across ${points.length} recorded scans: ${points
             .map((p) => `${escapeHtml(p.ts.slice(0, 10))} ${(p.overall as number).toFixed(1)}%`)
             .join(', ')}.">
        ${gridlines}
        ${breaks}
        ${lines}
        ${dots}
        <text class="tick" x="${pad}" y="${h - 6}" text-anchor="start">${escapeHtml(
          first.ts.slice(0, 10),
        )}</text>
        <text class="tick" x="${w - pad}" y="${h - 6}" text-anchor="end">${escapeHtml(
          last.ts.slice(0, 10),
        )}</text>
      </svg>
      <p class="note">${(first.overall as number).toFixed(1)}% → ${(last.overall as number).toFixed(
        1,
      )}% across ${points.length} recorded scans.</p>
      ${
        breaks.trim() === ''
          ? ''
          : '<p class="note">A vertical break marks a change to the metric set: scores either side of it measure different things.</p>'
      }
    </section>`;
}

/**
 * Which sides are worth badging as "unmapped". Unmapped is only news when
 * some components DO map that side — then it marks an outlier. When nothing
 * in the report maps it, that is the report's mode, not a per-row fact, and
 * badging all 31 rows is noise. `missing` and `unavailable` always badge:
 * those mean something is broken, not merely unconfigured.
 */
function sidesWorthBadging(components: readonly ComponentResult[]): Set<string> {
  const worth = new Set<string>();
  for (const side of ['code', 'figma', 'docs'] as const) {
    // "Mapped at all" is the test, not "resolved". A component absent from a
    // library everyone else is mapped into is exactly the outlier worth
    // pointing at, whether or not the file was read this run.
    if (components.some((c) => c.presence[side] !== 'unmapped')) worth.add(side);
  }
  return worth;
}

/** Name the side, not just the state: two bare "missing" badges tell you nothing. */
function presenceBadge(side: string, state: string, badgeUnmapped: Set<string>): string {
  if (state === 'present') return '';
  // Nothing needed this side, so nothing went wrong with it.
  if (state === 'not-checked') return '';
  if (state === 'unmapped' && !badgeUnmapped.has(side)) return '';
  return `<span class="badge badge-${escapeHtml(state)}">${escapeHtml(side)} ${escapeHtml(
    state,
  )}</span>`;
}

/** An axis with no number: say which kind of nothing it is. */
function scoreCell(axis: { score: number | null; degraded: boolean }): string {
  if (axis.score !== null) return fmt(axis.score);
  return axis.degraded
    ? '<span class="muted" title="Source unavailable — automated metrics did not run">not measured</span>'
    : '—';
}

function componentRows(report: CurrentReport): string {
  const badgeUnmapped = sidesWorthBadging(report.components);
  return report.components
    .map((c) => {
      // Every axis, not just the plotted two: a thin documentation score
      // still colours the dot, so hiding it would colour the chart on
      // evidence the reader never sees.
      const thin = (['code', 'design', 'documentation'] as const).filter(
        (k) => c.scores[k].lowConfidence,
      );
      const metrics = c.metrics
        .map(
          (m) =>
            `<tr class="metric-row metric-${m.answer === 'N/A' ? 'na' : m.answer.toLowerCase()}">` +
            `<td class="metric-id">${escapeHtml(m.metricId)}</td>` +
            `<td>${escapeHtml(m.guideline)}</td>` +
            `<td class="metric-answer">${escapeHtml(m.answer)}</td>` +
            `<td class="metric-source">${escapeHtml(m.source)}</td>` +
            `<td class="metric-evidence">${m.evidence === null ? '' : escapeHtml(m.evidence)}</td>` +
            `</tr>`,
        )
        .join('\n            ');

      return `<tr class="component-row" data-component="${escapeHtml(c.name)}">
            <td>
              <button class="disclose" aria-expanded="false" aria-controls="detail-${escapeHtml(c.name)}">
                <span class="chevron" aria-hidden="true">▸</span>${escapeHtml(c.name)}
              </button>
              ${presenceBadge('code', c.presence.code, badgeUnmapped)}${presenceBadge(
                'figma',
                c.presence.figma,
                badgeUnmapped,
              )}${presenceBadge('docs', c.presence.docs, badgeUnmapped)}
              ${
                thin.length === 0
                  ? ''
                  : `<span class="badge badge-low">thin ${thin
                      .map((k) => (k === 'documentation' ? 'docs' : k))
                      .join(' + ')}</span>`
              }
            </td>
            <td class="num" data-sort="${c.scores.code.score ?? -1}">${scoreCell(c.scores.code)}</td>
            <td class="num" data-sort="${c.scores.design.score ?? -1}">${scoreCell(
              c.scores.design,
            )}</td>
            <td class="num" data-sort="${c.scores.documentation.score ?? -1}">${scoreCell(
              c.scores.documentation,
            )}</td>
            <td data-sort="${c.quadrant ?? ''}">${
              c.quadrant === null
                ? '<span class="muted">not plotted</span>'
                : `<span class="pill pill-${c.quadrant}">${QUADRANT_LABELS[c.quadrant]}</span>`
            }</td>
          </tr>
          <tr class="detail-row" id="detail-${escapeHtml(c.name)}" hidden>
            <td colspan="5">
              <table class="metrics">
                <thead><tr><th>ID</th><th>Guideline</th><th>Answer</th><th>Source</th><th>Why</th></tr></thead>
                <tbody>
            ${metrics}
                </tbody>
              </table>
            </td>
          </tr>`;
    })
    .join('\n          ');
}

/** Screen-reader table mirroring every plotted point. */
function srTable(report: CurrentReport): string {
  const rows = plotted(report)
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.name)}</td><td>${fmt(c.scores.code.score)}</td>` +
        `<td>${fmt(c.scores.design.score)}</td><td>${QUADRANT_LABELS[c.quadrant!]}</td></tr>`,
    )
    .join('');
  return `<table class="sr-only">
        <caption>Quadrant data points</caption>
        <thead><tr><th>Component</th><th>Code health</th><th>Design health</th><th>Quadrant</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
}

/**
 * Say when an axis total leaves components out. A total computed over 24 of
 * 31 components is a different claim from one over all 31, and the reader
 * cannot tell them apart from the number alone.
 */
function excludedNote(report: CurrentReport): string {
  const parts = axesNotFullyCovered(report).map((b) => {
    const label = b.category === 'documentation' ? 'Docs' : b.category[0].toUpperCase() + b.category.slice(1);
    const why = b.excluded > 0 ? ` (${b.excluded} too thin to count)` : '';
    return `${label} over ${b.contributing} of ${b.total} components${why}`;
  });
  return parts.length === 0
    ? ''
    : `<p class="note">${parts.map((p) => escapeHtml(p)).join(' · ')}.</p>`;
}

function categoryTotal(report: CurrentReport, category: MetricCategory): string {
  const value =
    category === 'code'
      ? report.totals.code
      : category === 'design'
        ? report.totals.design
        : report.totals.documentation;
  return fmt(value);
}

export function renderReport(opts: RenderOptions): string {
  const { report } = opts;
  const title = opts.title ?? 'Component Health';
  const notPlotted = unplotted(report);
  const counts = report.quadrantCounts;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Current</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --panel: #ffffff; --ink: #14151a; --muted: #6b7280;
  --line: #e5e7eb; --accent: #4338ca;
  --healthy: #dcfce7; --moderate: #fef3c7; --monitor: #f3f4f6; --critical: #fee2e2;
  --healthy-ink: #166534; --moderate-ink: #92400e; --monitor-ink: #4b5563; --critical-ink: #991b1b;
  --dot-high: #16a34a; --dot-mid: #d97706; --dot-low: #dc2626; --dot-none: #9ca3af;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1115; --panel: #171a21; --ink: #e8eaed; --muted: #9aa3b2;
    --line: #262b35; --accent: #a5b4fc;
    --healthy: #14311f; --moderate: #3a2c10; --monitor: #1e2229; --critical: #3a1618;
    --healthy-ink: #86efac; --moderate-ink: #fcd34d; --monitor-ink: #cbd5e1; --critical-ink: #fca5a5;
    --dot-high: #4ade80; --dot-mid: #fbbf24; --dot-low: #f87171; --dot-none: #6b7280;
  }
}
:root[data-theme="dark"] {
  --bg: #0f1115; --panel: #171a21; --ink: #e8eaed; --muted: #9aa3b2;
  --line: #262b35; --accent: #a5b4fc;
  --healthy: #14311f; --moderate: #3a2c10; --monitor: #1e2229; --critical: #3a1618;
  --healthy-ink: #86efac; --moderate-ink: #fcd34d; --monitor-ink: #cbd5e1; --critical-ink: #fca5a5;
  --dot-high: #4ade80; --dot-mid: #fbbf24; --dot-low: #f87171; --dot-none: #6b7280;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrap { max-width: 1040px; margin: 0 auto; padding: 32px 16px 72px; }
header { display: flex; flex-wrap: wrap; gap: 24px; align-items: baseline; justify-content: space-between; }
h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 0 0 14px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--muted); }
.generated { color: var(--muted); font-size: 13px; }
.score-row { display: flex; flex-wrap: wrap; gap: 12px; margin: 24px 0; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; flex: 1 1 150px; }
.stat .k { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.stat .v { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; margin-top: 2px; }
.stat-overall .v { color: var(--accent); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px; margin-bottom: 20px; }
.quadrant { width: 100%; height: auto; }
.zone-healthy { fill: var(--healthy); } .zone-moderate { fill: var(--moderate); }
.zone-monitor { fill: var(--monitor); } .zone-critical { fill: var(--critical); }
.zone-label { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.zone-label-healthy { fill: var(--healthy-ink); } .zone-label-moderate { fill: var(--moderate-ink); }
.zone-label-monitor { fill: var(--monitor-ink); } .zone-label-critical { fill: var(--critical-ink); }
.axis { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 4 3; opacity: 0.7; }
.frame { fill: none; stroke: var(--line); stroke-width: 1; }
.tick, .axis-title { fill: var(--muted); font-size: 12px; }
.axis-title { font-size: 12px; letter-spacing: 0.03em; }
.dot circle { stroke: var(--panel); stroke-width: 2; cursor: pointer; transition: r 120ms ease; }
.dot:hover circle, .dot:focus circle { r: 11; }
.dot:focus { outline: none; }
.dot:focus circle { stroke: var(--accent); stroke-width: 3; }
.dot-low-confidence circle { fill-opacity: 0.35; stroke: var(--muted); }
.legend { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px; font-size: 13px; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
/* Narrow viewports scroll the table instead of clipping the Quadrant column. */
.scroller { overflow-x: auto; }
.scroller > table { min-width: 620px; }
.detail-row .metrics { min-width: 560px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; }
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--ink); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.disclose { background: none; border: 0; color: inherit; font: inherit; font-weight: 500; cursor: pointer; padding: 0; display: inline-flex; align-items: center; gap: 6px; }
.disclose:hover { color: var(--accent); }
.chevron { transition: transform 120ms ease; display: inline-block; color: var(--muted); }
.disclose[aria-expanded="true"] .chevron { transform: rotate(90deg); }
.detail-row td { background: var(--bg); padding: 0 10px 14px 28px; }
.metrics th, .metrics td { border-bottom: 1px solid var(--line); font-size: 13px; }
.metric-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
.metric-answer { font-weight: 600; }
.metric-yes .metric-answer { color: var(--dot-high); }
.metric-no .metric-answer { color: var(--dot-low); }
.metric-na .metric-answer { color: var(--muted); }
.metric-source, .metric-evidence { color: var(--muted); font-size: 12px; }
.pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.pill-healthy { background: var(--healthy); color: var(--healthy-ink); }
.pill-moderate { background: var(--moderate); color: var(--moderate-ink); }
.pill-monitor { background: var(--monitor); color: var(--monitor-ink); }
.pill-critical { background: var(--critical); color: var(--critical-ink); }
.badge { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 5px; font-size: 11px;
         background: var(--monitor); color: var(--monitor-ink); text-transform: lowercase; }
.badge-missing, .badge-unavailable { background: var(--critical); color: var(--critical-ink); }
.badge-low { background: var(--moderate); color: var(--moderate-ink); }
.muted { color: var(--muted); }
.note { color: var(--muted); font-size: 13px; margin: 10px 0 0; }
.warn { background: var(--critical); color: var(--critical-ink); border-radius: 10px; padding: 12px 14px; margin-bottom: 20px; font-size: 14px; }
.trend { width: 100%; height: auto; }
.grid { stroke: var(--line); stroke-width: 1; }
.trend-line { fill: none; stroke: var(--accent); stroke-width: 2; }
.trend-dot { fill: var(--accent); }
.trend-break { stroke: var(--muted); stroke-dasharray: 3 3; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
           clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
footer { color: var(--muted); font-size: 13px; margin-top: 28px; }
footer a { color: inherit; }
@media (max-width: 640px) { .wrap { padding: 20px 12px 48px; } .stat .v { font-size: 22px; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <span class="generated">Generated ${escapeHtml(report.generatedAt)}</span>
  </header>

  ${
    report.figmaUnavailable === null
      ? ''
      : `<p class="warn"><strong>Design metrics unavailable.</strong> ${escapeHtml(
          report.figmaUnavailable,
        )} This report covers code and documentation only.</p>`
  }

  <div class="score-row">
    <div class="stat stat-overall"><div class="k">Overall</div><div class="v">${fmt(
      report.totals.overall,
    )}</div></div>
    <div class="stat"><div class="k">Code</div><div class="v">${categoryTotal(report, 'code')}</div></div>
    <div class="stat"><div class="k">Design</div><div class="v">${categoryTotal(report, 'design')}</div></div>
    <div class="stat"><div class="k">Docs</div><div class="v">${categoryTotal(
      report,
      'documentation',
    )}</div></div>
    <div class="stat"><div class="k">Components</div><div class="v">${report.components.length}</div></div>
  </div>
  ${excludedNote(report)}

  <section class="card">
    <h2>Code vs design health</h2>
    ${quadrantSvg(report)}
    ${srTable(report)}
    <div class="legend">
      <span><span class="swatch" style="background:var(--dot-high)"></span>docs &gt; 70%</span>
      <span><span class="swatch" style="background:var(--dot-mid)"></span>docs 40–70%</span>
      <span><span class="swatch" style="background:var(--dot-low)"></span>docs &lt; 40%</span>
      <span><span class="swatch" style="background:var(--dot-none)"></span>no docs score</span>
      <span>Dotted outline = fewer than ${report.minConfidence} answered metrics on an axis</span>
      <span>Threshold: ${report.threshold}%</span>
    </div>
    <p class="note">
      ${counts.healthy} healthy · ${counts.critical} critical · ${counts.moderate} moderate ·
      ${counts.monitor} monitor${counts.unplotted > 0 ? ` · ${counts.unplotted} not plotted` : ''}
    </p>
  </section>

  ${
    notPlotted.length === 0
      ? ''
      : `<section class="card">
    <h2>Not enough data to plot</h2>
    <p class="note">These components have no answered metric on at least one axis, so they have no
    position on the quadrant. That is an undefined score, not a zero.</p>
    <table>
      <thead><tr><th>Component</th><th class="num">Code</th><th class="num">Design</th><th class="num">Docs</th></tr></thead>
      <tbody>${notPlotted
        .map(
          (c) =>
            `<tr><td>${escapeHtml(c.name)}</td><td class="num">${fmt(
              c.scores.code.score,
            )}</td><td class="num">${fmt(c.scores.design.score)}</td><td class="num">${fmt(
              c.scores.documentation.score,
            )}</td></tr>`,
        )
        .join('')}</tbody>
    </table>
  </section>`
  }

  ${opts.history === undefined ? '' : trendSvg(opts.history)}

  <section class="card">
    <h2>Every component</h2>
    <div class="scroller">
    <table id="components">
      <thead>
        <tr>
          <th class="sortable" data-col="0">Component</th>
          <th class="sortable num" data-col="1">Code</th>
          <th class="sortable num" data-col="2">Design</th>
          <th class="sortable num" data-col="3">Docs</th>
          <th class="sortable" data-col="4">Quadrant</th>
        </tr>
      </thead>
      <tbody>
          ${componentRows(report)}
      </tbody>
    </table>
    </div>
  </section>

  <footer>
    Generated by <a href="https://github.com/usepolder/current">Current</a>.
    Scores are Yes ÷ (Yes + No) per category, N/A excluded.
  </footer>
</div>
<script>
(function () {
  var table = document.getElementById('components');
  if (!table) return;
  var tbody = table.tBodies[0];

  function pairs() {
    var rows = Array.prototype.slice.call(tbody.rows);
    var out = [];
    for (var i = 0; i < rows.length; i += 2) out.push([rows[i], rows[i + 1]]);
    return out;
  }

  function sortBy(col, dir) {
    var data = pairs();
    data.sort(function (a, b) {
      var av = a[0].cells[col].dataset.sort;
      var bv = b[0].cells[col].dataset.sort;
      if (av === undefined) { av = a[0].cells[col].textContent.trim(); bv = b[0].cells[col].textContent.trim(); }
      var an = parseFloat(av), bn = parseFloat(bv);
      var cmp = (!isNaN(an) && !isNaN(bn)) ? an - bn : String(av).localeCompare(String(bv));
      return dir === 'asc' ? cmp : -cmp;
    });
    data.forEach(function (pair) { tbody.appendChild(pair[0]); tbody.appendChild(pair[1]); });
  }

  var state = {};
  Array.prototype.forEach.call(table.querySelectorAll('th.sortable'), function (th) {
    th.setAttribute('role', 'button');
    th.tabIndex = 0;
    function go() {
      var col = Number(th.dataset.col);
      state[col] = state[col] === 'asc' ? 'desc' : 'asc';
      sortBy(col, state[col]);
      th.setAttribute('aria-sort', state[col] === 'asc' ? 'ascending' : 'descending');
    }
    th.addEventListener('click', go);
    th.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });

  function toggle(name, force) {
    var btn = tbody.querySelector('.component-row[data-component="' + name.replace(/"/g, '\\\\"') + '"] .disclose');
    if (!btn) return;
    var detail = document.getElementById(btn.getAttribute('aria-controls'));
    var open = force !== undefined ? force : btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    detail.hidden = !open;
    return btn;
  }

  Array.prototype.forEach.call(tbody.querySelectorAll('.disclose'), function (btn) {
    btn.addEventListener('click', function () {
      toggle(btn.closest('.component-row').dataset.component);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.dot'), function (dot) {
    function open() {
      var btn = toggle(dot.dataset.component, true);
      if (btn) { btn.scrollIntoView({ behavior: 'smooth', block: 'center' }); btn.focus(); }
    }
    dot.addEventListener('click', open);
    dot.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
})();
</script>
</body>
</html>
`;
}
