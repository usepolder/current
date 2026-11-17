import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { CurrentError, type FigmaComponentSummary } from '@usepolder/current-core';

/** How sure we are that a code file and a Figma node are the same component. */
export type MatchKind = 'exact' | 'fuzzy' | 'ambiguous' | 'none';

export interface CodeComponent {
  name: string;
  /** Repo-relative posix path. */
  code: string;
  docs: string | null;
}

export interface PlannedComponent extends CodeComponent {
  figma: string | null;
  match: MatchKind;
  /** Why the match is uncertain, rendered as a trailing comment. */
  note: string | null;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'lib', 'build', 'coverage', '.next', '.turbo', 'out',
]);

const COMPONENT_FILE = /^([A-Z][A-Za-z0-9]*)\.tsx$/;
const NOT_A_COMPONENT = /\.(test|spec|stories)\.tsx$/;

/** Collapse the ways the same component gets written in code and in Figma. */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function walk(root: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory: skip rather than abort the scan
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(root, full, out);
    } else if (e.isFile() && e.name.endsWith('.tsx') && !NOT_A_COMPONENT.test(e.name)) {
      out.push(full);
    }
  }
}

/**
 * Find component source files.
 *
 * Two conventions are recognised, because between them they cover most React
 * design systems: `Button.tsx` named for the component, and `Button/index.tsx`
 * named for its directory. A file that is neither is not guessed at — an
 * unmapped component is obvious in the report, a wrongly mapped one is not.
 */
export function discoverComponents(root: string): CodeComponent[] {
  const files: string[] = [];
  walk(root, root, files);

  const byName = new Map<string, string[]>();
  for (const full of files) {
    const base = path.basename(full);
    const dirName = path.basename(path.dirname(full));
    let name: string | null = null;
    const m = COMPONENT_FILE.exec(base);
    if (m !== null) name = m[1];
    else if (base === 'index.tsx' && /^[A-Z][A-Za-z0-9]*$/.test(dirName)) name = dirName;
    if (name === null) continue;

    const rel = path.relative(root, full).split(path.sep).join('/');
    const list = byName.get(name) ?? [];
    list.push(rel);
    byName.set(name, list);
  }

  const out: CodeComponent[] = [];
  for (const [name, paths] of [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // `Button/Button.tsx` beats `Button/index.tsx`: it is the more specific
    // of the two conventions, and picking deterministically keeps repeated
    // runs byte-identical.
    const preferred = paths.find((p) => !p.endsWith('/index.tsx')) ?? paths[0];
    out.push({ name, code: preferred, docs: findDocs(root, name) });
  }
  return out;
}

function findDocs(root: string, name: string): string | null {
  const lower = name.toLowerCase();
  for (const candidate of [
    `docs/${lower}.mdx`, `docs/${lower}.md`, `docs/${name}.mdx`, `docs/${name}.md`,
  ]) {
    if (fs.existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

/**
 * Pair code components with Figma nodes by name.
 *
 * Only an exact name match is written as a live mapping. Anything softer is
 * written commented out, because README promises Current will not guess a
 * mapping: a wrong guess silently scores the wrong node forever, and nobody
 * re-reads a generated file they did not have to think about.
 */
export function planComponents(
  code: readonly CodeComponent[],
  figma: readonly FigmaComponentSummary[],
): PlannedComponent[] {
  const exact = new Map<string, FigmaComponentSummary[]>();
  const loose = new Map<string, FigmaComponentSummary[]>();
  for (const f of figma) {
    const e = exact.get(f.name) ?? [];
    e.push(f);
    exact.set(f.name, e);
    const k = normalise(f.name);
    const l = loose.get(k) ?? [];
    l.push(f);
    loose.set(k, l);
  }

  return code.map((c) => {
    const hits = exact.get(c.name) ?? [];
    if (hits.length === 1) {
      return { ...c, figma: hits[0].id, match: 'exact', note: null };
    }
    if (hits.length > 1) {
      return {
        ...c,
        figma: hits[0].id,
        match: 'ambiguous',
        note: `${hits.length} Figma components are named ${c.name}: ${hits.map((h) => `${h.id} on ${h.page || 'untitled page'}`).join(', ')}`,
      };
    }
    const near = loose.get(normalise(c.name)) ?? [];
    if (near.length === 1) {
      return { ...c, figma: near[0].id, match: 'fuzzy', note: `Figma calls this "${near[0].name}"` };
    }
    if (near.length > 1) {
      return {
        ...c,
        figma: near[0].id,
        match: 'ambiguous',
        note: `several Figma components resemble ${c.name}: ${near.map((h) => `"${h.name}" ${h.id}`).join(', ')}`,
      };
    }
    return { ...c, figma: null, match: 'none', note: null };
  });
}

function quote(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Render the `current:` block. Uncertain mappings are commented, not omitted. */
export function renderCurrentBlock(
  plan: readonly PlannedComponent[],
  fileKey: string | null,
): string {
  const lines: string[] = [
    '# Written by `current init`. Review the commented lines before trusting the scores.',
    'current:',
    '  version: 1',
  ];
  if (fileKey !== null) {
    lines.push('  figma:', `    file_key: ${quote(fileKey)}`);
  } else {
    lines.push(
      '  # figma:',
      '  #   file_key: "your-figma-file-key"   # then: current figma list',
    );
  }

  if (plan.length === 0) {
    lines.push(
      '  components: {}',
      '  # No component source was found. `current init` looks for Button.tsx or',
      '  # Button/index.tsx, ignoring tests, stories and build output.',
    );
    return lines.join('\n');
  }

  lines.push('  components:');
  for (const c of plan) {
    lines.push(`    ${c.name}:`);
    lines.push(`      code: ${quote(c.code)}`);
    if (c.match === 'exact') {
      lines.push(`      figma: ${quote(c.figma as string)}`);
    } else if (c.figma !== null) {
      lines.push(`      # figma: ${quote(c.figma)}   # unconfirmed — ${c.note}`);
    } else if (fileKey !== null) {
      lines.push('      # figma: "0:0"   # no Figma component matched this name');
    }
    if (c.docs !== null) lines.push(`      docs: ${quote(c.docs)}`);
  }
  return lines.join('\n');
}

/**
 * Put the block into an existing config without disturbing anything else.
 *
 * `.polder.yml` is shared with Drift and Reach, so this appends and never
 * rewrites: a reserialised file would reformat their keys and drop their
 * comments even when the values survived.
 */
export function mergeIntoConfig(existing: string | null, block: string): string {
  if (existing === null || existing.trim() === '') return `${block}\n`;

  let parsed: unknown;
  try {
    parsed = yaml.load(existing);
  } catch (err) {
    throw new CurrentError(
      `.polder.yml is not valid YAML, so there is nowhere safe to add the current: block.\n${(err as Error).message}`,
    );
  }
  if (typeof parsed === 'object' && parsed !== null && 'current' in parsed) {
    throw new CurrentError(
      '.polder.yml already has a current: block, and `current init` will not overwrite it.\n' +
        'Delete that block and run init again to regenerate it.',
    );
  }
  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}\n`;
}

/** Write through a temp file so a failure leaves the original untouched. */
export function writeAtomic(target: string, contents: string): void {
  const tmp = `${target}.init-${process.pid}`;
  fs.writeFileSync(tmp, contents);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
