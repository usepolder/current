import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  FigmaClient,
  NoComponentsError,
  PathTraversalError,
  parseAnswers,
  parseConfig,
  scanRepo,
  type ComponentResult,
  type CurrentReport,
} from '@usepolder/current-core';
import { fixtureNodes } from './fixtures/figma-nodes';

const FIXTURE = path.join(__dirname, 'fixtures', 'ds');

function fixtureFigma(opts: { fail?: number } = {}): FigmaClient {
  return new FigmaClient({
    token: 'test-token',
    fileKey: 'fixture-file',
    sleep: async () => {},
    fetcher: async (url: string) => {
      if (opts.fail !== undefined) {
        return {
          ok: false,
          status: opts.fail,
          headers: { get: () => null },
          text: async () => '',
        };
      }
      const ids = decodeURIComponent(new URL(url).searchParams.get('ids') ?? '').split(',');
      const nodes: Record<string, { document: unknown } | null> = {};
      for (const id of ids) {
        nodes[id] = fixtureNodes[id] ? { document: fixtureNodes[id] } : null;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ nodes }),
      };
    },
  });
}

async function scanFixture(overrides: { figma?: FigmaClient | null } = {}): Promise<CurrentReport> {
  const config = parseConfig(fs.readFileSync(path.join(FIXTURE, '.current.yml'), 'utf8'));
  const answers = parseAnswers(fs.readFileSync(path.join(FIXTURE, '.current.answers.yml'), 'utf8'));
  return scanRepo({
    repoRoot: FIXTURE,
    config,
    answers,
    figma: overrides.figma === undefined ? fixtureFigma() : overrides.figma,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
}

function byName(report: CurrentReport, name: string): ComponentResult {
  const found = report.components.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no component ${name} in report`);
  return found;
}

describe('scanRepo — end to end against a fixture design system', () => {
  it('scores every mapped component', async () => {
    const report = await scanFixture();
    expect(report.components.map((c) => c.name)).toEqual(['Button', 'Wrapper', 'Ghost']);
    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('puts a well-built component in the healthy quadrant', async () => {
    const button = byName(await scanFixture(), 'Button');
    expect(button.presence).toEqual({ code: 'present', figma: 'present', docs: 'present' });
    expect(button.quadrant).toBe('healthy');
    expect(button.scores.code.score).toBeGreaterThanOrEqual(60);
    expect(button.scores.design.score).toBeGreaterThanOrEqual(60);
    expect(button.scores.documentation.score).toBeGreaterThan(50);
  });

  it('puts a neglected component in the monitor quadrant', async () => {
    const wrapper = byName(await scanFixture(), 'Wrapper');
    expect(wrapper.quadrant).toBe('monitor');
    expect(wrapper.scores.code.score).toBeLessThan(60);
    expect(wrapper.scores.design.score).toBeLessThan(60);
  });

  it('reports a component whose files are missing rather than dropping it', async () => {
    const ghost = byName(await scanFixture(), 'Ghost');
    expect(ghost.presence.code).toBe('missing');
    expect(ghost.presence.figma).toBe('missing');
    expect(report_has(ghost, 'code file mapped but missing')).toBe(true);
  });

  it('scores unmapped docs as N/A, not as a failure', async () => {
    const wrapper = byName(await scanFixture(), 'Wrapper');
    expect(wrapper.presence.docs).toBe('unmapped');
    const docMetrics = wrapper.metrics.filter((m) => m.category === 'documentation');
    expect(docMetrics.every((m) => m.answer === 'N/A')).toBe(true);
    expect(wrapper.scores.documentation.score).toBeNull();
  });

  it('prefers a human answer over an automated check', async () => {
    const report = await scanFixture();
    const button = byName(report, 'Button');
    const co1 = button.metrics.find((m) => m.metricId === 'CO1');
    expect(co1).toMatchObject({ answer: 'Yes', source: 'manual' });
  });

  it('records evidence for every automated answer', async () => {
    const button = byName(await scanFixture(), 'Button');
    const auto = button.metrics.filter((m) => m.source === 'auto');
    expect(auto.length).toBeGreaterThan(5);
    expect(auto.every((m) => m.evidence !== null && m.evidence.length > 0)).toBe(true);
  });

  it('detects the fixture\u2019s real design facts', async () => {
    const button = byName(await scanFixture(), 'Button');
    expect(button.metrics.find((m) => m.metricId === 'DE10')?.answer).toBe('Yes');
    expect(button.metrics.find((m) => m.metricId === 'DE9')?.answer).toBe('Yes');

    const wrapper = byName(await scanFixture(), 'Wrapper');
    expect(wrapper.metrics.find((m) => m.metricId === 'DE10')?.answer).toBe('No');
    expect(wrapper.metrics.find((m) => m.metricId === 'DE7')?.answer).toBe('No');
  });

  it('detects the fixture\u2019s real code facts', async () => {
    const button = byName(await scanFixture(), 'Button');
    expect(button.metrics.find((m) => m.metricId === 'CO2')?.answer).toBe('Yes');
    expect(button.metrics.find((m) => m.metricId === 'CO7')?.answer).toBe('Yes');
    expect(button.metrics.find((m) => m.metricId === 'CO9')?.answer).toBe('Yes');

    const wrapper = byName(await scanFixture(), 'Wrapper');
    expect(wrapper.metrics.find((m) => m.metricId === 'CO7')?.answer).toBe('No');
    expect(wrapper.metrics.find((m) => m.metricId === 'CO5')?.answer).toBe('No');
    expect(wrapper.metrics.find((m) => m.metricId === 'CO8')?.answer).toBe('No');
  });

  it('totals only the components that have a score', async () => {
    const report = await scanFixture();
    expect(report.totals.code).not.toBeNull();
    expect(report.totals.overall).not.toBeNull();
    expect(report.quadrantCounts.healthy).toBe(1);
    // Wrapper is genuinely weak, and Ghost is mapped-but-missing on both
    // sides — a missing implementation should surface as a quadrant hit, not
    // vanish from the report.
    expect(report.quadrantCounts.monitor).toBe(2);
    expect(byName(report, 'Ghost').quadrant).toBe('monitor');
  });

  it('degrades to a code-only report when Figma fails, instead of throwing', async () => {
    const report = await scanFixture({ figma: fixtureFigma({ fail: 403 }) });
    expect(report.figmaUnavailable).toMatch(/rejected the token/);
    expect(byName(report, 'Button').presence.figma).toBe('unavailable');
    expect(byName(report, 'Button').scores.code.score).not.toBeNull();
    expect(byName(report, 'Button').quadrant).toBeNull();
  });

  it('does not score the design axis from leftover manual answers on a degraded run', async () => {
    // Button has four manual design answers, all Yes. Scoring the axis from
    // those alone would report design 100% while seven automated design
    // metrics never ran — a confident number for a measurement that did not
    // happen.
    const report = await scanFixture({ figma: fixtureFigma({ fail: 403 }) });
    const design = byName(report, 'Button').scores.design;

    expect(design.degraded).toBe(true);
    expect(design.score).toBeNull();
    expect(report.totals.design).toBeNull();

    // The human answers are still in the report, just not scored.
    const de2 = byName(report, 'Button').metrics.find((m) => m.metricId === 'DE2');
    expect(de2).toMatchObject({ answer: 'Yes', source: 'manual' });
  });

  it('keeps the code axis fully scored on a degraded run', async () => {
    const report = await scanFixture({ figma: fixtureFigma({ fail: 403 }) });
    expect(byName(report, 'Button').scores.code.degraded).toBe(false);
    expect(report.totals.code).not.toBeNull();
  });

  it('reports Figma as unavailable when no client is supplied at all', async () => {
    const report = await scanFixture({ figma: null });
    expect(report.figmaUnavailable).toMatch(/No Figma token/);
  });

  it('refuses to scan when no components are mapped', async () => {
    await expect(
      scanRepo({
        repoRoot: FIXTURE,
        config: { ...parseConfig('components:\n  A:\n    code: "a.tsx"\n'), components: [] },
        answers: new Map(),
      }),
    ).rejects.toBeInstanceOf(NoComponentsError);
  });

  it('rejects a traversing path before reading any file', async () => {
    await expect(
      scanRepo({
        repoRoot: FIXTURE,
        config: parseConfig('components:\n  Evil:\n    code: "../../../../etc/passwd"\n'),
        answers: new Map(),
      }),
    ).rejects.toBeInstanceOf(PathTraversalError);
  });
});

function report_has(component: ComponentResult, needle: string): boolean {
  return component.metrics.some((m) => (m.evidence ?? '').includes(needle));
}
