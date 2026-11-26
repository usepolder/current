import * as path from 'path';
import type * as t from '@babel/types';
import {
  CODE_CHECKS,
  chooseComponents,
  type CheckResult,
  type CodeCheck,
  type CodeFacts,
  type ComponentCandidate,
} from './code-checks';
import { importSpecifiers } from './related-files';
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

/**
 * Attributes whose value is presented to a person: read out by a screen
 * reader, shown as a tooltip or placeholder, or substituted for an image.
 * Hardcoding any of these locks the consumer into the component's wording
 * exactly as hardcoded children do. This is a reusability claim, not an
 * accessibility one: the question is whether the consumer can change it.
 */
const COPY_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
]);

/**
 * Elements whose children are message SOURCE for a translation library, not
 * hardcoded copy: `<Trans>Save changes</Trans>` is extracted into a catalogue
 * and translated, which is the opposite of locking the wording in.
 */
const TRANSLATION_ELEMENTS = new Set(['Trans', 'FormattedMessage', 'Translate', 'T']);

/** Children of these are not copy at all. */
const NON_TEXT_ELEMENTS = new Set(['style', 'script']);

/** Text a person would read: it contains a letter. `×`, `/`, `…`, `2` are not copy. */
function isCopy(text: string): boolean {
  return /\p{L}/u.test(text);
}

/**
 * The strings an expression can put on screen, and only those.
 *
 * Deliberately narrow. A string passed to a function is an argument, not
 * output — `{t('dialog.close')}` is a translation key, `{cn('a', 'b')}` is
 * class names — and a string in a comparison (`state === 'open'`) is never
 * rendered. Only a literal standing where a value is produced counts: the
 * expression itself, either branch of a ternary, or the value side of `&&`,
 * `||` and `??`.
 */
function renderedStrings(expr: t.Node | null | undefined): string[] {
  if (expr === null || expr === undefined) return [];
  switch (expr.type) {
    case 'StringLiteral':
      return [expr.value];
    case 'TemplateLiteral':
      return [expr.quasis.map((q) => q.value.cooked ?? q.value.raw).join('')];
    case 'ConditionalExpression':
      return [...renderedStrings(expr.consequent), ...renderedStrings(expr.alternate)];
    case 'LogicalExpression':
      return expr.operator === '&&'
        ? renderedStrings(expr.right)
        : [...renderedStrings(expr.left), ...renderedStrings(expr.right)];
    case 'JSXExpressionContainer':
      return expr.expression.type === 'JSXEmptyExpression' ? [] : renderedStrings(expr.expression);
    default:
      return [];
  }
}

/** One piece of hardcoded copy, as the evidence quotes it. */
function quote(text: string, attribute?: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const short = flat.length > 30 ? `${flat.slice(0, 29)}…` : flat;
  return attribute === undefined ? `"${short}"` : `${attribute}="${short}"`;
}

/**
 * CO17 — the component does not lock in its own words.
 *
 * Text written directly into a component's markup is text a consumer cannot
 * change. A Dialog rendering a literal "Close" works for one product, in one
 * language, with one tone of voice, and every other product forks it — and
 * it cannot be translated at all. The fix is always the same: take the text
 * as a prop or as children, or from a message function.
 *
 * A prop DEFAULT is not hardcoded copy: `function Dialog({ closeLabel =
 * 'Close' })` renders `{closeLabel}`, and the consumer can override it. That
 * falls out of reading only what is rendered — the literal sits in the
 * parameter list, not in the markup.
 */
export function checkNoHardcodedCopy(facts: CodeFacts): CheckResult {
  const chosen = chooseComponents(facts.ast, facts.componentName);
  if (chosen.length === 0) {
    return { answer: 'N/A', evidence: 'no component function found in the entry file' };
  }
  const component = chosen.find((c) => c.name === facts.componentName) ?? chosen[0];

  const found: string[] = [];
  let sawJsx = false;

  const visitElement = (el: t.JSXElement): void => {
    sawJsx = true;
    const name = elementName(el.openingElement);

    for (const attr of el.openingElement.attributes) {
      if (attr.type !== 'JSXAttribute') continue;
      const attrName = attributeName(attr);
      if (attrName === null || !COPY_ATTRIBUTES.has(attrName)) continue;
      for (const text of renderedStrings(attr.value)) {
        if (isCopy(text)) found.push(quote(text, attrName));
      }
    }

    if (NON_TEXT_ELEMENTS.has(name) || TRANSLATION_ELEMENTS.has(name)) return;
    for (const child of el.children) {
      if (child.type === 'JSXText') {
        if (isCopy(child.value)) found.push(quote(child.value));
      } else if (child.type === 'JSXExpressionContainer') {
        for (const text of renderedStrings(child)) {
          if (isCopy(text)) found.push(quote(text));
        }
      }
    }
  };

  walkAst(component.fn.body, (n) => {
    if (n.type === 'JSXElement') visitElement(n);
    if (n.type === 'JSXFragment') {
      sawJsx = true;
      for (const child of n.children) {
        if (child.type === 'JSXText' && isCopy(child.value)) found.push(quote(child.value));
      }
    }
  });

  if (!sawJsx) {
    return { answer: 'N/A', evidence: `${component.name} renders no JSX` };
  }
  if (found.length === 0) {
    return {
      answer: 'Yes',
      evidence: `${component.name} renders no hardcoded copy: its text arrives as props, children or messages`,
    };
  }
  const unique = [...new Set(found)];
  return {
    answer: 'No',
    evidence:
      `${component.name} hardcodes ${unique.length} piece(s) of copy a consumer cannot change ` +
      `or translate: ${unique.slice(0, 5).join(', ')}`,
  };
}

