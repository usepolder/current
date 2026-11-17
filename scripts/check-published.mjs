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
 * For each repository it takes the highest semver tag and compares it with the
 * `latest` version of every package that repository publishes. A tag ahead of
 * npm means a release was cut that never arrived.
 *
 * Needs no credentials: GitHub's API serves public repositories unauthenticated
 * and the npm registry is public. GITHUB_TOKEN is used when present only to
 * raise the rate limit.
 */

const FLEET = [
  { repo: 'usepolder/current', packages: ['@usepolder/current', '@usepolder/current-core'] },
  { repo: 'usepolder/drift', packages: ['@usepolder/drift'] },
  { repo: 'usepolder/reach', packages: ['@usepolder/reach', '@usepolder/core'] },
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

async function main() {
  const results = [];
  for (const { repo, packages } of FLEET) {
    const tag = await latestTag(repo);
    for (const pkg of packages) {
      const npm = await npmLatest(pkg);
      results.push(assess({ repo, pkg, tag, npm }));
    }
  }

  const symbol = { ok: 'ok  ', pending: '... ', skip: '--  ', fail: 'FAIL' };
  for (const r of results) console.log(`${symbol[r.level]} ${r.text}`);

  const failures = results.filter((r) => r.level === 'fail');
  if (failures.length > 0) {
    console.log('');
    for (const f of failures) console.log(`::error::${f.text}`);
    console.log(`\n${failures.length} package(s) have a tag that never reached npm.`);
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
