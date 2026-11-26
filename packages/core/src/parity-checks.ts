import type * as t from '@babel/types';
import {
  chooseComponents,
  collectTypeDeclarations,
  normalisePropName,
  type CheckResult,
  type CodeCheck,
  type CodeFacts,
} from './code-checks';
import type { Ast } from './parse';

/**
 * Parity between a component's Figma properties and its code props, in
 * VALUES rather than names.
 *
 * CO9 asks whether each Figma property has a code counterpart, and stops
 * there. A `size` that exists on both sides passes even when Figma offers
 * `sm, md, lg, xl` and code accepts `sm, md, lg`. That is real drift and
 * nothing found it: a designer specs `xl`, the developer has no way to build
 * it, and the gap surfaces in review or never. These two checks close it.
 *
 * Neither re-reports what CO9 reports. A Figma property with no code
 * counterpart at all is CO9's finding; here it is simply not compared.
 */

type Literal = string | number | boolean;

/** What one code prop accepts and defaults to, as far as the source says. */
export interface CodePropShape {
  name: string;
  /** Closed set of accepted values (`'sm' | 'md'`), or null when the type is open or unreadable. */
  values: string[] | null;
  /** The prop is typed `boolean`. */
  boolean: boolean;
  /** Whether the type marks it optional (`size?:`). */
  optional: boolean;
  /** The declared default, or undefined when the source declares none. */
  defaultValue: Literal | undefined;
}

type Decls = ReturnType<typeof collectTypeDeclarations>;

/**
 * The closed set of literal values a type admits, or null when it admits
 * anything else. `undefined` and `null` are skipped, since an optional prop
 * is still closed; `string`, a template type or an unresolvable reference
 * makes the set open, and an open set has nothing to compare.
 */
function literalValues(type: t.TSType | null | undefined, decls: Decls, seen: Set<string>): string[] | null {
  if (type === null || type === undefined) return null;
  switch (type.type) {
    case 'TSLiteralType': {
      const lit = type.literal;
      if (lit.type === 'StringLiteral') return [lit.value];
      if (lit.type === 'NumericLiteral') return [String(lit.value)];
      return null;
    }
    case 'TSUnionType': {
      const out: string[] = [];
      for (const member of type.types) {
        if (member.type === 'TSUndefinedKeyword' || member.type === 'TSNullKeyword') continue;
        const values = literalValues(member, decls, seen);
        if (values === null) return null;
        out.push(...values);
      }
      return out.length === 0 ? null : out;
    }
    case 'TSParenthesizedType':
      return literalValues(type.typeAnnotation, decls, seen);
    case 'TSTypeReference': {
      if (type.typeName.type !== 'Identifier') return null;
      const name = type.typeName.name;
      if (seen.has(name)) return null;
      const decl = decls.get(name);
      if (decl === undefined || decl.type !== 'TSTypeAliasDeclaration') return null;
      return literalValues(decl.typeAnnotation, decls, new Set([...seen, name]));
    }
    default:
      return null;
  }
}

function isBooleanType(type: t.TSType | null | undefined): boolean {
  if (type === null || type === undefined) return false;
  if (type.type === 'TSBooleanKeyword') return true;
  if (type.type === 'TSUnionType') {
    return type.types.every(
      (m) =>
        m.type === 'TSBooleanKeyword' ||
        m.type === 'TSUndefinedKeyword' ||
        (m.type === 'TSLiteralType' && m.literal.type === 'BooleanLiteral'),
    );
  }
  return false;
}

/** Property signatures reachable from a props type, following local declarations. */
function collectMembers(
  type: t.TSType | t.TSTypeAnnotation | t.TSTypeParameterInstantiation | null | undefined,
  decls: Decls,
  out: Map<string, t.TSPropertySignature>,
  seen: Set<string>,
): void {
  if (type === null || type === undefined) return;
  switch (type.type) {
    case 'TSTypeAnnotation':
      collectMembers(type.typeAnnotation, decls, out, seen);
      return;
    case 'TSTypeParameterInstantiation':
      for (const p of type.params) collectMembers(p, decls, out, seen);
      return;
    case 'TSTypeLiteral':
      addSignatures(type.members, out);
      return;
    case 'TSIntersectionType':
    case 'TSUnionType':
      for (const m of type.types) collectMembers(m, decls, out, seen);
      return;
    case 'TSParenthesizedType':
      collectMembers(type.typeAnnotation, decls, out, seen);
      return;
    case 'TSTypeReference':
      if (type.typeName.type === 'Identifier') collectNamed(type.typeName.name, decls, out, seen);
      collectMembers(type.typeParameters, decls, out, seen);
      return;
    default:
      return;
  }
}

function addSignatures(members: t.TSTypeElement[], out: Map<string, t.TSPropertySignature>): void {
  for (const m of members) {
    if (m.type === 'TSPropertySignature' && m.key.type === 'Identifier' && !out.has(m.key.name)) {
      out.set(m.key.name, m);
    }
  }
}

