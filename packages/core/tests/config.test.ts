import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  ParseError,
  PathTraversalError,
  parseConfig,
  resolveComponentPaths,
  resolveRepoPath,
} from '@usepolder/current-core';

const MINIMAL = `
components:
  Button:
    code: "src/Button.tsx"
    figma: "1:2"
`;

describe('parseConfig', () => {
  it('parses a minimal config', () => {
    const config = parseConfig(MINIMAL);
    expect(config.components).toHaveLength(1);
    expect(config.components[0]).toMatchObject({
      name: 'Button',
      code: 'src/Button.tsx',
      figma: '1:2',
      docs: null,
    });
    expect(config.threshold).toBe(60);
    expect(config.minConfidence).toBe(3);
    expect(config.failUnder).toBe(0);
    expect(config.metrics).toHaveLength(32);
  });

  it('reports malformed YAML with the file and line', () => {
    let thrown: unknown;
    try {
      parseConfig('components:\n  Button:\n   code: "a"\n  \tbad: indent\n');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ParseError);
    expect((thrown as Error).message).toContain('.current.yml:');
    expect((thrown as Error).message).not.toContain('at Object.');
  });

  it('rejects a config declaring a newer schema version than this build knows', () => {
    expect(() => parseConfig(`version: 99\n${MINIMAL}`)).toThrow(/only understands up to version/);
  });

  it('accepts the current schema version explicitly', () => {
    expect(parseConfig(`version: 1\n${MINIMAL}`).version).toBe(1);
  });

  it('allows a component with no mappings, scored purely from manual answers', () => {
    // The on-ramp for a team digitising an existing audit: components first,
    // code and Figma wiring later.
    const config = parseConfig('components:\n  Accordion: {}\n  Badge: {}\n');
    expect(config.components).toHaveLength(2);
    expect(config.components[0]).toMatchObject({
      name: 'Accordion',
      code: null,
      figma: null,
      docs: null,
    });
  });

  it('allows a docs-only component', () => {
    const config = parseConfig('components:\n  Ghost:\n    docs: "d.md"\n');
    expect(config.components[0]).toMatchObject({ docs: 'd.md', code: null, figma: null });
  });

  it('rejects an unknown metric id in metrics.disable', () => {
    expect(() => parseConfig(`${MINIMAL}\nmetrics:\n  disable: ["ZZ9"]\n`)).toThrow(/not a known metric id/);
  });

  it('drops disabled metrics and forces listed ones to manual', () => {
    const config = parseConfig(`${MINIMAL}\nmetrics:\n  disable: ["CO1"]\n  manual: ["CO2"]\n`);
    expect(config.metrics.find((m) => m.id === 'CO1')).toBeUndefined();
    expect(config.metrics.find((m) => m.id === 'CO2')?.check).toBeNull();
  });

  it('rejects an out-of-range threshold', () => {
    expect(() => parseConfig(`${MINIMAL}\nquadrant:\n  threshold: 140\n`)).toThrow(
      ConfigValidationError,
    );
  });

  it('reads fail_under as a bare top-level key, not a namespaced one', () => {
    expect(parseConfig(`${MINIMAL}\nfail_under: 70\n`).failUnder).toBe(70);
  });
});

describe('path traversal', () => {
  const root = path.resolve('/repo');

  it('accepts a path inside the repo', () => {
    expect(resolveRepoPath(root, 'src/Button.tsx', 'Button', 'code')).toBe(
      path.join(root, 'src/Button.tsx'),
    );
  });

  it('rejects a parent-directory escape', () => {
    expect(() => resolveRepoPath(root, '../../../etc/passwd', 'Button', 'code')).toThrow(
      PathTraversalError,
    );
  });

  it('rejects a nested escape that resolves outside the root', () => {
    expect(() => resolveRepoPath(root, 'src/../../outside.tsx', 'Button', 'code')).toThrow(
      PathTraversalError,
    );
  });

  it('rejects an absolute path', () => {
    expect(() => resolveRepoPath(root, '/etc/passwd', 'Button', 'code')).toThrow(
      PathTraversalError,
    );
  });

  it('rejects a path that resolves to the repo root itself', () => {
    expect(() => resolveRepoPath(root, 'src/..', 'Button', 'code')).toThrow(PathTraversalError);
  });

  it('allows a traversal that stays inside the repo', () => {
    expect(resolveRepoPath(root, 'src/ui/../Button.tsx', 'Button', 'code')).toBe(
      path.join(root, 'src/Button.tsx'),
    );
  });

  it('validates every component before any file is read', () => {
    const config = parseConfig(`
components:
  Good:
    code: "src/Good.tsx"
  Evil:
    code: "../../../etc/passwd"
`);
    expect(() => resolveComponentPaths(config, root)).toThrow(PathTraversalError);
  });

  it('validates docs paths too', () => {
    const config = parseConfig(`
components:
  Button:
    code: "src/Button.tsx"
    docs: "../../secrets.md"
`);
    expect(() => resolveComponentPaths(config, root)).toThrow(/Button\.docs/);
  });
});
