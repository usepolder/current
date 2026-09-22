import { describe, expect, it } from 'vitest';
import { selectMode, writesComment, writesHistory } from '../src/mode';

const base = { eventName: 'push', ref: 'refs/heads/main', defaultBranch: 'main', isPullRequest: false };

describe('selectMode', () => {
  it('is pull-request mode on a pull_request event with a PR payload', () => {
    expect(
      selectMode({ ...base, eventName: 'pull_request', isPullRequest: true }),
    ).toBe('pull-request');
  });

  it('handles pull_request_target the same way', () => {
    expect(
      selectMode({ ...base, eventName: 'pull_request_target', isPullRequest: true }),
    ).toBe('pull-request');
  });

  it('is inert on a pull_request event with no PR payload', () => {
    expect(selectMode({ ...base, eventName: 'pull_request', isPullRequest: false })).toBe('inert');
  });

  it('is push mode on a push to the default branch', () => {
    expect(selectMode(base)).toBe('push-default-branch');
  });

  it('is inert on a push to any other branch', () => {
    expect(selectMode({ ...base, ref: 'refs/heads/feature/x' })).toBe('inert');
  });

  it('is inert on a tag push', () => {
    expect(selectMode({ ...base, ref: 'refs/tags/v1.0.0' })).toBe('inert');
  });

  it('is inert when the default branch is unknown', () => {
    expect(selectMode({ ...base, defaultBranch: undefined })).toBe('inert');
  });

  it('honours a default branch that is not called main', () => {
    expect(
      selectMode({ ...base, ref: 'refs/heads/trunk', defaultBranch: 'trunk' }),
    ).toBe('push-default-branch');
    expect(
      selectMode({ ...base, ref: 'refs/heads/main', defaultBranch: 'trunk' }),
    ).toBe('inert');
  });

  it('is inert on schedule and workflow_dispatch', () => {
    expect(selectMode({ ...base, eventName: 'schedule' })).toBe('inert');
    expect(selectMode({ ...base, eventName: 'workflow_dispatch' })).toBe('inert');
  });
});

describe('what each mode is allowed to do', () => {
  it('writes history only on a push to the default branch', () => {
    expect(writesHistory('push-default-branch')).toBe(true);
    expect(writesHistory('pull-request')).toBe(false);
    expect(writesHistory('inert')).toBe(false);
  });

  it('never lets a PR run pollute the trend log', () => {
    // The whole point of the split: a trend log containing speculative branch
    // scores looks authoritative and is wrong.
    expect(writesHistory(selectMode({ ...base, eventName: 'pull_request', isPullRequest: true }))).toBe(
      false,
    );
  });

  it('comments only on a pull request', () => {
    expect(writesComment('pull-request')).toBe(true);
    expect(writesComment('push-default-branch')).toBe(false);
    expect(writesComment('inert')).toBe(false);
  });

  it('never both comments and writes history in the same run', () => {
    const modes = ['pull-request', 'push-default-branch', 'inert'] as const;
    for (const mode of modes) {
      expect(writesComment(mode) && writesHistory(mode)).toBe(false);
    }
  });
});
