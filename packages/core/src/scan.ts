import { reactMajorFor, type ProjectFacts } from './project';
import * as fs from 'fs';
import * as path from 'path';
import { lookupAnswer, type AnswerBook } from './answers';
import { type CheckResult, type CodeConnectFacts, type CodeFacts } from './code-checks';
import { ALL_CODE_CHECKS as CODE_CHECKS } from './structure-checks';
import {
  CODE_CONNECT_CONFIG,
  extractCodeConnect,
  indexCodeConnect,
  mappingFor,
  normaliseNodeId,
  type CodeConnectIndex,
} from './code-connect';
import { resolveComponentPaths, type ComponentMapping, type CurrentConfig } from './config';
import { checkDocSection, extractHeadings, extractHtmlHeadings, type DocsFacts } from './docs-checks';
import {
  isDocsUrl,
  renderDocsPages,
  type PageRenderer,
  type RenderedPage,
} from './docs-source';
import { FigmaError, NoComponentsError } from './errors';
import {
  LIVE_CHECKS,
  requestedDriver,
  requestedWidths,
  type LiveAbsence,
  type LiveFacts,
  type LiveProbe,
} from './live-checks';
import { probeLivePages, type PageProber, type ProbedPage } from './live-source';
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

/**
 * The evidence on a manual norm nobody has answered yet. Exported so a
 * consumer can tell it from a norm that *was* looked at and still needs a
 * person — a probe that could not settle CO1 leaves its own finding here
 * instead, and that one is worth showing (see `CheckResult.needsHuman`).
 */
export const NO_MANUAL_ANSWER = 'manual metric with no answer in .polder.answers.yml';

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
  /**
   * Probes a component's `preview:` URL in a browser. Omit it and the
   * probe-backed norms (CO3 keyboard, CO6 breakpoints) report N/A with an
   * install hint, exactly like hosted docs without a renderer.
   */
  probeLive?: PageProber | null;
  /** How many docs pages to render at once. Defaults to a small cap. */
  docsConcurrency?: number;
  /** How many previews to probe at once. Defaults to a small cap. */
  previewConcurrency?: number;
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
  previewUrl: string | null;
  /** The browser probe of `previewUrl`, or null when there was none. */
  probe: LiveProbe | null;
  probeAbsence: LiveAbsence | null;
  probeAbsenceDetail?: string;
  figmaNode: FigmaNode | null;
  /** The Code Connect side, or null when no norm asked for it. */
  codeConnect: CodeConnectFacts | null;
  /** Repo-level facts the code checks need, or null with no code to judge. */
  project: ProjectFacts | null;
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

  // Rendered up front, a few at a time, rather than one page per iteration of
  // the loop below: see renderDocsPages. The loop itself now awaits nothing.
  let docsPages = new Map<string, RenderedPage>();
  if (opts.renderDocs !== undefined && opts.renderDocs !== null) {
    const urls = [...resolvedPaths.values()]
      .map((p) => p.docs)
      .filter((d): d is string => d !== null && isDocsUrl(d));
    docsPages = await renderDocsPages(urls, opts.renderDocs, {
      ...(opts.docsConcurrency === undefined ? {} : { concurrency: opts.docsConcurrency }),
      logger,
    });
  }

  // Probed up front like the docs pages, and for the same reason: a browser
  // launch amortised over every component beats one per component. The
  // widths come from config, so the probe measures what the norms will ask
  // about rather than a fixed scale nobody configured.
  const widths = breakpointWidths(config);
  let previews = new Map<string, ProbedPage>();
  if (opts.probeLive !== undefined && opts.probeLive !== null) {
    const urls = config.components
      .map((c) => c.preview)
      .filter((p): p is string => p !== null);
    previews = await probeLivePages(urls, opts.probeLive, widths, {
      ...(opts.previewConcurrency === undefined ? {} : { concurrency: opts.previewConcurrency }),
      logger,
      request: { realScreenReader: wantsRealScreenReader(config) },
    });
  }

  // Walked once, and only when a norm actually asks: the walk touches the
  // whole repo, and a config that scores no Code Connect norm should not pay
  // for it. See code-connect.ts for why this is read from the repo.
  const codeConnect = config.metrics.some((m) => m.check === 'code.figma-connect')
    ? indexCodeConnect(repoRoot)
    : null;
  if (codeConnect !== null) {
    logger.trace(
      `code connect: ${codeConnect.mappings.length} mapping(s) in ${codeConnect.fileCount} file(s)` +
        (codeConnect.hasConfig ? `, ${CODE_CONNECT_CONFIG} present` : ''),
    );
  }

  const loaded: LoadedComponent[] = [];
  const reactCache = new Map<string, number | null>();
  for (const mapping of config.components) {
    const paths = resolvedPaths.get(mapping.name)!;
    let source: string | null = null;
    let ast: Ast | null = null;
    let related: RelatedFiles | null = null;
    let project: ProjectFacts | null = null;
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
      const otherEntries = new Map<string, string>();
      for (const [name, p] of resolvedPaths) {
        if (name !== mapping.name && p.code !== null) otherEntries.set(name, path.resolve(p.code));
      }
      project = {
        root: path.resolve(repoRoot),
        entryPath: path.resolve(paths.code),
        otherEntries,
        reactMajor: reactMajorFor(paths.code, repoRoot, reactCache),
      };
      logger.trace(
        `${mapping.name}: ${related.files.length} related file(s)` +
          (related.files.length > 0 ? ` — ${related.files.map((f) => f.filePath).join(', ')}` : ''),
      );
    } else if (paths.code !== null) {
      logger.trace(`${mapping.name}: code file missing at ${mapping.code}`);
    }

    const connect =
      codeConnect === null
        ? null
        : codeConnectFacts({
            index: codeConnect,
            mapping,
            figmaFileKey: config.figmaFileKey,
            codePath: paths.code,
            ast,
            repoRoot,
            logger,
          });

    const docs = loadDocs(mapping.name, paths.docs, opts, docsPages, logger);
    const live = loadPreview(mapping.name, mapping.preview, opts, previews, logger);

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
      previewUrl: mapping.preview,
      probe: live.probe,
      probeAbsence: live.absence,
      probeAbsenceDetail: live.detail,
      figmaNode: mapping.figma === null ? null : figmaNodes.get(mapping.figma) ?? null,
      codeConnect: connect,
      project,
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
 * Assemble the Code Connect side of one component.
 *
 * The component's own entry file is searched alongside the repo's `*.figma.*`
 * files: a single mapping often lives next to the component it maps rather
 * than in a file of its own, and a mapping found there is no less published
 * than one found elsewhere.
 */
