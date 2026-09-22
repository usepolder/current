import type { CheckResult } from './code-checks';
import type { FigmaNode } from './figma-client';

export interface DesignFacts {
  componentName: string;
  node: FigmaNode;
}

/** Every node in the subtree, the component itself first. */
export function flatten(node: FigmaNode): FigmaNode[] {
  const out: FigmaNode[] = [];
  const visit = (n: FigmaNode): void => {
    out.push(n);
    for (const child of n.children ?? []) visit(child);
  };
  visit(node);
  return out;
}

function boundKeys(node: FigmaNode): string[] {
  return Object.keys(node.boundVariables ?? {});
}

function styleKeys(node: FigmaNode): string[] {
  return Object.keys(node.styles ?? {});
}

/** Shared shape: is any node in the subtree binding this kind of token? */
function tokenCheck(
  node: FigmaNode,
  opts: {
    label: string;
    boundVariableKeys: readonly string[];
    styleKeys?: readonly string[];
    /** Nodes this metric applies to at all; empty means N/A. */
    applies: (n: FigmaNode) => boolean;
  },
): CheckResult {
  const nodes = flatten(node).filter(opts.applies);
  if (nodes.length === 0) {
    return { answer: 'N/A', evidence: `no layers in this component use ${opts.label}` };
  }
  const bound = nodes.filter(
    (n) =>
      boundKeys(n).some((k) => opts.boundVariableKeys.includes(k)) ||
      styleKeys(n).some((k) => (opts.styleKeys ?? []).includes(k)),
  );
  if (bound.length === nodes.length) {
    return { answer: 'Yes', evidence: `all ${nodes.length} relevant layer(s) bind ${opts.label}` };
  }
  if (bound.length === 0) {
    return {
      answer: 'No',
      evidence: `none of the ${nodes.length} relevant layer(s) bind ${opts.label} — raw values only`,
    };
  }
  return {
    answer: 'No',
    evidence: `${nodes.length - bound.length} of ${nodes.length} layer(s) use raw ${opts.label} instead of a token`,
  };
}

/** DE1 — colour tokens (bound variables or a shared fill/stroke style). */
export function checkColorTokens(facts: DesignFacts): CheckResult {
  return tokenCheck(facts.node, {
    label: 'colour tokens',
    boundVariableKeys: ['fills', 'strokes'],
    styleKeys: ['fill', 'fills', 'stroke', 'strokes'],
    applies: (n) => (n.fills?.length ?? 0) > 0 || (n.strokes?.length ?? 0) > 0,
  });
}

/** DE3 — typography tokens on text layers. */
export function checkTypeTokens(facts: DesignFacts): CheckResult {
  return tokenCheck(facts.node, {
    label: 'typography tokens',
    boundVariableKeys: ['fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing'],
    styleKeys: ['text'],
    applies: (n) => n.type === 'TEXT',
  });
}

/** DE4 — spacing tokens on auto-layout frames. */
export function checkSpacingTokens(facts: DesignFacts): CheckResult {
  return tokenCheck(facts.node, {
    label: 'spacing tokens',
    boundVariableKeys: [
      'itemSpacing',
      'paddingLeft',
      'paddingRight',
      'paddingTop',
      'paddingBottom',
      'counterAxisSpacing',
    ],
    applies: (n) =>
      n.layoutMode !== undefined &&
      n.layoutMode !== 'NONE' &&
      [n.itemSpacing, n.paddingLeft, n.paddingRight, n.paddingTop, n.paddingBottom].some(
        (v) => typeof v === 'number' && v > 0,
      ),
  });
}

/** DE5 — border radius tokens. */
export function checkRadiusTokens(facts: DesignFacts): CheckResult {
  return tokenCheck(facts.node, {
    label: 'radius tokens',
    boundVariableKeys: [
      'cornerRadius',
      'topLeftRadius',
      'topRightRadius',
      'bottomLeftRadius',
      'bottomRightRadius',
    ],
    applies: (n) => typeof n.cornerRadius === 'number' && n.cornerRadius > 0,
  });
}

