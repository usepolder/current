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

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export type CategoryScores = Record<MetricCategory, AxisScore>;
