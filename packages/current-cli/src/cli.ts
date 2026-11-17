import * as fs from 'fs';
import * as path from 'path';
import {
  CurrentError,
  FigmaClient,
  collectComponents,
  TOKEN_ENV_VAR,
  appendHistory,
  closeRenderer,
  createLogger,
  createPlaywrightRenderer,
  entryFromReport,
  isDocsUrl,
  loadUsage,
  metricKeys,
  parseAnswers,
  parseConfig,
  readHistory,
  resolveUsageFile,
  scanRepo,
  type AnswerBook,
  type FigmaComponentSummary,
  type CurrentConfig,
  type CurrentReport,
} from '@usepolder/current-core';
import { figmaList } from './figma-list';
import { buildExportRows, mergeAnswers, readImportRows, toCsv } from './answers-csv';
import {
  discoverComponents,
  mergeIntoConfig,
  planComponents,
  renderCurrentBlock,
  writeAtomic,
} from './init';
import { renderReport } from './render';
import { renderTerminal } from './terminal';

export const CONFIG_FILE = '.polder.yml';
export const ANSWERS_FILE = '.polder.answers.yml';
export const DEFAULT_REPORT_FILE = 'current-report.html';
export const DEFAULT_ANSWERS_CSV = 'current-answers.csv';

export interface CliArgs {
  command: 'scan' | 'figma-list' | 'init' | 'export' | 'import' | 'help' | 'version';
  dir: string;
  json: boolean;
  verbose: boolean;
  out: string | null;
  usage: string | null;
  noReport: boolean;
  recordHistory: boolean;
  /** `init --figma <key>`: the Figma file to match component names against. */
  figmaFileKey: string | null;
  /** `export`/`import`: the CSV path. Defaults to current-answers.csv. */
  csvFile: string | null;
}

/**
 * Names that are never read as a directory.
 *
 * `scan`, `figma`, `init`, `export` and `import` are implemented; `answer`
 * is not. They
 * are reserved anyway, because the alternative is worse in both directions:
 * `current init` used to fall through to the positional argument and silently
 * scan a directory called `init`, and once the command does land, the same
 * invocation would quietly start meaning something else. Reserving the name
 * up front makes that impossible and makes the gap visible today.
 *
 * A real directory with one of these names is still reachable: `current -- init`.
 */
const IMPLEMENTED_COMMANDS = ['scan', 'figma', 'init', 'export', 'import'] as const;
export const PLANNED_COMMANDS: readonly string[] = ['answer'];

export const RESERVED_COMMANDS: readonly string[] = [
  ...IMPLEMENTED_COMMANDS,
  ...PLANNED_COMMANDS,
];

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    command: 'scan',
    dir: '.',
    json: false,
    verbose: false,
    out: null,
    usage: null,
    noReport: false,
    recordHistory: false,
    figmaFileKey: null,
    csvFile: null,
  };

  const rest = [...argv];
  if (rest[0] === 'figma') {
    if (rest[1] !== 'list') {
      // `figma` on its own used to become the directory to scan.
      throw new CurrentError(
        rest[1] === undefined
          ? '`figma` needs a subcommand. The only one is `figma list`.'
          : `Unknown figma subcommand: ${rest[1]}. The only one is \`figma list\`.`,
      );
    }
    args.command = 'figma-list';
    rest.splice(0, 2);
  } else if (rest[0] === 'scan') {
    rest.splice(0, 1);
  } else if (rest[0] === 'init') {
    args.command = 'init';
    rest.splice(0, 1);
  } else if (rest[0] === 'export' || rest[0] === 'import') {
    args.command = rest[0];
    rest.splice(0, 1);
  } else if (rest[0] !== undefined && PLANNED_COMMANDS.includes(rest[0])) {
    throw new CurrentError(
      `\`${rest[0]}\` is not a command in this version of current.\n` +
        `To scan a directory named ${rest[0]}, write: current -- ${rest[0]}`,
    );
  }

  // Everything after a bare `--` is positional, so a directory can be named
  // after a flag or a reserved command.
  let positionalsOnly = false;
  let positionals = 0;

  const takePositional = (a: string): void => {
    positionals += 1;
    if (positionals > 1) {
      throw new CurrentError(
        `Unexpected extra argument: ${a}. current scans one directory at a time.`,
      );
    }
    args.dir = a;
  };

  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (positionalsOnly) {
      takePositional(a);
    } else if (a === '--') {
      positionalsOnly = true;
    } else if (a === '--json') args.json = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--no-report') args.noReport = true;
    else if (a === '--record-history') args.recordHistory = true;
    else if (a === '--help' || a === '-h') args.command = 'help';
    else if (a === '--version') args.command = 'version';
    else if (a === '--out') {
      const value = rest[i + 1];
      if (value === undefined) throw new CurrentError('--out requires a file path');
      args.out = value;
      i += 1;
    } else if (a === '--file') {
      const value = rest[i + 1];
      if (value === undefined) throw new CurrentError('--file requires a CSV path');
      args.csvFile = value;
      i += 1;
    } else if (a === '--figma') {
      const value = rest[i + 1];
      if (value === undefined) throw new CurrentError('--figma requires a Figma file key');
      args.figmaFileKey = value;
      i += 1;
    } else if (a === '--usage') {
      const value = rest[i + 1];
      if (value === undefined) throw new CurrentError('--usage requires a Reach JSON report path');
      args.usage = value;
      i += 1;
    } else if (a.startsWith('-')) {
      throw new CurrentError(`Unknown flag: ${a}`);
    } else {
      takePositional(a);
    }
  }

  return args;
}