function collectNamed(name: string, decls: Decls, out: Map<string, t.TSPropertySignature>, seen: Set<string>): void {
  if (seen.has(name)) return;
  seen.add(name);
  const decl = decls.get(name);
  if (decl === undefined) return;
  if (decl.type === 'TSInterfaceDeclaration') {
    addSignatures(decl.body.body, out);
    for (const parent of decl.extends ?? []) {
      if (parent.expression.type === 'Identifier') collectNamed(parent.expression.name, decls, out, seen);
    }
  } else {
    collectMembers(decl.typeAnnotation, decls, out, seen);
  }
}

function literalOf(node: t.Node | null | undefined): Literal | undefined {
  if (node === null || node === undefined) return undefined;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'NumericLiteral') return node.value;
  if (node.type === 'BooleanLiteral') return node.value;
  return undefined;
}

/** `Button.defaultProps = { size: 'md' }` at the top level of the file. */
function defaultPropsFor(ast: Ast, componentName: string): Map<string, Literal> {
  const out = new Map<string, Literal>();
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ExpressionStatement') continue;
    const e = stmt.expression;
    if (
      e.type === 'AssignmentExpression' &&
      e.left.type === 'MemberExpression' &&
      e.left.object.type === 'Identifier' &&
      e.left.object.name === componentName &&
      e.left.property.type === 'Identifier' &&
      e.left.property.name === 'defaultProps' &&
      e.right.type === 'ObjectExpression'
    ) {
      for (const p of e.right.properties) {
        if (p.type !== 'ObjectProperty' || p.key.type !== 'Identifier') continue;
        const value = literalOf(p.value);
        if (value !== undefined) out.set(p.key.name, value);
      }
    }
  }
  return out;
}

/**
 * Every prop the mapped component declares, with its accepted values and
 * default. The same component choice and the same props sources as CO9: the
 * first parameter's annotation, the wrapper's type arguments, and the
 * conventional `<Name>Props`.
 */
export function collectCodePropShapes(ast: Ast, componentName: string): Map<string, CodePropShape> {
  const decls = collectTypeDeclarations(ast);
  const shapes = new Map<string, CodePropShape>();
  for (const c of chooseComponents(ast, componentName)) {
    const members = new Map<string, t.TSPropertySignature>();
    const seen = new Set<string>();
    const defaults = new Map<string, Literal>(defaultPropsFor(ast, c.name));

    const first = c.fn.params[0];
    if (first !== undefined) {
      const target = first.type === 'AssignmentPattern' ? first.left : first;
      if (target.type === 'ObjectPattern' || target.type === 'Identifier') {
        collectMembers(target.typeAnnotation as t.TSTypeAnnotation | null | undefined, decls, members, seen);
      }
      if (target.type === 'ObjectPattern') {
        for (const p of target.properties) {
          if (p.type !== 'ObjectProperty' || p.key.type !== 'Identifier') continue;
          if (p.value.type === 'AssignmentPattern') {
            const value = literalOf(p.value.right);
            if (value !== undefined) defaults.set(p.key.name, value);
          }
        }
      }
    }
    for (const hint of c.typeHints) collectMembers(hint, decls, members, seen);
    collectNamed(`${c.name}Props`, decls, members, seen);

    for (const [name, sig] of members) {
      const type = sig.typeAnnotation?.typeAnnotation;
      shapes.set(name, {
        name,
        values: literalValues(type, decls, new Set()),
        boolean: isBooleanType(type),
        optional: sig.optional === true,
        defaultValue: defaults.get(name),
      });
    }
  }
  return shapes;
}

/** One Figma property definition, read defensively: the API's shapes are loose. */
interface FigmaProp {
  key: string;
  type: string | null;
  options: string[] | null;
  defaultValue: Literal | undefined;
}

function figmaProps(defs: Record<string, unknown>): FigmaProp[] {
  return Object.entries(defs).map(([key, def]) => {
    const d = (typeof def === 'object' && def !== null ? def : {}) as Record<string, unknown>;
    const opts = Array.isArray(d.variantOptions)
      ? d.variantOptions.filter((x): x is string => typeof x === 'string')
      : null;
    const dv = d.defaultValue;
    return {
      key,
      type: typeof d.type === 'string' ? d.type : null,
      options: opts,
      defaultValue: typeof dv === 'string' || typeof dv === 'boolean' || typeof dv === 'number' ? dv : undefined,
    };
  });
}

/**
 * Compare a value across the two sides: case-insensitive, punctuation
 * ignored, so `Large`/`large` and `x-large`/`xLarge` agree. Never more than
 * that — `lg` does not match `large`. A value only matches a value.
 */
