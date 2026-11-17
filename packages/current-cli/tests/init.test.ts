import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
    const [p] = planComponents([codeComponent('Button', 'src/Button.tsx')], [figmaNode('1:2', 'Button')]);
    expect(p).toMatchObject({ figma: '1:2', match: 'exact' });
  });

  // README promises Current will not guess a mapping, so anything softer than
  // an exact match has to be confirmed by a person.
  it('treats a near match as uncertain rather than mapping it', () => {
    const [p] = planComponents(
      [codeComponent('ButtonGroup', 'src/ButtonGroup.tsx')],
      [figmaNode('1:9', 'Button Group')],
    );
    expect(p.match).toBe('fuzzy');
    expect(p.note).toContain('Button Group');
  });

  it('refuses to choose when two Figma components share the name', () => {
    const [p] = planComponents(
      [codeComponent('Button', 'src/Button.tsx')],
      [figmaNode('1:2', 'Button', 'Core'), figmaNode('3:4', 'Button', 'Legacy')],
    );
    expect(p.match).toBe('ambiguous');
    expect(p.note).toContain('Legacy');
  });

  it('records no match when Figma has nothing like it', () => {
    const [p] = planComponents([codeComponent('Button', 'src/Button.tsx')], [figmaNode('1:2', 'Avatar')]);
    expect(p).toMatchObject({ figma: null, match: 'none' });
  });
});

describe('renderCurrentBlock', () => {
  it('writes an exact match live and an uncertain one commented out', () => {
    const plan = planComponents(
      [codeComponent('Button', 'src/Button.tsx'), codeComponent('ButtonGroup', 'src/ButtonGroup.tsx')],
      [figmaNode('1:2', 'Button'), figmaNode('1:9', 'Button Group')],
    );
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
});
