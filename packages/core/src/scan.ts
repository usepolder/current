import * as fs from 'fs';
import * as path from 'path';
import { lookupAnswer, type AnswerBook } from './answers';
import { CODE_CHECKS, type CheckResult, type CodeFacts } from './code-checks';
import { resolveComponentPaths, type CurrentConfig } from './config';
import { checkDocSection, extractHeadings, extractHtmlHeadings, type DocsFacts } from './docs-checks';
import { isDocsUrl, type PageRenderer } from './docs-source';
import { FigmaError, NoComponentsError } from './errors';
import { DESIGN_CHECKS, figmaPropertyNames, type DesignFacts } from './figma-checks';
import type { FigmaClient, FigmaNode } from './figma-client';
import { silentLogger, type Logger } from './logger';
import { CATEGORIES, type Answer, type MetricCategory } from './metrics';
import { parseSource, type Ast } from './parse';
import { collectRelatedFiles, type RelatedFiles } from './related-files';
import {
  countQuadrants,
  metricsForCategory,
  SCHEMA_VERSION,
  type ComponentResult,
  type CurrentReport,
  type MetricResult,
  type UsageBasis,
} from './report';
import {
  averageConfidentScore,
  averageScore,
  quadrantFor,
  scoreAnswers,
  usagePriority,
  type AxisScore,
} from './score';
import type { UsageMap } from './usage';

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
  /**
   * Renders a hosted docs URL to HTML. Omit it and URL-mapped docs report as
   * N/A with an install hint rather than being scored wrong.
   */
  renderDocs?: PageRenderer | null;
  /**
   * Per-component usage from a Reach report. Omit it and the report carries no
   * priority — nothing is weighted by a guess.
   */
  usage?: UsageMap | null;
  now?: () => Date;
}

interface LoadedComponent {
  name: string;
  codePath: string | null;
  docsPath: string | null;
  source: string | null;
  ast: Ast | null;
  /** Styles and sub-modules the entry file imports from its own directory. */
  related: RelatedFiles | null;
  /** Headings found in the docs, or null when there were none to read. */
  docsHeadings: string[] | null;
  docsAbsence: DocsFacts['absence'];
  docsAbsenceDetail?: string;
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
    throw new NoComponentsError('.polder.yml');
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

  const loaded: LoadedComponent[] = [];
  for (const mapping of config.components) {
    const paths = resolvedPaths.get(mapping.name)!;
    let source: string | null = null;
    let ast: Ast | null = null;
    let related: RelatedFiles | null = null;
    if (paths.code !== null && fs.existsSync(paths.code)) {
      source = fs.readFileSync(paths.code, 'utf8');
      ast = parseSource(source, path.relative(repoRoot, paths.code));
      logger.trace(`${mapping.name}: parsed ${path.relative(repoRoot, paths.code)}`);
      // Another component's entry file is never this component's.
      const others = new Set<string>();
      for (const [name, p] of resolvedPaths) {
        if (name !== mapping.name && p.code !== null) others.add(path.resolve(p.code));
      }
      related = collectRelatedFiles(paths.code, ast, repoRoot, others);
      logger.trace(
        `${mapping.name}: ${related.files.length} related file(s)` +
          (related.files.length > 0 ? ` — ${related.files.map((f) => f.filePath).join(', ')}` : ''),
      );
    } else if (paths.code !== null) {
      logger.trace(`${mapping.name}: code file missing at ${mapping.code}`);
    }

    const docs = await loadDocs(mapping.name, paths.docs, opts, logger);

    loaded.push({
      name: mapping.name,
      codePath: mapping.code,
      docsPath: mapping.docs,
      source,
      ast,
      related,
      docsHeadings: docs.headings,
      docsAbsence: docs.absence,
      docsAbsenceDetail: docs.detail,
      figmaNode: mapping.figma === null ? null : figmaNodes.get(mapping.figma) ?? null,
    });
  }

  const scored = loaded.map((c, i) =>
    scoreComponent(c, config, answers, logger, {
      figmaMapped: config.components[i].figma !== null,
      figmaUnavailable: figmaUnavailable !== null,
    }),
  );
  const { components, usage } = applyUsage(scored, opts.usage ?? null);

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

  const code = averageConfidentScore(components.map((c) => c.scores.code));
  const design = averageConfidentScore(components.map((c) => c.scores.design));
  const documentation = averageConfidentScore(components.map((c) => c.scores.documentation));

