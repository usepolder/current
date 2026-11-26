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
  RETIRED_METRIC_IDS,
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
  collectCodePropNames,
  type CodeCheck,
  normalisePropName,
  type CheckResult,
  type CodeConnectFacts,
  type CodeFacts,
} from './code-checks';
// The public registry is the full set: source-reading and structural checks.
export {
  ALL_CODE_CHECKS as CODE_CHECKS,
  STRUCTURE_CHECKS,
  checkExtensible,
} from './structure-checks';
export { lowestMajor, reactMajorFor, type ProjectFacts } from './project';
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
  DEFAULT_INTERACTION_STATES,
  DEFAULT_MIN_BOUND,
  DESIGN_CHECKS,
  INTERACTION_STATES,
  MIN_BOUND_KEY,
  STATES_KEY,
  STATE_SYNONYMS,
  UNSHIPPED_NODE_TYPES,
  checkInteractionStates,
  checkPrototyping,
  figmaPropertyNames,
  flatten,
  flattenShipped,
  statesNamed,
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
  checkScreenReader,
  checkTextExpansion,
  checkContrast,
  requestedWidths,
  requestedDriver,
  REAL_SCREEN_READERS,
  SCREEN_READER_DRIVERS,
  DRIVER_KEY,
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
  type ScreenReaderProbe,
  type ScreenReaderStop,
  type ExpansionProbe,
  type ContrastProbe,
  type ContrastFinding,
  type RealScreenReaderName,
} from './live-checks';
export {
  isPreviewUrl,
  createPlaywrightProber,
  closeProber,
  probeLivePages,
  DEFAULT_PREVIEW_CONCURRENCY,
  ProberUnavailableError,
  PROBER_INSTALL_HINT,
  SCREEN_READER_INSTALL_HINT,
  CONTRAST_INSTALL_HINT,
  TEXT_EXPANSION_RATIO,
  parseAnnouncement,
  toClassicScript,
  type PageProber,
  type ProberOptions,
  type ProbedPage,
  type ProbeRequest,
  type ReaderReading,
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
