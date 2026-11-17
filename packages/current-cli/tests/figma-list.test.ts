import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import type { FigmaClient } from '@usepolder/current-core';
import { figmaList, oneLine, yamlKey } from '../src/figma-list';

interface Node {
  id: string;
  name: string;
  type: string;
  children?: Node[];
}

const component = (id: string, name: string, type = 'COMPONENT'): Node => ({ id, name, type });

/** A document with one page holding the given components. */
const page = (name: string, children: Node[]): Node => ({
  id: '0:0',
  name: 'Document',
  type: 'DOCUMENT',
  children: [{ id: '0:1', name, type: 'CANVAS', children }],
});

function listOf(document: Node): Promise<string> {
  const client = { fetchFile: async () => document } as unknown as FigmaClient;
  return figmaList(client);
}

/** The mapping lines, as the reader would paste them under `current.components`. */
function mappingLines(output: string): string[] {
  return output.split('\n').filter((l) => l.startsWith('  '));
}

/** Parse the pasted block the way `.polder.yml` would. */
function parsePasted(output: string): Record<string, unknown> {
  const body = output
    .split('\n')
    .filter((l) => l.startsWith('  ') || l.startsWith('# '))
    .join('\n');
  return yaml.load(`components:\n${body.replace(/^# .*$/gm, '')}`) as Record<string, unknown>;
}

describe('figmaList', () => {
  it('leaves a plain component name bare and aligned', async () => {
    const out = await listOf(
      page('Components', [component('1:2', 'Button'), component('3:4', 'ButtonGroup')]),
    );
    expect(out).toContain('# Components');
    expect(mappingLines(out)).toEqual([
      '  Button:       { figma: "1:2" }',
      '  ButtonGroup:  { figma: "3:4" }',
    ]);
  });

  it('flattens a newline in a component name onto one line', async () => {
    const out = await listOf(page('Components', [component('1:2', 'Butt\nrogue: "x"')]));

    expect(out).not.toMatch(/\n\s*rogue/);
    expect(mappingLines(out)).toEqual(['  "Butt rogue: \\"x\\"":  { figma: "1:2" }']);

    // What the reader pastes is the one entry they think they pasted.
    const parsed = parsePasted(out) as { components: Record<string, unknown> };
    expect(Object.keys(parsed.components)).toEqual(['Butt rogue: "x"']);
  });

  it('flattens a newline in a page name so the header stays a comment', async () => {
    const out = await listOf(page('Core\ncomponents: oops', [component('1:2', 'Button')]));

    expect(out).toContain('# Core components: oops');
    expect(out).not.toMatch(/\ncomponents: oops/);
    expect(mappingLines(out)).toEqual(['  Button:  { figma: "1:2" }']);
  });

  it('quotes a name that would not survive as a bare YAML key', async () => {
    const out = await listOf(
      page('Components', [
        component('1:2', 'Button: primary'),
        component('3:4', '# Hashed'),
        component('5:6', 'on'),
        component('7:8', '404'),
        component('9:10', 'Icon/Chevron'),
      ]),
    );

    const parsed = parsePasted(out) as { components: Record<string, unknown> };
    // Sorted: js-yaml hands back a plain object, which orders "404" first.
    expect(Object.keys(parsed.components).sort()).toEqual(
      ['Button: primary', '# Hashed', 'on', '404', 'Icon/Chevron'].sort(),
    );
  });

  it('pads from the quoted key so the column still lines up', async () => {
    const out = await listOf(
      page('Components', [component('1:2', 'Button: primary'), component('3:4', 'Card')]),
    );
    const columns = mappingLines(out).map((l) => l.indexOf('{ figma:'));
    expect(new Set(columns).size).toBe(1);
  });

  it('still labels component sets', async () => {
    const out = await listOf(
      page('Components', [component('1:2', 'Button', 'COMPONENT_SET')]),
    );
    expect(out).toContain('# component set');
  });
});

describe('oneLine', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(oneLine('  Button \n\t primary  ')).toBe('Button primary');
  });
});

describe('yamlKey', () => {
  it('passes through names design systems actually use', () => {
    for (const name of ['Button', 'ButtonGroup', 'Icon/Chevron', 'Button_v2', 'Nav.Item']) {
      expect(yamlKey(name)).toBe(name);
    }
  });

  it('quotes indicators, reserved words and digits', () => {
    expect(yamlKey('Button: primary')).toBe('"Button: primary"');
    expect(yamlKey('on')).toBe('"on"');
    expect(yamlKey('404')).toBe('"404"');
    expect(yamlKey('')).toBe('""');
  });

  it('escapes quotes and backslashes inside a quoted key', () => {
    expect(yamlKey('He said "hi"\\')).toBe('"He said \\"hi\\"\\\\"');
  });
});