function norm(value: Literal): string {
  return String(value).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

/** Display a Figma key without the `#1:2` suffix Figma adds. */
function display(key: string): string {
  return key.split('#')[0];
}

/** Pairs of a Figma property and the code prop it maps to, by CO9's rule. */
function paired(facts: CodeFacts): { figma: FigmaProp; code: CodePropShape }[] | null {
  const defs = facts.figmaPropertyDefinitions;
  if (defs === null || defs === undefined) return null;
  const shapes = collectCodePropShapes(facts.ast, facts.componentName);
  const byNorm = new Map<string, CodePropShape>();
  for (const s of shapes.values()) byNorm.set(normalisePropName(s.name), s);
  const out: { figma: FigmaProp; code: CodePropShape }[] = [];
  for (const figma of figmaProps(defs)) {
    const code = byNorm.get(normalisePropName(figma.key));
    if (code !== undefined) out.push({ figma, code });
  }
  return out;
}

const BOOLEAN_OPTIONS = new Set(['true', 'false', 'on', 'off', 'yes', 'no']);

/**
 * CO14 — a Figma variant offers the same values as the code prop it maps to.
 *
 * A Figma variant whose options are `True` / `False` and a code prop typed
 * `boolean` agree: that is how Figma spells a boolean variant. A code prop
 * whose type is open (`string`) or not readable has nothing to compare and
 * sits out, as does a Figma property with no code counterpart (CO9's
 * finding, not this one's).
 */
export function checkVariantValues(facts: CodeFacts): CheckResult {
  const pairs = paired(facts);
  if (pairs === null) return { answer: 'N/A', evidence: 'no Figma node resolved for this component' };

  const compared: string[] = [];
  const mismatches: string[] = [];
  for (const { figma, code } of pairs) {
    if (figma.type !== 'VARIANT' || figma.options === null || figma.options.length === 0) continue;
    const figmaNorm = figma.options.map(norm);
    if (code.boolean && figmaNorm.every((o) => BOOLEAN_OPTIONS.has(o))) {
      compared.push(display(figma.key));
      continue;
    }
    if (code.values === null) continue;
    compared.push(display(figma.key));
    const codeNorm = code.values.map(norm);
    const onlyFigma = figma.options.filter((o) => !codeNorm.includes(norm(o)));
    const onlyCode = code.values.filter((v) => !figmaNorm.includes(norm(v)));
    if (onlyFigma.length === 0 && onlyCode.length === 0) continue;
    const parts: string[] = [];
    if (onlyFigma.length > 0) parts.push(`Figma has ${onlyFigma.join(', ')} that code does not accept`);
    if (onlyCode.length > 0) parts.push(`code accepts ${onlyCode.join(', ')} that Figma does not offer`);
    mismatches.push(`${display(figma.key)}: ${parts.join('; ')}`);
  }

  if (compared.length === 0) {
    return {
      answer: 'N/A',
      evidence: 'no Figma variant property maps to a code prop with a closed set of values',
    };
  }
  if (mismatches.length > 0) {
    return {
      answer: 'No',
      evidence: `${mismatches.length} of ${compared.length} variant propert(ies) disagree — ${mismatches.join(' | ')}`,
    };
  }
  return {
    answer: 'Yes',
    evidence: `all ${compared.length} variant propert(ies) offer the same values in Figma and code: ${compared.join(', ')}`,
  };
}

/**
 * CO15 — a component opens in the same state in Figma and in code.
 *
 * Only `VARIANT` and `BOOLEAN` properties are compared. A `TEXT` property's
 * default is placeholder content — "Button label" — not a state, and code
 * rarely defaults its label at all, so comparing them would flag nearly
 * every component for something that is not drift.
 *
 * A boolean prop with no declared default is `false`, because that is what
 * an absent boolean is. A variant prop with no declared default has no
 * comparable value — the component may fall back internally, and guessing
 * which would be inventing the answer — so it sits out.
 */
export function checkDefaultValues(facts: CodeFacts): CheckResult {
  const pairs = paired(facts);
  if (pairs === null) return { answer: 'N/A', evidence: 'no Figma node resolved for this component' };

  const compared: string[] = [];
  const mismatches: string[] = [];
  for (const { figma, code } of pairs) {
    if (figma.defaultValue === undefined) continue;
    let codeDefault: Literal | undefined = code.defaultValue;
    if (figma.type === 'BOOLEAN') {
      if (!code.boolean && typeof codeDefault !== 'boolean') continue;
      if (codeDefault === undefined) codeDefault = false;
    } else if (figma.type === 'VARIANT') {
      if (codeDefault === undefined) continue;
    } else {
      continue;
    }
    compared.push(display(figma.key));
    if (norm(figma.defaultValue) !== norm(codeDefault)) {
      const implied = code.defaultValue === undefined ? ' (no default declared, so false)' : '';
      mismatches.push(
        `${display(figma.key)}: Figma defaults to ${String(figma.defaultValue)}, code to ${String(codeDefault)}${implied}`,
      );
    }
  }

  if (compared.length === 0) {
    return {
      answer: 'N/A',
      evidence: 'no Figma variant or boolean property maps to a code prop with a declared default',
    };
  }
  if (mismatches.length > 0) {
    return {
      answer: 'No',
      evidence: `${mismatches.length} of ${compared.length} default(s) disagree — ${mismatches.join(' | ')}`,
    };
  }
  return {
    answer: 'Yes',
    evidence: `all ${compared.length} compared default(s) agree in Figma and code: ${compared.join(', ')}`,
  };
}

export const PARITY_CHECKS: Record<string, CodeCheck> = {
  'code.figma-variant-values': checkVariantValues,
  'code.figma-default-values': checkDefaultValues,
};
