#!/usr/bin/env node
/**
 * Flags work that is tagged but never published.
 *
 * Drift went 4.5 months unable to publish because its npm token expired. No
 * workflow failed and no error was raised — releases simply stopped reaching
 * anyone, and two merged PRs sat unshipped until someone happened to ask. This
 * check exists for that failure mode: silent by construction, invisible until
 * you go looking.
 *
 * There are two ways work stops reaching people, and they look nothing alike:
 *
 *   tagged but never published  — a release was cut and the publish failed.
 *                                 This is what happened to Drift.
 *   merged but never tagged     — the work is on the default branch and
 *                                 nobody cut a release. This is what happened
 *                                 to `current init` and `current export`,
 *                                 which sat on main while npm served a
 *                                 version that predated both.
 *
 * The first is caught by comparing the highest semver tag against npm. The
 * second needs the version in the default branch's package.json, because
 * there is no tag to compare. An earlier version of this script watched only
 * the first and would have missed the second entirely.
 *
 * Needs no credentials: GitHub's API serves public repositories unauthenticated
 * and the npm registry is public. GITHUB_TOKEN is used when present only to
 * raise the rate limit.
 */

const FLEET = [
  {
    repo: 'usepolder/current',
    packages: [
      { name: '@usepolder/current', manifest: 'packages/current-cli/package.json' },
      { name: '@usepolder/current-core', manifest: 'packages/core/package.json' },
    ],
  },
  {
    repo: 'usepolder/drift',
    packages: [{ name: '@usepolder/drift', manifest: 'package.json' }],
  },
  {
    repo: 'usepolder/reach',
    packages: [
      { name: '@usepolder/reach', manifest: 'packages/reach-cli/package.json' },
      { name: '@usepolder/core', manifest: 'packages/core/package.json' },
    ],
  },
];

/**
 * A release is not atomic: the tag exists for a minute or two before npm
 * serves the new version. Without a grace period this check would cry wolf at
 * every release, and a check that cries wolf gets ignored — which is how the
 * original problem went unnoticed in the first place.
 */
const GRACE_MS = 6 * 60 * 60 * 1000;

const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Returns > 0 when a is newer than b. */
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'polder-release-audit', ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const ghHeaders = process.env.GITHUB_TOKEN
  ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
  : {};

/** The highest semver tag in a repository, with the date of its commit. */
export async function latestTag(repo, fetchJson = getJson) {
  const tags = await fetchJson(`https://api.github.com/repos/${repo}/tags?per_page=100`, ghHeaders);
  const versioned = tags
    .map((t) => ({ name: t.name, sha: t.commit?.sha, parsed: SEMVER_TAG.exec(t.name) }))
    .filter((t) => t.parsed !== null)
    .map((t) => ({ ...t, version: [Number(t.parsed[1]), Number(t.parsed[2]), Number(t.parsed[3])] }))
    .sort((a, b) => compare(b.version, a.version));

  if (versioned.length === 0) return null;
  const newest = versioned[0];

  // Only the newest tag's date is needed, so this costs one extra request.
  let taggedAt = null;
  if (newest.sha !== undefined) {
    const commit = await fetchJson(`https://api.github.com/repos/${repo}/commits/${newest.sha}`, ghHeaders);
    const iso = commit.commit?.committer?.date ?? commit.commit?.author?.date;
    if (iso) taggedAt = Date.parse(iso);
  }
  return { name: newest.name, version: newest.version, taggedAt };
}

export async function npmLatest(pkg, fetchJson = getJson) {
  const doc = await fetchJson(`https://registry.npmjs.org/${pkg}`);
  const latest = doc['dist-tags']?.latest;
  return latest === undefined ? null : { raw: latest, version: parse(latest) };
}

