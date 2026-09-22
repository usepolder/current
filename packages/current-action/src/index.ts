// GitHub Action entrypoint. Thin on purpose: every decision worth testing
// lives in mode.ts / comment.ts / badge.ts, which have no @actions imports.
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  CurrentError,
  FigmaClient,
  TOKEN_ENV_VAR,
  appendHistory,
  createLogger,
  entryFromReport,
  lastEntry,
  parseAnswers,
  parseConfig,
  readHistory,
  scanRepo,
  type CurrentConfig,
  type CurrentReport,
} from '@usepolder/current-core';
import { BADGE_DIR, BADGE_JSON, BADGE_SVG, badgeJson, badgeSvg } from './badge';
import { CURRENT_MARKER, findExistingComment, renderComment } from './comment';
import { selectMode, writesComment, writesHistory } from './mode';

const CONFIG_FILE = '.current.yml';
const ANSWERS_FILE = '.current.answers.yml';

function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function buildFigmaClient(config: CurrentConfig, verbose: boolean): FigmaClient | null {
  const token = process.env[TOKEN_ENV_VAR];
  if (config.figmaFileKey === null) return null;
  if (token === undefined || token.trim() === '') {
    core.warning(
      `Current: $${TOKEN_ENV_VAR} is not set, so design metrics were not evaluated. ` +
        'Add it as a repository secret to score the Figma side.',
    );
    return null;
  }
  return new FigmaClient({
    token: token.trim(),
    fileKey: config.figmaFileKey,
    logger: createLogger(verbose, (line) => core.debug(line)),
  });
}

async function upsertComment(
  octokit: ReturnType<typeof github.getOctokit>,
  repo: { owner: string; repo: string },
  issueNumber: number,
  body: string,
): Promise<void> {
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const match = findExistingComment(existing, CURRENT_MARKER);
  if (match === null) {
    await octokit.rest.issues.createComment({ ...repo, issue_number: issueNumber, body });
  } else {
    await octokit.rest.issues.updateComment({ ...repo, comment_id: match.id, body });
  }
}

function updateBadge(repoRoot: string, report: CurrentReport): string[] {
  const dir = path.join(repoRoot, BADGE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, BADGE_JSON), badgeJson(report));
  fs.writeFileSync(path.join(dir, BADGE_SVG), badgeSvg(report));
  return [path.join(BADGE_DIR, BADGE_JSON), path.join(BADGE_DIR, BADGE_SVG)];
}

async function run(): Promise<void> {
  const workdir = path.resolve(core.getInput('working-directory') || '.');
  const verbose = core.getInput('verbose') === 'true';

  const rawConfig = readIfExists(path.join(workdir, CONFIG_FILE));
  if (rawConfig === null) {
    core.setFailed(
      `Current: no ${CONFIG_FILE} found in ${workdir}. ` +
        'Create one with a components: block mapping each component to its code path and Figma node id.',
    );
    return;
  }

  const config = parseConfig(rawConfig, CONFIG_FILE);
  const rawAnswers = readIfExists(path.join(workdir, ANSWERS_FILE));
  const answers = rawAnswers === null ? new Map() : parseAnswers(rawAnswers, ANSWERS_FILE);

  const report = await scanRepo({
    repoRoot: workdir,
    config,
    answers,
    figma: buildFigmaClient(config, verbose),
    logger: createLogger(verbose, (line) => core.debug(line)),
  });

  const t = report.totals;
  core.info(
    `Current: overall ${t.overall === null ? '—' : `${t.overall.toFixed(1)}%`} ` +
      `(code ${t.code ?? '—'}, design ${t.design ?? '—'}, docs ${t.documentation ?? '—'}) ` +
      `across ${report.components.length} component(s)`,
  );

  core.setOutput('score', t.overall ?? '');
  core.setOutput('code-score', t.code ?? '');
  core.setOutput('design-score', t.design ?? '');
  core.setOutput('docs-score', t.documentation ?? '');

  const pr = github.context.payload.pull_request;
  const mode = selectMode({
    eventName: github.context.eventName,
    ref: github.context.ref,
    defaultBranch: github.context.payload.repository?.default_branch as string | undefined,
    isPullRequest: pr !== undefined,
  });
  core.info(`Current: running in ${mode} mode`);

  // The delta compares against the last entry committed on the base branch.
  // PR runs read history; they never write it.
  const previous = lastEntry(readHistory(workdir));
  const baseScore = previous?.overall ?? null;
  if (previous !== null && previous.metricsHash !== undefined) {
    const currentHash = entryFromReport(
      report,
      config.metrics.map((m) => m.id),
    ).metricsHash;
    if (previous.metricsHash !== currentHash) {
      core.warning(
        'Current: the metric set changed since the last recorded scan, so the delta compares ' +
          'two different rubrics. Treat it as a reset, not a regression.',
      );
    }
  }

  const body = renderComment(
    report,
    baseScore,
    (pr?.base?.ref as string | undefined) ?? null,
  );

  try {
    await core.summary.addRaw(body, true).write();
  } catch {
    // Step summary is best-effort; absent outside a real runner.
  }

  if (writesComment(mode) && pr) {
    const token = core.getInput('github-token', { required: true });
    await upsertComment(github.getOctokit(token), github.context.repo, pr.number, body);
    core.info('Current: PR comment upserted');
  }

  if (writesHistory(mode)) {
    appendHistory(
      workdir,
      entryFromReport(
        report,
        config.metrics.map((m) => m.id),
        github.context.sha,
      ),
    );
    const files = updateBadge(workdir, report);
    core.info(`Current: history entry appended, badge refreshed (${files.join(', ')})`);
    core.setOutput('changed-files', files.join('\n'));
  }

  if (config.failUnder > 0 && t.overall !== null && t.overall < config.failUnder) {
    core.setFailed(
      `Overall score ${t.overall.toFixed(1)}% is below fail_under (${config.failUnder}%)`,
    );
  }
}

run().catch((err: Error) => {
  core.setFailed(err instanceof CurrentError ? err.message : (err.stack ?? err.message));
});
