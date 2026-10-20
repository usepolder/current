import * as fs from 'fs';
import * as path from 'path';
import type * as t from '@babel/types';
import { parseSource, type Ast } from './parse';

/** A file that belongs to a component but is not its entry file. */
export interface RelatedFile {
  /** Repo-relative, for evidence lines. */
  filePath: string;
  source: string;
  kind: 'script' | 'style';
  /** Null for style files, and for scripts that would not parse. */
  ast: Ast | null;
}

export interface RelatedFiles {
  files: RelatedFile[];
  /** Relative imports that resolved outside the component's directory or to another component. */
  notFollowed: number;
  /** Scripts that were found but could not be parsed. */
  unparseable: string[];
}

const SCRIPT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const STYLE_EXTS = ['.css', '.scss', '.sass', '.less'];
const MAX_FILES = 50;

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve a relative specifier the way a bundler would: exact, +ext, then index. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    ...[...SCRIPT_EXTS, ...STYLE_EXTS].map((e) => base + e),
    // TS projects import './Foo.js' for Foo.ts.
    ...(/\.[cm]?jsx?$/.test(base)
      ? SCRIPT_EXTS.map((e) => base.replace(/\.[cm]?jsx?$/, e))
      : []),
    ...SCRIPT_EXTS.map((e) => path.join(base, `index${e}`)),
  ];
  return candidates.find(isFile) ?? null;
}

/** `import`, `export … from`, and `export *` sources, in source order. */
function importSpecifiers(ast: Ast): string[] {
  const out: string[] = [];
  for (const stmt of ast.program.body as t.Statement[]) {
    if (stmt.type === 'ImportDeclaration') out.push(stmt.source.value);
    else if (
      (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportAllDeclaration') &&
      stmt.source
    ) {
      out.push(stmt.source.value);
    }
  }
  return out;
}

function within(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Find the files that make up a component beyond its entry file: the
 * `Button.styles.ts`, `Button.module.css`, `./variants` it imports.
 *
 * Only relative imports are followed, and only while they stay inside the
 * entry file's directory. That bound is what keeps this an answer to "what
 * does *this component* hardcode" — following `../Icon` or `../../tokens`
 * would blame Button for someone else's values. A file mapped as another
 * component's own code is never claimed, for the same reason, which matters in
 * flat layouts where every component shares a directory.
 *
 * `notFollowed` counts what was skipped so the evidence can say so, rather than
 * letting a partial scan read as a complete one.
 */
export function collectRelatedFiles(
  entryFile: string,
  entryAst: Ast,
  repoRoot: string,
  otherComponentFiles: ReadonlySet<string>,
): RelatedFiles {
  const dir = path.dirname(entryFile);
  const result: RelatedFiles = { files: [], notFollowed: 0, unparseable: [] };
  const visited = new Set<string>([path.resolve(entryFile)]);
  const skipped = new Set<string>();
  const queue: Array<{ file: string; ast: Ast }> = [{ file: entryFile, ast: entryAst }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const specifier of importSpecifiers(current.ast)) {
      if (!isRelative(specifier)) continue;
      const resolved = resolveSpecifier(current.file, specifier);
      if (resolved === null) continue;
      const abs = path.resolve(resolved);
      if (visited.has(abs) || skipped.has(abs)) continue;

      // realpath, so a symlink inside the component directory cannot lead
      // out of the repo.
      const real = fs.realpathSync(abs);
      const realRoot = fs.realpathSync(repoRoot);
      if (
        !within(dir, abs) ||
        !within(realRoot, real) ||
        otherComponentFiles.has(abs) ||
        otherComponentFiles.has(real)
      ) {
        skipped.add(abs);
        continue;
      }
      if (visited.size > MAX_FILES) {
        skipped.add(abs);
        continue;
      }
      visited.add(abs);

      const rel = path.relative(repoRoot, abs);
      const ext = path.extname(abs).toLowerCase();
      const source = fs.readFileSync(abs, 'utf8');
      if (STYLE_EXTS.includes(ext)) {
        result.files.push({ filePath: rel, source, kind: 'style', ast: null });
        continue;
      }
      if (!SCRIPT_EXTS.includes(ext)) continue;
      try {
        const ast = parseSource(source, rel);
        result.files.push({ filePath: rel, source, kind: 'script', ast });
        queue.push({ file: abs, ast });
      } catch {
        result.unparseable.push(rel);
        result.files.push({ filePath: rel, source, kind: 'script', ast: null });
      }
    }
  }

  result.notFollowed = skipped.size;
  return result;
}
