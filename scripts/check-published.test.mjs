import { describe, expect, it } from 'vitest';
import { assess, assessUnreleased } from './check-published.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-11-17T12:00:00Z');

const tag = (name, version, daysAgo) => ({
  name,
  version,
  taggedAt: daysAgo === null ? null : NOW - daysAgo * DAY,
});
const npm = (raw, version) => ({ raw, version });

describe('assess', () => {
  it('passes when npm matches the newest tag', () => {
    const r = assess({ repo: 'usepolder/drift', pkg: '@usepolder/drift', tag: tag('v1.1.4', [1, 1, 4], 0), npm: npm('1.1.4', [1, 1, 4]), now: NOW });
    expect(r.level).toBe('ok');
  });

  it('passes when npm is ahead, which happens between a publish and its tag', () => {
    const r = assess({ repo: 'r', pkg: 'p', tag: tag('v1.0.0', [1, 0, 0], 1), npm: npm('1.1.0', [1, 1, 0]), now: NOW });
    expect(r.level).toBe('ok');
  });

  // The real failure: Drift tagged 1.1.2 and the publish never happened,
  // and nothing said so for four and a half months.
  it('fails when a tag has been ahead of npm for months', () => {
    const r = assess({ repo: 'usepolder/drift', pkg: '@usepolder/drift', tag: tag('v1.1.2', [1, 1, 2], 136), npm: npm('1.1.1', [1, 1, 1]), now: NOW });
    expect(r.level).toBe('fail');
    expect(r.text).toContain('136 day(s) ago');
  });

  it('holds fire while a release is still propagating', () => {
    const r = assess({ repo: 'r', pkg: 'p', tag: tag('v2.0.0', [2, 0, 0], 0), npm: npm('1.9.9', [1, 9, 9]), now: NOW });
    expect(r.level).toBe('pending');
  });

  it('fails once the grace period has passed', () => {
    const r = assess({ repo: 'r', pkg: 'p', tag: tag('v2.0.0', [2, 0, 0], 1), npm: npm('1.9.9', [1, 9, 9]), now: NOW });
    expect(r.level).toBe('fail');
  });

  it('fails when a tagged package was never published at all', () => {
    const r = assess({ repo: 'r', pkg: 'p', tag: tag('v1.0.0', [1, 0, 0], 10), npm: null, now: NOW });
    expect(r.level).toBe('fail');
    expect(r.text).toContain('nothing is published');
  });

  it('compares numerically, not as strings', () => {
    const r = assess({ repo: 'r', pkg: 'p', tag: tag('v1.10.0', [1, 10, 0], 10), npm: npm('1.9.0', [1, 9, 0]), now: NOW });
    expect(r.level).toBe('fail');
  });

  it('skips a repository with no semver tags', () => {
    const r = assess({ repo: 'r', pkg: 'p', tag: null, npm: npm('1.0.0', [1, 0, 0]), now: NOW });
    expect(r.level).toBe('skip');
  });

  it('still reports when the tag date could not be read', () => {
    const r = assess({ repo: 'r', pkg: 'p', tag: tag('v2.0.0', [2, 0, 0], null), npm: npm('1.0.0', [1, 0, 0]), now: NOW });
    expect(r.level).toBe('fail');
    expect(r.text).toContain('unknown');
  });
});

describe('assessUnreleased', () => {
  const manifest = (raw, version, daysAgo) => ({
    raw,
    version,
    bumpedAt: daysAgo === null ? null : NOW - daysAgo * DAY,
  });

  // The exact state this script missed: `current init` and `current export`
  // merged to main, the version bumped, no tag cut, and npm still serving the
  // release that predated both. The tag check sees nothing wrong because the
  // newest tag IS published.
  it('fails when the default branch is ahead of npm with no tag for it', () => {
    const r = assessUnreleased({
      pkg: '@usepolder/current',
      manifest: manifest('0.2.0', [0, 2, 0], 4),
      npm: npm('0.1.1', [0, 1, 1]),
      tag: tag('v0.1.1', [0, 1, 1], 20),
      now: NOW,
    });
    expect(r.level).toBe('fail');
    expect(r.text).toContain('never tagged');
    expect(r.text).toContain('4 day(s)');
  });

  it('passes when the branch and npm agree', () => {
    const r = assessUnreleased({
      pkg: 'p',
      manifest: manifest('1.0.0', [1, 0, 0], 10),
      npm: npm('1.0.0', [1, 0, 0]),
      tag: tag('v1.0.0', [1, 0, 0], 10),
      now: NOW,
    });
    expect(r.level).toBe('ok');
  });

  // One problem, one line. If the tag exists, the tag check already reports
  // it; saying it twice makes the output look worse than reality.
  it('stays quiet when a tag exists, because assess already reports that', () => {
    const r = assessUnreleased({
      pkg: 'p',
      manifest: manifest('2.0.0', [2, 0, 0], 10),
      npm: npm('1.0.0', [1, 0, 0]),
      tag: tag('v2.0.0', [2, 0, 0], 10),
      now: NOW,
    });
    expect(r.level).toBe('ok');
  });

  it('holds fire while a release is still in flight', () => {
    const r = assessUnreleased({
      pkg: 'p',
      manifest: manifest('2.0.0', [2, 0, 0], 0),
      npm: npm('1.0.0', [1, 0, 0]),
      tag: tag('v1.0.0', [1, 0, 0], 30),
      now: NOW,
    });
    expect(r.level).toBe('pending');
  });

  it('says nothing about a package that was never published', () => {
    const r = assessUnreleased({
      pkg: 'p',
      manifest: manifest('1.0.0', [1, 0, 0], 10),
      npm: null,
      tag: null,
      now: NOW,
    });
    expect(r.level).toBe('skip');
  });

  it('says nothing when the manifest could not be read', () => {
    const r = assessUnreleased({
      pkg: 'p',
      manifest: null,
      npm: npm('1.0.0', [1, 0, 0]),
      tag: null,
      now: NOW,
    });
    expect(r.level).toBe('skip');
  });

  it('still reports when the bump date is unknown', () => {
    const r = assessUnreleased({
      pkg: 'p',
      manifest: manifest('2.0.0', [2, 0, 0], null),
      npm: npm('1.0.0', [1, 0, 0]),
      tag: tag('v1.0.0', [1, 0, 0], 30),
      now: NOW,
    });
    expect(r.level).toBe('fail');
    expect(r.text).toContain('unknown');
  });
});
