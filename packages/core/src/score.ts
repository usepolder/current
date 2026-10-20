import type { Answer, MetricCategory } from './metrics';

/**
 * Score = Yes / (Yes + No), with N/A excluded from the denominator — the same
 * formula the source audit sheet uses for its per-category percentages.
 *
 *   answered = Yes + No        (the denominator)
 *   score    = null when answered === 0   ← an undefined axis, never 0%
 *   lowConfidence when 0 < answered < minConfidence
 *
 * The null case is reachable in real data: the sheet already has components
 * whose whole Prototyping row is N/A. Scoring those 0% would park a healthy
 * component in the "critical" corner, so they are excluded from the plot and
 * listed separately instead.
 */
export interface AxisScore {
  /** 0-100, or null when no metric in this category was answered Yes or No. */
  score: number | null;
  yes: number;
  no: number;
  na: number;
  /** Yes + No. The denominator. */
  answered: number;
  /** True when answered is above zero but below the configured minimum. */
  lowConfidence: boolean;
  /**
   * True when a whole data source for this axis was unavailable, so the
   * automated metrics could not run. The remaining manual answers are real,
   * but they are a fraction of the rubric — scoring the axis from them alone
   * would report a confident number for a measurement that did not happen.
   */
  degraded: boolean;
}

export type Quadrant = 'healthy' | 'critical' | 'monitor' | 'moderate';

export function scoreAnswers(
  answers: readonly Answer[],
  minConfidence: number,
  degraded = false,
): AxisScore {
  let yes = 0;
  let no = 0;
  let na = 0;
  for (const a of answers) {
    if (a === 'Yes') yes += 1;
    else if (a === 'No') no += 1;
    else na += 1;
  }
  const answered = yes + no;
  // A degraded axis reports no score at all. Its manual answers still appear
  // in the per-metric table, so nothing a human recorded is lost — but the
  // axis has no number, because the number would be measuring a third of the
  // rubric while looking exactly like a full one.
  if (answered === 0 || degraded) {
    return { score: null, yes, no, na, answered, lowConfidence: false, degraded };
  }
  return {
    score: round1((yes / answered) * 100),
    yes,
    no,
    na,
    answered,
    lowConfidence: answered < minConfidence,
    degraded: false,
  };
}

/**
 * Top-right healthy, top-left critical, bottom-left monitor, bottom-right
 * moderate — with X = code health and Y = design health. Strong design over
 * weak code is "critical" because a shipped component that looks right and
 * behaves wrong is the expensive kind of broken.
 *
 *            design ▲
 *      critical     │     healthy
 *   (design ok,     │   (both ok)
 *    code weak)     │
 *   ───────────────┼───────────────▶ code
 *      monitor      │     moderate
 *   (both weak)     │   (code ok,
 *                   │    design weak)
 */
export function quadrantFor(
  codeScore: number | null,
  designScore: number | null,
  threshold: number,
): Quadrant | null {
  if (codeScore === null || designScore === null) return null;
  const codeStrong = codeScore >= threshold;
  const designStrong = designScore >= threshold;
  if (codeStrong && designStrong) return 'healthy';
  if (!codeStrong && designStrong) return 'critical';
  if (!codeStrong && !designStrong) return 'monitor';
  return 'moderate';
}

export const QUADRANT_LABELS: Record<Quadrant, string> = {
  healthy: 'Healthy',
  critical: 'Critical',
  monitor: 'Monitor',
  moderate: 'Moderate',
};

/**
 * Aggregate score across components for one category. Components with an
 * undefined axis contribute nothing — averaging them in as 0 would be the
 * same lie the per-component null exists to avoid.
 */
export function averageScore(scores: readonly (number | null)[]): number | null {
  const present = scores.filter((s): s is number => s !== null);
  if (present.length === 0) return null;
  return round1(present.reduce((a, b) => a + b, 0) / present.length);
}

/**
 * Average an axis across components, ignoring the ones whose score rests on
 * too few answered metrics.
 *
 * Without this, a failure makes the system look healthier. A component whose
 * documentation could not be read falls back to whatever single metric was
 * answered by hand — usually a Yes, so 100% — and a full-weight average of
 * seven such components lifts the headline above the components that were
 * actually measured. A number that improves when the network fails is not a
 * measurement.
 */
export function averageConfidentScore(
  axes: readonly AxisScore[],
): { score: number | null; contributing: number; excluded: number } {
  const scored = axes.filter((a) => a.score !== null);
  const confident = scored.filter((a) => !a.lowConfidence);
  const excluded = scored.length - confident.length;
  if (confident.length === 0) {
    // Everything is thin. Report what there is rather than nothing, but say
    // how thin it was.
    return {
      score: averageScore(scored.map((a) => a.score)),
      contributing: scored.length,
      excluded: 0,
    };
  }
  return {
    score: averageScore(confident.map((a) => a.score)),
    contributing: confident.length,
    excluded,
  };
}

/**
 * The weakest of a component's code and design scores — the axis that makes it
 * broken. Documentation is left out on purpose: a thin doc page is worth
 * fixing but is not what makes a component urgent, and letting it in would
 * put a well-built Button behind a badly-built Divider that happens to be
 * documented.
 */
export function weakestAxis(
  code: number | null,
  design: number | null,
): { axis: 'code' | 'design'; score: number } | null {
  if (code === null && design === null) return null;
  if (design === null) return { axis: 'code', score: code as number };
  if (code === null) return { axis: 'design', score: design };
  return code <= design ? { axis: 'code', score: code } : { axis: 'design', score: design };
}

/**
 * Usage-weighted priority, 0-100: how far the component falls short, scaled
 * by how much of the busiest component's traffic it carries.
 *
 *   priority = (100 - weakest axis) x uses / maxUses
 *
 * The busiest component with a 40% axis scores 60; a component used a tenth
 * as often with the same 40% scores 6. Linear on purpose — it is a ranking a
 * person can reproduce on a napkin, and the raw counts are printed beside it.
 *
 * null when nothing was scored, so an unmeasured component is never ranked
 * as if it were fine.
 */
export function usagePriority(
  code: number | null,
  design: number | null,
  uses: number,
  maxUses: number,
): number | null {
  const weakest = weakestAxis(code, design);
  if (weakest === null) return null;
  if (maxUses <= 0) return 0;
  return round1(((100 - weakest.score) * uses) / maxUses);
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export type CategoryScores = Record<MetricCategory, AxisScore>;
