import * as path from 'path';
import * as yaml from 'js-yaml';
import { isDocsUrl } from './docs-source';
import { ConfigValidationError, ParseError, PathTraversalError } from './errors';
import { CODE_CHECKS } from './code-checks';
import { DESIGN_CHECKS } from './figma-checks';
import { CATEGORIES, DEFAULT_METRICS, type MetricCategory, type MetricDef } from './metrics';

/** Bump when a change to the `current:` block would break configs in the wild. */
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
  /** Repo-relative path to a Reach JSON report supplying per-component usage. */
  usageFile: string | null;
}

interface RawConfig {
  version?: unknown;
  figma?: { file_key?: unknown } | unknown;
  components?: unknown;
  metrics?: unknown;
  quadrant?: { threshold?: unknown } | unknown;
  min_confidence?: unknown;
  fail_under?: unknown;
  usage?: unknown;
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
    // A component with no mappings at all is legal: it is scored purely from
    // manual answers. That is how a team starts — the audit spreadsheet they
    // already keep, lifted into a file, before any automation is wired up.
    // If it has no answers either, it simply scores null and lands in the
    // report's "not enough data" list, which says so plainly.
    out.push({
      name,
      code: readOptionalString(value.code, name, 'code'),
      figma: readOptionalString(value.figma, name, 'figma'),
      docs: readOptionalString(value.docs, name, 'docs'),
    });
  }
  return out;
}

/** The checks a norm may name, and the one `params` key each takes (null: none). */
const CHECK_PARAM: Record<string, 'headings' | 'text' | null> = {
  ...Object.fromEntries(Object.keys(CODE_CHECKS).map((id) => [id, null])),
  ...Object.fromEntries(Object.keys(DESIGN_CHECKS).map((id) => [id, null])),
  'docs.section': 'headings',
  'code.contains': 'text',
  'code.forbids': 'text',
};

/** A check only sees its own source, so its id has to match the axis it scores. */
const CHECK_PREFIX: Record<MetricCategory, string> = {
  code: 'code.',
  design: 'design.',
  documentation: 'docs.',
};

const METRIC_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const OVERRIDE_KEYS = ['guideline', 'subcategory', 'note', 'check', 'params'];
const CUSTOM_KEYS = ['id', 'category', ...OVERRIDE_KEYS];

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigValidationError(`${where} must be a non-empty string`);
  }
  return value.trim();
}

function rejectUnknownKeys(entry: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) {
      throw new ConfigValidationError(
        `${where}: unknown key "${key}". Allowed: ${allowed.join(', ')}`,
      );
    }
  }
}

/** Validate a check id and its params against one norm's category. */
function parseCheck(
  entry: Record<string, unknown>,
  category: MetricCategory,
  where: string,
): Pick<MetricDef, 'check' | 'params'> {
  const check = entry.check === undefined || entry.check === null ? null : entry.check;
  if (check === null) {
    if (entry.params !== undefined) {
      throw new ConfigValidationError(`${where}: \`params\` needs a \`check\` to configure`);
    }
    return { check: null };
  }
  if (typeof check !== 'string' || !(check in CHECK_PARAM)) {
    throw new ConfigValidationError(
      `${where}: "${String(check)}" is not a known check. ` +
        `Known checks: ${Object.keys(CHECK_PARAM).join(', ')}. ` +
        'Leave `check` out to answer this norm by hand in the answers file.',
    );
  }
  if (!check.startsWith(CHECK_PREFIX[category])) {
    throw new ConfigValidationError(
      `${where}: check "${check}" cannot score a ${category} norm ` +
        `(${category} norms use ${CHECK_PREFIX[category]}* checks)`,
    );
  }

  const key = CHECK_PARAM[check];
  if (key === null) {
    if (entry.params !== undefined) {
      throw new ConfigValidationError(`${where}: check "${check}" takes no params`);
    }
    return { check };
  }
  const params = entry.params;
  const list = isPlainObject(params) ? params[key] : undefined;
  if (
    !isPlainObject(params) ||
    Object.keys(params).some((k) => k !== key) ||
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((x) => typeof x === 'string' && x.trim() !== '')
  ) {
    throw new ConfigValidationError(
      `${where}: check "${check}" needs params: { ${key}: [a non-empty list of strings] }`,
    );
  }
  return { check, params: { [key]: (list as string[]).map((x) => x.trim()) } };
}