export const HELP = `current — component health for design systems

Usage
  npx @usepolder/current [dir] [options]
  npx @usepolder/current scan [dir] [options]
  npx @usepolder/current init [dir] [--figma <file-key>]
  npx @usepolder/current export [dir] [--file <csv>]
  npx @usepolder/current import [dir] [--file <csv>]
  npx @usepolder/current figma list [dir]

Options
  --json             Print the full report as JSON instead of a summary
  --figma <key>      init only: match component names against this Figma file
  --file <csv>       export/import only: the CSV path (default ${DEFAULT_ANSWERS_CSV})
  --out <file>       Where to write the HTML report (default ${DEFAULT_REPORT_FILE})
  --usage <file>     Reach JSON report; ranks what to fix first by how much each component is used
                     (or set \`usage:\` under \`current:\` in ${CONFIG_FILE})
  --no-report        Skip writing the HTML report
  --record-history   Append this run's scores to .current/history.jsonl
  --verbose, -v      Trace every metric's resolution to stderr
  --help, -h         Show this message
  --version          Print the version

Reserved names
  ${RESERVED_COMMANDS.join(', ')} are read as commands, never as a directory.
  answer is reserved but not implemented yet. To scan a directory with one of
  those names, put it after --:  current -- init

Setup
  1. export ${TOKEN_ENV_VAR}=<your Figma personal access token>
  2. Run \`current init --figma <file-key>\` to scaffold ${CONFIG_FILE} from
     your source and that Figma file. It never overwrites an existing
     current: block, and leaves uncertain matches commented out for you to
     confirm. ${CONFIG_FILE} is shared with Drift and Reach.
  3. Review it, then run \`current\`.

Answers for metrics that cannot be automated go in ${ANSWERS_FILE}.
\`current export\` writes those questions to a CSV with the automated evidence
beside each one, so the review can be split across the people who can actually
answer it; \`current import\` folds the filled-in file back. An empty answer
cell stays unanswered rather than becoming N/A.
Nothing is sent anywhere except the Figma API you configure.`;

function readFileIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

export function loadConfig(dir: string): { config: CurrentConfig; configPath: string } {
  const configPath = path.join(dir, CONFIG_FILE);
  const raw = readFileIfExists(configPath);
  if (raw === null) {
    throw new CurrentError(
      `No ${CONFIG_FILE} found in ${dir}.\n` +
        'Current shares this file with Polder Drift and Reach. Create one with a\n' +
        '`current:` block, for example:\n\n' +
        '  current:\n' +
        '    figma:\n' +
        '      file_key: "your-figma-file-key"\n' +
        '    components:\n' +
        '      Button:\n' +
        '        code: "src/components/Button/Button.tsx"\n' +
        '        figma: "12:345"\n' +
        '        docs: "docs/button.mdx"\n',
    );
  }
  return { config: parseConfig(raw, CONFIG_FILE), configPath };
}

