import * as fs from 'fs';
import * as path from 'path';

/**
 * Facts about the design system as a whole that a code check needs in order
 * to judge one component.
 *
 * Kept apart from the per-file facts because none of it is visible from the
 * component's own source: which React the system is built for decides what
 * forwarding a ref means (CO16), and where the system's root and the other
 * components' entry files are decides which imports cross a boundary (CO18).
 */
export interface ProjectFacts {
  /** The directory holding `.polder.yml`: the design system's root. */
  root: string;
  /** This component's entry file, absolute. */
  entryPath: string;
  /** Every other mapped component's entry file, absolute, by component name. */
  otherEntries: ReadonlyMap<string, string>;
  /**
   * The lowest React major version the system declares support for, or null
   * when no `package.json` between the component and the root names React.
   *
   * The LOWEST, because a component has to work on every version it claims.
   * A peer range of `^18 || ^19` means the component runs on React 18, where
   * `ref` is not a prop — so behaviour that only works on 19 is not enough.
   */
  reactMajor: number | null;
}

/** The dependency fields React can be declared in, most authoritative first. */
const REACT_FIELDS = ['peerDependencies', 'dependencies', 'devDependencies'] as const;

/**
 * The lowest major version a semver range admits, or null when the range
 * names none (`*`, `latest`, a git URL, a workspace protocol).
 *
 * Every integer that starts a version in the range is a candidate, so
 * `^18.2.0 || ^19.0.0` gives 18, `>=17 <20` gives 17, and `18.x` gives 18.
 */
export function lowestMajor(range: string): number | null {
  const majors = [...range.matchAll(/(?:^|[\s|^~><=v])(\d+)(?=[.\sx*|]|$)/g)].map((m) =>
    Number(m[1]),
  );
  return majors.length === 0 ? null : Math.min(...majors);
}

/** React's declared range in one package.json, or null. */
function reactRange(file: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  for (const field of REACT_FIELDS) {
    const deps = (parsed as Record<string, unknown>)[field];
    if (typeof deps !== 'object' || deps === null) continue;
    const range = (deps as Record<string, unknown>).react;
    if (typeof range === 'string') return range;
  }
  return null;
}

/**
 * The React major the component is built for: the nearest `package.json`
 * that declares React, walking up from the component to the root and no
 * further. Cached by directory, because every component in a package shares
 * the answer.
 *
 * Nearest rather than root, because a design system in a monorepo declares
 * React in its own package, and the repo root's `package.json` may declare
 * none or a different one for an app.
 */
export function reactMajorFor(
  entryPath: string,
  root: string,
  cache: Map<string, number | null>,
): number | null {
  const stop = path.resolve(root);
  let dir = path.dirname(path.resolve(entryPath));
  const visited: string[] = [];
  let found: number | null = null;
  for (;;) {
    const hit = cache.get(dir);
    if (hit !== undefined) {
      found = hit;
      break;
    }
    visited.push(dir);
    const range = reactRange(path.join(dir, 'package.json'));
    if (range !== null) {
      found = lowestMajor(range);
      break;
    }
    const parent = path.dirname(dir);
    if (dir === stop || parent === dir || !(dir + path.sep).startsWith(stop + path.sep)) break;
    dir = parent;
  }
  for (const d of visited) cache.set(d, found);
  return found;
}
