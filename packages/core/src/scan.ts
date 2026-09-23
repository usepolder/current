import * as fs from 'fs';
import * as path from 'path';
import { lookupAnswer, type AnswerBook } from './answers';
import { CODE_CHECKS, type CheckResult, type CodeFacts } from './code-checks';
import { resolveComponentPaths, type CurrentConfig } from './config';
import { checkDocSection } from './docs-checks';
import { FigmaError, NoComponentsError } from './errors';
import { DESIGN_CHECKS, figmaPropertyNames, type DesignFacts } from './figma-checks';
import type { FigmaClient, FigmaNode } from './figma-client';
import { silentLogger, type Logger } from './logger';
import { CATEGORIES, type Answer, type MetricCategory } from './metrics';
import { parseSource, type Ast } from './parse';
import {
  countQuadrants,
  metricsForCategory,
  SCHEMA_VERSION,
  type ComponentResult,
  type CurrentReport,
  type MetricResult,
} from './report';
import { averageScore, quadrantFor, scoreAnswers, type AxisScore } from './score';

/**
 * Evidence marker for a design check that could not run because Figma was
 * unreachable. Matched exactly when deciding whether the design axis is
 * degraded, so the two stay in step.
 */
const FIGMA_UNAVAILABLE = 'Figma unavailable — design metrics not evaluated';

export interface ScanOptions {
  repoRoot: string;
  config: CurrentConfig;
  answers: AnswerBook;
  /** Omit to produce a code-and-docs-only report. */
  figma?: FigmaClient | null;
  logger?: Logger;
  now?: () => Date;
}

interface LoadedComponent {
  name: string;
  codePath: string | null;
  docsPath: string | null;
  source: string | null;
  ast: Ast | null;
  docsSource: string | null;
  figmaNode: FigmaNode | null;
}

/**
 * The whole pipeline: resolve mappings → read code and docs → fetch Figma →
 * run every enabled check → merge manual answers → score → assemble.
 *
 *   config ──▶ identity map ──▶ code scan ─┐
 *                           ╰─▶ figma ─────┼─▶ per-metric answers ──▶ scores ──▶ report
 *              answers file ───────────────┘
 */
