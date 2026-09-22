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
export { createLogger, silentLogger, type Logger } from './logger';
export {
  scoreAnswers,
  quadrantFor,
  averageScore,
  round1,
  QUADRANT_LABELS,
  type AxisScore,
  type Quadrant,
} from './score';
export {
  CODE_CHECKS,
  collectCodePropNames,
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
export { checkDocSection, extractHeadings, type DocsFacts } from './docs-checks';
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
  metricsForCategory,
  type AnswerSource,
  type ComponentResult,
  type CurrentReport,
  type MetricResult,
} from './report';
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
