import type * as t from '@babel/types';
import type { Ast } from './parse';
import type { Answer } from './metrics';
import type { RelatedFiles } from './related-files';
import {
  attributeName,
  elementName,
  hasAttribute,
  hasSpread,
  isHostElement,
  walkAst,
} from './walk-ast';

export interface CheckResult {
  answer: Answer;
  /** One line explaining what the check looked at. Printed by --verbose. */
  evidence: string;
}

/** Everything a code-side check can look at. */
export interface CodeFacts {
  componentName: string;
  filePath: string;
  source: string;
  ast: Ast;
  /** Figma variant/property names, when the Figma side resolved. */
  figmaPropertyNames: string[] | null;
  /**
   * The component's other files (styles, sub-modules it imports from its own
   * directory). Absent means only the entry file was available.
   */
  related?: RelatedFiles;
}

const ICONISH = /(^|[^a-z])icon$|^icon/i;

function collectJsxElements(ast: Ast): t.JSXOpeningElement[] {
  const out: t.JSXOpeningElement[] = [];
  walkAst(ast.program, (node) => {
    if (node.type === 'JSXOpeningElement') out.push(node);
  });
  return out;
}

/** CO2 — are ARIA attributes defined anywhere in the component's markup? */
export function checkAriaAttributes(facts: CodeFacts): CheckResult {
  const elements = collectJsxElements(facts.ast);
  const hosts = elements.filter((e) => isHostElement(elementName(e)));
  if (hosts.length === 0) {
    return {
      answer: 'N/A',
      evidence: 'renders no host elements — ARIA is the composed components’ responsibility',
    };
  }
  const aria = elements.filter((e) =>
    hasAttribute(e, (n) => n.startsWith('aria-') || n === 'role'),
  );
  if (aria.length > 0) {
    return {
      answer: 'Yes',
      evidence: `${aria.length} element(s) carry aria-* or role attributes`,
    };
  }
  const spreading = hosts.filter((e) => hasSpread(e));
  if (spreading.length > 0) {
    return {
      answer: 'N/A',
      evidence:
        'no literal aria-*/role attributes, but props are spread onto a host element — ' +
        'cannot tell statically whether callers pass them',
    };
  }
  return { answer: 'No', evidence: 'no aria-* or role attributes on any host element' };
}

/** CO5 — non-text content (img, svg, icons) carries a text alternative. */
export function checkTextAlternatives(facts: CodeFacts): CheckResult {
  const elements = collectJsxElements(facts.ast);
  const nonText = elements.filter((e) => {
    const name = elementName(e);
    return name === 'img' || name === 'svg' || ICONISH.test(name);
  });
  if (nonText.length === 0) {
    return { answer: 'N/A', evidence: 'no images, svgs, or icon elements rendered' };
  }
  const missing = nonText.filter(
    (e) =>
      !hasAttribute(
        e,
        (n) =>
          n === 'alt' ||
          n === 'aria-label' ||
          n === 'aria-labelledby' ||
          n === 'aria-hidden' ||
          n === 'title',
      ) && !hasSpread(e),
  );
  if (missing.length === 0) {
    return {
      answer: 'Yes',
      evidence: `all ${nonText.length} non-text element(s) carry alt/aria-label/aria-hidden/title`,
    };
  }
  return {
    answer: 'No',
    evidence: `${missing.length} of ${nonText.length} non-text element(s) lack a text alternative: ${missing
      .map((e) => `<${elementName(e)}>`)
      .join(', ')}`,
  };
}

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g;
const PX_VALUE = /\b\d+(?:\.\d+)?px\b/g;

/** Every string a script contains — where a hardcoded value would live. */
function scriptLiterals(ast: Ast): string[] {
  const literals: string[] = [];
  walkAst(ast.program, (node) => {
    if (node.type === 'StringLiteral') literals.push(node.value);
    else if (node.type === 'TemplateElement') literals.push(node.value.raw);
  });
  return literals;
}

