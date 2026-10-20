import * as fs from 'fs';
import * as path from 'path';
import { resolveRepoPath, type CurrentConfig } from './config';
import { ConfigValidationError, CurrentError, ParseError } from './errors';

/** DS instances per component, as Reach counted them. */
export type UsageMap = ReadonlyMap<string, number>;

/** First Reach report schema that carries per-component `usage`. */
export const MIN_REACH_SCHEMA = 2;

/**
 * Read per-component usage out of a Reach JSON report.
 *
 * A v1 Reach report has no `usage` at all. That has to fail loudly rather than
 * read as "nothing is used": every component would get priority 0 and the
 * ranking would quietly be empty, which looks exactly like a healthy system.
 */
export function parseReachUsage(raw: string, source: string): UsageMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ParseError(source, `not valid JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigValidationError(`${source} is not a Reach report (expected a JSON object)`);
  }
  const report = parsed as Record<string, unknown>;
  if (report.tool !== 'reach') {
    throw new ConfigValidationError(
      `${source} is not a Reach report (its "tool" is ${JSON.stringify(report.tool ?? null)}). ` +
        'Produce one with `npx @usepolder/reach --json`.',
    );
  }
  if (typeof report.schemaVersion !== 'number' || report.schemaVersion < MIN_REACH_SCHEMA) {
    throw new ConfigValidationError(
      `${source} is a Reach report from before per-component usage (schema ` +
        `${String(report.schemaVersion)}; need ${MIN_REACH_SCHEMA} or later). Upgrade Reach and re-run it.`,
    );
  }
  const usage = report.usage;
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
    throw new ConfigValidationError(`${source} has no \`usage\` object`);
  }
  const map = new Map<string, number>();
  for (const [name, uses] of Object.entries(usage)) {
    if (typeof uses !== 'number' || !Number.isFinite(uses) || uses < 0) {
      throw new ConfigValidationError(
        `${source}: usage.${name} must be a non-negative number, got ${JSON.stringify(uses)}`,
      );
    }
    map.set(name, uses);
  }
  return map;
}

/** Read and parse a Reach report from an absolute path. */
export function loadUsage(file: string): UsageMap {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new CurrentError(
      code === 'ENOENT'
        ? `Usage file not found: ${file}. Run Reach first (\`npx @usepolder/reach --json > reach.json\`).`
        : `Cannot read the usage file ${file}: ${(err as Error).message}`,
    );
  }
  return parseReachUsage(raw, path.basename(file));
}

/**
 * The configured usage file, resolved and confined to the repo. Config comes
 * off PR branches, so it gets the same traversal guard as a `code:` path.
 */
export function resolveUsageFile(config: CurrentConfig, repoRoot: string): string | null {
  return config.usageFile === null
    ? null
    : resolveRepoPath(repoRoot, config.usageFile, 'current', 'usage');
}
