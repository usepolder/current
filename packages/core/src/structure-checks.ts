import type * as t from '@babel/types';
import {
  CODE_CHECKS,
  chooseComponents,
  type CheckResult,
  type CodeCheck,
  type CodeFacts,
  type ComponentCandidate,
} from './code-checks';
import { attributeName, elementName, walkAst } from './walk-ast';

/**
 * Checks on how a component is BUILT, as opposed to what it renders.
 *
 * Every one of these asks the same thing from a different angle: can a
 * product team use this component as it is, or will they have to wrap it,
 * fork it or override it from outside? Those are the moments a design system
 * starts to drift, and Drift (the sibling tool) only finds them afterwards, in
 * product code. These find the cause, in the component.
 */

/** JSX opening elements inside one function, not the whole file. */
function jsxIn(fn: t.Function): t.JSXOpeningElement[] {
  const out: t.JSXOpeningElement[] = [];
  walkAst(fn.body, (n) => {
    if (n.type === 'JSXOpeningElement') out.push(n);
  });
  return out;
}

/**
 * Elements that render nothing of their own: fragments, and context
 * providers. A component made only of these is a provider or a passthrough,
 * which has no element to extend.
 */
function isStructuralOnly(name: string): boolean {
  return name === 'Fragment' || name === 'React.Fragment' || /(^|\.)Provider$/.test(name);
}

/** How the component receives its props. */
interface PropsShape {
  /** `function X(props)` — the whole object's name. */
  objectName: string | null;
  /** `function X({ a, ...rest })` — the rest element's name. */
  restName: string | null;
  /** Keys destructured by name: `a` above. */
  destructured: Set<string>;
}

function propsShape(fn: t.Function): PropsShape {
  const shape: PropsShape = { objectName: null, restName: null, destructured: new Set() };
  const first = fn.params[0];
  if (first === undefined) return shape;
  const target = first.type === 'AssignmentPattern' ? first.left : first;
  if (target.type === 'Identifier') {
    shape.objectName = target.name;
  } else if (target.type === 'ObjectPattern') {
    for (const prop of target.properties) {
      if (prop.type === 'RestElement' && prop.argument.type === 'Identifier') {
        shape.restName = prop.argument.name;
      } else if (prop.type === 'ObjectProperty' && prop.key.type === 'Identifier') {
        shape.destructured.add(prop.key.name);
      }
    }
  }
  return shape;
}

/** Does this expression mention `className`, directly or as `props.className`? */
function mentionsClassName(expr: t.Node, objectName: string | null): boolean {
  let found = false;
  walkAst(expr, (n) => {
    if (n.type === 'Identifier' && n.name === 'className') found = true;
    if (
      n.type === 'MemberExpression' &&
      n.property.type === 'Identifier' &&
      n.property.name === 'className' &&
      n.object.type === 'Identifier' &&
      n.object.name === objectName
    ) {
      found = true;
    }
  });
  return found;
}

/** `{...rest}` or `{...props}`: the consumer's leftover props landing on an element. */
function receivesProps(el: t.JSXOpeningElement, shape: PropsShape): boolean {
  return el.attributes.some(
    (a) =>
      a.type === 'JSXSpreadAttribute' &&
      a.argument.type === 'Identifier' &&
      (a.argument.name === shape.restName || a.argument.name === shape.objectName),
  );
}

function attribute(el: t.JSXOpeningElement, name: string): t.JSXAttribute | null {
  for (const a of el.attributes) {
    if (a.type === 'JSXAttribute' && attributeName(a) === name) return a;
  }
  return null;
}

/**
 * CO16 — the component can be extended without forking it.
 *
 * Three things, each of which a product team otherwise rebuilds:
 *
 *   1. It forwards its ref. Without one a consumer cannot focus, measure or
 *      position the element, so they wrap it or copy it.
 *   2. It passes props it does not know about to an element. A `data-*`
 *      attribute, an event handler, an `aria-*` the author did not foresee:
 *      if they are dropped, the consumer cannot use the component for the
 *      case they have.
 *   3. It merges a consumer's `className` with its own, rather than dropping
 *      it or letting it replace the component's own class.
 *
 * Forwarding a ref means different things on different React versions, and
 * getting that wrong produces a confident answer in either direction. From
 * React 19 `ref` is an ordinary prop, so a component that spreads its rest
 * props onto an element already forwards it. On 18 it is not, and the same
 * code silently drops the ref. So the spread counts only when the system
 * declares React 19 or later for every version it supports — `^18 || ^19`
 * must work on 18 — and an undeclared version is treated as 18, the version
 * where the spread is not enough. A false Yes here is the worse error: a team
 * that has it never looks.
 *
 * Spreading onto a child COMPONENT rather than a DOM element counts as
 * passing props on. Whether that child forwards them further is its own
 * CO16, and charging this one for it would score the same gap twice.
 */