const DEFAULT_LAYER_NAME =
  /^(frame|group|rectangle|ellipse|vector|line|polygon|star|slice|component|instance|union|subtract|intersect|exclude)(\s+\d+)?$/i;

/** DE7 — layer names are semantic, not Figma's "Frame 427" defaults. */
export function checkLayerNames(facts: DesignFacts): CheckResult {
  // Skip the component node itself: its name is the component's name, judged
  // by the code-side semantic-name check instead.
  const layers = flatten(facts.node).slice(1);
  if (layers.length === 0) {
    return { answer: 'N/A', evidence: 'component has no child layers' };
  }
  const defaults = layers.filter((n) => DEFAULT_LAYER_NAME.test(n.name.trim()));
  if (defaults.length === 0) {
    return { answer: 'Yes', evidence: `all ${layers.length} child layer(s) are named` };
  }
  const sample = [...new Set(defaults.map((n) => n.name))].slice(0, 5).join(', ');
  return {
    answer: 'No',
    evidence: `${defaults.length} of ${layers.length} layer(s) keep Figma default names (e.g. ${sample})`,
  };
}

/** DE9 — interaction states connected, or built as an interactive component set. */
export function checkPrototyping(facts: DesignFacts): CheckResult {
  const nodes = flatten(facts.node);
  if (facts.node.type === 'COMPONENT_SET') {
    const variants = Object.keys(facts.node.componentPropertyDefinitions ?? {});
    return {
      answer: 'Yes',
      evidence:
        variants.length > 0
          ? `component set with ${variants.length} propert(ies): ${variants
              .map((v) => v.split('#')[0])
              .join(', ')}`
          : 'component set with variants',
    };
  }
  const wired = nodes.filter(
    (n) =>
      (typeof n.transitionNodeID === 'string' && n.transitionNodeID !== '') ||
      (Array.isArray(n.interactions) && n.interactions.length > 0),
  );
  if (wired.length > 0) {
    return { answer: 'Yes', evidence: `${wired.length} layer(s) have prototype interactions wired` };
  }
  return {
    answer: 'No',
    evidence: 'no prototype interactions and not an interactive component set',
  };
}

/** DE10 — built with Auto Layout. */
export function checkAutoLayout(facts: DesignFacts): CheckResult {
  const root = facts.node;
  // A component set delegates layout to its variants.
  const subjects =
    root.type === 'COMPONENT_SET' ? (root.children ?? []) : [root];
  if (subjects.length === 0) {
    return { answer: 'N/A', evidence: 'component set has no variants' };
  }
  const withAutoLayout = subjects.filter(
    (n) => typeof n.layoutMode === 'string' && n.layoutMode !== 'NONE',
  );
  if (withAutoLayout.length === subjects.length) {
    return {
      answer: 'Yes',
      evidence:
        subjects.length === 1
          ? `layoutMode is ${subjects[0].layoutMode}`
          : `all ${subjects.length} variant(s) use Auto Layout`,
    };
  }
  return {
    answer: 'No',
    evidence:
      subjects.length === 1
        ? 'layoutMode is NONE'
        : `${subjects.length - withAutoLayout.length} of ${subjects.length} variant(s) do not use Auto Layout`,
  };
}

/** Figma variant/component property names, for the code parity check. */
export function figmaPropertyNames(node: FigmaNode): string[] {
  const defs = node.componentPropertyDefinitions;
  if (defs && typeof defs === 'object') return Object.keys(defs);
  return [];
}

export const DESIGN_CHECKS: Record<string, (facts: DesignFacts) => CheckResult> = {
  'design.color-tokens': checkColorTokens,
  'design.type-tokens': checkTypeTokens,
  'design.spacing-tokens': checkSpacingTokens,
  'design.radius-tokens': checkRadiusTokens,
  'design.layer-names': checkLayerNames,
  'design.prototyping': checkPrototyping,
  'design.auto-layout': checkAutoLayout,
};
