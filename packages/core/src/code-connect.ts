import * as fs from 'fs';
import * as path from 'path';
import type * as t from '@babel/types';
import { parseSource, type Ast } from './parse';
import { walkAst } from './walk-ast';

/**
 * Figma Code Connect, read from the repo.
 *
 * CO12 ("composition mirrors the Figma component") is the one norm where the
 * two sides of the audit have to agree with each other, and Code Connect is
 * the only artefact that states that agreement explicitly: a
 * `figma.connect(Button, "https://…?node-id=1-10")` call is a team asserting
 * *this* code implements *that* Figma node, published and kept in version
 * control.
 *
 * It is read from the repo rather than from Figma because there is no REST
 * endpoint that reports published Code Connect mappings — the published
 * mappings are visible in Dev Mode and nowhere in the API. What the repo
 * holds is the source of truth the publish command reads, so reading it here
 * answers the same question one step earlier.
 *
 * Mappings are found by Code Connect's own file convention (`Button.figma.ts`,
 * `Button.figma.tsx`, … alongside the component) and in the component's own
 * entry file, which is where a one-off mapping tends to end up. Custom
 * `codeConnect.include` globs in `figma.config.json` are not expanded; a repo
 * that keeps its mappings somewhere else entirely reports N/A rather than a
 * wrong No, and the evidence says so.
 */

/** Code Connect's file convention: `Button.figma.tsx` and friends. */
const CODE_CONNECT_FILE = /\.figma\.(?:[cm]?tsx?|[cm]?jsx?)$/;

/** Marks a repo as using Code Connect even before any mapping file is found. */
export const CODE_CONNECT_CONFIG = 'figma.config.json';

/** Directories a repo walk has no business reading. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
  'storybook-static',
  'vendor',
]);

/** Depth and file caps, so a pathological repo cannot stall a scan. */
const MAX_DEPTH = 12;
const MAX_FILES = 500;

/** One `figma.connect()` call. */
export interface CodeConnectMapping {
  /** Repo-relative path of the file holding the call. */
  filePath: string;
  /**
   * The component the call names, e.g. `Button` or `Table.Row`. Null for the
   * `figma.connect("https://…")` form, which maps a Figma component to a
   * native element and names no code component.
   */
  component: string | null;
  url: string;
  /** Figma file key from the URL, or null when the URL carries none. */
  fileKey: string | null;
  /** Node id in Figma's own `12:345` form, or null when the URL carries none. */
  nodeId: string | null;
  /** Prop names mapped in the third argument, for the evidence line. */
  props: string[];
}

/** Every Code Connect mapping in a repo, plus whether it uses Code Connect at all. */
export interface CodeConnectIndex {
  mappings: CodeConnectMapping[];
  /** How many `*.figma.*` files were read. */
  fileCount: number;
  /** A `figma.config.json` at the repo root. */
  hasConfig: boolean;
}

/**
 * A node id as Figma's API writes it: `1:10`.
 *
 * URLs carry the same id with colons swapped for dashes (`node-id=1-10`) or
 * percent-encoded (`node-id=1%3A10`), and both forms name the same node. Node
 * ids contain no literal dashes, so swapping every one back is safe.
 */
export function normaliseNodeId(raw: string): string {
  return decodeURIComponent(raw.trim()).replace(/-/g, ':');
}

/** The file key and node id a Figma URL points at. */
export function parseFigmaUrl(url: string): { fileKey: string | null; nodeId: string | null } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { fileKey: null, nodeId: null };
  }
  // Both /file/<key>/<name> and the newer /design/<key>/<name> are in use.
  const key = /\/(?:file|design)\/([^/?#]+)/.exec(parsed.pathname)?.[1] ?? null;
  const node = parsed.searchParams.get('node-id');
  return {
    fileKey: key === null ? null : decodeURIComponent(key),
    nodeId: node === null || node.trim() === '' ? null : normaliseNodeId(node),
  };
}

/** `figma.connect` and `connect` (a destructured import) both count. */
function isConnectCallee(callee: t.Node): boolean {
  if (callee.type === 'Identifier') return callee.name === 'connect';
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  const property = callee.property;
  if (property.type !== 'Identifier' || property.name !== 'connect') return false;
  const object = callee.object;
  return object.type === 'Identifier' ? object.name === 'figma' : true;
}

/** `Button` / `Table.Row` as written, or null for anything else. */
function componentName(node: t.Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) {
    const object = componentName(node.object);
    const property = node.property;
    if (object === null || property.type !== 'Identifier') return null;
    return `${object}.${property.name}`;
  }
  return null;
}

