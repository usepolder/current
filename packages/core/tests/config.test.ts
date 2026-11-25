import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  ParseError,
  PathTraversalError,
  DEFAULT_METRICS,
  type MetricDef,
  metricKeys,
  metricsHash,
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

/** Wrap a Current config body in the `current:` block of a shared .polder.yml. */
function polder(body: string): string {
  const indented = body
    .split('\n')
    .map((l) => (l.trim() === '' ? l : `  ${l}`))
    .join('\n');
  return `current:\n${indented}\n`;
}


describe('parseConfig', () => {
  it('parses a minimal config', () => {
    const config = parseConfig(polder(MINIMAL));
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
    expect(config.metrics).toHaveLength(DEFAULT_METRICS.length);
  });

  it('reports malformed YAML with the file and line', () => {
    let thrown: unknown;
    try {
      parseConfig('components:\n  Button:\n   code: "a"\n  \tbad: indent\n');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ParseError);
    expect((thrown as Error).message).toContain('.polder.yml:');
    expect((thrown as Error).message).not.toContain('at Object.');
  });

  it('rejects a config declaring a newer schema version than this build knows', () => {
    expect(() => parseConfig(polder(`version: 99\n${MINIMAL}`))).toThrow(/only understands up to version/);
  });

  it('accepts the current schema version explicitly', () => {
    expect(parseConfig(polder(`version: 1\n${MINIMAL}`)).version).toBe(1);
  });

  it('allows a component with no mappings, scored purely from manual answers', () => {
    // The on-ramp for a team digitising an existing audit: components first,
    // code and Figma wiring later.
    const config = parseConfig(polder('components:\n  Accordion: {}\n  Badge: {}\n'));
    expect(config.components).toHaveLength(2);
    expect(config.components[0]).toMatchObject({
      name: 'Accordion',
      code: null,
      figma: null,
      docs: null,
    });
  });

  it('allows a docs-only component', () => {
    const config = parseConfig(polder('components:\n  Ghost:\n    docs: "d.md"\n'));
    expect(config.components[0]).toMatchObject({ docs: 'd.md', code: null, figma: null });
  });

  it('rejects an unknown metric id in metrics.disable', () => {
    expect(() => parseConfig(polder(`${MINIMAL}\nmetrics:\n  disable: ["ZZ9"]\n`))).toThrow(/not a known metric id/);
  });

  it('drops disabled metrics and forces listed ones to manual', () => {
    const config = parseConfig(polder(`${MINIMAL}\nmetrics:\n  disable: ["CO1"]\n  manual: ["CO2"]\n`));
    expect(config.metrics.find((m) => m.id === 'CO1')).toBeUndefined();
    expect(config.metrics.find((m) => m.id === 'CO2')?.check).toBeNull();
  });

  it('rejects an out-of-range threshold', () => {
    expect(() => parseConfig(polder(`${MINIMAL}\nquadrant:\n  threshold: 140\n`))).toThrow(
      ConfigValidationError,
    );
  });

  it('reads fail_under from inside the current block', () => {
    expect(parseConfig(polder(`${MINIMAL}\nfail_under: 70\n`)).failUnder).toBe(70);
  });
});

describe('sharing .polder.yml with Drift and Reach', () => {
  it('ignores the other tools’ keys', () => {
    // A repo already set up for Drift or Reach should gain a block, not a
    // second config file.
    const config = parseConfig(`
component_library: "@acme/ds"
allowlist: []
fail_on_drift: true
reach:
  include: ["src/**"]
  fail_under: 40
current:
  components:
    Button:
      code: "src/Button.tsx"
`);
    expect(config.components).toHaveLength(1);
    // Reach's fail_under must not leak into Current's.
    expect(config.failUnder).toBe(0);
  });

  it('explains how to add the block when it is missing', () => {
    let thrown: unknown;
    try {
      parseConfig('component_library: "@acme/ds"\n');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigValidationError);
    expect((thrown as Error).message).toContain('no `current:` block');
    expect((thrown as Error).message).toContain('shares this file with Drift and Reach');
  });

  it('rejects a current key that is not an object', () => {
    expect(() => parseConfig('current: "yes please"\n')).toThrow(/`current` must be a YAML object/);
  });

  it('still reports an empty file helpfully', () => {
    expect(() => parseConfig('')).toThrow(/needs a `current:` block/);
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
    const config = parseConfig(polder(`
components:
  Good:
    code: "src/Good.tsx"
  Evil:
    code: "../../../etc/passwd"
`));
    expect(() => resolveComponentPaths(config, root)).toThrow(PathTraversalError);
  });

  it('validates docs paths too', () => {
    const config = parseConfig(polder(`
components:
  Button:
    code: "src/Button.tsx"
    docs: "../../secrets.md"
`));
    expect(() => resolveComponentPaths(config, root)).toThrow(/Button\.docs/);
  });
});

