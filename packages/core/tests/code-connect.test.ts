import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODE_CHECKS,
  extractCodeConnect,
  indexCodeConnect,
  mappingFor,
  normaliseNodeId,
  parseConfig,
  parseFigmaUrl,
  parseSource,
  scanRepo,
  type CodeConnectFacts,
  type CodeConnectIndex,
  type CodeFacts,
} from '@usepolder/current-core';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'current-connect-')));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

function mappings(source: string, filePath = 'src/Button.figma.tsx') {
  return extractCodeConnect(parseSource(source, filePath), filePath);
}

const CONNECT = (url = 'https://www.figma.com/design/fk/DS?node-id=1-10') =>
  `import figma from '@figma/code-connect/react';\nimport { Button } from './Button';\nfigma.connect(Button, '${url}');\n`;

describe('parseFigmaUrl', () => {
  it('reads the file key and node id from a /design/ URL', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/abc123/DS?node-id=1-10')).toEqual({
      fileKey: 'abc123',
      nodeId: '1:10',
    });
  });

  it('reads a legacy /file/ URL the same way', () => {
    expect(parseFigmaUrl('https://figma.com/file/abc123/DS?node-id=12%3A345&t=x')).toEqual({
      fileKey: 'abc123',
      nodeId: '12:345',
    });
  });

  it('reports no node for a URL that names only a file', () => {
    expect(parseFigmaUrl('https://figma.com/design/abc123/DS')).toEqual({
      fileKey: 'abc123',
      nodeId: null,
    });
  });

  it('does not throw on something that is not a URL', () => {
    expect(parseFigmaUrl('not a url')).toEqual({ fileKey: null, nodeId: null });
  });

  it('normalises every form of a node id to Figma’s own', () => {
    expect(normaliseNodeId('1-10')).toBe('1:10');
    expect(normaliseNodeId('1:10')).toBe('1:10');
    expect(normaliseNodeId('1%3A10')).toBe('1:10');
    // Instance ids carry two parts, both dash-encoded in a URL.
    expect(normaliseNodeId('I1-2;3-4')).toBe('I1:2;3:4');
  });
});

describe('extractCodeConnect', () => {
  it('reads the component, node and mapped props off a figma.connect call', () => {
    const found = mappings(
      `import figma from '@figma/code-connect/react';
       import { Button } from './Button';
       figma.connect(Button, 'https://figma.com/design/fk/DS?node-id=1-10', {
         props: { label: figma.string('Label'), 'aria-label': figma.string('Aria') },
         example: ({ label }) => <Button>{label}</Button>,
       });`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      filePath: 'src/Button.figma.tsx',
      component: 'Button',
      fileKey: 'fk',
      nodeId: '1:10',
      props: ['label', 'aria-label'],
    });
  });

  it('reads the url-only form, which names no code component', () => {
    const found = mappings(
      `import figma from '@figma/code-connect/react';
       figma.connect('https://figma.com/design/fk/DS?node-id=2-20', {
         example: () => <button>click me</button>,
       });`,
    );
    expect(found[0]).toMatchObject({ component: null, nodeId: '2:20', props: [] });
  });

  it('reads a dotted component name and a destructured connect', () => {
    const found = mappings(
      `import { connect } from '@figma/code-connect/react';
       connect(Table.Row, \`https://figma.com/design/fk/DS?node-id=3-30\`);`,
    );
    expect(found[0]).toMatchObject({ component: 'Table.Row', nodeId: '3:30' });
  });

  it('ignores calls that are not Code Connect', () => {
    expect(mappings("db.connect('postgres://localhost/x');\nfigma.getFile('abc');")).toEqual([]);
  });
});