function stringValue(node: t.Node | undefined): string | null {
  if (node === undefined) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
  }
  return null;
}

/** The `props: { … }` keys of a `figma.connect` options object. */
function propNames(node: t.Node | undefined): string[] {
  if (node === undefined || node.type !== 'ObjectExpression') return [];
  const props = node.properties.find(
    (p) =>
      p.type === 'ObjectProperty' &&
      !p.computed &&
      ((p.key.type === 'Identifier' && p.key.name === 'props') ||
        (p.key.type === 'StringLiteral' && p.key.value === 'props')),
  );
  if (props === undefined || props.type !== 'ObjectProperty') return [];
  const value = props.value;
  if (value.type !== 'ObjectExpression') return [];
  const out: string[] = [];
  for (const entry of value.properties) {
    if (entry.type !== 'ObjectProperty' || entry.computed) continue;
    if (entry.key.type === 'Identifier') out.push(entry.key.name);
    else if (entry.key.type === 'StringLiteral') out.push(entry.key.value);
  }
  return out;
}

/**
 * Every `figma.connect()` call in one parsed file.
 *
 * Both documented shapes are read: `figma.connect(Button, url, options?)` and
 * `figma.connect(url, options?)`.
 */
export function extractCodeConnect(ast: Ast, filePath: string): CodeConnectMapping[] {
  const out: CodeConnectMapping[] = [];
  walkAst(ast.program, (node) => {
    if (node.type !== 'CallExpression') return;
    if (!isConnectCallee(node.callee as t.Node)) return;
    const args = node.arguments.filter((a) => a.type !== 'SpreadElement') as t.Node[];
    const firstAsUrl = stringValue(args[0]);
    const url = firstAsUrl ?? stringValue(args[1]);
    if (url === null) return;
    const first = args[0];
    const component =
      firstAsUrl === null && first !== undefined ? componentName(first) : null;
    const { fileKey, nodeId } = parseFigmaUrl(url);
    out.push({
      filePath,
      component,
      url,
      fileKey,
      nodeId,
      props: propNames(args[firstAsUrl === null ? 2 : 1]),
    });
  });
  return out;
}

/** Repo-relative, posix-separated, for evidence lines that read the same everywhere. */
function relative(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

function collectFiles(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(full, depth + 1, out);
    } else if (entry.isFile() && CODE_CONNECT_FILE.test(entry.name)) {
      out.push(full);
    }
  }
}

/**
 * Walk the repo for Code Connect files and read every mapping in them.
 *
 * Done once per scan, not once per component: the walk is the expensive part
 * and the answer is the same for everyone.
 */
export function indexCodeConnect(repoRoot: string): CodeConnectIndex {
  const files: string[] = [];
  collectFiles(repoRoot, 0, files);
  files.sort();

  const mappings: CodeConnectMapping[] = [];
  for (const file of files) {
    const rel = relative(repoRoot, file);
    let ast: Ast;
    try {
      ast = parseSource(fs.readFileSync(file, 'utf8'), rel);
    } catch {
      // A Code Connect file nobody named in `components:` is not worth
      // failing a scan over; it just contributes no mappings.
      continue;
    }
    mappings.push(...extractCodeConnect(ast, rel));
  }

  return {
    mappings,
    fileCount: files.length,
    hasConfig: fs.existsSync(path.join(repoRoot, CODE_CONNECT_CONFIG)),
  };
}

/** `src/Button/Button.figma.tsx` → `Button`. */
function connectFileSubject(filePath: string): string {
  return path.basename(filePath).replace(/\.figma\.[^.]+$/, '');
}

/** The last segment of a dotted name: `Table.Row` → `Row`. */
function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

/**
 * The mapping that covers one component, by the two conventions Code Connect
 * documents: the call names the component, or the file is named after it.
 *
 * A call that names the component wins over one that merely sits in a file of
 * that name, and an exact dotted match (`Table.Row`) wins over its last
 * segment, so a `Row.figma.tsx` holding several calls still resolves.
 */
export function mappingFor(
  mappings: readonly CodeConnectMapping[],
  componentName: string,
): CodeConnectMapping | null {
  const named = mappings.filter((m) => m.component === componentName);
  if (named.length > 0) return named[0];

  const bySegment = mappings.filter(
    (m) => m.component !== null && lastSegment(m.component) === lastSegment(componentName),
  );
  if (bySegment.length > 0) return bySegment[0];

  const byFile = mappings.filter(
    (m) => m.component === null && connectFileSubject(m.filePath) === componentName,
  );
  return byFile[0] ?? null;
}