describe('customising the norms', () => {
  const metrics = (body: string) => parseConfig(polder(`${MINIMAL}\nmetrics:\n${body}`)).metrics;
  const indent = (s: string) => s.split('\n').map((l) => `  ${l}`).join('\n');

  it('adds a custom norm with no check as a manual one', () => {
    const m = metrics(
      indent('custom:\n  - id: ORG1\n    category: design\n    guideline: Dark mode variant exists'),
    );
    expect(m).toHaveLength(DEFAULT_METRICS.length + 1);
    expect(m.find((x) => x.id === 'ORG1')).toMatchObject({
      category: 'design',
      subcategory: 'Custom',
      guideline: 'Dark mode variant exists',
      check: null,
    });
  });

  it('adds an automated custom norm from a built-in check with params', () => {
    const m = metrics(
      indent(
        'custom:\n' +
          '  - id: ORG2\n    category: code\n    guideline: No raw HTML injection\n' +
          '    check: code.forbids\n    params: { text: [dangerouslySetInnerHTML] }\n' +
          '  - id: ORG3\n    category: documentation\n    guideline: Migration notes\n' +
          '    check: docs.section\n    params: { headings: [migration, upgrading] }',
      ),
    );
    expect(m.find((x) => x.id === 'ORG2')).toMatchObject({
      check: 'code.forbids',
      params: { text: ['dangerouslySetInnerHTML'] },
    });
    expect(m.find((x) => x.id === 'ORG3')?.params).toEqual({ headings: ['migration', 'upgrading'] });
  });

  it('overrides wording and params of a built-in norm, leaving the rest of it alone', () => {
    const m = metrics(
      indent(
        'override:\n  DO2:\n    guideline: Usage lives in the styleguide\n' +
          '    params: { headings: [usage, best practices] }',
      ),
    );
    const do2 = m.find((x) => x.id === 'DO2')!;
    expect(do2.guideline).toBe('Usage lives in the styleguide');
    expect(do2.params).toEqual({ headings: ['usage', 'best practices'] });
    expect(do2.check).toBe('docs.section');
    expect(do2.category).toBe('documentation');
    expect(m).toHaveLength(DEFAULT_METRICS.length);
    // Untouched norms are exactly the defaults.
    expect(m.find((x) => x.id === 'DO3')).toEqual(DEFAULT_METRICS.find((x) => x.id === 'DO3'));
  });

  it('can automate a manual built-in by giving it a check', () => {
    const m = metrics(
      indent('override:\n  CO12:\n    check: code.contains\n    params: { text: [forwardRef] }'),
    );
    expect(m.find((x) => x.id === 'CO12')?.check).toBe('code.contains');
  });

  it('lets `manual` win over an override, and drops the params with the check', () => {
    const m = metrics(
      indent('override:\n  DO2:\n    params: { headings: [usage] }\nmanual: [DO2]'),
    );
    const do2 = m.find((x) => x.id === 'DO2')!;
    expect(do2.check).toBeNull();
    expect(do2.params).toBeUndefined();
  });

  it('can disable and force manual on a custom norm', () => {
    const custom = indent(
      'custom:\n  - id: ORG2\n    category: code\n    guideline: g\n    check: code.contains\n    params: { text: [x] }',
    );
    expect(metrics(`${custom}\n  disable: [ORG2]`).find((x) => x.id === 'ORG2')).toBeUndefined();
    expect(metrics(`${custom}\n  manual: [ORG2]`).find((x) => x.id === 'ORG2')?.check).toBeNull();
  });

  const rejects = (body: string, message: RegExp) =>
    expect(() => metrics(indent(body))).toThrow(message);

  it('refuses a custom id that collides with a built-in or another custom norm', () => {
    rejects('custom:\n  - { id: CO1, category: code, guideline: g }', /already a metric id/);
    rejects(
      'custom:\n  - { id: A1, category: code, guideline: g }\n  - { id: A1, category: code, guideline: g }',
      /already a metric id/,
    );
  });

  it('refuses ids that would be awkward as answer-file keys', () => {
    rejects('custom:\n  - { id: "has space", category: code, guideline: g }', /must start with a letter/);
    rejects('custom:\n  - { id: "9x", category: code, guideline: g }', /must start with a letter/);
  });

  it('refuses a custom norm missing its category or guideline, or with a bad category', () => {
    rejects('custom:\n  - { id: A1, guideline: g }', /category must be one of/);
    rejects('custom:\n  - { id: A1, category: ux, guideline: g }', /category must be one of/);
    rejects('custom:\n  - { id: A1, category: code }', /guideline must be a non-empty string/);
  });

  it('refuses unknown keys instead of silently ignoring a typo', () => {
    rejects('custom:\n  - { id: A1, category: code, guidline: g, guideline: g }', /unknown key "guidline"/);
    rejects('override:\n  DO2: { headngs: [a] }', /unknown key "headngs"/);
    rejects('disbale: [CO1]', /unknown key "disbale"/);
  });

  it('refuses an unknown check and lists the ones that exist', () => {
    rejects(
      'custom:\n  - { id: A1, category: code, guideline: g, check: code.magic }',
      /not a known check.*code\.contains/,
    );
  });

  it('refuses a check that cannot score the norm’s category', () => {
    rejects(
      'custom:\n  - { id: A1, category: design, guideline: g, check: code.contains, params: { text: [x] } }',
      /cannot score a design norm/,
    );
  });

  it('validates params against the check', () => {
    rejects('custom:\n  - { id: A1, category: code, guideline: g, check: code.contains }', /needs params/);
    rejects(
      'custom:\n  - { id: A1, category: code, guideline: g, check: code.contains, params: { text: [] } }',
      /needs params/,
    );
    rejects(
      'custom:\n  - { id: A1, category: code, guideline: g, check: code.contains, params: { headings: [x] } }',
      /needs params/,
    );
    rejects(
      'custom:\n  - { id: A1, category: code, guideline: g, check: code.aria-attributes, params: { text: [x] } }',
      /takes no params/,
    );
    rejects('custom:\n  - { id: A1, category: code, guideline: g, params: { text: [x] } }', /needs a `check`/);
  });

  // `min_bound` is the first optional param, so it validates differently from
  // the string-list params: leaving it out is the normal case.
  it('accepts a token norm with no params, and reads min_bound when given', () => {
    expect(metrics(indent('override:\n  DE1: { params: { min_bound: 90 } }')).find((m) => m.id === 'DE1')?.params).toEqual({
      min_bound: 90,
    });
    expect(metrics(indent('override:\n  DE1: { guideline: g }')).find((m) => m.id === 'DE1')?.params).toBeUndefined();
  });

  it('refuses a min_bound that is not a usable percent', () => {
    const bad = (v: string) => rejects(`override:\n  DE5: { params: { min_bound: ${v} } }`, /min_bound/);
    bad('0'); // would answer Yes for a component binding nothing
    bad('101');
    bad('-10');
    bad('"90"'); // a string, not a number
    rejects('override:\n  DE5: { params: { min_bound: 90, text: [x] } }', /min_bound/);
    rejects('override:\n  DE5: { params: { headings: [x] } }', /min_bound/);
  });

  it('refuses min_bound on a check that has no threshold', () => {
    rejects('override:\n  DE7: { params: { min_bound: 90 } }', /takes no params/);
  });

  it('refuses to override an unknown id, pointing at custom instead', () => {
    rejects('override:\n  ZZ9: { guideline: g }', /not a built-in metric.*metrics\.custom/);
  });

  it('refuses to override a metric that is also disabled', () => {
    rejects('override:\n  DO2: { guideline: g }\ndisable: [DO2]', /both disabled and overridden/);
  });

  it('reports a norm’s location in the error', () => {
    rejects('custom:\n  - { id: A1, category: code, guideline: g }\n  - { id: A2, category: code }', /metrics\.custom\[1\]/);
  });
});

