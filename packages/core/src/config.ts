import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigValidationError, ParseError, PathTraversalError } from './errors';
import { DEFAULT_METRICS, DEFAULT_METRICS_BY_ID, type MetricDef } from './metrics';

/** Bump when a change to `.current.yml` would break configs already in the wild. */
export const CURRENT_SCHEMA_VERSION = 1;

export const DEFAULT_THRESHOLD = 60;
export const DEFAULT_MIN_CONFIDENCE = 3;

export interface ComponentMapping {
  name: string;
  /** Repo-relative posix path to the component source, or null when unmapped. */
  code: string | null;
  /** Figma node id, e.g. "12:345", or null when unmapped. */
  figma: string | null;
  /** Repo-relative posix path to the component's doc file, or null. */
  docs: string | null;
}

export interface CurrentConfig {
  version: number;
  figmaFileKey: string | null;
  components: ComponentMapping[];
  metrics: MetricDef[];
  threshold: number;
  minConfidence: number;
  failUnder: number;
}

interface RawConfig {
  version?: unknown;
  figma?: { file_key?: unknown } | unknown;
  components?: unknown;
  metrics?: { disable?: unknown; manual?: unknown } | unknown;
  quadrant?: { threshold?: unknown } | unknown;
  min_confidence?: unknown;
  fail_under?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Resolve a repo-relative path and refuse anything that escapes the root.
 * The Action runs this config straight off PR branches, including forks, so
 * an unvalidated path is an arbitrary-file-read into a PR comment.
 */
export function resolveRepoPath(
  repoRoot: string,
  value: string,
  component: string,
  field: string,
): string {
  if (path.isAbsolute(value)) {
    throw new PathTraversalError(field, component, value);
  }
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, value);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathTraversalError(field, component, value);
  }
  return resolved;
}

function readOptionalString(
  value: unknown,
  component: string,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigValidationError(
      `components.${component}.${field} must be a non-empty string when present`,
    );
  }
  return value.trim();
}

function parseComponents(raw: unknown): ComponentMapping[] {
  if (raw === undefined || raw === null) return [];
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError(
      '`components` must be a mapping of component name to { code, figma, docs }',
    );
  }
  const out: ComponentMapping[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) {
      throw new ConfigValidationError(
        `components.${name} must be an object with code / figma / docs keys`,
      );
    }
    const mapping: ComponentMapping = {
      name,
      code: readOptionalString(value.code, name, 'code'),
      figma: readOptionalString(value.figma, name, 'figma'),
      docs: readOptionalString(value.docs, name, 'docs'),
    };
    if (mapping.code === null && mapping.figma === null) {
      throw new ConfigValidationError(
        `components.${name} needs at least one of \`code:\` or \`figma:\` — ` +
          'a component mapped to neither can never be scored.',
      );
    }
    out.push(mapping);
  }
  return out;
}

function parseMetricSelection(raw: unknown): MetricDef[] {
  let disabled: string[] = [];
  let forcedManual: string[] = [];

  if (raw !== undefined && raw !== null) {
    if (!isPlainObject(raw)) {
      throw new ConfigValidationError('`metrics` must be an object with `disable` / `manual` keys');
    }
    disabled = requireIdList(raw.disable, 'metrics.disable');
    forcedManual = requireIdList(raw.manual, 'metrics.manual');
  }

  const disabledSet = new Set(disabled);
  const manualSet = new Set(forcedManual);

  return DEFAULT_METRICS.filter((m) => !disabledSet.has(m.id)).map((m) =>
    manualSet.has(m.id) ? { ...m, check: null } : m,
  );
}

function requireIdList(value: unknown, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
    throw new ConfigValidationError(`${key} must be a list of metric ids`);
  }
  for (const id of value as string[]) {
    if (!DEFAULT_METRICS_BY_ID.has(id)) {
      throw new ConfigValidationError(
        `${key}: "${id}" is not a known metric id. ` +
          `Known ids: ${DEFAULT_METRICS.map((m) => m.id).join(', ')}`,
      );
    }
  }
  return value as string[];
}

function requireNumberInRange(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
    throw new ConfigValidationError(`${key} must be a number between ${min} and ${max}`);
  }
  return value;
}

export function parseConfig(raw: string, configPath = '.current.yml'): CurrentConfig {
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    const mark = (err as { mark?: { line: number; column: number } }).mark;
    throw new ParseError(
      configPath,
      (err as Error).message.split('\n')[0],
      mark ? mark.line + 1 : undefined,
      mark ? mark.column + 1 : undefined,
    );
  }

  if (parsed === undefined || parsed === null) {
    throw new ConfigValidationError(`${configPath} is empty — it needs at least a \`components:\` block`);
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigValidationError(`${configPath} must be a YAML object`);
  }

  const cfg = parsed as RawConfig;

  let version = CURRENT_SCHEMA_VERSION;
  if (cfg.version !== undefined && cfg.version !== null) {
    if (typeof cfg.version !== 'number' || !Number.isInteger(cfg.version) || cfg.version < 1) {
      throw new ConfigValidationError('`version` must be a positive integer');
    }
    if (cfg.version > CURRENT_SCHEMA_VERSION) {
      throw new ConfigValidationError(
        `${configPath} declares version ${cfg.version}, but this build of Current only understands ` +
          `up to version ${CURRENT_SCHEMA_VERSION}. Upgrade with \`npm i -g @usepolder/current\`.`,
      );
    }
    version = cfg.version;
  }

  let figmaFileKey: string | null = null;
  if (cfg.figma !== undefined && cfg.figma !== null) {
    if (!isPlainObject(cfg.figma)) {
      throw new ConfigValidationError('`figma` must be an object with a `file_key` key');
    }
    const key = cfg.figma.file_key;
    if (key !== undefined && key !== null) {
      if (typeof key !== 'string' || key.trim() === '') {
        throw new ConfigValidationError('figma.file_key must be a non-empty string');
      }
      figmaFileKey = key.trim();
    }
  }

  const components = parseComponents(cfg.components);
  const metrics = parseMetricSelection(cfg.metrics);

  let threshold = DEFAULT_THRESHOLD;
  if (isPlainObject(cfg.quadrant) && cfg.quadrant.threshold !== undefined) {
    threshold = requireNumberInRange(cfg.quadrant.threshold, 'quadrant.threshold', 0, 100);
  } else if (cfg.quadrant !== undefined && cfg.quadrant !== null && !isPlainObject(cfg.quadrant)) {
    throw new ConfigValidationError('`quadrant` must be an object with a `threshold` key');
  }

  const minConfidence =
    cfg.min_confidence === undefined || cfg.min_confidence === null
      ? DEFAULT_MIN_CONFIDENCE
      : requireNumberInRange(cfg.min_confidence, 'min_confidence', 0, 100);

  const failUnder =
    cfg.fail_under === undefined || cfg.fail_under === null
      ? 0
      : requireNumberInRange(cfg.fail_under, 'fail_under', 0, 100);

  return { version, figmaFileKey, components, metrics, threshold, minConfidence, failUnder };
}

/** Validate every mapped path against the repo root. Throws on the first escape. */
export function resolveComponentPaths(
  config: CurrentConfig,
  repoRoot: string,
): Map<string, { code: string | null; docs: string | null }> {
  const resolved = new Map<string, { code: string | null; docs: string | null }>();
  for (const c of config.components) {
    resolved.set(c.name, {
      code: c.code === null ? null : resolveRepoPath(repoRoot, c.code, c.name, 'code'),
      docs: c.docs === null ? null : resolveRepoPath(repoRoot, c.docs, c.name, 'docs'),
    });
  }
  return resolved;
}
