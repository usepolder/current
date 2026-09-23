import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  FigmaClient,
  parseAnswers,
  parseConfig,
  scanRepo,
  type CurrentReport,
  type HistoryEntry,
} from '@usepolder/current-core';
import { fixtureNodes } from '../../core/tests/fixtures/figma-nodes';
import { displayPath } from '../src/cli';
import { escapeHtml, renderReport } from '../src/render';

const FIXTURE = path.join(__dirname, '..', '..', 'core', 'tests', 'fixtures', 'ds');

function figma(): FigmaClient {
  return new FigmaClient({
    token: 't',
    fileKey: 'fixture-file',
    fetcher: async (url: string) => {
      const ids = decodeURIComponent(new URL(url).searchParams.get('ids') ?? '').split(',');
      const nodes: Record<string, { document: unknown } | null> = {};
      for (const id of ids) nodes[id] = fixtureNodes[id] ? { document: fixtureNodes[id] } : null;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ nodes }),
      };
    },
  });
}

async function fixtureReport(): Promise<CurrentReport> {
  return scanRepo({
    repoRoot: FIXTURE,
    config: parseConfig(fs.readFileSync(path.join(FIXTURE, '.current.yml'), 'utf8')),
    answers: parseAnswers(fs.readFileSync(path.join(FIXTURE, '.current.answers.yml'), 'utf8')),
    figma: figma(),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
}

describe('escapeHtml', () => {
  it('escapes the characters that would break out of markup or an attribute', () => {
    expect(escapeHtml('<script>"x"&\'y\'</script>')).toBe(
      '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;',
    );
  });
});

describe('renderReport', () => {
  it('produces a self-contained document with no external requests', async () => {
    const html = renderReport({ report: await fixtureReport() });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href="http/);
  });

  it('plots each scored component once and labels it for a screen reader', async () => {
    const report = await fixtureReport();
    const html = renderReport({ report });
    const plotted = report.components.filter((c) => c.quadrant !== null);

    for (const c of plotted) {
      expect(html).toContain(`data-component="${c.name}"`);
      expect(html).toMatch(new RegExp(`aria-label="${c.name}: code [\\d.]+%, design [\\d.]+%`));
    }
  });

  it('mirrors the plotted points in a screen-reader table', async () => {
    const html = renderReport({ report: await fixtureReport() });
    expect(html).toContain('<caption>Quadrant data points</caption>');
    // Visually hidden, not display:none — display:none removes it from the
    // accessibility tree, which would defeat the point.
    expect(html).toContain('.sr-only');
    expect(html).not.toMatch(/\.sr-only\s*\{[^}]*display:\s*none/);
  });

  it('names the quadrant regions', async () => {
    const html = renderReport({ report: await fixtureReport() });
    for (const label of ['Healthy', 'Critical', 'Monitor', 'Moderate']) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it('escapes a component name that contains markup', async () => {
    const report = await fixtureReport();
    report.components[0].name = '<img src=x onerror=alert(1)>';
    const html = renderReport({ report });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('does not badge "unmapped" when nothing in the report maps that side', async () => {
    // A pure manual audit maps nothing. Badging every row three times over
    // is noise, not signal.
    const report = await fixtureReport();
    for (const c of report.components) {
      c.presence = { code: 'unmapped', figma: 'unmapped', docs: 'unmapped' };
    }
    const html = renderReport({ report });
    expect(html).not.toContain('code unmapped');
    expect(html).not.toContain('figma unmapped');
  });

  it('badges "unmapped" when it marks an outlier against mapped siblings', async () => {
    const report = await fixtureReport();
    report.components[0].presence = { code: 'present', figma: 'present', docs: 'present' };
    report.components[1].presence = { code: 'unmapped', figma: 'present', docs: 'present' };
    const html = renderReport({ report });
    expect(html).toContain('code unmapped');
  });

  it('always badges a broken side, mapped-but-missing or unavailable', async () => {
    const report = await fixtureReport();
    for (const c of report.components) {
      c.presence = { code: 'missing', figma: 'unavailable', docs: 'unmapped' };
    }
    const html = renderReport({ report });
    expect(html).toContain('code missing');
    expect(html).toContain('figma unavailable');
  });

  it('lists components that could not be plotted', async () => {
    const report = await fixtureReport();
    const html = renderReport({ report });
    if (report.totals.componentsNotPlotted > 0) {
      expect(html).toContain('Not enough data to plot');
    }
  });

  it('warns at the top when the design side was unavailable', async () => {
    const report = await fixtureReport();
    report.figmaUnavailable = 'Figma rejected the token';
    const html = renderReport({ report });
    expect(html).toContain('Design metrics unavailable');
    expect(html).toContain('Figma rejected the token');
  });

  it('renders a trend chart once there are at least two runs', async () => {
    const report = await fixtureReport();
    const history: HistoryEntry[] = [
      { ts: '2026-01-01T00:00:00.000Z', overall: 40, code: 40, design: 40, documentation: 40, components: 3, metricsHash: 'aaaa' },
      { ts: '2026-02-01T00:00:00.000Z', overall: 60, code: 60, design: 60, documentation: 60, components: 3, metricsHash: 'aaaa' },
    ];
    const html = renderReport({ report, history });
    expect(html).toContain('Overall score over time');
    expect(html).toContain('trend-line');
  });

  it('omits the trend chart with a single run', async () => {
    const html = renderReport({
      report: await fixtureReport(),
      history: [
        { ts: '2026-01-01T00:00:00.000Z', overall: 40, code: 40, design: 40, documentation: 40, components: 3, metricsHash: 'aaaa' },
      ],
    });
    expect(html).not.toContain('Overall score over time');
  });

  it('breaks the trend line where the metric set changed', async () => {
    const html = renderReport({
      report: await fixtureReport(),
      history: [
        { ts: '2026-01-01T00:00:00.000Z', overall: 40, code: 40, design: 40, documentation: 40, components: 3, metricsHash: 'aaaa' },
        { ts: '2026-02-01T00:00:00.000Z', overall: 90, code: 90, design: 90, documentation: 90, components: 3, metricsHash: 'bbbb' },
      ],
    });
    expect(html).toContain('trend-break');
    expect(html).toContain('measure different things');
  });

  it('supports dark mode without a theme toggle', async () => {
    const html = renderReport({ report: await fixtureReport() });
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('color-scheme: light dark');
  });
});

describe('displayPath', () => {
  it('prefers a short relative path', () => {
    expect(displayPath('/repo/out.html', '/repo')).toBe('out.html');
    expect(displayPath('/repo/a/out.html', '/repo')).toBe('a/out.html');
  });

  it('falls back to the absolute path rather than a pile of dot-dots', () => {
    expect(displayPath('/tmp/demo/out.html', '/a/b/c/d/e')).toBe('/tmp/demo/out.html');
  });

  it('passes null through', () => {
    expect(displayPath(null)).toBeNull();
  });
});
