// GitHub Action entrypoint. Thin on purpose: every decision worth testing
// lives in mode.ts / comment.ts / badge.ts, which have no @actions imports.
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  CurrentError,
  FigmaClient,
  HISTORY_DIR,
  HISTORY_FILE,
  TOKEN_ENV_VAR,
  closeRenderer,
  isDocsUrl,
  loadUsage,
  appendHistory,
  createLogger,
  entryFromReport,
  lastEntry,
  metricKeys,
  parseAnswers,
  parseConfig,
  readHistory,
  resolveUsageFile,
  scanRepo,
  type CurrentConfig,
  type CurrentReport,
} from '@usepolder/current-core';
import { BADGE_DIR, BADGE_JSON, BADGE_SVG, badgeJson, badgeMessage, badgeSvg } from './badge';
import { CURRENT_MARKER, findExistingComment, renderComment } from './comment';
import { selectMode, writesComment, writesHistory } from './mode';
import { createActionRenderer, defaultDeps } from './docs-runtime';
import { commitAndPush } from './persist';

const CONFIG_FILE = '.polder.yml';
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
        'Current shares this file with Drift and Reach — add a `current:` block with your components.',
    );
    return;
  }

  const config = parseConfig(rawConfig, CONFIG_FILE);
  const rawAnswers = readIfExists(path.join(workdir, ANSWERS_FILE));
  const answers = rawAnswers === null ? new Map() : parseAnswers(rawAnswers, ANSWERS_FILE);

  // Only a URL-mapped docs page needs a browser; a repo without one never
  // triggers the on-demand install.
  const logger = createLogger(verbose, (line) => core.debug(line));
  const renderDocs = config.components.some((c) => c.docs !== null && isDocsUrl(c.docs))
    ? createActionRenderer(logger, defaultDeps((m) => core.warning(m)))
    : null;

  const usageFile = resolveUsageFile(config, workdir);
  const usage = usageFile === null ? null : loadUsage(usageFile);
  if (usage !== null) logger.trace(`usage: ${usage.size} component(s) from ${usageFile}`);

  let report: CurrentReport;
  try {
    report = await scanRepo({
      repoRoot: workdir,
      config,
      answers,
      usage,
      figma: buildFigmaClient(config, verbose),
      renderDocs,
      logger,
    });
  } finally {
    await closeRenderer(renderDocs);
  }

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
    const currentHash = entryFromReport(report, metricKeys(config.metrics)).metricsHash;
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
      entryFromReport(report, metricKeys(config.metrics), github.context.sha),
    );
    const files = [...updateBadge(workdir, report), path.join(HISTORY_DIR, HISTORY_FILE)];
    core.info(`Current: history entry appended, badge refreshed (${files.join(', ')})`);
    core.setOutput('changed-files', files.join('\n'));

    // Everything above happened in the runner's checkout, which is thrown away
    // when the job ends. Without this the badge never appears, the trend log
    // stays empty and every PR delta reads "first run".
    const branch = github.context.ref.replace(/^refs\/heads\//, '');
    const outcome = commitAndPush({
      cwd: workdir,
      files,
      branch,
      message: `chore: update Current score to ${badgeMessage(report)} [skip ci]`,
    });
    switch (outcome.kind) {
      case 'pushed':
        core.info(`Current: committed and pushed to ${branch}`);
        break;
      case 'unchanged':
        core.info('Current: nothing to commit');
        break;
      case 'failed':
        // A warning, not a failure: the score is valid and the PR delta does
        // not depend on this run. But it must be loud, because a badge that
        // silently never updates is the bug this step exists to fix.
        core.warning(
          `Current: could not save the badge and history to ${branch} (${outcome.step}: ${outcome.detail}). ` +
            'Check that the workflow has `permissions: contents: write`, that actions/checkout kept its ' +
            'credentials, and that branch protection allows github-actions[bot] to push.',
        );
        break;
    }
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
