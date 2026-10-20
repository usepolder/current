import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAndPush, runGit, type GitRunner } from '../src/persist';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8' }).trim();
}

/** A bare "origin" plus a clone of it, like a runner checkout on main. */
function setup(): { origin: string; work: string; clone: (name: string) => string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'current-persist-')));
  dirs.push(base);
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'ignore' });
  const clone = (name: string): string => {
    const dir = path.join(base, name);
    execFileSync('git', ['clone', origin, dir], { stdio: 'ignore' });
    return dir;
  };
  const seed = clone('seed');
  fs.writeFileSync(path.join(seed, 'README.md'), 'hi\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'push', 'origin', 'HEAD:refs/heads/main');
  return { origin, work: clone('work'), clone };
}

function write(root: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

const FILES = ['.current/badge.json', '.current/badge.svg', '.current/history.jsonl'];

describe('commitAndPush', () => {
  it('lands the badge and history on the remote branch', () => {
    const { origin, work } = setup();
    write(work, '.current/badge.json', '{}\n');
    write(work, '.current/badge.svg', '<svg/>\n');
    write(work, '.current/history.jsonl', '{"overall":80}\n');

    const r = commitAndPush({ cwd: work, files: FILES, branch: 'main', message: 'chore: update [skip ci]' });

    expect(r).toEqual({ kind: 'pushed', attempts: 1 });
    expect(git(origin, 'log', '-1', '--format=%s|%an', 'main')).toBe(
      'chore: update [skip ci]|github-actions[bot]',
    );
    expect(git(origin, 'ls-tree', '-r', '--name-only', 'main').split('\n')).toEqual(
      expect.arrayContaining(FILES),
    );
  });

  it('does nothing when the files are unchanged', () => {
    const { work } = setup();
    write(work, '.current/badge.json', '{}\n');
    commitAndPush({ cwd: work, files: ['.current/badge.json'], branch: 'main', message: 'm' });
    const before = git(work, 'rev-parse', 'HEAD');
    const r = commitAndPush({ cwd: work, files: ['.current/badge.json'], branch: 'main', message: 'm' });
    expect(r).toEqual({ kind: 'unchanged' });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('commits only the named files, not other changes in the tree', () => {
    const { origin, work } = setup();
    write(work, '.current/badge.json', '{}\n');
    write(work, 'stray.txt', 'left by an earlier step\n');
    git(work, 'add', 'stray.txt');

    commitAndPush({ cwd: work, files: ['.current/badge.json'], branch: 'main', message: 'm' });

    const tree = git(origin, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    expect(tree).toContain('.current/badge.json');
    expect(tree).not.toContain('stray.txt');
  });

  it('rebases and retries when the branch moved during the scan', () => {
    const { origin, work, clone } = setup();
    const other = clone('other');
    write(other, 'feature.txt', 'landed meanwhile\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'feature');
    git(other, 'push', 'origin', 'HEAD:refs/heads/main');

    write(work, '.current/history.jsonl', '{"overall":80}\n');
    const r = commitAndPush({ cwd: work, files: ['.current/history.jsonl'], branch: 'main', message: 'm' });

    expect(r).toEqual({ kind: 'pushed', attempts: 2 });
    const tree = git(origin, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    expect(tree).toEqual(expect.arrayContaining(['feature.txt', '.current/history.jsonl']));
  });

  it('reports a rejected push instead of forcing, and leaves the remote alone', () => {
    const { origin, work } = setup();
    const before = git(origin, 'rev-parse', 'main');
    // A branch-protection rule looks like this from the runner's side.
    fs.writeFileSync(
      path.join(origin, 'hooks', 'pre-receive'),
      '#!/bin/sh\necho "protected branch" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    write(work, '.current/badge.json', '{}\n');

    const r = commitAndPush({ cwd: work, files: ['.current/badge.json'], branch: 'main', message: 'm' });

    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.step).toBe('git push');
      expect(r.detail).toContain('protected branch');
    }
    expect(git(origin, 'rev-parse', 'main')).toBe(before);
  });

  it('aborts a conflicting rebase and reports it', () => {
    const { work, clone } = setup();
    const other = clone('other');
    write(other, '.current/history.jsonl', '{"from":"other"}\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'other run');
    git(other, 'push', 'origin', 'HEAD:refs/heads/main');

    write(work, '.current/history.jsonl', '{"from":"work"}\n');
    const r = commitAndPush({ cwd: work, files: ['.current/history.jsonl'], branch: 'main', message: 'm' });

    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.step).toBe('git pull --rebase');
    expect(git(work, 'status', '--porcelain')).toBe('');
  });

  it('never invokes a shell: a hostile branch name is just an argument', () => {
    const calls: string[][] = [];
    const spy: GitRunner = (args, cwd) => {
      calls.push(args);
      return runGit(args, cwd);
    };
    const { work } = setup();
    write(work, '.current/badge.json', '{}\n');
    commitAndPush({
      cwd: work,
      files: ['.current/badge.json'],
      branch: 'main; touch pwned',
      message: 'm',
      git: spy,
    });
    expect(fs.existsSync(path.join(work, 'pwned'))).toBe(false);
    expect(calls.some((a) => a.includes('HEAD:refs/heads/main; touch pwned'))).toBe(true);
  });
});