export function checkExtensible(facts: CodeFacts): CheckResult {
  const chosen = chooseComponents(facts.ast, facts.componentName);
  if (chosen.length === 0) {
    return { answer: 'N/A', evidence: 'no component function found in the entry file' };
  }
  const component: ComponentCandidate =
    chosen.find((c) => c.name === facts.componentName) ?? chosen[0];

  const elements = jsxIn(component.fn);
  const rendered = elements.filter((el) => !isStructuralOnly(elementName(el)));
  if (rendered.length === 0) {
    return {
      answer: 'N/A',
      evidence:
        elements.length === 0
          ? `${component.name} renders no JSX, so there is no element to extend`
          : `${component.name} renders only providers or fragments, so there is no element to extend`,
    };
  }

  const shape = propsShape(component.fn);
  const targets = rendered.filter((el) => receivesProps(el, shape));
  const failures: string[] = [];
  const passes: string[] = [];

  // 2. Unknown props reach an element.
  const spreadName = shape.restName ?? shape.objectName;
  if (targets.length === 0) {
    failures.push(
      spreadName === null
        ? 'drops props it does not declare: there is no `...rest` to pass on'
        : `drops props it does not declare: \`${spreadName}\` is never spread onto an element`,
    );
  } else {
    passes.push(`passes unknown props to <${elementName(targets[0])}>`);
  }

  // 1. The ref.
  const react = facts.project?.reactMajor ?? null;
  if (component.wrappers.includes('forwardRef')) {
    passes.push('forwards its ref with forwardRef');
  } else if (
    shape.destructured.has('ref') &&
    rendered.some((el) => attribute(el, 'ref') !== null)
  ) {
    passes.push('passes its ref prop to an element');
  } else if (react !== null && react >= 19 && targets.length > 0) {
    passes.push(`forwards its ref through the spread (React ${react}, where ref is a prop)`);
  } else {
    // The version only matters when there is a spread it could have counted.
    const why =
      targets.length === 0
        ? ''
        : react === null
          ? ' (no package.json declares React, so it is judged as React 18, where spreading props does not carry a ref)'
          : ` (on React ${react} spreading props does not carry a ref)`;
    failures.push(`does not forward a ref${why}`);
  }

  // 3. className is merged, not dropped or replaced.
  const clobbered = targets.filter((el) => {
    const cls = attribute(el, 'className');
    return cls !== null && (cls.value == null || !mentionsClassName(cls.value, shape.objectName));
  });
  const destructuredButUnused =
    shape.destructured.has('className') &&
    !rendered.some((el) => {
      const cls = attribute(el, 'className');
      return cls !== null && cls.value != null && mentionsClassName(cls.value, shape.objectName);
    });
  if (clobbered.length > 0) {
    failures.push(
      `does not merge a consumer's className on <${elementName(clobbered[0])}>: ` +
        'its own className and the spread overwrite one another',
    );
  } else if (destructuredButUnused) {
    failures.push("takes a className prop and never applies it, so a consumer's class is dropped");
  } else if (targets.length > 0 || shape.destructured.has('className')) {
    passes.push('keeps a consumer’s className');
  }

  if (failures.length > 0) {
    return { answer: 'No', evidence: `${component.name} ${failures.join('; and ')}` };
  }
  return { answer: 'Yes', evidence: `${component.name} ${passes.join(', ')}` };
}

export const STRUCTURE_CHECKS: Record<string, CodeCheck> = {
  'code.extensible': checkExtensible,
};

/**
 * Every code check, source-reading and structural alike. Assembled here
 * rather than in code-checks.ts because this module imports from that one:
 * registering it there would make the two import each other.
 */
export const ALL_CODE_CHECKS: Record<string, CodeCheck> = {
  ...CODE_CHECKS,
  ...STRUCTURE_CHECKS,
};