function codeConnectFacts(args: {
  index: CodeConnectIndex;
  mapping: ComponentMapping;
  figmaFileKey: string | null;
  codePath: string | null;
  ast: Ast | null;
  repoRoot: string;
  logger: Logger;
}): CodeConnectFacts {
  const { index, mapping, ast, codePath } = args;
  const inline =
    ast === null || codePath === null
      ? []
      : extractCodeConnect(ast, path.relative(args.repoRoot, codePath).split(path.sep).join('/'));

  const all = [...inline, ...index.mappings];
  const found = mappingFor(all, mapping.name);
  if (found !== null) {
    args.logger.trace(
      `${mapping.name}: code connect — ${found.filePath} → ${found.nodeId ?? 'no node id'}`,
    );
  }

  return {
    mapping: found,
    usesCodeConnect: all.length > 0 || index.hasConfig,
    fileCount: index.fileCount,
    mappingCount: all.length,
    expectedNodeId: mapping.figma === null ? null : normaliseNodeId(mapping.figma),
    expectedFileKey: args.figmaFileKey,
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
function loadDocs(
  component: string,
  docs: string | null,
  opts: ScanOptions,
  pages: ReadonlyMap<string, RenderedPage>,
  logger: Logger,
): { headings: string[] | null; absence: DocsFacts['absence']; detail?: string } {
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

  const page = pages.get(docs);
  if (page === undefined) {
    // Only reachable if the prefetch and this lookup disagree about which
    // URLs exist. Report it as unread rather than as zero headings: a bug of
    // ours must not read as a verdict about the user's documentation.
    logger.trace(`${component}: ${docs} was never rendered`);
    return { headings: null, absence: 'unreadable', detail: 'page was not rendered' };
  }

  if ('error' in page) {
    const detail = page.error.split('\n')[0];
    logger.trace(`${component}: docs page failed — ${detail}`);
    return { headings: null, absence: 'unreadable', detail };
  }

  const headings = extractHtmlHeadings(page.html);
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
}

/**
 * Pick up a component's browser probe.
 *
 * Every failure path here is N/A, never No. A preview that would not load
 * tells us nothing about the component's keyboard support, and scoring it
 * No would mean a broken Storybook build quietly tanking the code axis of
 * every component in the system.
 */
function loadPreview(
  component: string,
  preview: string | null,
  opts: ScanOptions,
  previews: ReadonlyMap<string, ProbedPage>,
  logger: Logger,
): { probe: LiveProbe | null; absence: LiveAbsence | null; detail?: string } {
  if (preview === null) return { probe: null, absence: 'unmapped' };

  if (opts.probeLive === undefined || opts.probeLive === null) {
    logger.trace(`${component}: preview mapped but no prober was provided`);
    return { probe: null, absence: 'no-prober' };
  }

  const probed = previews.get(preview);
  if (probed === undefined) {
    // Same defensive branch as loadDocs: a disagreement between the prefetch
    // and this lookup is our bug, and must not read as a verdict.
    logger.trace(`${component}: ${preview} was never probed`);
    return { probe: null, absence: 'unreachable', detail: 'preview was not probed' };
  }
  if ('error' in probed) {
    logger.trace(`${component}: preview probe failed — ${probed.error}`);
    return { probe: null, absence: 'unreachable', detail: probed.error };
  }
  const states = probed.probe.states;
  logger.trace(
    `${component}: probed ${preview} — ${probed.probe.interactiveCount} interactive element(s), ` +
      `${probed.probe.viewports.length} width(s), ` +
      (states === null ? 'no state probe' : `${states.length} element(s) state-probed`),
  );
  return { probe: probed.probe, absence: null };
}

/**
 * Every width any enabled breakpoints norm asks about.
 *
 * A union rather than the first norm's list: a config may well score two
 * different breakpoint norms (say, one overridden for a narrow utility
 * component), and probing one scale would leave the other reporting "not
 * probed at that width" forever.
 */
/**
 * Does any enabled screen-reader norm ask for real assistive technology?
 *
 * A union across norms, same as `breakpointWidths`, and for a blunter reason:
 * the real reader drives the whole machine rather than one page, so it cannot
 * be turned on per norm within a single run. One norm asking for it is
 * enough, and the probe falls back per URL if it is not available.
 */
function wantsRealScreenReader(config: CurrentConfig): boolean {
  return config.metrics.some(
    (metric) => metric.check === 'code.screenreader' && requestedDriver(metric.params) === 'real',
  );
}

function breakpointWidths(config: CurrentConfig): number[] {
  const all = new Set<number>();
  for (const metric of config.metrics) {
    if (metric.check === 'code.breakpoints') {
      for (const w of requestedWidths(metric.params)) all.add(w);
    }
  }
  return [...all].sort((a, b) => a - b);
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
          figmaPropertyDefinitions:
            c.figmaNode === null ? null : (c.figmaNode.componentPropertyDefinitions ?? {}),
          ...(c.related === null ? {} : { related: c.related }),
          ...(c.codeConnect === null ? {} : { codeConnect: c.codeConnect }),
          ...(c.project === null ? {} : { project: c.project }),
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
        evidence: NO_MANUAL_ANSWER,
      });
      continue;
    }

    const outcome = runCheck(metric.check, metric.params, {
      codeFacts,
      designFacts,
      component: c,
      ctx,
    });

    // A check that looked and could not settle the norm leaves it where it
    // started: waiting for a person. It keeps the check's evidence, so the
    // report says what the machine did manage to see — see
    // `CheckResult.needsHuman`.
    const unsettled = outcome.needsHuman === true && outcome.answer === 'N/A';
    results.push({
      metricId: metric.id,
      category: metric.category,
      subcategory: metric.subcategory,
      guideline: metric.guideline,
      answer: outcome.answer,
      source: unsettled ? 'unanswered' : 'auto',
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
  // Probe-backed norms first: they are `code.*` by category but read a
  // rendered page, not an AST, so a component with no code mapped can still
  // be scored from its preview.
  const live = LIVE_CHECKS[checkId];
  if (live) {
    const facts: LiveFacts = {
      componentName: args.component.name,
      probe: args.component.probe,
      absence: args.component.probeAbsence,
      ...(args.component.probeAbsenceDetail === undefined
        ? {}
        : { absenceDetail: args.component.probeAbsenceDetail }),
    };
    return live(facts, params);
  }

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
    return fn(args.designFacts, params);
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