export async function scanRepo(opts: ScanOptions): Promise<CurrentReport> {
  const logger = opts.logger ?? silentLogger;
  const { config, repoRoot, answers } = opts;

  if (config.components.length === 0) {
    throw new NoComponentsError('.current.yml');
  }

  // Throws on any path escaping the repo root, before a single file is read.
  const resolvedPaths = resolveComponentPaths(config, repoRoot);

  let figmaNodes = new Map<string, FigmaNode>();
  let figmaUnavailable: string | null = null;

  const figmaIds = config.components
    .map((c) => c.figma)
    .filter((id): id is string => id !== null);

  if (opts.figma && figmaIds.length > 0) {
    try {
      figmaNodes = await opts.figma.fetchNodes(figmaIds);
      logger.trace(`figma: resolved ${figmaNodes.size} of ${figmaIds.length} requested node(s)`);
    } catch (err) {
      // Degrade rather than fail: a code-only report with a visible warning
      // beats no report at all when Figma is down or rate limiting.
      figmaUnavailable =
        err instanceof FigmaError ? err.message : `Figma request failed: ${(err as Error).message}`;
      logger.trace(`figma: unavailable — ${figmaUnavailable}`);
    }
  } else if (figmaIds.length > 0) {
    figmaUnavailable = `No Figma token provided; design metrics were not evaluated.`;
  }

  const loaded: LoadedComponent[] = config.components.map((mapping) => {
    const paths = resolvedPaths.get(mapping.name)!;
    let source: string | null = null;
    let ast: Ast | null = null;
    if (paths.code !== null && fs.existsSync(paths.code)) {
      source = fs.readFileSync(paths.code, 'utf8');
      ast = parseSource(source, path.relative(repoRoot, paths.code));
      logger.trace(`${mapping.name}: parsed ${path.relative(repoRoot, paths.code)}`);
    } else if (paths.code !== null) {
      logger.trace(`${mapping.name}: code file missing at ${mapping.code}`);
    }

    let docsSource: string | null = null;
    if (paths.docs !== null && fs.existsSync(paths.docs)) {
      docsSource = fs.readFileSync(paths.docs, 'utf8');
    } else if (paths.docs !== null) {
      logger.trace(`${mapping.name}: docs file missing at ${mapping.docs}`);
    }

    return {
      name: mapping.name,
      codePath: mapping.code,
      docsPath: mapping.docs,
      source,
      ast,
      docsSource,
      figmaNode: mapping.figma === null ? null : figmaNodes.get(mapping.figma) ?? null,
    };
  });

  const components = loaded.map((c, i) =>
    scoreComponent(c, config, answers, logger, {
      figmaMapped: config.components[i].figma !== null,
      figmaUnavailable: figmaUnavailable !== null,
    }),
  );

  // Figma being unreachable is only worth warning about if it actually cost
  // a score. When every design metric was answered by a human, it did not,
  // and a banner saying "design metrics were not evaluated" above a design
  // column full of numbers is just wrong.
  if (figmaUnavailable !== null && !components.some((c) => c.scores.design.degraded)) {
    logger.trace(
      'figma: unavailable, but no design metric needed it — not reported as a degraded run',
    );
    figmaUnavailable = null;
  }

  const totals = {
    code: averageScore(components.map((c) => c.scores.code.score)),
    design: averageScore(components.map((c) => c.scores.design.score)),
    documentation: averageScore(components.map((c) => c.scores.documentation.score)),
    overall: null as number | null,
    componentsScored: components.filter((c) => c.quadrant !== null).length,
    componentsNotPlotted: components.filter((c) => c.quadrant === null).length,
  };
  totals.overall = averageScore([totals.code, totals.design, totals.documentation]);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    threshold: config.threshold,
    minConfidence: config.minConfidence,
    figmaUnavailable,
    components,
    totals,
    quadrantCounts: countQuadrants(components),
  };
}

