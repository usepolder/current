import { spawnSync } from 'child_process';

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in `cwd`. Injectable so callers can trace it; tests use the real one. */
export type GitRunner = (args: string[], cwd: string) => GitResult;

export const runGit: GitRunner = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.error ? String(r.error.message) : (r.stderr ?? ''),
  };
};

/** The identity GitHub itself uses for its Actions bot. */
const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];

export type PersistOutcome =
  | { kind: 'pushed'; attempts: number }
  | { kind: 'unchanged' }
  | { kind: 'failed'; step: string; detail: string };

export interface PersistOptions {
  /** Working directory; git finds the repo from here. */
  cwd: string;
  /** Files to commit, relative to `cwd`. Nothing else is staged. */
  files: string[];
  /** The branch to push to — the default branch, on the push this runs for. */
  branch: string;
  message: string;
  git?: GitRunner;
}

const PUSH_ATTEMPTS = 3;
/** Git's wording when the remote branch has commits we lack — the only rejection a rebase can fix. */
const MOVED = /non-fast-forward|fetch first|tip of your current branch is behind/;

function fail(step: string, r: GitResult): PersistOutcome {
  // Keep every line: with a protected branch the reason is a `remote:` line
  // near the top, and the last lines are only git's generic "failed to push".
  const lines = (r.stderr || r.stdout).split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return { kind: 'failed', step, detail: lines.join(' | ').slice(0, 800) };
}

/**
 * Commit the given files and push them to `branch`.
 *
 * The Action writes the badge and history into the checkout; without this step
 * they die with the runner. Only the named files are committed, so a workflow
 * that left other changes in the tree is not swept into a bot commit.
 *
 * If the push is rejected because the branch moved while the scan ran, rebase
 * onto it and try again. It gives up rather than forcing: a rebase conflict in
 * history.jsonl means two writers raced, and picking a winner would silently
 * drop a trend point.
 */
export function commitAndPush(opts: PersistOptions): PersistOutcome {
  const git = opts.git ?? runGit;
  const { cwd, files, branch } = opts;

  const add = git(['add', '--', ...files], cwd);
  if (add.status !== 0) return fail('git add', add);

  const pending = git(['status', '--porcelain', '--', ...files], cwd);
  if (pending.status !== 0) return fail('git status', pending);
  if (pending.stdout.trim() === '') return { kind: 'unchanged' };

  const commit = git([...BOT, 'commit', '-m', opts.message, '--', ...files], cwd);
  if (commit.status !== 0) return fail('git commit', commit);

  const target = `HEAD:refs/heads/${branch}`;
  let lastPush: GitResult | null = null;
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
    lastPush = git(['push', 'origin', target], cwd);
    if (lastPush.status === 0) return { kind: 'pushed', attempts: attempt };
    if (attempt === PUSH_ATTEMPTS || !MOVED.test(lastPush.stderr)) break;

    const rebase = git([...BOT, 'pull', '--rebase', '--autostash', 'origin', branch], cwd);
    if (rebase.status !== 0) {
      git(['rebase', '--abort'], cwd);
      return fail('git pull --rebase', rebase);
    }
  }
  return fail('git push', lastPush!);
}