function parseOverrides(raw: unknown, base: readonly MetricDef[]): Map<string, MetricDef> {
  const out = new Map<string, MetricDef>();
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError('`metrics.override` must be a mapping of metric id to changes');
  }
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const [id, entry] of Object.entries(raw)) {
    const where = `metrics.override.${id}`;
    const original = byId.get(id);
    if (original === undefined) {
      throw new ConfigValidationError(
        `${where}: "${id}" is not a built-in metric. Add a new one under \`metrics.custom\` instead.`,
      );
    }
    if (!isPlainObject(entry)) {
      throw new ConfigValidationError(`${where} must be a mapping of the fields to change`);
    }
    rejectUnknownKeys(entry, OVERRIDE_KEYS, where);
    // Changing what is checked is one decision, so `check` and `params` are
    // read together: params never silently carry over onto a different check.
    const merged: MetricDef = { ...original };
    if ('guideline' in entry) merged.guideline = requireString(entry.guideline, `${where}.guideline`);
    if ('subcategory' in entry) {
      merged.subcategory = requireString(entry.subcategory, `${where}.subcategory`);
    }
    if ('note' in entry) merged.note = requireString(entry.note, `${where}.note`);
    // Changing what is checked is one decision, so `check` and `params` are
    // read together: params never silently carry over onto a different check.
    // `params` alone re-tunes the check the norm already has.
    if ('check' in entry || 'params' in entry) {
      const source = 'check' in entry ? entry : { ...entry, check: original.check };
      const { params: _replaced, ...rest } = merged;
      out.set(id, { ...rest, ...parseCheck(source, original.category, where) });
      continue;
    }
    out.set(id, merged);
  }
  return out;
}

function parseCustom(raw: unknown, taken: Set<string>): MetricDef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError('`metrics.custom` must be a list of norms');
  }
  const out: MetricDef[] = [];
  raw.forEach((entry, i) => {
    const where = `metrics.custom[${i}]`;
    if (!isPlainObject(entry)) {
      throw new ConfigValidationError(`${where} must be a mapping with id, category and guideline`);
    }
    rejectUnknownKeys(entry, CUSTOM_KEYS, where);
    const id = requireString(entry.id, `${where}.id`);
    if (!METRIC_ID.test(id)) {
      throw new ConfigValidationError(
        `${where}.id: "${id}" must start with a letter and use only letters, digits, - and _ (max 32)`,
      );
    }
    if (taken.has(id)) {
      throw new ConfigValidationError(
        `${where}.id: "${id}" is already a metric id. ` +
          'Pick another, or change the built-in one under `metrics.override`.',
      );
    }
    taken.add(id);
    const category = entry.category;
    if (typeof category !== 'string' || !(CATEGORIES as readonly string[]).includes(category)) {
      throw new ConfigValidationError(
        `${where}.category must be one of ${CATEGORIES.join(', ')}`,
      );
    }
    const cat = category as MetricCategory;
    out.push({
      id,
      category: cat,
      subcategory:
        entry.subcategory === undefined ? 'Custom' : requireString(entry.subcategory, `${where}.subcategory`),
      guideline: requireString(entry.guideline, `${where}.guideline`),
      ...(entry.note === undefined ? {} : { note: requireString(entry.note, `${where}.note`) }),
      // No `check` means a person answers it, in the same answers file as the
      // built-in manual metrics. Not everything an organisation cares about
      // can be read out of source, and the tool does not pretend otherwise.
      ...parseCheck(entry, cat, where),
    });
  });
  return out;
}

/**
 * The rubric: built-in metrics, with the organisation's edits applied.
 *
 *   built-in ──▶ override (reword, re-tune)  ──▶ + custom ──▶ − disable ──▶ manual
 *
 * Everything here can be changed; the scoring arithmetic cannot. A rubric is
 * opinion, and each organisation's differs. A score whose formula could be
 * quietly tuned is not comparable to anything.
 */