/**
 * The right-hand sides of declarations in a stylesheet. Reading values only
 * keeps `#face { … }` (an id selector) from being counted as a colour.
 */
function styleValues(source: string): string[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...stripped.matchAll(/:\s*([^;{}]+)(?=[;}])/g)].map((m) => m[1]);
}

/** CO7 — component uses tokens rather than hardcoded colour/spacing values. */
export function checkTokenUsage(facts: CodeFacts): CheckResult {
  const literals = scriptLiterals(facts.ast);
  const related = facts.related?.files ?? [];
  for (const file of related) {
    if (file.kind === 'style') literals.push(...styleValues(file.source));
    else if (file.ast !== null) literals.push(...scriptLiterals(file.ast));
  }

  const scanned = 1 + related.filter((f) => f.kind === 'style' || f.ast !== null).length;
  const caveats: string[] = [];
  if (facts.related && facts.related.unparseable.length > 0) {
    caveats.push(`${facts.related.unparseable.length} unparseable file(s) skipped`);
  }
  if (facts.related && facts.related.notFollowed > 0) {
    caveats.push(
      `${facts.related.notFollowed} import(s) outside the component's directory not followed`,
    );
  }
  const scope = `across ${scanned} file(s)${caveats.length > 0 ? `; ${caveats.join('; ')}` : ''}`;

  const haystack = literals.join('\n');
  const hexes = haystack.match(HEX_COLOR) ?? [];
  const pxs = haystack.match(PX_VALUE) ?? [];
  const total = hexes.length + pxs.length;
  if (total === 0) {
    return {
      answer: 'Yes',
      evidence: `no hardcoded hex colours or px values in source literals ${scope}`,
    };
  }
  const sample = [...new Set([...hexes, ...pxs])].slice(0, 5).join(', ');
  return {
    answer: 'No',
    evidence: `${hexes.length} hardcoded hex colour(s) and ${pxs.length} px value(s) (e.g. ${sample}) ${scope}`,
  };
}

const GENERIC_NAMES =
  /^(component|wrapper|container|box|thing|temp|tmp|test|new|my|foo|bar|item|element|base|main|index|untitled)\d*$/i;

/** CO8 — the component's own name means something. */
export function checkSemanticName(facts: CodeFacts): CheckResult {
  const name = facts.componentName;
  if (GENERIC_NAMES.test(name)) {
    return { answer: 'No', evidence: `"${name}" is a generic placeholder name` };
  }
  if (/\d$/.test(name)) {
    return {
      answer: 'No',
      evidence: `"${name}" ends in a digit, which usually marks a versioned duplicate`,
    };
  }
  if (name.length < 3) {
    return { answer: 'No', evidence: `"${name}" is too short to be descriptive` };
  }
  return { answer: 'Yes', evidence: `"${name}" is descriptive` };
}