/** Is `child` inside `parent` (or `parent` itself)? Both absolute. */
function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `src/Button/Button.tsx` without its extension, for comparing import targets. */
function withoutExt(file: string): string {
  return file.replace(/\.[cm]?[jt]sx?$/, '');
}

/**
 * Is `target` one of a component's PUBLIC entry points: its folder (which a
 * bundler resolves to `index`), an index file in it, or its entry file?
 */
function isPublicEntry(target: string, entry: string): boolean {
  const dir = path.dirname(entry);
  const bare = withoutExt(target);
  return (
    target === dir ||
    bare === withoutExt(entry) ||
    bare === path.join(dir, 'index')
  );
}

/**
 * CO18 — the component's imports point in the right direction.
 *
 * A design system's components should depend on the system and on packages,
 * nothing else. Two kinds of import break that, and both leave a component
 * that cannot be reused on its own and breaks when something it should not
 * know about changes:
 *
 *   1. Leaving the system. A relative import that climbs out of the
 *      directory holding `.polder.yml` — `../../../app/hooks/useUser` —
 *      couples the component to the product it was meant to serve.
 *   2. Reaching into another component. `../Button/internal/useRipple`
 *      depends on how Button is built today, not on what Button promises;
 *      `../Button` (its folder, resolved to its index) or its entry file is
 *      the public way in.
 *
 * Read across every file that belongs to the component — its entry file and
 * the sub-modules it imports from its own folder — because coupling in a
 * helper file is still the component's coupling.
 *
 * What it cannot see: aliased imports (`@/components/...`, `~/lib`). Those
 * need the project's tsconfig `paths` or bundler config to resolve, and a
 * guess would turn an alias into a false finding. They are not judged, and
 * the evidence says how many were skipped. Package imports are always fine.
 *
 * The internals rule stands down where it cannot tell anything apart. When
 * two components share a folder (`components/Button.tsx` next to
 * `components/Card.tsx`), "inside Button's folder" is also "inside Card's own
 * folder", so every import Card makes would look like it reached into
 * Button. Such a component is judged only on the first rule.
 */
export function checkDependencyDirection(facts: CodeFacts): CheckResult {
  const project = facts.project;
  if (project === undefined) {
    return { answer: 'N/A', evidence: 'no project facts: the design system root is unknown' };
  }

  const files: { abs: string; label: string; ast: CodeFacts['ast'] }[] = [
    { abs: project.entryPath, label: facts.filePath, ast: facts.ast },
  ];
  for (const f of facts.related?.files ?? []) {
    if (f.kind === 'script' && f.ast !== null) {
      files.push({ abs: path.resolve(project.root, f.filePath), label: f.filePath, ast: f.ast });
    }
  }

  const ownDir = path.dirname(project.entryPath);
  // Other components whose folder is distinct from this one's: only there
  // does "inside its folder" mean "its internals".
  const others = [...project.otherEntries].filter(([, entry]) => {
    const dir = path.dirname(entry);
    return !within(ownDir, dir) && !within(dir, ownDir);
  });

  const outside: string[] = [];
  const internals: string[] = [];
  let relative = 0;
  let aliased = 0;

  for (const file of files) {
    for (const spec of importSpecifiers(file.ast)) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        // Bare package names are fine. Aliases look like packages but are
        // not, and cannot be resolved without the project's config.
        if (/^[@~#]\//.test(spec) || spec.startsWith('src/')) aliased++;
        continue;
      }
      relative++;
      const target = path.resolve(path.dirname(file.abs), spec);
      if (!within(target, project.root)) {
        outside.push(`${file.label} imports '${spec}'`);
        continue;
      }
      for (const [name, entry] of others) {
        if (within(target, path.dirname(entry)) && !isPublicEntry(target, entry)) {
          internals.push(`${file.label} imports '${spec}' from inside ${name}`);
          break;
        }
      }
    }
  }

  const skipped =
    aliased === 0 ? '' : ` (${aliased} aliased import(s) not judged: aliases need the project config to resolve)`;

  if (outside.length > 0 || internals.length > 0) {
    const parts: string[] = [];
    if (outside.length > 0) {
      parts.push(`${outside.length} import(s) leave the design system: ${outside.slice(0, 3).join('; ')}`);
    }
    if (internals.length > 0) {
      parts.push(
        `${internals.length} import(s) reach into another component instead of its entry: ` +
          internals.slice(0, 3).join('; '),
      );
    }
    return { answer: 'No', evidence: `${parts.join('. ')}${skipped}` };
  }

  return {
    answer: 'Yes',
    evidence:
      relative === 0
        ? `no relative imports across ${files.length} file(s), so nothing crosses a boundary${skipped}`
        : `all ${relative} relative import(s) across ${files.length} file(s) stay inside the system, ` +
          `and none reaches into another component${skipped}`,
  };
}

export const STRUCTURE_CHECKS: Record<string, CodeCheck> = {
  'code.extensible': checkExtensible,
  'code.no-hardcoded-copy': checkNoHardcodedCopy,
  'code.dependency-direction': checkDependencyDirection,
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
