import { describe, expect, it } from 'vitest';
import type { CurrentReport } from '@usepolder/current-core';
import { CURRENT_MARKER, findExistingComment, renderComment } from '../src/comment';
import { badgeColor, badgeJson, badgeMessage } from '../src/badge';

describe('findExistingComment', () => {
  it('returns null when no comment carries the marker', () => {
    expect(findExistingComment([{ id: 1, body: 'looks good to me' }])).toBeNull();
  });

  it('returns null for an empty thread', () => {
    expect(findExistingComment([])).toBeNull();
  });

  it('finds the marked comment among unrelated ones', () => {
    const found = findExistingComment([
      { id: 1, body: 'ship it' },
      { id: 2, body: `${CURRENT_MARKER}\n## Current` },
      { id: 3, body: 'nit: naming' },
    ]);
    expect(found?.id).toBe(2);
  });

  it('keeps the oldest when duplicates exist, so the thread does not migrate', () => {
    const found = findExistingComment([
      { id: 50, body: `${CURRENT_MARKER} newer duplicate` },
      { id: 10, body: `${CURRENT_MARKER} original` },
      { id: 30, body: `${CURRENT_MARKER} middle` },
    ]);
    expect(found?.id).toBe(10);
  });

  it('matches on the marker regardless of which identity posted it', () => {
    const found = findExistingComment([
      { id: 7, body: `${CURRENT_MARKER} x`, user: { login: 'some-pat-user', type: 'User' } },
    ]);
    expect(found?.id).toBe(7);
  });

  it('tolerates a comment with a null body', () => {
    expect(findExistingComment([{ id: 1, body: null }, { id: 2, body: `${CURRENT_MARKER}` }])?.id).toBe(2);
  });

  it('does not match a different tool’s marker', () => {
    expect(findExistingComment([{ id: 1, body: '<!-- polder-reach --> Reach score' }])).toBeNull();
  });
});

function component(name: string, quadrant: CurrentReport['components'][number]['quadrant']) {
  return {
    name,
    presence: { code: 'present', figma: 'present', docs: 'present' },
    scores: {} as never,
    quadrant,
    metrics: [],
  } as CurrentReport['components'][number];
}

function report(overrides: Partial<CurrentReport> = {}): CurrentReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    threshold: 60,
    minConfidence: 3,
    figmaUnavailable: null,
    components: [component('Button', 'healthy')],
    totals: {
      code: 70,
      design: 80,
      documentation: 60,
      overall: 70,
      componentsScored: 2,
      componentsNotPlotted: 0,
    },
    quadrantCounts: { healthy: 1, critical: 1, monitor: 0, moderate: 0, unplotted: 0 },
    ...overrides,
  };
}

describe('renderComment', () => {
  it('always includes the marker so the next run can find it', () => {
    expect(renderComment(report(), null, null)).toContain(CURRENT_MARKER);
  });

  it('shows the overall score and the per-category breakdown', () => {
    const body = renderComment(report(), null, null);
    expect(body).toContain('**Overall: 70.0%**');
    expect(body).toContain('| Score | 70.0% | 80.0% | 60.0% |');
  });

  it('shows an upward delta against the base', () => {
    expect(renderComment(report(), 65, 'main')).toContain('▲ +5.0 pts vs `main`');
  });

  it('shows a downward delta', () => {
    expect(renderComment(report(), 75, 'main')).toContain('▼ -5.0 pts vs `main`');
  });

  it('says so when nothing moved', () => {
    expect(renderComment(report(), 70, 'main')).toContain('no change');
  });

  it('omits the delta on a first run with no baseline', () => {
    const body = renderComment(report(), null, null);
    expect(body).not.toContain('pts vs');
  });

  it('calls out critical components by name', () => {
    const body = renderComment(
      report({ components: [component('Button', 'healthy'), component('Dialog', 'critical')] }),
      null,
      null,
    );
    expect(body).toContain('**Critical**');
    expect(body).toContain('`Dialog`');
    expect(body).not.toContain('`Button`');
  });

  it('warns when the design side could not be measured', () => {
    const body = renderComment(report({ figmaUnavailable: 'rate limited' }), null, null);
    expect(body).toContain('Design metrics unavailable');
  });

  it('handles a report with no mapped components', () => {
    const body = renderComment(report({ components: [] }), null, null);
    expect(body).toContain('No components are mapped');
  });

  it('shows an em dash rather than a number when nothing scored', () => {
    const body = renderComment(
      report({ totals: { ...report().totals, overall: null, code: null } }),
      null,
      null,
    );
    expect(body).toContain('**Overall: —**');
  });
});

describe('badge', () => {
  it('maps scores to shields colours', () => {
    expect(badgeColor(90)).toBe('brightgreen');
    expect(badgeColor(65)).toBe('green');
    expect(badgeColor(45)).toBe('yellow');
    expect(badgeColor(25)).toBe('orange');
    expect(badgeColor(5)).toBe('red');
    expect(badgeColor(null)).toBe('lightgrey');
  });

  it('says "no data" rather than 0% when nothing scored', () => {
    expect(badgeMessage(report({ totals: { ...report().totals, overall: null } }))).toBe('no data');
  });

  it('emits a shields.io endpoint document', () => {
    const parsed = JSON.parse(badgeJson(report()));
    expect(parsed).toMatchObject({ schemaVersion: 1, label: 'component health', message: '70.0%' });
  });
});