describe('metricKeys', () => {
  it('carries what each metric measures, not just which ones are enabled', () => {
    const keys = metricKeys(DEFAULT_METRICS);
    expect(keys).toHaveLength(DEFAULT_METRICS.length);
    // Every key names its metric and encodes its category + check + params.
    expect(keys.every((k) => k.includes(':'))).toBe(true);
    expect(keys.find((k) => k.startsWith('CO3:'))).toContain('code.keyboard');
    expect(keys.find((k) => k.startsWith('CO1:'))).toContain('code.states');
    expect(keys.find((k) => k.startsWith('CO4:'))).toContain('code.screenreader');
    expect(keys.find((k) => k.startsWith('CO10:'))).toContain('code.text-expansion');
    // A norm only a human can answer carries a null check, and says so. DE2
    // is the last one of those in the default set, which is why it is the
    // example: CO10 used to be, until a pseudo-localized probe answered it.
    expect(keys.find((k) => k.startsWith('DE2:'))).toContain('"design",null');
  });

  /**
   * The gap this closes. A rubric change shipped by Current itself — a norm
   * going from "a human answers this" to "a browser probes it" — used to be
   * invisible, because a metric matching the shipped default contributed only
   * its bare id. The hash has to move, or the trend line joins a hand-audited
   * score to a probed one as if they measured the same thing.
   */
  it('changes when a built-in default changes what it checks', () => {
    const before: MetricDef[] = [
      { id: 'CO3', category: 'code', subcategory: 'A11y', guideline: 'keyboard', check: null },
    ];
    const after: MetricDef[] = [{ ...before[0], check: 'code.keyboard' }];
    expect(metricKeys(before)).not.toEqual(metricKeys(after));
    expect(metricsHash(metricKeys(before))).not.toBe(metricsHash(metricKeys(after)));
  });

  it('changes when a default gains params, e.g. a breakpoints scale', () => {
    const base: MetricDef = {
      id: 'CO6',
      category: 'code',
      subcategory: 'Responsiveness',
      guideline: 'breakpoints',
      check: 'code.breakpoints',
    };
    expect(metricsHash(metricKeys([base]))).not.toBe(
      metricsHash(metricKeys([{ ...base, params: { widths: [320, 768] } }])),
    );
  });

  it('marks a norm whose check params changed, and one that was added', () => {
    const cfg = parseConfig(
      polder(
        `${MINIMAL}\nmetrics:\n  override:\n    DO2: { params: { headings: [usage, extra] } }\n` +
          '  custom:\n    - { id: ORG1, category: design, guideline: g }',
      ),
    );
    const keys = metricKeys(cfg.metrics);
    const defaults = metricKeys(DEFAULT_METRICS);
    expect(keys.find((k) => k.startsWith('DO2:'))).not.toBe(
      defaults.find((k) => k.startsWith('DO2:')),
    );
    expect(keys.find((k) => k.startsWith('ORG1:'))).toBeDefined();
    // Nothing else moved: the other 31 defaults keep their keys.
    expect(keys.filter((k) => defaults.includes(k))).toHaveLength(DEFAULT_METRICS.length - 1);
  });

  it('does not change when only the wording changes', () => {
    const cfg = parseConfig(
      polder(`${MINIMAL}\nmetrics:\n  override:\n    DO2: { guideline: Reworded, note: n }\n`),
    );
    expect(metricKeys(cfg.metrics)).toEqual(metricKeys(DEFAULT_METRICS));
  });

  it('does not change when a heading list is merely reordered', () => {
    const a = parseConfig(polder(`${MINIMAL}\nmetrics:\n  override:\n    DO2: { params: { headings: [a, b] } }\n`));
    const b = parseConfig(polder(`${MINIMAL}\nmetrics:\n  override:\n    DO2: { params: { headings: [b, a] } }\n`));
    expect(metricKeys(a.metrics)).toEqual(metricKeys(b.metrics));
  });

  it('marks a built-in flipped to manual, since its score now means something else', () => {
    const cfg = parseConfig(polder(`${MINIMAL}\nmetrics:\n  manual: [CO2]\n`));
    const defaults = metricKeys(DEFAULT_METRICS);
    expect(metricKeys(cfg.metrics).find((k) => k.startsWith('CO2:'))).not.toBe(
      defaults.find((k) => k.startsWith('CO2:')),
    );
  });

  it('does not change when a norm is disabled — its key simply leaves the set', () => {
    const cfg = parseConfig(polder(`${MINIMAL}\nmetrics:\n  disable: [CO3]\n`));
    const keys = metricKeys(cfg.metrics);
    expect(keys.some((k) => k.startsWith('CO3:'))).toBe(false);
    expect(metricsHash(keys)).not.toBe(metricsHash(metricKeys(DEFAULT_METRICS)));
  });
});