describe('indexCodeConnect', () => {
  it('finds mapping files anywhere in the repo and notes the config file', () => {
    const root = repo({
      'figma.config.json': '{ "codeConnect": { "include": ["**/*.figma.tsx"] } }',
      'src/Button/Button.figma.tsx': CONNECT(),
      'src/Wrapper/Wrapper.tsx': 'export const Wrapper = () => <div />;',
    });
    const index = indexCodeConnect(root);
    expect(index.fileCount).toBe(1);
    expect(index.hasConfig).toBe(true);
    expect(index.mappings[0]).toMatchObject({
      filePath: 'src/Button/Button.figma.tsx',
      component: 'Button',
      nodeId: '1:10',
    });
  });

  it('does not walk into node_modules or a build directory', () => {
    const root = repo({
      'node_modules/lib/Thing.figma.tsx': CONNECT(),
      'dist/Thing.figma.js': CONNECT(),
      'src/Thing.figma.tsx': CONNECT(),
    });
    expect(indexCodeConnect(root).fileCount).toBe(1);
  });

  it('skips a mapping file that will not parse instead of failing the scan', () => {
    const root = repo({
      'src/Broken.figma.tsx': 'figma.connect(Broken, (((',
      'src/Button.figma.tsx': CONNECT(),
    });
    const index = indexCodeConnect(root);
    expect(index.fileCount).toBe(2);
    expect(index.mappings.map((m) => m.component)).toEqual(['Button']);
  });

  it('reports a repo with no Code Connect at all', () => {
    const index = indexCodeConnect(repo({ 'src/Button.tsx': 'export const Button = () => null;' }));
    expect(index).toMatchObject({ fileCount: 0, hasConfig: false, mappings: [] });
  });
});

describe('mappingFor', () => {
  const index = (...sources: Array<[string, string]>): CodeConnectIndex => ({
    mappings: sources.flatMap(([file, src]) => mappings(src, file)),
    fileCount: sources.length,
    hasConfig: false,
  });

  it('prefers the call that names the component over the file it sits in', () => {
    const i = index(
      ['src/Button.figma.tsx', CONNECT('https://figma.com/design/fk/DS?node-id=9-99')],
      ['src/Misc.figma.tsx', "figma.connect(Tag, 'https://figma.com/design/fk/DS?node-id=1-10');"],
    );
    expect(mappingFor(i.mappings, 'Tag')?.nodeId).toBe('1:10');
  });

  it('matches the url-only form by the file it is named after', () => {
    const i = index([
      'src/Tag.figma.tsx',
      "figma.connect('https://figma.com/design/fk/DS?node-id=4-40');",
    ]);
    expect(mappingFor(i.mappings, 'Tag')?.nodeId).toBe('4:40');
    expect(mappingFor(i.mappings, 'Button')).toBeNull();
  });

  it('matches a dotted name by its last segment', () => {
    const i = index([
      'src/Row.figma.tsx',
      "figma.connect(Table.Row, 'https://figma.com/design/fk/DS?node-id=5-50');",
    ]);
    expect(mappingFor(i.mappings, 'Row')?.nodeId).toBe('5:50');
  });
});

describe('code.figma-connect', () => {
  const check = CODE_CHECKS['code.figma-connect'];

  function facts(connect: Partial<CodeConnectFacts> | null): CodeFacts {
    const source = 'export const Button = () => <button />;';
    return {
      componentName: 'Button',
      filePath: 'src/Button.tsx',
      source,
      ast: parseSource(source, 'src/Button.tsx'),
      figmaPropertyNames: null,
      ...(connect === null
        ? {}
        : {
            codeConnect: {
              mapping: null,
              usesCodeConnect: true,
              fileCount: 1,
              mappingCount: 1,
              expectedNodeId: '1:10',
              expectedFileKey: 'fk',
              ...connect,
            },
          }),
    };
  }

  const mapping = (over: Partial<CodeConnectFacts['mapping']> = {}) => ({
    filePath: 'src/Button/Button.figma.tsx',
    component: 'Button',
    url: 'https://figma.com/design/fk/DS?node-id=1-10',
    fileKey: 'fk',
    nodeId: '1:10',
    props: ['label'],
    ...over,
  });

  it('answers Yes when the mapping names the node this audit scores', () => {
    const r = check(facts({ mapping: mapping() }));
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('Button.figma.tsx');
    expect(r.evidence).toContain('node 1:10');
    expect(r.evidence).toContain('the node this audit scores');
    expect(r.evidence).toContain('1 prop(s) mapped');
  });

  it('answers Yes on a mapping for a component with no Figma node in the config', () => {
    const r = check(facts({ mapping: mapping(), expectedNodeId: null, expectedFileKey: null }));
    expect(r.answer).toBe('Yes');
    expect(r.evidence).not.toContain('the node this audit scores');
  });

  it('answers No when the mapping points at a different node', () => {
    const r = check(facts({ mapping: mapping({ nodeId: '9:99' }) }));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('node 9:99');
    expect(r.evidence).toContain('1:10');
  });

  it('answers No when the mapping points into another Figma file', () => {
    const r = check(facts({ mapping: mapping({ fileKey: 'other' }) }));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('other');
  });

  it('answers No for a URL that names a file but no component', () => {
    const r = check(facts({ mapping: mapping({ nodeId: null }) }));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('no node');
  });

  it('answers No when the repo uses Code Connect but nothing maps this component', () => {
    const r = check(facts({ mapping: null, fileCount: 4, mappingCount: 6 }));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('6 mapping(s) in 4 Code Connect file(s)');
  });

  it('answers N/A, not No, for a repo that does not use Code Connect at all', () => {
    const r = check(
      facts({ usesCodeConnect: false, fileCount: 0, mappingCount: 0, mapping: null }),
    );
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('no Code Connect in this repo');
  });

  it('answers N/A when a config declares Code Connect but no mapping was found', () => {
    // A custom `codeConnect.include` glob can put mappings anywhere; a search
    // that came up empty is not a finding about the component.
    const r = check(facts({ mapping: null, fileCount: 0, mappingCount: 0 }));
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('figma.config.json');
  });

  it('answers N/A when no norm asked for Code Connect on this run', () => {
    expect(check(facts(null)).answer).toBe('N/A');
  });
});

