import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODE_CHECKS,
  collectRelatedFiles,
  parseConfig,
  parseSource,
  scanRepo,
  type CodeFacts,
} from '@usepolder/current-core';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'current-related-')));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

function related(root: string, entry: string, others: string[] = []) {
  const file = path.join(root, entry);
  const ast = parseSource(fs.readFileSync(file, 'utf8'), entry);
  return collectRelatedFiles(file, ast, root, new Set(others.map((o) => path.join(root, o))));
}

describe('collectRelatedFiles', () => {
  it('follows a styles module and a stylesheet next to the component', () => {
    const root = repo({
      'src/Button/Button.tsx':
        "import { root } from './Button.styles';\nimport './Button.css';\nexport const Button = () => <button className={root} />;",
      'src/Button/Button.styles.ts': "export const root = 'x';",
      'src/Button/Button.css': '.b { color: red; }',
    });
    const r = related(root, 'src/Button/Button.tsx');
    expect(r.files.map((f) => f.filePath).sort()).toEqual([
      'src/Button/Button.css',
      'src/Button/Button.styles.ts',
    ]);
    expect(r.files.find((f) => f.filePath.endsWith('.css'))!.kind).toBe('style');
  });

  it('follows imports transitively and resolves index files', () => {
    const root = repo({
      'src/Button/Button.tsx': "import { v } from './variants';\nexport const Button = () => <b />;",
      'src/Button/variants/index.ts': "export { v } from './base';",
      'src/Button/variants/base.ts': "export const v = '#fff';",
    });
    expect(
      related(root, 'src/Button/Button.tsx')
        .files.map((f) => f.filePath)
        .sort(),
    ).toEqual(['src/Button/variants/base.ts', 'src/Button/variants/index.ts']);
  });

  it('does not leave the component directory, and counts what it skipped', () => {
    const root = repo({
      'src/Button/Button.tsx': "import { Icon } from '../Icon/Icon';\nimport pkg from 'react';\nexport const Button = () => <Icon />;",
      'src/Icon/Icon.tsx': "export const Icon = () => <i style={{ color: '#f00' }} />;",
    });
    const r = related(root, 'src/Button/Button.tsx');
    expect(r.files).toEqual([]);
    expect(r.notFollowed).toBe(1);
  });

  it('never claims another mapped component’s file in a flat layout', () => {
    const root = repo({
      'src/Button.tsx': "import { Card } from './Card';\nimport { s } from './shared';\nexport const Button = () => <Card />;",
      'src/Card.tsx': "export const Card = () => <div style={{ padding: '8px' }} />;",
      'src/shared.ts': "export const s = 1;",
    });
    const r = related(root, 'src/Button.tsx', ['src/Card.tsx']);
    expect(r.files.map((f) => f.filePath)).toEqual(['src/shared.ts']);
    expect(r.notFollowed).toBe(1);
  });

  it('survives import cycles and unresolvable specifiers', () => {
    const root = repo({
      'src/A/A.tsx': "import './b';\nimport './missing';\nexport const A = () => <a />;",
      'src/A/b.ts': "import './A';\nexport const b = 1;",
    });
    expect(related(root, 'src/A/A.tsx').files.map((f) => f.filePath)).toEqual(['src/A/b.ts']);
  });

  it('reports a script it cannot parse rather than dropping it silently', () => {
    const root = repo({
      'src/A/A.tsx': "import './broken';\nexport const A = () => <a />;",
      'src/A/broken.ts': 'export const = = ;',
    });
    expect(related(root, 'src/A/A.tsx').unparseable).toEqual(['src/A/broken.ts']);
  });

  it('will not follow a symlink out of the repo', () => {
    const outside = repo({ 'secret.ts': "export const s = '#000';" });
    const root = repo({
      'src/A/A.tsx': "import './leak';\nexport const A = () => <a />;",
    });
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'src/A/leak.ts'));
    const r = related(root, 'src/A/A.tsx');
    expect(r.files).toEqual([]);
    expect(r.notFollowed).toBe(1);
  });
});

describe('code.token-usage across files', () => {
  const check = CODE_CHECKS['code.token-usage'];
  const entry = "import './x';\nexport const B = () => <b />;";

  function facts(root: string): CodeFacts {
    const file = path.join(root, 'src/B/B.tsx');
    return {
      componentName: 'B',
      filePath: 'src/B/B.tsx',
      source: entry,
      ast: parseSource(entry, 'B.tsx'),
      figmaPropertyNames: null,
      related: related(root, 'src/B/B.tsx'),
    };
  }

  it('finds a hardcoded colour in a styles module the entry file imports', () => {
    const root = repo({
      'src/B/B.tsx': entry,
      'src/B/x.ts': "export const root = { color: '#ff0000', padding: '12px' };",
    });
    const r = check(facts(root));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('#ff0000');
    expect(r.evidence).toContain('across 2 file(s)');
  });

  it('finds hardcoded values in a stylesheet, but not selectors or comments', () => {
    const root = repo({
      'src/B/B.tsx': entry,
      'src/B/x.css': '/* was #123456 */\n#face { margin: var(--space-2); }\n.b { color: #abc; }',
    });
    const r = check(facts(root));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('1 hardcoded hex colour(s)');
    expect(r.evidence).toContain('#abc');
  });

  it('passes when the related files really are clean, and says how many it read', () => {
    const root = repo({
      'src/B/B.tsx': entry,
      'src/B/x.css': '.b { color: var(--color-fg); padding: var(--space-2); }',
    });
    const r = check(facts(root));
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('across 2 file(s)');
  });

  it('discloses when it could not read part of the component', () => {
    const root = repo({
      'src/B/B.tsx': "import '../tokens';\nexport const B = () => <b />;",
      'src/tokens.ts': 'export const t = 1;',
    });
    const f = facts(root);
    f.related = related(root, 'src/B/B.tsx');
    expect(check(f).evidence).toContain('outside the component');
  });
});

describe('scanRepo reads a component’s styles', () => {
  it('scores hardcoded values that live in Button.styles.ts', async () => {
    const root = repo({
      '.polder.yml':
        'current:\n  version: 1\n  components:\n    Button:\n      code: "src/Button/Button.tsx"\n',
      'src/Button/Button.tsx':
        "import { root } from './Button.styles';\nexport const Button = () => <button style={root} />;",
      'src/Button/Button.styles.ts': "export const root = { background: '#123456' };",
    });
    const report = await scanRepo({
      repoRoot: root,
      config: parseConfig(fs.readFileSync(path.join(root, '.polder.yml'), 'utf8')),
      answers: new Map(),
    });
    const co7 = report.components[0].metrics.find((m) => m.metricId === 'CO7')!;
    expect(co7.answer).toBe('No');
    expect(co7.evidence).toContain('#123456');
  });
});