describe('preview mapping', () => {
  it('reads a preview URL', () => {
    const c = parseConfig(polder(`
components:
  Button:
    code: "src/Button.tsx"
    preview: "http://localhost:6006/iframe.html?id=button--primary"
`));
    expect(c.components[0].preview).toBe('http://localhost:6006/iframe.html?id=button--primary');
  });

  it('defaults preview to null', () => {
    expect(parseConfig(polder(MINIMAL)).components[0].preview).toBeNull();
  });

  // A path here would silently never be probed, so it is an error, not a shrug.
  it('rejects a repo path, pointing at what preview is for', () => {
    expect(() =>
      parseConfig(polder(`
components:
  Button:
    preview: "src/Button.stories.tsx"
`)),
    ).toThrow(/must be an http\(s\) URL/);
  });
});

describe('code.breakpoints widths', () => {
  it('takes no params by default', () => {
    const c = parseConfig(polder(MINIMAL));
    expect(c.metrics.find((m) => m.id === 'CO6')?.check).toBe('code.breakpoints');
    expect(c.metrics.find((m) => m.id === 'CO6')?.params).toBeUndefined();
  });

  it('accepts a configured scale, sorted and deduped', () => {
    const c = parseConfig(polder(`
components:
  Button:
    code: "src/Button.tsx"
metrics:
  override:
    CO6:
      params: { widths: [1280, 360, 360] }
`));
    expect(c.metrics.find((m) => m.id === 'CO6')?.params).toEqual({ widths: [360, 1280] });
  });

  it('rejects widths that are not plausible viewports', () => {
    for (const widths of ['[0]', '[12]', '["320px"]', '[]', '[9000]']) {
      expect(() =>
        parseConfig(polder(`
components:
  Button:
    code: "src/Button.tsx"
metrics:
  override:
    CO6:
      params: { widths: ${widths} }
`)),
      ).toThrow(ConfigValidationError);
    }
  });

  it('refuses a probe-backed check on a norm from another axis', () => {
    expect(() =>
      parseConfig(polder(`
components:
  Button:
    code: "src/Button.tsx"
metrics:
  override:
    DE6:
      check: "code.keyboard"
`)),
    ).toThrow(/cannot score a design norm/);
  });
});

