import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODE_CHECKS,
  lowestMajor,
  parseSource,
  reactMajorFor,
  type CodeFacts,
  type ProjectFacts,
} from '@usepolder/current-core';

function project(overrides: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    root: '/ds',
    entryPath: '/ds/src/Button/Button.tsx',
    otherEntries: new Map(),
    reactMajor: 18,
    ...overrides,
  };
}

function facts(source: string, overrides: Partial<CodeFacts> = {}): CodeFacts {
  return {
    componentName: 'Button',
    filePath: 'src/Button/Button.tsx',
    source,
    ast: parseSource(source, 'src/Button/Button.tsx'),
    figmaPropertyNames: null,
    project: project(),
    ...overrides,
  };
}

describe('code.extensible (CO16)', () => {
  const check = CODE_CHECKS['code.extensible'];

  it('answers Yes for the textbook component', () => {
    const r = check(
      facts(`
        import { forwardRef } from 'react';
        import clsx from 'clsx';
        export const Button = forwardRef(function Button({ className, ...rest }, ref) {
          return <button ref={ref} className={clsx('btn', className)} {...rest} />;
        });
      `),
    );
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('forwardRef');
    expect(r.evidence).toContain('<button>');
  });

  it('accepts React.forwardRef and memo(forwardRef(...))', () => {
    for (const src of [
      `export const Button = React.forwardRef(({ ...rest }, ref) => <button ref={ref} {...rest} />);`,
      `export const Button = memo(forwardRef(({ ...rest }, ref) => <button ref={ref} {...rest} />));`,
    ]) {
      expect(check(facts(src)).answer).toBe('Yes');
    }
  });

  it('answers No with no ref forwarded on React 18, and says why the spread is not enough', () => {
    const r = check(facts(`export function Button({ ...rest }) { return <button {...rest} />; }`));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('does not forward a ref');
    expect(r.evidence).toContain('React 18');
  });

  // On React 19 ref is a plain prop, so the spread carries it.
  it('counts the spread as forwarding the ref on React 19', () => {
    const r = check(
      facts(`export function Button({ ...rest }) { return <button {...rest} />; }`, {
        project: project({ reactMajor: 19 }),
      }),
    );
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('React 19');
  });

  // An undeclared React is judged as 18: a false Yes is the worse error.
  it('judges an undeclared React as 18, and names the assumption', () => {
    const r = check(
      facts(`export function Button({ ...rest }) { return <button {...rest} />; }`, {
        project: project({ reactMajor: null }),
      }),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('no package.json declares React');
  });

  it('accepts a ref taken as a prop and passed to an element', () => {
    const r = check(
      facts(`export function Button({ ref, ...rest }) { return <button ref={ref} {...rest} />; }`),
    );
    expect(r.answer).toBe('Yes');
  });

  it('answers No when unknown props are dropped', () => {
    const r = check(
      facts(`
        export const Button = forwardRef(({ label, onClick }, ref) =>
          <button ref={ref} onClick={onClick}>{label}</button>);
      `),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('no `...rest`');
  });

  it('answers No when rest is collected but never spread', () => {
    const r = check(
      facts(`
        export const Button = forwardRef(({ label, ...rest }, ref) =>
          <button ref={ref}>{label}</button>);
      `),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('`rest` is never spread');
  });

  it('accepts spreading the whole props object', () => {
    const r = check(
      facts(`export const Button = forwardRef((props, ref) => <button ref={ref} {...props} />);`),
    );
    expect(r.answer).toBe('Yes');
  });

  // Whether a child forwards further is the child's own CO16.
  it('counts a spread onto a child component as passing props on', () => {
    const r = check(
      facts(`export const Button = forwardRef((props, ref) => <Pressable ref={ref} {...props} />);`),
    );
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('<Pressable>');
  });

  // The common bug: the component's own className and the spread overwrite
  // each other, whichever order they are in.
  it.each([
    `<button ref={ref} className="btn" {...rest} />`,
    `<button ref={ref} {...rest} className="btn" />`,
    `<button ref={ref} className={styles.root} {...rest} />`,
  ])('answers No when className is not merged: %s', (jsx) => {
    const r = check(facts(`export const Button = forwardRef(({ ...rest }, ref) => ${jsx});`));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain("does not merge a consumer's className");
  });

  it.each([
    'clsx("btn", className)',
    'cn("btn", className)',
    '`btn ${className ?? ""}`',
    '["btn", className].join(" ")',
  ])('accepts className merged with %s', (expr) => {
    const r = check(
      facts(
        `export const Button = forwardRef(({ className, ...rest }, ref) => <button ref={ref} className={${expr}} {...rest} />);`,
      ),
    );
    expect(r.answer).toBe('Yes');
  });

  it('accepts props.className when props are not destructured', () => {
    const r = check(
      facts(
        'export const Button = forwardRef((props, ref) => <button ref={ref} {...props} className={cx("btn", props.className)} />);',
      ),
    );
    expect(r.answer).toBe('Yes');
  });

  it('answers No when className is taken and never applied', () => {
    const r = check(
      facts(
        `export const Button = forwardRef(({ className, ...rest }, ref) => <button ref={ref} {...rest} />);`,
      ),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('never applies it');
  });

  it('reports every failure, not just the first', () => {
    const r = check(facts(`export function Button({ label }) { return <button className="btn">{label}</button>; }`));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('drops props');
    expect(r.evidence).toContain('does not forward a ref');
    // No spread, so the React version is beside the point and not mentioned.
    expect(r.evidence).not.toContain('React 18');
  });

  it('answers N/A for a provider, which has no element to extend', () => {
    const r = check(
      facts(
        `export function ThemeProvider({ children }) { return <ThemeContext.Provider value={1}>{children}</ThemeContext.Provider>; }`,
        { componentName: 'ThemeProvider' },
      ),
    );
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('providers or fragments');
  });

  it('answers N/A when no component function is found', () => {
    expect(check(facts(`export const tokens = { blue: '#00f' };`)).answer).toBe('N/A');
  });

  // Only the component's own JSX counts, not a helper's elsewhere in the file.
  it('judges the mapped component, not another one in the same file', () => {
    const r = check(
      facts(`
        function Icon() { return <svg />; }
        export const Button = forwardRef(({ ...rest }, ref) => <button ref={ref} {...rest} />);
      `),
    );
    expect(r.answer).toBe('Yes');
  });
});

describe('lowestMajor', () => {
  it.each([
    ['^18.2.0', 18],
    ['^18.2.0 || ^19.0.0', 18],
    ['>=17 <20', 17],
    ['18.x', 18],
    ['19', 19],
    ['~19.1.0', 19],
    ['>= 18', 18],
    ['v19.0.0', 19],
  ])('%s -> %i', (range, major) => {
    expect(lowestMajor(range)).toBe(major);
  });

  it.each(['*', 'latest', 'workspace:*', 'github:facebook/react', 'npm:react@19'])(
    'returns null for %s, which names no usable major',
    (range) => {
      expect(lowestMajor(range)).toBeNull();
    },
  );
});

describe('reactMajorFor', () => {
  const temps: string[] = [];
  afterEach(() => {
    while (temps.length > 0) fs.rmSync(temps.pop()!, { recursive: true, force: true });
  });

  function tree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'current-react-'));
    temps.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return root;
  }

  // A design system in a monorepo declares React in its own package, and the
  // repo root may name a different one for an app.
  it('reads the nearest package.json that declares React', () => {
    const root = tree({
      'package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      'packages/ds/package.json': JSON.stringify({ peerDependencies: { react: '^18.2.0' } }),
      'packages/ds/src/Button.tsx': '',
    });
    expect(reactMajorFor(path.join(root, 'packages/ds/src/Button.tsx'), root, new Map())).toBe(18);
  });

  it('walks past a package.json that does not declare React', () => {
    const root = tree({
      'package.json': JSON.stringify({ peerDependencies: { react: '>=19' } }),
      'src/package.json': JSON.stringify({ name: 'inner' }),
      'src/Button.tsx': '',
    });
    expect(reactMajorFor(path.join(root, 'src/Button.tsx'), root, new Map())).toBe(19);
  });

  it('prefers peerDependencies, which is what a library supports', () => {
    const root = tree({
      'package.json': JSON.stringify({
        peerDependencies: { react: '^18 || ^19' },
        devDependencies: { react: '^19.1.0' },
      }),
      'Button.tsx': '',
    });
    expect(reactMajorFor(path.join(root, 'Button.tsx'), root, new Map())).toBe(18);
  });

  it('returns null when nothing up to the root declares React', () => {
    const root = tree({ 'package.json': '{}', 'Button.tsx': '' });
    expect(reactMajorFor(path.join(root, 'Button.tsx'), root, new Map())).toBeNull();
  });

  it('does not read above the root', () => {
    const outer = tree({
      'package.json': JSON.stringify({ dependencies: { react: '19' } }),
      'ds/Button.tsx': '',
    });
    const root = path.join(outer, 'ds');
    expect(reactMajorFor(path.join(root, 'Button.tsx'), root, new Map())).toBeNull();
  });

  it('survives a package.json that is not JSON', () => {
    const root = tree({ 'package.json': '{ nope', 'Button.tsx': '' });
    expect(reactMajorFor(path.join(root, 'Button.tsx'), root, new Map())).toBeNull();
  });
});

describe('code.no-hardcoded-copy (CO17)', () => {
  const check = CODE_CHECKS['code.no-hardcoded-copy'];
  const run = (body: string) =>
    check(facts(`export function Dialog({ title, children, onClose, closeLabel = 'Close', open }) { return ${body}; }`, { componentName: 'Dialog' }));

  it('answers Yes when all text arrives as props or children', () => {
    const r = run(`<div role="dialog"><h2>{title}</h2>{children}<button aria-label={closeLabel} onClick={onClose}>×</button></div>`);
    expect(r.answer).toBe('Yes');
  });

  // The default lives in the parameter list, so the consumer can override it.
  it('does not count a prop default as hardcoded', () => {
    expect(run(`<button>{closeLabel}</button>`).answer).toBe('Yes');
  });

  it('answers No for literal text in the markup, quoting it', () => {
    const r = run(`<div><h2>{title}</h2><button onClick={onClose}>Close</button></div>`);
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('"Close"');
  });

  it.each(['aria-label', 'title', 'placeholder', 'alt'])(
    'answers No for a literal %s, which is copy a person is shown',
    (attr) => {
      const r = run(`<button ${attr}="Close dialog" onClick={onClose} />`);
      expect(r.answer).toBe('No');
      expect(r.evidence).toContain(`${attr}="Close dialog"`);
    },
  );

  it('finds literals on both sides of a ternary and after &&', () => {
    const r = run(`<div>{open ? 'Hide details' : 'Show details'}{open && 'Loading'}</div>`);
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('"Hide details"');
    expect(r.evidence).toContain('"Show details"');
    expect(r.evidence).toContain('"Loading"');
  });

  // A string passed to a function is an argument, not output.
  it.each([
    `<button>{t('dialog.close')}</button>`,
    `<p>{formatMessage({ id: 'dialog.title' })}</p>`,
    `<div className={cn('a', 'b')}>{children}</div>`,
    `<div>{open === 'yes' ? title : children}</div>`,
  ])('does not count strings that are never rendered: %s', (jsx) => {
    expect(run(jsx).answer).toBe('Yes');
  });

  it.each(['×', '·', '/', '…', '—', '2', ' '])('does not count %j, which is not copy', (text) => {
    expect(run(`<span>{title}<span aria-hidden="true">${text}</span></span>`).answer).toBe('Yes');
  });

  // Translation libraries extract these children into a catalogue.
  it('does not count message source inside <Trans>', () => {
    expect(run(`<p><Trans>Are you sure you want to delete this?</Trans></p>`).answer).toBe('Yes');
  });

  it('ignores the contents of <style>', () => {
    expect(run(`<div><style>{'.a { color: red }'}</style>{children}</div>`).answer).toBe('Yes');
  });

  it('counts each piece once and caps the evidence at five', () => {
    const r = run(`<div><b>One</b><b>Two</b><b>Three</b><b>Four</b><b>Five</b><b>Six</b><b>One</b></div>`);
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('6 piece(s)');
    expect(r.evidence).not.toContain('"Six"');
  });

  it('answers N/A when the component renders no JSX', () => {
    const r = check(facts(`export function useDialog() { return 1; } export function Dialog() { return null; }`, { componentName: 'Dialog' }));
    expect(r.answer).toBe('N/A');
  });
});