describe('CO12 end to end', () => {
  const polder = (body: string) => `current:\n${body}`;

  async function scan(files: Record<string, string>, body: string) {
    const root = repo(files);
    return scanRepo({
      repoRoot: root,
      config: parseConfig(polder(body)),
      answers: new Map(),
    });
  }

  const BUTTON = 'export const Button = () => <button />;\n';
  const CONFIG = `  version: 1
  figma:
    file_key: "fk"
  components:
    Button:
      code: "src/Button/Button.tsx"
      figma: "1:10"
    Wrapper:
      code: "src/Wrapper/Wrapper.tsx"
      figma: "1:20"
`;

  function co12(report: Awaited<ReturnType<typeof scan>>, name: string) {
    return report.components
      .find((c) => c.name === name)!
      .metrics.find((m) => m.metricId === 'CO12')!;
  }

  it('scores the connected component Yes and the unconnected one No', async () => {
    const report = await scan(
      {
        'src/Button/Button.tsx': BUTTON,
        'src/Button/Button.figma.tsx': CONNECT(),
        'src/Wrapper/Wrapper.tsx': 'export const Wrapper = () => <div />;\n',
      },
      CONFIG,
    );
    expect(co12(report, 'Button')).toMatchObject({ answer: 'Yes', source: 'auto' });
    expect(co12(report, 'Wrapper')).toMatchObject({ answer: 'No', source: 'auto' });
  });

  it('finds a mapping written into the component’s own file', async () => {
    const report = await scan(
      {
        'src/Button/Button.tsx': `${BUTTON}${CONNECT()}`,
        'src/Wrapper/Wrapper.tsx': 'export const Wrapper = () => <div />;\n',
      },
      CONFIG,
    );
    expect(co12(report, 'Button').answer).toBe('Yes');
  });

  it('leaves CO12 N/A for a system with no Code Connect', async () => {
    const report = await scan(
      {
        'src/Button/Button.tsx': BUTTON,
        'src/Wrapper/Wrapper.tsx': 'export const Wrapper = () => <div />;\n',
      },
      CONFIG,
    );
    expect(co12(report, 'Button').answer).toBe('N/A');
    expect(co12(report, 'Wrapper').answer).toBe('N/A');
  });

  it('leaves CO12 N/A when figma.config.json points its mappings somewhere Current does not look', async () => {
    const report = await scan(
      {
        'figma.config.json': '{ "codeConnect": { "include": ["connect/**/*.ts"] } }',
        'connect/button.ts': CONNECT(),
        'src/Button/Button.tsx': BUTTON,
        'src/Wrapper/Wrapper.tsx': 'export const Wrapper = () => <div />;\n',
      },
      CONFIG,
    );
    const r = co12(report, 'Button');
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('figma.config.json');
  });

  it('catches a mapping that points at the wrong node', async () => {
    const report = await scan(
      {
        'src/Button/Button.tsx': BUTTON,
        'src/Button/Button.figma.tsx': CONNECT('https://figma.com/design/fk/DS?node-id=9-99'),
        'src/Wrapper/Wrapper.tsx': 'export const Wrapper = () => <div />;\n',
      },
      CONFIG,
    );
    const r = co12(report, 'Button');
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('9:99');
  });
});