function parseMetricSelection(raw: unknown): MetricDef[] {
  if (raw === undefined || raw === null) return [...DEFAULT_METRICS];
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError(
      '`metrics` must be an object with `disable` / `manual` / `override` / `custom` keys',
    );
  }
  rejectUnknownKeys(raw, ['disable', 'manual', 'override', 'custom'], 'metrics');

  const overrides = parseOverrides(raw.override, DEFAULT_METRICS);
  const all: MetricDef[] = [
    ...DEFAULT_METRICS.map((m) => overrides.get(m.id) ?? m),
    ...parseCustom(raw.custom, new Set(DEFAULT_METRICS.map((m) => m.id))),
  ];
  const known = new Set(all.map((m) => m.id));

  const disabled = new Set(requireIdList(raw.disable, 'metrics.disable', known));
  const manual = new Set(requireIdList(raw.manual, 'metrics.manual', known));
  for (const id of overrides.keys()) {
    if (disabled.has(id)) {
      throw new ConfigValidationError(
        `metrics: "${id}" is both disabled and overridden — the override would never run`,
      );
    }
  }

  return all
    .filter((m) => !disabled.has(m.id))
    .map((m) => {
      if (!manual.has(m.id)) return m;
      const { params: _unused, ...rest } = m;
      return { ...rest, check: null };
    });
}

function requireIdList(value: unknown, key: string, known: ReadonlySet<string>): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
    throw new ConfigValidationError(`${key} must be a list of metric ids`);
  }
  for (const id of value as string[]) {
    if (!known.has(id)) {
      throw new ConfigValidationError(
        `${key}: "${id}" is not a known metric id. Known ids: ${[...known].join(', ')}`,
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

/**
 * Current reads the same `.polder.yml` as Drift and Reach, under a `current:`
 * key — the way Reach namespaces its own settings under `reach:`.
 *
 * One toolchain, one config file. Keys belonging to the other tools
 * (`component_library`, `allowlist`, `reach:`, detection profiles) are ignored
 * here, so a repo already set up for Drift or Reach just gains a block.
 */
export function parseConfig(raw: string, configPath = '.polder.yml'): CurrentConfig {
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
    throw new ConfigValidationError(
      `${configPath} is empty — it needs a \`current:\` block with \`components:\` inside it`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigValidationError(`${configPath} must be a YAML object`);
  }

  const block = (parsed as Record<string, unknown>).current;
  if (block === undefined || block === null) {
    throw new ConfigValidationError(
      `${configPath} has no \`current:\` block.\n` +
        'Current shares this file with Drift and Reach; add its settings under `current:`:\n\n' +
        '  current:\n' +
        '    components:\n' +
        '      Button:\n' +
        '        code: "src/components/Button/Button.tsx"\n' +
        '        figma: "12:345"\n',
    );
  }
  if (!isPlainObject(block)) {
    throw new ConfigValidationError(`${configPath}: \`current\` must be a YAML object`);
  }

  const cfg = block as RawConfig;

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

  let usageFile: string | null = null;
  if (cfg.usage !== undefined && cfg.usage !== null) {
    if (typeof cfg.usage !== 'string' || cfg.usage.trim() === '') {
      throw new ConfigValidationError(
        '`usage` must be the path to a Reach JSON report, e.g. usage: "reach.json"',
      );
    }
    usageFile = cfg.usage.trim();
  }

  return {
    version,
    figmaFileKey,
    components,
    metrics,
    threshold,
    minConfidence,
    failUnder,
    usageFile,
  };
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
      // A hosted docs URL is not a path and must not be path-validated —
      // the traversal guard exists to stop a config reading arbitrary local
      // files, which a URL cannot do.
      docs:
        c.docs === null || isDocsUrl(c.docs)
          ? c.docs
          : resolveRepoPath(repoRoot, c.docs, c.name, 'docs'),
    });
  }
  return resolved;
}
