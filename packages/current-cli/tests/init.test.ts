import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverComponents,
  mergeIntoConfig,
  planComponents,
  renderCurrentBlock,
  run,
  type CodeComponent,
} from '../src/index';

const temps: string[] = [];

function tempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-init-'));
  temps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

afterEach(() => {
  while (temps.length > 0) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function invoke(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  let out = '';
  let err = '';
  const code = await run(argv, {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    env,
    version: '0.1.0-test',
  });
  return { code, out, err };
}

const figmaNode = (id: string, name: string, page = 'Components') => ({
  id,
  name,
  type: 'COMPONENT',
  page,
});

const codeComponent = (name: string, code: string): CodeComponent => ({ name, code, docs: null });

/**
 * Do what a reader does to a commented-out entry: take the `# ` off the
 * indented lines and drop the prose, leaving the mapping behind. The point of
 * writing those entries is that this produces a config that parses.
 */
function uncomment(yml: string): string {
  return yml
    .split('\n')
    .filter((l) => !/^  # \S/.test(l))
    .map((l) => l.replace(/^  # /, '  '))
    .join('\n');
}

/**
 * Serve one Figma file document to `init --figma`.
 *
 * The CLI builds its own FigmaClient, which falls back to `globalThis.fetch`,
 * so the stub goes there and is restored afterwards. No other request is
 * expected: an extra call means the command grew a network step a test did
 * not account for, which is worth failing over.
 */
function stubFigmaFile(components: { id: string; name: string }[]): () => void {
  const original = globalThis.fetch;
  let calls = 0;
  (globalThis as { fetch?: unknown }).fetch = async () => {
    calls += 1;
    if (calls > 1) throw new Error('unexpected second Figma request');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          document: {
            id: '0:0',
            name: 'Document',
            type: 'DOCUMENT',
            children: [
              {
                id: '0:1',
                name: 'Components',
                type: 'CANVAS',
                children: components.map((c) => ({ ...c, type: 'COMPONENT' })),
              },
            ],
          },
        }),
    };
  };
  return () => {
    (globalThis as { fetch?: unknown }).fetch = original;
  };
}

describe('discoverComponents', () => {
  it('finds both the Button.tsx and Button/index.tsx conventions', () => {
    const dir = tempRepo({
      'src/Button/Button.tsx': 'export const Button = () => null;',
      'src/Card/index.tsx': 'export const Card = () => null;',
    });
    expect(discoverComponents(dir).map((c) => [c.name, c.code])).toEqual([
      ['Button', 'src/Button/Button.tsx'],
      ['Card', 'src/Card/index.tsx'],
    ]);
  });

  it('ignores tests, stories and build output', () => {
    const dir = tempRepo({
      'src/Button/Button.tsx': '',
      'src/Button/Button.test.tsx': '',
      'src/Button/Button.stories.tsx': '',
      'dist/Widget.tsx': '',
      'node_modules/pkg/Thing.tsx': '',
    });
    expect(discoverComponents(dir).map((c) => c.name)).toEqual(['Button']);
  });

  it('prefers Button.tsx over Button/index.tsx so repeated runs match', () => {
    const dir = tempRepo({
      'src/Button/Button.tsx': '',
      'src/Button/index.tsx': '',
    });
    expect(discoverComponents(dir)[0].code).toBe('src/Button/Button.tsx');
  });

  it('picks up a docs file named after the component', () => {
    const dir = tempRepo({ 'src/Button/Button.tsx': '', 'docs/button.mdx': '# Button' });
    expect(discoverComponents(dir)[0].docs).toBe('docs/button.mdx');
  });

  it('does not treat a lowercase file as a component', () => {
    const dir = tempRepo({ 'src/helpers/useThing.tsx': '' });
    expect(discoverComponents(dir)).toEqual([]);
  });
});

describe('planComponents', () => {
  it('maps an exact name match', () => {
    const { components, figmaOnly } = planComponents(
      [codeComponent('Button', 'src/Button.tsx')],
      [figmaNode('1:2', 'Button')],
    );
    expect(components[0]).toMatchObject({ figma: '1:2', match: 'exact' });
    expect(figmaOnly).toEqual([]);
  });

  // README promises Current will not guess a mapping, so anything softer than
  // an exact match has to be confirmed by a person.
  it('treats a near match as uncertain rather than mapping it', () => {
    const { components, figmaOnly } = planComponents(
      [codeComponent('ButtonGroup', 'src/ButtonGroup.tsx')],
      [figmaNode('1:9', 'Button Group')],
    );
    expect(components[0].match).toBe('fuzzy');
    expect(components[0].note).toContain('Button Group');
    // A fuzzy hit still accounts for the node: it is named on the commented
    // mapping, so reporting it as unmatched as well would double-count it.
    expect(figmaOnly).toEqual([]);
  });

  it('refuses to choose when two Figma components share the name', () => {
    const { components, figmaOnly } = planComponents(
      [codeComponent('Button', 'src/Button.tsx')],
      [figmaNode('1:2', 'Button', 'Core'), figmaNode('3:4', 'Button', 'Legacy')],
    );
    expect(components[0].match).toBe('ambiguous');
    expect(components[0].note).toContain('Legacy');
    // Both candidates are named in the note, so neither is an orphan.
    expect(figmaOnly).toEqual([]);
  });

  it('records no match when Figma has nothing like it', () => {
    const { components, figmaOnly } = planComponents(
      [codeComponent('Button', 'src/Button.tsx')],
      [figmaNode('1:2', 'Avatar')],
    );
    expect(components[0]).toMatchObject({ figma: null, match: 'none' });
    // ...and the Avatar node is reported from the other side, rather than
    // disappearing the way it did when this mapped over code alone.
    expect(figmaOnly).toEqual([{ name: 'Avatar', figma: '1:2', page: 'Components' }]);
  });
});

describe('renderCurrentBlock', () => {
  it('writes an exact match live and an uncertain one commented out', () => {
    const plan = planComponents(
      [codeComponent('Button', 'src/Button.tsx'), codeComponent('ButtonGroup', 'src/ButtonGroup.tsx')],
      [figmaNode('1:2', 'Button'), figmaNode('1:9', 'Button Group')],
    ).components;
    const yml = renderCurrentBlock(plan, 'FILEKEY');
    expect(yml).toContain('      figma: "1:2"');
    expect(yml).toContain('      # figma: "1:9"');
    expect(yml).toContain('file_key: "FILEKEY"');
  });

  it('says what it searched for when nothing was found', () => {
    const yml = renderCurrentBlock([], null);
    expect(yml).toContain('components: {}');
    expect(yml).toContain('Button/index.tsx');
  });

  it('writes a Figma-only component commented out, with no invented code path', () => {
    const { components, figmaOnly } = planComponents(
      [codeComponent('Button', 'src/Button.tsx')],
      [figmaNode('1:2', 'Button'), figmaNode('4:5', 'Modal', 'Overlays')],
    );
    const yml = renderCurrentBlock(components, 'FILEKEY', figmaOnly);
    expect(yml).toContain('  #   Modal:');
    expect(yml).toContain('  #     figma: "4:5"   # on Overlays');
    expect(yml).toContain('  #     code: ""');
    // Every line about it is a comment, so the component cannot be scored
    // until a person has confirmed a real path for it.
    for (const line of yml.split('\n').filter((l) => l.includes('Modal'))) {
      expect(line.trimStart().startsWith('#')).toBe(true);
    }
  });

  it('still lists Figma components when the repo has no component source at all', () => {
    const { components, figmaOnly } = planComponents([], [figmaNode('4:5', 'Modal')]);
    const yml = renderCurrentBlock(components, 'FILEKEY', figmaOnly);
    // `components:` and not `components: {}`: there are commented entries
    // below that the reader is told to uncomment, and a block mapping cannot
    // follow a flow one.
    expect(yml).toContain('  components:\n');
    expect(yml).not.toContain('components: {}');
    expect(yml).toContain('  #   Modal:');
    expect(yaml.load(uncomment(yml))).toMatchObject({
      current: { components: { Modal: { figma: '4:5' } } },
    });
  });

  it('keeps writing components: {} when there is nothing to uncomment', () => {
    expect(renderCurrentBlock([], 'FILEKEY', [])).toContain('components: {}');
  });

  // Figma layer names are unconstrained. A newline used to end the comment it
  // was written into, leaving a line at column 0 and a config that would not
  // parse — or one that parsed with a stray top-level key.
  it('cannot be made to write a line outside the comment block', () => {
    const { components, figmaOnly } = planComponents(
      [],
      [{ id: '4:5', name: 'Modal\nrogue: true', type: 'COMPONENT', page: 'Over\nlays' }],
    );
    const yml = renderCurrentBlock(components, 'FILEKEY', figmaOnly);
    for (const line of yml.split('\n').slice(6)) {
      expect(line.trimStart().startsWith('#')).toBe(true);
    }
    expect(() => yaml.load(yml)).not.toThrow();
    expect(yml).toContain('"Modal rogue: true"');
  });

  it('quotes a name that would not survive uncommenting as a bare key', () => {
    const { components, figmaOnly } = planComponents(
      [],
      [{ id: '4:5', name: 'Modal: large', type: 'COMPONENT', page: 'Overlays' }],
    );
    const yml = renderCurrentBlock(components, 'FILEKEY', figmaOnly);
    expect(yml).toContain('  #   "Modal: large":');
    expect(yaml.load(uncomment(yml))).toMatchObject({
      current: { components: { 'Modal: large': { figma: '4:5' } } },
    });
  });

  // Figma has no uniqueness rule for component names, and these entries are
  // keyed by name, so two of them would collide once uncommented.
  it('warns when two unmatched components share a name', () => {
    const { components, figmaOnly } = planComponents(
      [],
      [figmaNode('4:5', 'Modal', 'Old'), figmaNode('4:6', 'Modal', 'New')],
    );
    const yml = renderCurrentBlock(components, 'FILEKEY', figmaOnly);
    expect(yml).toContain('  #   Modal:   # name shared with 4:6 — uncomment only one');
    expect(yml).toContain('  #   Modal:   # name shared with 4:5 — uncomment only one');
  });

  it('adds nothing when every Figma component matched', () => {
    const { components, figmaOnly } = planComponents(
      [codeComponent('Button', 'src/Button.tsx')],
      [figmaNode('1:2', 'Button')],
    );
    expect(figmaOnly).toEqual([]);
    expect(renderCurrentBlock(components, 'FILEKEY', figmaOnly)).not.toContain('matched no component source');
  });
});

describe('mergeIntoConfig', () => {
  it('refuses to touch a file that already has a current: block', () => {
    expect(() => mergeIntoConfig('current:\n  version: 1\n', 'current:\n')).toThrow(
      /already has a current: block/,
    );
  });

  it('keeps other tools’ keys byte-identical when adding the block', () => {
    const existing = 'drift:\n  version: 1\n  tokens: "tokens.json"\n';
    const merged = mergeIntoConfig(existing, 'current:\n  version: 1');
    expect(merged.startsWith(existing)).toBe(true);
    expect(merged).toContain('current:');
  });

  it('refuses a file that is not valid YAML rather than appending blindly', () => {
    expect(() => mergeIntoConfig('drift: [unclosed\n', 'current:\n')).toThrow(/not valid YAML/);
  });
});

describe('run init', () => {
  it('writes a config and reports what it found', async () => {
    const dir = tempRepo({ 'src/Button/Button.tsx': '', 'src/Card/Card.tsx': '' });
    const r = await invoke(['init', dir]);
    expect(r.code).toBe(0);
    const written = fs.readFileSync(path.join(dir, '.polder.yml'), 'utf8');
    expect(written).toContain('Button:');
    expect(written).toContain('code: "src/Card/Card.tsx"');
    expect(r.out).toContain('2 components from source');
  });

  it('adds the block to an existing shared config without disturbing it', async () => {
    const existing = 'reach:\n  version: 1\n  entry: "src/index.ts"\n';
    const dir = tempRepo({ 'src/Button/Button.tsx': '', '.polder.yml': existing });
    const r = await invoke(['init', dir]);
    expect(r.code).toBe(0);
    const written = fs.readFileSync(path.join(dir, '.polder.yml'), 'utf8');
    expect(written.startsWith(existing)).toBe(true);
    expect(written).toContain('current:');
    expect(r.out).toContain('Added a current: block');
  });

  it('refuses when a current: block exists, and leaves the file untouched', async () => {
    const existing = 'current:\n  version: 1\n  components: {}\n';
    const dir = tempRepo({ 'src/Button/Button.tsx': '', '.polder.yml': existing });
    const before = fs.readFileSync(path.join(dir, '.polder.yml'));
    const r = await invoke(['init', dir]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/already has a current: block/);
    expect(fs.readFileSync(path.join(dir, '.polder.yml'))).toEqual(before);
  });

  // A Figma step that cannot run must not leave a half-built config behind.
  it('writes nothing when --figma is given with no token', async () => {
    const dir = tempRepo({ 'src/Button/Button.tsx': '' });
    const r = await invoke(['init', dir, '--figma', 'FILEKEY'], {});
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('CURRENT_FIGMA_TOKEN');
    expect(fs.existsSync(path.join(dir, '.polder.yml'))).toBe(false);
  });

  it('writes a reviewable skeleton when the repo has no components', async () => {
    const dir = tempRepo({ 'README.md': '# nothing here' });
    const r = await invoke(['init', dir]);
    expect(r.code).toBe(0);
    const written = fs.readFileSync(path.join(dir, '.polder.yml'), 'utf8');
    expect(written).toContain('components: {}');
    expect(written).toContain('Button.tsx');
  });

  it('rejects --figma with no value', async () => {
    const r = await invoke(['init', '--figma']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--figma requires/);
  });

  it('leaves no temp file behind', async () => {
    const dir = tempRepo({ 'src/Button/Button.tsx': '' });
    await invoke(['init', dir]);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.init-'))).toEqual([]);
  });

  // The gap the critical quadrant exists to surface: finished in Figma,
  // missing in code. init used to scaffold only the code side and say nothing.
  it('names a Figma component that has no code, in the config and on stdout', async () => {
    const dir = tempRepo({ 'src/Button/Button.tsx': '' });
    const restore = stubFigmaFile([
      { id: '1:2', name: 'Button' },
      { id: '4:5', name: 'Modal' },
    ]);
    try {
      const r = await invoke(['init', dir, '--figma', 'FILEKEY'], { CURRENT_FIGMA_TOKEN: 'figd_x' });
      expect(r.code).toBe(0);
      expect(r.out).toContain('1 Figma component with no component source: Modal');
      const written = fs.readFileSync(path.join(dir, '.polder.yml'), 'utf8');
      expect(written).toContain('  #   Modal:');
      expect(written).toContain('  #     figma: "4:5"');
      // The matched side is untouched.
      expect(written).toContain('      figma: "1:2"');
    } finally {
      restore();
    }
  });

  // A real library's gap can be dozens of components; the line names enough to
  // recognise and leaves the rest to the config rather than wrapping the
  // terminal three times.
  it('stops naming after five and points at the config for the rest', async () => {
    const dir = tempRepo({ 'src/Button/Button.tsx': '' });
    const restore = stubFigmaFile([
      { id: '1:2', name: 'Button' },
      ...['Calendar', 'Carousel', 'DataGrid', 'Modal', 'Popover', 'Tooltip'].map((name, i) => ({
        id: `4:${i}`,
        name,
      })),
    ]);
    try {
      const r = await invoke(['init', dir, '--figma', 'FILEKEY'], { CURRENT_FIGMA_TOKEN: 'figd_x' });
      expect(r.code).toBe(0);
      expect(r.out).toContain(
        '6 Figma components with no component source: Calendar, Carousel, DataGrid, Modal, Popover and 1 more',
      );
      // The one it stopped short of is still in the file.
      expect(fs.readFileSync(path.join(dir, '.polder.yml'), 'utf8')).toContain('  #   Tooltip:');
    } finally {
      restore();
    }
  });

  it('says nothing about Figma-only components when every one matched', async () => {
    const dir = tempRepo({ 'src/Button/Button.tsx': '', 'src/Card/Card.tsx': '' });
    const restore = stubFigmaFile([
      { id: '1:2', name: 'Button' },
      { id: '1:3', name: 'Card' },
    ]);
    try {
      const r = await invoke(['init', dir, '--figma', 'FILEKEY'], { CURRENT_FIGMA_TOKEN: 'figd_x' });
      expect(r.code).toBe(0);
      expect(r.out).toContain('2 mapped to Figma');
      expect(r.out).not.toContain('no component source');
      const written = fs.readFileSync(path.join(dir, '.polder.yml'), 'utf8');
      expect(written).not.toContain('matched no component source');
    } finally {
      restore();
    }
  });

  it('reports nothing about Figma when --figma was not given', async () => {
    const dir = tempRepo({ 'src/Button/Button.tsx': '' });
    const r = await invoke(['init', dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no Figma file given');
    expect(r.out).not.toContain('no component source');
    const written = fs.readFileSync(path.join(dir, '.polder.yml'), 'utf8');
    expect(written).not.toContain('matched no component source');
    expect(written).toContain('#   file_key: "your-figma-file-key"');
  });
});