/** Normalise "Size#123:4" / "isDisabled" / "has-icon" to a comparable key. */
export function normalisePropName(raw: string): string {
  return raw
    .split('#')[0]
    .replace(/^(is|has|should|enable|show)/i, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

type TypeMembers = t.TSTypeElement[];

/** Top-level `interface XProps` / `type XProps = {...}` declarations, by name. */
function collectTypeDeclarations(ast: Ast): Map<string, t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration> {
  const out = new Map<string, t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration>();
  for (const stmt of ast.program.body) {
    const decl =
      (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') &&
      stmt.declaration
        ? stmt.declaration
        : stmt;
    if (decl.type === 'TSInterfaceDeclaration' || decl.type === 'TSTypeAliasDeclaration') {
      out.set(decl.id.name, decl);
    }
  }
  return out;
}

/** Add the property names a type contributes, following local references and `extends`. */
function addTypeProps(
  type: t.TSType | t.TSTypeAnnotation | t.TSTypeParameterInstantiation | null | undefined,
  decls: ReturnType<typeof collectTypeDeclarations>,
  names: Set<string>,
  seen: Set<string>,
): void {
  if (type === null || type === undefined) return;
  switch (type.type) {
    case 'TSTypeAnnotation':
      addTypeProps(type.typeAnnotation, decls, names, seen);
      return;
    case 'TSTypeParameterInstantiation':
      // `FC<ButtonProps>`, `forwardRef<HTMLButtonElement, ButtonProps>` — the
      // props type is one of the arguments; the ones that do not resolve to a
      // local declaration (HTMLButtonElement) contribute nothing.
      for (const param of type.params) addTypeProps(param, decls, names, seen);
      return;
    case 'TSTypeLiteral':
      addMembers(type.members, names);
      return;
    case 'TSIntersectionType':
    case 'TSUnionType':
      for (const member of type.types) addTypeProps(member, decls, names, seen);
      return;
    case 'TSParenthesizedType':
      addTypeProps(type.typeAnnotation, decls, names, seen);
      return;
    case 'TSTypeReference': {
      if (type.typeName.type === 'Identifier') {
        addNamedType(type.typeName.name, decls, names, seen);
      }
      // `Omit<ButtonProps, 'x'>`, `Readonly<ButtonProps>`: look inside.
      addTypeProps(type.typeParameters, decls, names, seen);
      return;
    }
    default:
      return;
  }
}

function addMembers(members: TypeMembers, names: Set<string>): void {
  for (const member of members) {
    if (
      (member.type === 'TSPropertySignature' || member.type === 'TSMethodSignature') &&
      member.key.type === 'Identifier'
    ) {
      names.add(member.key.name);
    }
  }
}

function addNamedType(
  name: string,
  decls: ReturnType<typeof collectTypeDeclarations>,
  names: Set<string>,
  seen: Set<string>,
): void {
  if (seen.has(name)) return;
  seen.add(name);
  const decl = decls.get(name);
  if (decl === undefined) return;
  if (decl.type === 'TSInterfaceDeclaration') {
    addMembers(decl.body.body, names);
    for (const parent of decl.extends ?? []) {
      if (parent.expression.type === 'Identifier') addNamedType(parent.expression.name, decls, names, seen);
    }
  } else {
    addTypeProps(decl.typeAnnotation, decls, names, seen);
  }
}

interface ComponentCandidate {
  name: string;
  exported: boolean;
  fn: t.Function;
  /** Type annotations that may carry the props type, outside the parameter. */
  typeHints: (t.TSTypeAnnotation | t.TSTypeParameterInstantiation | null | undefined)[];
}

const WRAPPERS = new Set(['forwardRef', 'memo', 'observer']);

/** Unwrap `forwardRef(fn)` / `React.memo(fn)` down to the function inside. */
function unwrapComponent(
  expr: t.Node | null | undefined,
  hints: ComponentCandidate['typeHints'],
): t.Function | null {
  if (expr === null || expr === undefined) return null;
  if (
    expr.type === 'ArrowFunctionExpression' ||
    expr.type === 'FunctionExpression' ||
    expr.type === 'FunctionDeclaration'
  ) {
    return expr;
  }
  if (expr.type === 'CallExpression') {
    const callee = expr.callee;
    const calleeName =
      callee.type === 'Identifier'
        ? callee.name
        : callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
          ? callee.property.name
          : null;
    if (calleeName !== null && WRAPPERS.has(calleeName)) {
      hints.push(expr.typeParameters);
      return unwrapComponent(expr.arguments[0] as t.Node | undefined, hints);
    }
  }
  return null;
}

/** Top-level function components: `function X`, `const X = () =>`, `export default`, wrapped or not. */
function findComponents(ast: Ast): ComponentCandidate[] {
  const out: ComponentCandidate[] = [];
  const add = (
    name: string | null,
    exported: boolean,
    expr: t.Node | null | undefined,
    hints: ComponentCandidate['typeHints'],
  ): void => {
    const fn = unwrapComponent(expr, hints);
    if (fn === null || name === null) return;
    // Components are capitalised; a lowercase helper is a hook or utility.
    if (name[0] === undefined || name[0] !== name[0].toUpperCase() || name[0] === name[0].toLowerCase()) return;
    out.push({ name, exported, fn, typeHints: hints });
  };

  for (const stmt of ast.program.body) {
    const exported = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration';
    const decl = exported && stmt.declaration ? stmt.declaration : stmt;
    if (decl.type === 'FunctionDeclaration') {
      add(decl.id?.name ?? null, exported, decl, []);
    } else if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type !== 'Identifier') continue;
        add(d.id.name, exported, d.init, [d.id.typeAnnotation as t.TSTypeAnnotation | null | undefined]);
      }
    }
  }

  // `const Button = ...; export { Button }` / `export default Button`
  const exportedNames = new Set<string>();
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ExportNamedDeclaration' && !stmt.declaration && !stmt.source) {
      for (const spec of stmt.specifiers) {
        if (spec.type === 'ExportSpecifier' && spec.local.type === 'Identifier') {
          exportedNames.add(spec.local.name);
        }
      }
    } else if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration.type === 'Identifier') {
      exportedNames.add(stmt.declaration.name);
    }
  }
  for (const c of out) if (exportedNames.has(c.name)) c.exported = true;
  return out;
}

