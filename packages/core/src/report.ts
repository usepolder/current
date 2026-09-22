import type { Answer, MetricCategory, MetricDef } from './metrics';
import type { AxisScore, Quadrant } from './score';

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

export interface ComponentResult {
  name: string;
  /** Which sides resolved. A missing side is reported, never silently dropped. */
  presence: {
    code: 'present' | 'missing' | 'unmapped';
    figma: 'present' | 'missing' | 'unmapped' | 'unavailable';
    docs: 'present' | 'missing' | 'unmapped';
  };
  scores: Record<MetricCategory, AxisScore>;
  quadrant: Quadrant | null;
  metrics: MetricResult[];
}

export interface CurrentReport {
  schemaVersion: number;
  generatedAt: string;
  threshold: number;
  minConfidence: number;
  /** Set when the Figma side could not be reached; the report is code-only. */
  figmaUnavailable: string | null;
  components: ComponentResult[];
  totals: {
    code: number | null;
    design: number | null;
    documentation: number | null;
    /** Mean of the three category totals that are present. */
    overall: number | null;
    componentsScored: number;
    componentsNotPlotted: number;
  };
  quadrantCounts: Record<Quadrant, number> & { unplotted: number };
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