  const totals = {
    code: code.score,
    design: design.score,
    documentation: documentation.score,
    overall: averageScore([code.score, design.score, documentation.score]),
    componentsScored: components.filter((c) => c.quadrant !== null).length,
    componentsNotPlotted: components.filter((c) => c.quadrant === null).length,
    /** Per-axis component counts behind each total, and how many were too thin to count. */
    basis: {
      code: { contributing: code.contributing, excluded: code.excluded },
      design: { contributing: design.contributing, excluded: design.excluded },
      documentation: {
        contributing: documentation.contributing,
        excluded: documentation.excluded,
      },
    },
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    threshold: config.threshold,
    minConfidence: config.minConfidence,
    figmaUnavailable,
    components,
    usage,
    totals,
    quadrantCounts: countQuadrants(components),
  };
}

/**
 * Attach usage and priority. A mapped component Reach never saw is used zero
 * times, not unknown: the data exists, and it says nobody renders it.
 *
 * The priority scale is the busiest of *these* components, so a repo whose
 * heaviest DS component is not scored by Current still gets a 0-100 ranking
 * among the ones that are.
 */
function applyUsage(
  components: ComponentResult[],
  usage: UsageMap | null,
): { components: ComponentResult[]; usage: UsageBasis | null } {
  if (usage === null) return { components, usage: null };

  const uses = components.map((c) => usage.get(c.name) ?? 0);
  const maxUses = Math.max(0, ...uses);
  const mapped = new Set(components.map((c) => c.name));

  return {
    components: components.map((c, i) => ({
      ...c,
      usage: uses[i],
      priority: usagePriority(c.scores.code.score, c.scores.design.score, uses[i], maxUses),
    })),
    usage: {
      totalUses: [...usage.values()].reduce((a, b) => a + b, 0),
      unmatched: [...usage]
        .filter(([name]) => !mapped.has(name))
        .map(([name, n]) => ({ name, uses: n }))
        .sort((a, b) => b.uses - a.uses || (a.name < b.name ? -1 : 1)),
    },
  };
}

/**
 * Read a component's documentation, from a repo file or a hosted page.
 *
 * A URL that cannot be rendered is N/A, never No: "we could not look" and
 * "we looked and it is not documented" are different answers, and conflating
 * them would mark a well-documented system as undocumented the moment a
 * renderer is missing or a site is down.
 */
async function loadDocs(
  component: string,
  docs: string | null,
  opts: ScanOptions,
  logger: Logger,
): Promise<{ headings: string[] | null; absence: DocsFacts['absence']; detail?: string }> {
  if (docs === null) return { headings: null, absence: 'unmapped' };

  if (!isDocsUrl(docs)) {
    if (!fs.existsSync(docs)) {
      logger.trace(`${component}: docs file missing at ${docs}`);
      return { headings: null, absence: 'missing' };
    }
    const headings = extractHeadings(fs.readFileSync(docs, 'utf8'));
    logger.trace(`${component}: ${headings.length} heading(s) from the docs file`);
    return { headings, absence: null };
  }

  if (opts.renderDocs === undefined || opts.renderDocs === null) {
    logger.trace(`${component}: docs are a URL but no renderer was provided`);
    return { headings: null, absence: 'no-renderer' };
  }

  try {
    const html = await opts.renderDocs(docs);
    const headings = extractHtmlHeadings(html);
    if (headings.length === 0) {
      // A hosted docs page with no headings at all is far more likely to be
      // an incomplete render than a real page documenting nothing. Treat it
      // as unread rather than scoring the component as undocumented.
      logger.trace(`${component}: ${docs} returned no headings — treating as unread`);
      return {
        headings: null,
        absence: 'unreadable',
        detail: 'page returned no headings; it may not have finished rendering',
      };
    }
    logger.trace(`${component}: ${headings.length} heading(s) from ${docs}`);
    return { headings, absence: null };
  } catch (err) {
    const detail = (err as Error).message.split('\n')[0];
    logger.trace(`${component}: docs page failed — ${detail}`);
    return { headings: null, absence: 'unreadable', detail };
  }
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
          ...(c.related === null ? {} : { related: c.related }),
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
      docs: c.docsPath === null ? 'unmapped' : c.docsHeadings === null ? 'missing' : 'present',
    },
    scores,
    quadrant: quadrantFor(scores.code.score, scores.design.score, config.threshold),
    usage: null,
    priority: null,
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
    return fn(args.codeFacts, params);
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
    return checkDocSection({
      componentName: args.component.name,
      headings: args.component.docsHeadings,
      absence: args.component.docsAbsence,
      absenceDetail: args.component.docsAbsenceDetail,
      wanted: (params?.headings as string[] | undefined) ?? [],
    });
  }

  return { answer: 'N/A', evidence: `unknown check "${checkId}"` };
}
