import * as fs from 'fs';
import * as path from 'path';
import {
  CurrentError,
  FigmaClient,
  TOKEN_ENV_VAR,
  appendHistory,
  createLogger,
  entryFromReport,
  parseAnswers,
  parseConfig,
  readHistory,
  scanRepo,
  type AnswerBook,
  type CurrentConfig,
  type CurrentReport,
} from '@usepolder/current-core';
import { figmaList } from './figma-list';
import { renderReport } from './render';
import { renderTerminal } from './terminal';

export const CONFIG_FILE = '.current.yml';
export const ANSWERS_FILE = '.current.answers.yml';
export const DEFAULT_REPORT_FILE = 'current-report.html';

export interface CliArgs {
  command: 'scan' | 'figma-list' | 'help' | 'version';
  dir: string;
  json: boolean;
  verbose: boolean;
  out: string | null;
  noReport: boolean;
  recordHistory: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    command: 'scan',
    dir: '.',
    json: false,
    verbose: false,
    out: null,
    noReport: false,
    recordHistory: false,
  };

  const rest = [...argv];
  if (rest[0] === 'figma' && rest[1] === 'list') {
    args.command = 'figma-list';
    rest.splice(0, 2);
  } else if (rest[0] === 'scan') {
    rest.splice(0, 1);
  }

  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--json') args.json = true;
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
    } else if (a.startsWith('-')) {
      throw new CurrentError(`Unknown flag: ${a}`);
    } else {
      args.dir = a;
    }
  }

  return args;
}

export const HELP = `current — component health for design systems

Usage
  npx @usepolder/current [dir] [options]
  npx @usepolder/current figma list [dir]

Options
  --json             Print the full report as JSON instead of a summary
  --out <file>       Where to write the HTML report (default ${DEFAULT_REPORT_FILE})
  --no-report        Skip writing the HTML report
  --record-history   Append this run's scores to .current/history.jsonl
  --verbose, -v      Trace every metric's resolution to stderr
  --help, -h         Show this message
  --version          Print the version

Setup
  1. Create ${CONFIG_FILE} with a components: block mapping each component
     to its code path and Figma node id.
  2. export ${TOKEN_ENV_VAR}=<your Figma personal access token>
  3. Run \`current figma list\` to get node ids for the mapping.

Answers for metrics that cannot be automated go in ${ANSWERS_FILE}.
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
        'Create one with a components: block, for example:\n\n' +
        '  figma:\n' +
        '    file_key: "your-figma-file-key"\n' +
        '  components:\n' +
        '    Button:\n' +
        '      code: "src/components/Button/Button.tsx"\n' +
        '      figma: "12:345"\n' +
        '      docs: "docs/button.mdx"\n',
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

export interface RunIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  version: string;
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
    if (figma === null && config.figmaFileKey !== null) {
      logger.trace(`$${TOKEN_ENV_VAR} not set — design metrics will report as unavailable`);
    }

    const report = await scanRepo({ repoRoot: dir, config, answers, figma, logger });

    if (args.recordHistory) {
      appendHistory(
        dir,
        entryFromReport(
          report,
          config.metrics.map((m) => m.id),
        ),
      );
      logger.trace('history: appended one entry to .current/history.jsonl');
    }

    let reportPath: string | null = null;
    if (!args.noReport && !args.json) {
      reportPath = path.resolve(dir, args.out ?? DEFAULT_REPORT_FILE);
      fs.writeFileSync(
        reportPath,
        renderReport({ report, history: readHistory(dir) }),
      );
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