/** The pure part, so the comparison can be tested without the network. */
export function assess({ repo, pkg, tag, npm, now = Date.now(), graceMs = GRACE_MS }) {
  if (tag === null) return { level: 'skip', text: `${repo}: no semver tags` };
  if (npm === null || npm.version === null) {
    return { level: 'fail', text: `${pkg}: tagged ${tag.name} but nothing is published` };
  }
  const diff = compare(tag.version, npm.version);
  if (diff <= 0) return { level: 'ok', text: `${pkg}: ${npm.raw} (tag ${tag.name})` };

  const age = tag.taggedAt === null ? null : now - tag.taggedAt;
  if (age !== null && age < graceMs) {
    return { level: 'pending', text: `${pkg}: ${tag.name} tagged recently, npm still on ${npm.raw}` };
  }
  const days = age === null ? 'unknown' : Math.floor(age / 86400000);
  return {
    level: 'fail',
    text: `${pkg}: tag ${tag.name} is AHEAD of npm ${npm.raw} — tagged ${days} day(s) ago and never published`,
  };
}

/** The version in a manifest on the default branch, and when it last changed. */
export async function manifestVersion(repo, manifestPath, fetchJson = getJson) {
  let doc;
  try {
    doc = await fetchJson(
      `https://api.github.com/repos/${repo}/contents/${manifestPath}`,
      ghHeaders,
    );
  } catch {
    return null; // manifest moved or renamed: say nothing rather than guess
  }
  const raw = Buffer.from(doc.content ?? '', 'base64').toString('utf8');
  let version;
  try {
    version = JSON.parse(raw).version;
  } catch {
    return null;
  }
  const parsed = parse(String(version ?? ''));
  if (parsed === null) return null;

  let bumpedAt = null;
  try {
    const commits = await fetchJson(
      `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(manifestPath)}&per_page=1`,
      ghHeaders,
    );
    const iso = commits[0]?.commit?.committer?.date ?? commits[0]?.commit?.author?.date;
    if (iso) bumpedAt = Date.parse(iso);
  } catch {
    // leave bumpedAt null; assess reports it as unknown rather than failing
  }
  return { raw: String(version), version: parsed, bumpedAt };
}

/**
 * The second silence: the default branch is ahead of npm and no tag exists for
 * it, so nobody cut a release at all.
 *
 * Only reported when there is no matching tag. If the tag exists, this is the
 * tagged-but-unpublished case and `assess` already says so — reporting both
 * would double-count one problem.
 */
export function assessUnreleased({
  pkg,
  manifest,
  npm,
  tag,
  now = Date.now(),
  graceMs = GRACE_MS,
}) {
  if (manifest === null) return { level: 'skip', text: `${pkg}: no readable manifest` };
  if (npm === null || npm.version === null) return { level: 'skip', text: `${pkg}: not published` };
  if (compare(manifest.version, npm.version) <= 0) return { level: 'ok', text: '' };

  // A tag for this exact version means the release was cut; that is assess's
  // problem, not this one.
  if (tag !== null && compare(tag.version, manifest.version) >= 0) {
    return { level: 'ok', text: '' };
  }

  const age = manifest.bumpedAt === null ? null : now - manifest.bumpedAt;
  if (age !== null && age < graceMs) {
    return { level: 'pending', text: `${pkg}: ${manifest.raw} on the default branch, npm on ${npm.raw}` };
  }
  const days = age === null ? 'unknown' : Math.floor(age / 86400000);
  return {
    level: 'fail',
    text: `${pkg}: ${manifest.raw} is on the default branch but npm has ${npm.raw} — bumped ${days} day(s) ago and never tagged`,
  };
}

async function main() {
  const results = [];
  for (const { repo, packages } of FLEET) {
    const tag = await latestTag(repo);
    for (const { name, manifest: manifestPath } of packages) {
      const npm = await npmLatest(name);
      results.push(assess({ repo, pkg: name, tag, npm }));

      const manifest = await manifestVersion(repo, manifestPath);
      const unreleased = assessUnreleased({ pkg: name, manifest, npm, tag });
      if (unreleased.level !== 'ok') results.push(unreleased);
    }
  }

  const symbol = { ok: 'ok  ', pending: '... ', skip: '--  ', fail: 'FAIL' };
  for (const r of results) console.log(`${symbol[r.level]} ${r.text}`);

  const failures = results.filter((r) => r.level === 'fail');
  if (failures.length > 0) {
    console.log('');
    for (const f of failures) console.log(`::error::${f.text}`);
    console.log(`\n${failures.length} package(s) have work that never reached npm.`);
    process.exit(1);
  }
  console.log('\nEvery repository’s newest tag is published.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`release audit failed: ${err.message}`);
    process.exit(2);
  });
}