export function loadAnswers(dir: string): AnswerBook {
  const raw = readFileIfExists(path.join(dir, ANSWERS_FILE));
  return raw === null ? new Map() : parseAnswers(raw, ANSWERS_FILE);
}

function buildFigmaClient(
  config: CurrentConfig,
  verbose: boolean,
  env: NodeJS.ProcessEnv,
): FigmaClient | null {
  const token = env[TOKEN_ENV_VAR];
  if (config.figmaFileKey === null || token === undefined || token.trim() === '') return null;
  return new FigmaClient({
    token: token.trim(),
    fileKey: config.figmaFileKey,
    logger: createLogger(verbose),
  });
}

/**
 * Name things on one summary line without turning it into a wall.
 *
 * Five, because the prefix this is appended to already costs about 50
 * columns: ten names ran past 180 and wrapped two or three times in a normal
 * terminal, which puts the "and N more" tail mid-wrap and makes the list
 * unscannable just as it gets interesting. The config holds the full list
 * either way, so the line points there for the tail.
 */
function nameList(names: readonly string[], limit = 5): string {
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`;
}

/**
 * Scaffold the `current:` block from what is on disk, and from Figma when a
 * file key is given.
 *
 * Everything is computed before anything is written, so a Figma walk that
 * fails partway leaves no half-built config behind.
 */
async function runInit(
  dir: string,
  args: CliArgs,
  io: RunIo,
  logger: ReturnType<typeof createLogger>,
): Promise<string> {
  const configPath = path.join(dir, CONFIG_FILE);
  const existing = readFileIfExists(configPath);

  // Refuse an existing current: block before doing any work, so the refusal is
  // instant rather than arriving after a minute of Figma paging.
  if (existing !== null) mergeIntoConfig(existing, '');

  const code = discoverComponents(dir);
  logger.trace(`init: ${code.length} component source file(s) found`);

  let figma: FigmaComponentSummary[] = [];
  if (args.figmaFileKey !== null) {
    const token = io.env[TOKEN_ENV_VAR];
    if (token === undefined || token.trim() === '') {
      throw new CurrentError(
        `$${TOKEN_ENV_VAR} is not set, so --figma has nothing to authenticate with.\n` +
          `  export ${TOKEN_ENV_VAR}=figd_...`,
      );
    }
    const client = new FigmaClient({ token: token.trim(), fileKey: args.figmaFileKey, logger });
    figma = collectComponents(await client.fetchFile());
    logger.trace(`init: ${figma.length} Figma component(s) found`);
  }

  const { components: plan, figmaOnly } = planComponents(code, figma);
  const block = renderCurrentBlock(plan, args.figmaFileKey, figmaOnly);
  writeAtomic(configPath, mergeIntoConfig(existing, block));

  const exact = plan.filter((c) => c.match === 'exact').length;
  const unsure = plan.filter((c) => c.match === 'fuzzy' || c.match === 'ambiguous').length;
  const unmatched = plan.filter((c) => c.match === 'none').length;

  const where = displayPath(configPath, io.cwd ?? process.cwd());
  const lines = [
    `${existing === null ? 'Wrote' : 'Added a current: block to'} ${where}`,
    `  ${plan.length} component${plan.length === 1 ? '' : 's'} from source`,
  ];
  if (args.figmaFileKey === null) {
    lines.push('  no Figma file given - add figma.file_key, then run `current figma list`');
  } else {
    lines.push(`  ${exact} mapped to Figma`);
    if (unsure > 0) {
      lines.push(`  ${unsure} left commented out: confirm the name before trusting them`);
    }
    if (unmatched > 0) lines.push(`  ${unmatched} with no Figma match`);
    // The gap in the other direction, which init used to omit entirely: a
    // component that looks finished in Figma and has no code behind it is the
    // critical corner of the quadrant, so it is named here, not just counted.
    if (figmaOnly.length > 0) {
      lines.push(
        `  ${figmaOnly.length} Figma component${figmaOnly.length === 1 ? '' : 's'} with no component source: ${nameList(figmaOnly.map((f) => f.name))}`,
      );
    }
  }
  lines.push('', 'Review it, then run `current` to score.');
  return lines.join('\n');
}

/** Where the CSV lives, relative to where the user is standing. */
function csvPath(args: CliArgs, io: RunIo): string {
  const cwd = io.cwd ?? process.cwd();
  return path.resolve(cwd, args.csvFile ?? DEFAULT_ANSWERS_CSV);
}

/**
 * Fold a filled-in CSV back into the answers file.
 *
 * Deliberately does not scan: importing must work after the config has moved
 * on, and a scan would fail on an unrelated problem while someone is trying
 * to save a day of review work.
 */
function runImport(dir: string, args: CliArgs, io: RunIo): string {
  const source = csvPath(args, io);
  const raw = readFileIfExists(source);
  if (raw === null) {
    throw new CurrentError(
      `No CSV at ${displayPath(source, io.cwd ?? process.cwd())}.\n` +
        'Run `current export` first, fill in the answer column, then import it.',
    );
  }

  const rows = readImportRows(raw);
  if (rows.length === 0) {
    return `${displayPath(source, io.cwd ?? process.cwd())} has no filled-in answers yet. Nothing changed.`;
  }

  const answersPath = path.join(dir, ANSWERS_FILE);
  const merged = mergeAnswers(readFileIfExists(answersPath), rows);
  writeAtomic(answersPath, merged.text);

  const parts = [`${merged.added} added`];
  if (merged.changed > 0) parts.push(`${merged.changed} changed`);
  if (merged.unchanged > 0) parts.push(`${merged.unchanged} already matched`);
  return `Wrote ${displayPath(answersPath, io.cwd ?? process.cwd())}\n  ${parts.join(', ')}`;
}

export interface RunIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  version: string;
  /** Where the user is standing. Defaults to process.cwd(); injected by tests. */
  cwd?: string;
}

export async function run(argv: readonly string[], io: RunIo): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 2;
  }

  if (args.command === 'help') {
    io.stdout(`${HELP}\n`);
    return 0;
  }
  if (args.command === 'version') {
    io.stdout(`${io.version}\n`);
    return 0;
  }

  const dir = path.resolve(args.dir);
  const logger = createLogger(args.verbose, (line) => io.stderr(`${line}\n`));

  try {
    if (args.command === 'init') {
      io.stdout(`${await runInit(dir, args, io, logger)}\n`);
      return 0;
    }

    if (args.command === 'import') {
      io.stdout(`${runImport(dir, args, io)}\n`);
      return 0;
    }

    const { config } = loadConfig(dir);

    if (args.command === 'figma-list') {
      if (config.figmaFileKey === null) {
        throw new CurrentError(
          `${CONFIG_FILE} has no figma.file_key, so there is no file to list components from.`,
        );
      }
      const token = io.env[TOKEN_ENV_VAR];
      if (token === undefined || token.trim() === '') {
        throw new CurrentError(
          `$${TOKEN_ENV_VAR} is not set. Create a Figma personal access token and export it:\n` +
            `  export ${TOKEN_ENV_VAR}=figd_...`,
        );
      }
      const client = new FigmaClient({
        token: token.trim(),
        fileKey: config.figmaFileKey,
        logger,
      });
      io.stdout(`${await figmaList(client)}\n`);
      return 0;
    }

    const answers = loadAnswers(dir);
    const figma = buildFigmaClient(config, args.verbose, io.env);
    // Only spin up a renderer if some component actually points at a URL.
    const needsRenderer = config.components.some((c) => c.docs !== null && isDocsUrl(c.docs));
    const renderDocs = needsRenderer ? createPlaywrightRenderer({ logger }) : null;
    if (figma === null && config.figmaFileKey !== null) {
      logger.trace(`$${TOKEN_ENV_VAR} not set — design metrics will report as unavailable`);
    }

    // An explicit --usage is relative to where the user is standing, like
    // --out. The config's `usage:` is repo-relative and traversal-guarded.
    const usageFile =
      args.usage !== null
        ? path.resolve(io.cwd ?? process.cwd(), args.usage)
        : resolveUsageFile(config, dir);
    const usage = usageFile === null ? null : loadUsage(usageFile);
    if (usage !== null) logger.trace(`usage: ${usage.size} component(s) from ${usageFile}`);

    let report;
    try {
      report = await scanRepo({ repoRoot: dir, config, answers, figma, renderDocs, usage, logger });
    } finally {
      // Always shut the browser down, including on a failed scan, so a crash
      // never strands a headless chromium on the user's machine.
      await closeRenderer(renderDocs);
    }

    if (args.recordHistory) {
      appendHistory(
        dir,
        entryFromReport(report, metricKeys(config.metrics)),
      );
      logger.trace('history: appended one entry to .current/history.jsonl');
    }

    let reportPath: string | null = null;
    // `export` scans only to collect the questions; writing an HTML report as
    // a side effect would be a surprise.
    if (!args.noReport && !args.json && args.command !== 'export') {
      reportPath = resolveReportPath(dir, args.out, io.cwd ?? process.cwd());
      const html = renderReport({ report, history: readHistory(dir) });
      try {
        fs.writeFileSync(reportPath, html);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        throw new CurrentError(
          code === 'ENOENT'
            ? `Cannot write the report to ${reportPath}: that directory does not exist.`
            : code === 'EACCES'
              ? `Cannot write the report to ${reportPath}: permission denied.`
              : `Cannot write the report to ${reportPath}: ${(err as Error).message}`,
        );
      }
    }

    if (args.command === 'export') {
      const target = csvPath(args, io);
      const rows = buildExportRows(report);
      writeAtomic(target, toCsv(rows));
      const where = displayPath(target, io.cwd ?? process.cwd());
      if (rows.length === 0) {
        io.stdout(`Nothing left for a person to answer. Wrote an empty ${where}.\n`);
        return 0;
      }
      const components = new Set(rows.map((r) => r.component)).size;
      io.stdout(
        `Wrote ${where}\n` +
          `  ${rows.length} question${rows.length === 1 ? '' : 's'} across ${components} component${components === 1 ? '' : 's'}\n` +
          '  Fill in the answer column with Yes, No or N/A, then: current import\n',
      );
      return 0;
    }

    if (args.json) {
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      io.stdout(`${renderTerminal(report, displayPath(reportPath))}\n`);
    }

    return failUnderExit(report, config, io);
  } catch (err) {
    if (err instanceof CurrentError) {
      io.stderr(`${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}

/**
 * An explicit `--out` is relative to where the user is standing, not to the
 * directory being scanned — `current ../ds --out report.html` should put the
 * report next to them, not inside someone else's repo. The default filename
 * stays in the scanned repo, which is what the README's .gitignore advice
 * assumes.
 */
export function resolveReportPath(
  scanDir: string,
  out: string | null,
  cwd: string,
): string {
  return out === null ? path.resolve(scanDir, DEFAULT_REPORT_FILE) : path.resolve(cwd, out);
}

/**
 * Show whichever of the relative and absolute path is actually readable.
 * Scanning a directory far from the cwd produced paths like
 * `../../../../../../tmp/ds/current-report.html`, which helps nobody.
 */
export function displayPath(target: string | null, cwd: string = process.cwd()): string | null {
  if (target === null) return null;
  const relative = path.relative(cwd, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return target;
  return relative;
}

function failUnderExit(report: CurrentReport, config: CurrentConfig, io: RunIo): number {
  if (config.failUnder <= 0) return 0;
  const overall = report.totals.overall;
  if (overall === null || overall >= config.failUnder) return 0;
  io.stderr(
    `Overall score ${overall.toFixed(1)}% is below fail_under (${config.failUnder}%)\n`,
  );
  return 1;
}
