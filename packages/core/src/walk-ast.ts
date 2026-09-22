import type * as t from '@babel/types';

/**
 * Minimal recursive AST walk. @babel/traverse would do this too, but it is a
 * heavy dependency with its own scope-tracking machinery and none of these
 * checks need scope — a dozen lines beats another package in the tree.
 */
export function walkAst(node: unknown, visit: (n: t.Node) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  const candidate = node as { type?: unknown };
  if (typeof candidate.type === 'string') {
    visit(node as t.Node);
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    if (value !== null && typeof value === 'object') walkAst(value, visit);
  }
}

/** JSX attribute name as written, e.g. `aria-label`, `className`, `{...rest}` → null. */
export function attributeName(attr: t.JSXAttribute | t.JSXSpreadAttribute): string | null {
  if (attr.type !== 'JSXAttribute') return null;
  const name = attr.name;
  if (name.type === 'JSXIdentifier') return name.name;
  return `${name.namespace.name}:${name.name.name}`;
}

/** `<div>` → "div", `<Table.Row>` → "Table.Row", `<Button>` → "Button". */
export function elementName(node: t.JSXOpeningElement): string {
  const name = node.name;
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') {
    const parts: string[] = [];
    let cur: t.JSXMemberExpression | t.JSXIdentifier = name;
    while (cur.type === 'JSXMemberExpression') {
      parts.unshift(cur.property.name);
      cur = cur.object;
    }
    parts.unshift(cur.name);
    return parts.join('.');
  }
  return `${name.namespace.name}:${name.name.name}`;
}

/** Host elements are lowercase (`div`); components are capitalised (`Button`). */
export function isHostElement(name: string): boolean {
  const first = name[0];
  return first !== undefined && first === first.toLowerCase() && first !== first.toUpperCase();
}

export function hasAttribute(node: t.JSXOpeningElement, predicate: (name: string) => boolean): boolean {
  return node.attributes.some((attr) => {
    const name = attributeName(attr);
    return name !== null && predicate(name);
  });
}

/** True when the element spreads props (`{...rest}`) — a11y attrs may arrive that way. */
export function hasSpread(node: t.JSXOpeningElement): boolean {
  return node.attributes.some((attr) => attr.type === 'JSXSpreadAttribute');
}
