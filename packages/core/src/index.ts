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
  type CodeFacts,
} from './code-checks';
export {
  DESIGN_CHECKS,
  figmaPropertyNames,
  flatten,
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
  isDocsUrl,
  createPlaywrightRenderer,
  closeRenderer,
  RendererUnavailableError,
  RENDERER_INSTALL_HINT,
  type PageRenderer,
  type RendererOptions,
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
export { scanRepo, type ScanOptions } from './scan';
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