/**
 * The props a component declares: its own first parameter (destructured names
 * and its type annotation) and the `*Props` type that describes it.
 *
 * Deliberately not "every destructuring pattern in the file". A component
 * that calls `const { data, isLoading } = useQuery()` has not gained `data`
 * and `isLoading` props, and counting them would credit a Figma "Loading"
 * property to a hook's return value.
 *
 * Without a `componentName`, or when no component can be found, only the
 * `*Props` type declarations are read — never destructuring.
 */
export function collectCodePropNames(ast: Ast, componentName?: string): string[] {
  const names = new Set<string>();
  const decls = collectTypeDeclarations(ast);
  const seen = new Set<string>();

  const all = findComponents(ast);
  const named = componentName === undefined ? [] : all.filter((c) => c.name === componentName);
  const chosen = named.length > 0 ? named : all.filter((c) => c.exported);

  if (chosen.length === 0) {
    for (const name of decls.keys()) {
      if (/Props$/.test(name)) addNamedType(name, decls, names, seen);
    }
    return [...names];
  }

  for (const c of chosen) {
    const param = c.fn.params[0];
    if (param !== undefined) {
      const target = param.type === 'AssignmentPattern' ? param.left : param;
      if (target.type === 'ObjectPattern') {
        for (const prop of target.properties) {
          if (prop.type === 'ObjectProperty' && prop.key.type === 'Identifier') names.add(prop.key.name);
        }
      }
      if (target.type === 'ObjectPattern' || target.type === 'Identifier') {
        addTypeProps(target.typeAnnotation as t.TSTypeAnnotation | null | undefined, decls, names, seen);
      }
    }
    for (const hint of c.typeHints) addTypeProps(hint, decls, names, seen);
    // The conventional `ButtonProps` even when nothing links it explicitly.
    addNamedType(`${c.name}Props`, decls, names, seen);
  }

  return [...names];
}

/**
 * CO9 — do Figma's variant/component properties have counterparts in code?
 * N/A without a Figma side: the metric is about parity, and one side alone
 * cannot disagree with anything.
 */
export function checkFigmaPropParity(facts: CodeFacts): CheckResult {
  if (facts.figmaPropertyNames === null) {
    return { answer: 'N/A', evidence: 'no Figma node resolved for this component' };
  }
  if (facts.figmaPropertyNames.length === 0) {
    return { answer: 'N/A', evidence: 'Figma component declares no properties or variants' };
  }
  const codeProps = new Set(collectCodePropNames(facts.ast, facts.componentName).map(normalisePropName));
  const missing = facts.figmaPropertyNames.filter(
    (p) => !codeProps.has(normalisePropName(p)),
  );
  if (missing.length === 0) {
    return {
      answer: 'Yes',
      evidence: `all ${facts.figmaPropertyNames.length} Figma propert(ies) have a code counterpart`,
    };
  }
  return {
    answer: 'No',
    evidence: `Figma propert(ies) with no code counterpart: ${missing
      .map((p) => p.split('#')[0])
      .join(', ')}`,
  };
}

