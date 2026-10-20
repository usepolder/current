import { CATEGORIES, type Answer, type MetricCategory, type MetricDef } from './metrics';
import { weakestAxis, type AxisScore, type Quadrant } from './score';

/** Bump when the JSON report's shape changes in a way consumers would notice. */
export const SCHEMA_VERSION = 1;

export type AnswerSource = 'auto' | 'manual' | 'unanswered';

export interface MetricResult {
  metricId: string;
  category: MetricCategory;
  subcategory: string;
  guideline: string;
  answer: Answer;
  source: AnswerSource;
  /** Why an automated check answered the way it did. */
  evidence: string | null;
}

/**
 * Why a side of a component did or did not resolve.
 *
 * `unavailable` and `not-checked` both mean "we did not read Figma", but only
 * the first one cost a score. When every design metric is answered by a
 * human, the node is never fetched because nothing needed it — that is a
 * non-event, not a failure, and flagging it as one puts a red badge on every
 * row of a perfectly good report.
 */
export type SidePresence =
  | 'present'
  | 'missing'
  | 'unmapped'
  | 'unavailable'
  | 'not-checked';

export interface ComponentResult {
  name: string;
  /** Which sides resolved. A missing side is reported, never silently dropped. */
  presence: {
    code: 'present' | 'missing' | 'unmapped';
    figma: SidePresence;
    docs: 'present' | 'missing' | 'unmapped';
  };
  scores: Record<MetricCategory, AxisScore>;
  quadrant: Quadrant | null;
  /**
   * DS instances of this component in the consuming code, from Reach. null
   * when no usage data was supplied; 0 when it was and Reach saw none.
   */
  usage: number | null;
  /** Usage-weighted urgency, 0-100. null without usage data or without a score. */
  priority: number | null;
  metrics: MetricResult[];
}

/** What the usage numbers were measured over. */
export interface UsageBasis {
  /** Every DS instance Reach counted, including components Current does not score. */
  totalUses: number;
  /** In use, but not mapped in `.polder.yml`, so nothing here scores them. */
  unmatched: { name: string; uses: number }[];
}

export interface CurrentReport {
  schemaVersion: number;
  generatedAt: string;
  threshold: number;
  minConfidence: number;
  /** Set when the Figma side could not be reached; the report is code-only. */
  figmaUnavailable: string | null;
  components: ComponentResult[];
  /** null when no usage data was supplied. */
  usage: UsageBasis | null;
  totals: {
    code: number | null;
    design: number | null;
    documentation: number | null;
    /** Mean of the three category totals that are present. */
    overall: number | null;
    componentsScored: number;
    componentsNotPlotted: number;
    /**
     * How many components stand behind each axis total, and how many were
     * left out for resting on too few answered metrics.
     */
    basis: Record<
      MetricCategory,
      { contributing: number; excluded: number }
    >;
  };
  quadrantCounts: Record<Quadrant, number> & { unplotted: number };
}

export interface AxisBasis {
  category: MetricCategory;
  /** Components that actually contributed to the axis total. */
  contributing: number;
  /** Components in the report. */
  total: number;
  /** Of the non-contributors, how many were dropped for being too thin. */
  excluded: number;
}

/**
 * Axes whose total was computed over fewer than all components, for any
 * reason — some were too thin to count, others were never scored at all.
 *
 * Both need saying. A documentation figure averaged over one of three
 * components is a claim about that one component, and a reader who sees only
 * the number cannot tell. Surfaced here rather than in each renderer so the
 * report, the terminal and the PR comment cannot disagree about it.
 */
export function axesNotFullyCovered(report: CurrentReport): AxisBasis[] {
  const total = report.components.length;
  return CATEGORIES.map((category) => ({
    category,
    contributing: report.totals.basis[category].contributing,
    total,
    excluded: report.totals.basis[category].excluded,
  })).filter((b) => b.contributing > 0 && b.contributing < b.total);
}

export interface FixFirstEntry {
  name: string;
  uses: number;
  priority: number;
  /** Share of all DS usage, 0-100, when the total is known. */
  share: number | null;
  axis: 'code' | 'design';
  score: number;
}

/**
 * The components worth fixing first: below the threshold on code or design,
 * actually in use, most urgent first. A weak component nothing renders is not
 * on the list — it is real, but it is not what to do this week.
 */
export function fixFirst(report: CurrentReport, limit = 5): FixFirstEntry[] {
  if (report.usage === null) return [];
  const total = report.usage.totalUses;
  const entries: FixFirstEntry[] = [];
  for (const c of report.components) {
    if (c.usage === null || c.usage <= 0 || c.priority === null) continue;
    const weakest = weakestAxis(c.scores.code.score, c.scores.design.score);
    if (weakest === null || weakest.score >= report.threshold) continue;
    entries.push({
      name: c.name,
      uses: c.usage,
      priority: c.priority,
      share: total > 0 ? Math.round((c.usage / total) * 1000) / 10 : null,
      axis: weakest.axis,
      score: weakest.score,
    });
  }
  return entries
    .sort((a, b) => b.priority - a.priority || b.uses - a.uses || (a.name < b.name ? -1 : 1))
    .slice(0, limit);
}

export function metricsForCategory(
  metrics: readonly MetricDef[],
  category: MetricCategory,
): MetricDef[] {
  return metrics.filter((m) => m.category === category);
}

export function countQuadrants(components: readonly ComponentResult[]): CurrentReport['quadrantCounts'] {
  const counts = { healthy: 0, critical: 0, monitor: 0, moderate: 0, unplotted: 0 };
  for (const c of components) {
    if (c.quadrant === null) counts.unplotted += 1;
    else counts[c.quadrant] += 1;
  }
  return counts;
}
