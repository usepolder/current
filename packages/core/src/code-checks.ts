import type * as t from '@babel/types';
import type { Ast } from './parse';
import type { Answer } from './metrics';
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

/** CO7 — component uses tokens rather than hardcoded colour/spacing values. */
export function checkTokenUsage(facts: CodeFacts): CheckResult {
  const literals: string[] = [];
  walkAst(facts.ast.program, (node) => {
    if (node.type === 'StringLiteral') literals.push(node.value);
    else if (node.type === 'TemplateElement') literals.push(node.value.raw);
  });
  const haystack = literals.join('\n');
  const hexes = haystack.match(HEX_COLOR) ?? [];
  const pxs = haystack.match(PX_VALUE) ?? [];
  const total = hexes.length + pxs.length;
  if (total === 0) {
    return { answer: 'Yes', evidence: 'no hardcoded hex colours or px values in source literals' };
  }
  const sample = [...new Set([...hexes, ...pxs])].slice(0, 5).join(', ');
  return {
    answer: 'No',
    evidence: `${hexes.length} hardcoded hex colour(s) and ${pxs.length} px value(s) (e.g. ${sample})`,
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

/** Prop names from a `*Props` type/interface plus destructured component params. */
export function collectCodePropNames(ast: Ast): string[] {
  const names = new Set<string>();

  walkAst(ast.program, (node) => {
    if (node.type === 'TSInterfaceDeclaration' && /Props$/.test(node.id.name)) {
      for (const member of node.body.body) {
        if (member.type === 'TSPropertySignature' && member.key.type === 'Identifier') {
          names.add(member.key.name);
        }
      }
      return;
    }
    if (
      node.type === 'TSTypeAliasDeclaration' &&
      /Props$/.test(node.id.name) &&
      node.typeAnnotation.type === 'TSTypeLiteral'
    ) {
      for (const member of node.typeAnnotation.members) {
        if (member.type === 'TSPropertySignature' && member.key.type === 'Identifier') {
          names.add(member.key.name);
        }
      }
      return;
    }
    if (node.type === 'ObjectPattern') {
      for (const prop of node.properties) {
        if (prop.type === 'ObjectProperty' && prop.key.type === 'Identifier') {
          names.add(prop.key.name);
        }
      }
    }
  });

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
  const codeProps = new Set(collectCodePropNames(facts.ast).map(normalisePropName));
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

export const CODE_CHECKS: Record<string, (facts: CodeFacts) => CheckResult> = {
  'code.aria-attributes': checkAriaAttributes,
  'code.text-alternatives': checkTextAlternatives,
  'code.token-usage': checkTokenUsage,
  'code.semantic-name': checkSemanticName,
  'code.figma-prop-parity': checkFigmaPropParity,
};