/** A check reads the component's facts, plus the `params` its norm configured. */
export type CodeCheck = (facts: CodeFacts, params?: Record<string, unknown>) => CheckResult;

interface SearchTarget {
  filePath: string;
  text: string;
}

/**
 * Blank out comments, keeping every offset intact. A norm about code should be
 * neither satisfied nor tripped by a comment about it: "// never use
 * dangerouslySetInnerHTML" is not a use.
 */
function withoutComments(source: string, ast: Ast | null): string {
  if (ast === null) return source;
  let out = source;
  for (const c of ast.comments ?? []) {
    if (c.start == null || c.end == null) continue;
    out = out.slice(0, c.start) + out.slice(c.start, c.end).replace(/[^\n]/g, ' ') + out.slice(c.end);
  }
  return out;
}

function withoutStyleComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
}

/** The entry file and the related files the other code checks read, comments removed. */
function searchTargets(facts: CodeFacts): SearchTarget[] {
  const targets: SearchTarget[] = [
    { filePath: facts.filePath, text: withoutComments(facts.source, facts.ast) },
  ];
  for (const f of facts.related?.files ?? []) {
    targets.push({
      filePath: f.filePath,
      text: f.kind === 'style' ? withoutStyleComments(f.source) : withoutComments(f.source, f.ast),
    });
  }
  return targets;
}

function textParam(params: Record<string, unknown> | undefined): string[] {
  const raw = params?.text;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

function findFirst(
  targets: readonly SearchTarget[],
  needles: readonly string[],
): { needle: string; filePath: string } | null {
  for (const t of targets) {
    for (const needle of needles) {
      if (t.text.includes(needle)) return { needle, filePath: t.filePath };
    }
  }
  return null;
}

const quoted = (needles: readonly string[]) => needles.map((n) => `"${n}"`).join(' / ');

/**
 * `code.contains` — Yes when the component's source contains at least one of
 * `params.text`. Plain substring, case-sensitive, never a pattern: the config
 * is read straight off pull-request branches, and a regex from a fork is a
 * way to hang the runner.
 */
export function checkContains(
  facts: CodeFacts,
  params?: Record<string, unknown>,
): CheckResult {
  const needles = textParam(params);
  if (needles.length === 0) return { answer: 'N/A', evidence: 'no `text` configured for this norm' };
  const targets = searchTargets(facts);
  const hit = findFirst(targets, needles);
  if (hit !== null) {
    return { answer: 'Yes', evidence: `found "${hit.needle}" in ${hit.filePath}` };
  }
  return {
    answer: 'No',
    evidence: `none of ${quoted(needles)} found across ${targets.length} file(s), comments excluded`,
  };
}

/** `code.forbids` — Yes when none of `params.text` appears anywhere in the source. */
export function checkForbids(
  facts: CodeFacts,
  params?: Record<string, unknown>,
): CheckResult {
  const needles = textParam(params);
  if (needles.length === 0) return { answer: 'N/A', evidence: 'no `text` configured for this norm' };
  const targets = searchTargets(facts);
  const hit = findFirst(targets, needles);
  if (hit !== null) {
    return { answer: 'No', evidence: `found "${hit.needle}" in ${hit.filePath}` };
  }
  return {
    answer: 'Yes',
    evidence: `none of ${quoted(needles)} found across ${targets.length} file(s), comments excluded`,
  };
}

export const CODE_CHECKS: Record<string, CodeCheck> = {
  'code.contains': checkContains,
  'code.forbids': checkForbids,
  'code.aria-attributes': checkAriaAttributes,
  'code.text-alternatives': checkTextAlternatives,
  'code.token-usage': checkTokenUsage,
  'code.semantic-name': checkSemanticName,
  'code.figma-prop-parity': checkFigmaPropParity,
};