describe('design.interaction-states states', () => {
  function withStates(states: string): string {
    return polder(`
components:
  Button:
    figma: "1:10"
metrics:
  override:
    DE6:
      params: { states: ${states} }
`);
  }

  it('takes no params by default, and DE6 is automated', () => {
    const de6 = parseConfig(polder(MINIMAL)).metrics.find((m) => m.id === 'DE6');
    expect(de6?.check).toBe('design.interaction-states');
    expect(de6?.params).toBeUndefined();
  });

  it('accepts a configured set, lowercased, deduped and in the guideline’s order', () => {
    const c = parseConfig(withStates('[Disabled, hover, HOVER, focus]'));
    expect(c.metrics.find((m) => m.id === 'DE6')?.params).toEqual({
      states: ['hover', 'focus', 'disabled'],
    });
  });

  it('does not change the rubric fingerprint when a state list is merely reordered', () => {
    const a = parseConfig(withStates('[hover, disabled]'));
    const b = parseConfig(withStates('[disabled, hover]'));
    expect(metricKeys(a.metrics)).toEqual(metricKeys(b.metrics));
  });

  it('rejects anything that is not a known state', () => {
    for (const states of ['[]', '[wiggling]', '[1]', '"hover"', '[default]', '[danger]']) {
      expect(() => parseConfig(withStates(states))).toThrow(ConfigValidationError);
    }
  });

  it('says what the default is and why asking for all of them is wrong', () => {
    expect(() => parseConfig(withStates('[everything]'))).toThrow(
      /Default hover, pressed, disabled/,
    );
    expect(() => parseConfig(withStates('[everything]'))).toThrow(/only\s+some of the nine/);
  });

  it('rejects an unrelated key alongside it', () => {
    expect(() =>
      parseConfig(polder(`
components:
  Button:
    figma: "1:10"
metrics:
  override:
    DE6:
      params: { states: [hover], min_bound: 50 }
`)),
    ).toThrow(ConfigValidationError);
  });
});
