export {
  CurrentError,
  ParseError,
  ConfigValidationError,
  PathTraversalError,
  NoComponentsError,
  FigmaError,
} from './errors';
export {
  DEFAULT_METRICS,
  DEFAULT_METRICS_BY_ID,
  CATEGORIES,
  metricKeys,
  type Answer,
  type MetricCategory,
  type MetricDef,
} from './metrics';
export {
  parseConfig,
  resolveComponentPaths,
  resolveRepoPath,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_THRESHOLD,
  DEFAULT_MIN_CONFIDENCE,
  type ComponentMapping,
  type CurrentConfig,
} from './config';
export { parseAnswers, coerceAnswer, lookupAnswer, type AnswerBook } from './answers';
export { parseSource, BABEL_OPTIONS, type Ast } from './parse';
export { collectRelatedFiles, type RelatedFile, type RelatedFiles } from './related-files';
export { createLogger, silentLogger, type Logger } from './logger';
export {
  scoreAnswers,
  quadrantFor,
  averageScore,
  averageConfidentScore,
  weakestAxis,
  usagePriority,
  round1,
  QUADRANT_LABELS,
  type AxisScore,
  type Quadrant,
} from './score';
export {
  CODE_CHECKS,
  collectCodePropNames,
  type CodeCheck,
  normalisePropName,
  type CheckResult,
  type CodeConnectFacts,
  type CodeFacts,
} from './code-checks';
export {
  CODE_CONNECT_CONFIG,
  extractCodeConnect,
  indexCodeConnect,
  mappingFor,
  normaliseNodeId,
  parseFigmaUrl,
  type CodeConnectIndex,
  type CodeConnectMapping,
} from './code-connect';
export {
  DEFAULT_MIN_BOUND,
  DESIGN_CHECKS,
  MIN_BOUND_KEY,
  figmaPropertyNames,
  flatten,
  type DesignCheck,
  type DesignFacts,
} from './figma-checks';
export {
  checkDocSection,
  extractHeadings,
  extractHtmlHeadings,
  headingMatches,
  type DocsFacts,
} from './docs-checks';
export {
  LIVE_CHECKS,
  checkKeyboardAccess,
  checkBreakpoints,
  checkStates,
  requestedWidths,
  DEFAULT_BREAKPOINT_WIDTHS,
  PROBE_VIEWPORT_HEIGHT,
  WIDTHS_KEY,
  type LiveCheck,
  type LiveFacts,
  type LiveProbe,
  type LiveAbsence,
  type FocusStop,
  type ViewportProbe,
  type StateProbe,
} from './live-checks';
export {
  isPreviewUrl,
  createPlaywrightProber,
  closeProber,
  probeLivePages,
  DEFAULT_PREVIEW_CONCURRENCY,
  ProberUnavailableError,
  PROBER_INSTALL_HINT,
  type PageProber,
  type ProberOptions,
  type ProbedPage,
} from './live-source';
export {
  isDocsUrl,
  createPlaywrightRenderer,
  closeRenderer,
  renderDocsPages,
  DEFAULT_DOCS_CONCURRENCY,
  RendererUnavailableError,
  RENDERER_INSTALL_HINT,
  type PageRenderer,
  type RendererOptions,
  type RenderedPage,
} from './docs-source';
export {
  FigmaClient,
  collectComponents,
  FIGMA_API,
  TOKEN_ENV_VAR,
  type FigmaNode,
  type FigmaFetcher,
  type FigmaComponentSummary,
} from './figma-client';
export {
  SCHEMA_VERSION,
  countQuadrants,
  axesNotFullyCovered,
  fixFirst,
  metricsForCategory,
  type AnswerSource,
  type AxisBasis,
  type ComponentResult,
  type CurrentReport,
  type MetricResult,
  type UsageBasis,
  type FixFirstEntry,
} from './report';
export {
  parseReachUsage,
  loadUsage,
  resolveUsageFile,
  MIN_REACH_SCHEMA,
  type UsageMap,
} from './usage';
export { scanRepo, NO_MANUAL_ANSWER, type ScanOptions } from './scan';
export {
  appendHistory,
  readHistory,
  entryFromReport,
  historyPath,
  lastEntry,
  metricsHash,
  HISTORY_DIR,
  HISTORY_FILE,
  type HistoryEntry,
} from './history';