function scoreComponent(
  c: LoadedComponent,
  config: CurrentConfig,
  answers: AnswerBook,
  logger: Logger,
  ctx: { figmaMapped: boolean; figmaUnavailable: boolean },
): ComponentResult {
  const results: MetricResult[] = [];

  const codeFacts: CodeFacts | null =
    c.ast === null
      ? null
      : {
          componentName: c.name,
          filePath: c.codePath ?? '',
          source: c.source ?? '',
          ast: c.ast,
          figmaPropertyNames: c.figmaNode === null ? null : figmaPropertyNames(c.figmaNode),
        };

  const designFacts: DesignFacts | null =
    c.figmaNode === null ? null : { componentName: c.name, node: c.figmaNode };

  for (const metric of config.metrics) {
    const manual = lookupAnswer(answers, c.name, metric.id);

    // A human answer always wins: someone looked at the real thing.
    if (manual !== undefined) {
      results.push({
        metricId: metric.id,
        category: metric.category,
        subcategory: metric.subcategory,
        guideline: metric.guideline,
        answer: manual,
        source: 'manual',
        evidence: null,
      });
      logger.trace(`${c.name}/${metric.id}: ${manual} (manual answer)`);
      continue;
    }

    if (metric.check === null) {
      results.push({
        metricId: metric.id,
        category: metric.category,
        subcategory: metric.subcategory,
        guideline: metric.guideline,
        answer: 'N/A',
        source: 'unanswered',
        evidence: 'manual metric with no answer in .current.answers.yml',
      });
      continue;
    }

    const outcome = runCheck(metric.check, metric.params, {
      codeFacts,
      designFacts,
      component: c,
      ctx,
    });

    results.push({
      metricId: metric.id,
      category: metric.category,
      subcategory: metric.subcategory,
      guideline: metric.guideline,
      answer: outcome.answer,
      source: 'auto',
      evidence: outcome.evidence,
    });
    logger.trace(`${c.name}/${metric.id}: ${outcome.answer} (${metric.check}) — ${outcome.evidence}`);
  }

  // The design axis is degraded only when Figma being unreachable actually
  // cost us something — that is, some design metric was waiting on an
  // automated check that never ran.
  //
  // If every design metric is answered by a human (or configured manual),
  // Figma being down changes nothing about the score, and withholding it
  // would punish a team for a network failure that had no bearing on their
  // answers. That is the whole-audit-in-a-file case, and it must still score.
  const designDegraded = results.some(
    (r) => r.category === 'design' && r.source === 'auto' && r.evidence === FIGMA_UNAVAILABLE,
  );

  const scores = {} as Record<MetricCategory, AxisScore>;
  for (const category of CATEGORIES) {
    const ids = new Set(metricsForCategory(config.metrics, category).map((m) => m.id));
    const categoryAnswers: Answer[] = results
      .filter((r) => ids.has(r.metricId))
      .map((r) => r.answer);
    scores[category] = scoreAnswers(
      categoryAnswers,
      config.minConfidence,
      category === 'design' && designDegraded,
    );
  }

  return {
    name: c.name,
    presence: {
      code: c.codePath === null ? 'unmapped' : c.ast === null ? 'missing' : 'present',
      figma: !ctx.figmaMapped
        ? 'unmapped'
        : ctx.figmaUnavailable
          ? // Only a failure if a design check was actually waiting on it.
            designDegraded
            ? 'unavailable'
            : 'not-checked'
          : c.figmaNode === null
            ? 'missing'
            : 'present',
      docs: c.docsPath === null ? 'unmapped' : c.docsSource === null ? 'missing' : 'present',
    },
    scores,
    quadrant: quadrantFor(scores.code.score, scores.design.score, config.threshold),
    metrics: results,
  };
}

function runCheck(
  checkId: string,
  params: Record<string, unknown> | undefined,
  args: {
    codeFacts: CodeFacts | null;
    designFacts: DesignFacts | null;
    component: LoadedComponent;
    ctx: { figmaMapped: boolean; figmaUnavailable: boolean };
  },
): CheckResult {
  if (checkId.startsWith('code.')) {
    if (args.codeFacts === null) {
      return {
        answer: args.component.codePath === null ? 'N/A' : 'No',
        evidence:
          args.component.codePath === null
            ? 'no code path mapped for this component'
            : `code file mapped but missing: ${args.component.codePath}`,
      };
    }
    const fn = CODE_CHECKS[checkId];
    if (!fn) return { answer: 'N/A', evidence: `unknown check "${checkId}"` };
    return fn(args.codeFacts);
  }

  if (checkId.startsWith('design.')) {
    if (args.designFacts === null) {
      if (!args.ctx.figmaMapped) {
        return { answer: 'N/A', evidence: 'no Figma node mapped for this component' };
      }
      if (args.ctx.figmaUnavailable) {
        return { answer: 'N/A', evidence: FIGMA_UNAVAILABLE };
      }
      return { answer: 'No', evidence: 'Figma node mapped but not found in the file' };
    }
    const fn = DESIGN_CHECKS[checkId];
    if (!fn) return { answer: 'N/A', evidence: `unknown check "${checkId}"` };
    return fn(args.designFacts);
  }

  if (checkId === 'docs.section') {
    const headings = (params?.headings as string[] | undefined) ?? [];
    return checkDocSection({
      componentName: args.component.name,
      source: args.component.docsSource,
      missing: args.component.docsPath !== null && args.component.docsSource === null,
      headings,
    });
  }

  return { answer: 'N/A', evidence: `unknown check "${checkId}"` };
}
