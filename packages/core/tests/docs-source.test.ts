import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCS_CONCURRENCY,
  RendererUnavailableError,
  closeRenderer,
  createPlaywrightRenderer,
  parseAnswers,
  parseConfig,
  renderDocsPages,
  scanRepo,
  type PageRenderer,
} from '@usepolder/current-core';

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function repoWith(config: string, answers = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-docs-'));
  temps.push(dir);
  fs.writeFileSync(path.join(dir, '.polder.yml'), polder(config));
  if (answers !== '') fs.writeFileSync(path.join(dir, '.polder.answers.yml'), answers);
  return dir;
}


/** Wrap a Current config body in the `current:` block of a shared .polder.yml. */
function polder(body: string): string {
  const indented = body
    .split('\n')
    .map((l) => (l.trim() === '' ? l : `  ${l}`))
    .join('\n');
  return `current:\n${indented}\n`;
}

const URL_CONFIG = `
components:
  Button:
    docs: "https://example.test/docs/button"
`;

function docMetrics(component: { metrics: Array<{ metricId: string; answer: string; evidence: string | null }> }) {
  return component.metrics.filter((m) => /^DO[2-9]$/.test(m.metricId));
}

describe('hosted documentation', () => {
  it('scores a rendered page like a local file', async () => {
    const dir = repoWith(URL_CONFIG);
    const renderDocs: PageRenderer = async () =>
      '<h1>Button</h1><h2>Usage</h2><h2>Anatomy</h2><h2>States</h2><h2>Accessibility</h2>';

    const report = await scanRepo({
      repoRoot: dir,
      config: parseConfig(polder(URL_CONFIG)),
      answers: new Map(),
      renderDocs,
    });

    const button = report.components[0];
    expect(button.presence.docs).toBe('present');
    const answers = Object.fromEntries(docMetrics(button).map((m) => [m.metricId, m.answer]));
    expect(answers.DO2).toBe('Yes'); // Usage
    expect(answers.DO4).toBe('Yes'); // Anatomy
    expect(answers.DO8).toBe('Yes'); // States
    expect(answers.DO9).toBe('Yes'); // Accessibility
    expect(answers.DO5).toBe('No'); // no Animation section
  });

  it('passes the mapped URL through to the renderer untouched', async () => {
    const dir = repoWith(URL_CONFIG);
    const seen: string[] = [];
    await scanRepo({
      repoRoot: dir,
      config: parseConfig(polder(URL_CONFIG)),
      answers: new Map(),
      renderDocs: async (url) => {
        seen.push(url);
        return '<h2>Usage</h2>';
      },
    });
    expect(seen).toEqual(['https://example.test/docs/button']);
  });

  it('answers N/A, not No, when no renderer is available', async () => {
    // Scoring a hosted page as undocumented because no browser is installed
    // would slander a well-documented system.
    const dir = repoWith(URL_CONFIG);
    const report = await scanRepo({
      repoRoot: dir,
      config: parseConfig(polder(URL_CONFIG)),
      answers: new Map(),
    });

    const button = report.components[0];
    expect(docMetrics(button).every((m) => m.answer === 'N/A')).toBe(true);
    expect(docMetrics(button)[0].evidence).toContain('playwright');
    expect(button.scores.documentation.score).toBeNull();
  });

  it('answers N/A and names the failure when the page cannot be read', async () => {
    const dir = repoWith(URL_CONFIG);
    const report = await scanRepo({
      repoRoot: dir,
      config: parseConfig(polder(URL_CONFIG)),
      answers: new Map(),
      renderDocs: async () => {
        throw new Error('net::ERR_NAME_NOT_RESOLVED at https://example.test');
      },
    });

    const metrics = docMetrics(report.components[0]);
    expect(metrics.every((m) => m.answer === 'N/A')).toBe(true);
    expect(metrics[0].evidence).toContain('ERR_NAME_NOT_RESOLVED');
  });

  it('treats a heading-less hosted page as unread, not as undocumented', async () => {
    // A slow SPA that has not painted yet returns its empty shell. Scoring
    // that as "No" on every metric is a confident claim that a documented
    // component is undocumented — the exact failure this must not have.
    const dir = repoWith(URL_CONFIG);
    const report = await scanRepo({
      repoRoot: dir,
      config: parseConfig(polder(URL_CONFIG)),
      answers: new Map(),
      renderDocs: async () => '<html><body><div id="app"></div></body></html>',
    });

    const metrics = docMetrics(report.components[0]);
    expect(metrics.every((m) => m.answer === 'N/A')).toBe(true);
    expect(metrics[0].evidence).toContain('not have finished rendering');
    expect(report.components[0].scores.documentation.score).toBeNull();
  });

  it('never runs a renderer for a local docs path', async () => {
    const dir = repoWith(
      'components:\n  Button:\n    docs: "docs/button.md"\n',
    );
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'button.md'), '# Button\n\n## Usage\ntext\n');

    let called = false;
    const report = await scanRepo({
      repoRoot: dir,
      config: parseConfig(polder('components:\n  Button:\n    docs: "docs/button.md"\n')),
      answers: new Map(),
      renderDocs: async () => {
        called = true;
        return '';
      },
    });

    expect(called).toBe(false);
    expect(report.components[0].presence.docs).toBe('present');
  });

  it('lets a human answer override what the live page says', async () => {
    const dir = repoWith(URL_CONFIG, 'Button:\n  DO5: Yes\n');
    const report = await scanRepo({
      repoRoot: dir,
      config: parseConfig(polder(URL_CONFIG)),
      answers: parseAnswers('Button:\n  DO5: Yes\n'),
      renderDocs: async () => '<h2>Usage</h2>',
    });

    const do5 = report.components[0].metrics.find((m) => m.metricId === 'DO5');
    expect(do5).toMatchObject({ answer: 'Yes', source: 'manual' });
  });

  it('does not path-validate a URL', async () => {
    // The traversal guard stops a config reading arbitrary local files; a URL
    // cannot do that, and running it through the guard would reject it.
    expect(() => parseConfig(polder(URL_CONFIG))).not.toThrow();
    const config = parseConfig(polder(URL_CONFIG));
    expect(config.components[0].docs).toBe('https://example.test/docs/button');
  });
});

describe('createPlaywrightRenderer', () => {
  it('reports a clean install hint when playwright is absent', async () => {
    const render = createPlaywrightRenderer({
      load: async () => {
        throw new Error('Cannot find module \'playwright\'');
      },
    });
    await expect(render('https://example.test')).rejects.toBeInstanceOf(RendererUnavailableError);
  });

  it('reports the same hint when the module loads but has no chromium', async () => {
    const render = createPlaywrightRenderer({ load: async () => ({}) });
    await expect(render('https://example.test')).rejects.toThrow(/playwright/);
  });

  // Load-bearing for the Action, which installs playwright-core into
  // RUNNER_TEMP the first time a page is rendered. Concurrent workers all call
  // the renderer at once; if each one launched its own browser, that would be
  // four npm installs racing over one directory.
  it('launches one browser however many pages render at once', async () => {
    let loads = 0;
    let launches = 0;
    const page = {
      goto: async () => undefined,
      waitForSelector: async () => undefined,
      evaluate: async () => 3,
      content: async () => '<h2>Usage</h2>',
      close: async () => undefined,
    };
    const render = createPlaywrightRenderer({
      load: async () => {
        loads += 1;
        return {
          chromium: {
            launch: async () => {
              launches += 1;
              return { newPage: async () => page, close: async () => undefined };
            },
          },
        };
      },
    });

    const urls = Array.from({ length: 12 }, (_, i) => `https://example.test/${i}`);
    const out = await renderDocsPages(urls, render, { concurrency: 4 });

    expect(loads).toBe(1);
    expect(launches).toBe(1);
    expect(out.size).toBe(12);
    await closeRenderer(render);
  });

  it('closes cleanly even when it never launched a browser', async () => {
    await expect(closeRenderer(createPlaywrightRenderer())).resolves.toBeUndefined();
    await expect(closeRenderer(null)).resolves.toBeUndefined();
  });
});

describe('renderDocsPages', () => {
  /** A renderer that records how many calls were in flight at their peak. */
  function tracking(body: (url: string) => Promise<string> = async (u) => `<h2>${u}</h2>`) {
    const state = { inFlight: 0, peak: 0, calls: [] as string[] };
    const render: PageRenderer = async (url) => {
      state.calls.push(url);
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      try {
        return await body(url);
      } finally {
        state.inFlight -= 1;
      }
    };
    return { render, state };
  }

  const urls = (n: number) =>
    Array.from({ length: n }, (_, i) => `https://example.test/docs/${i}`);

  it('renders more than one page at a time', async () => {
    const { render, state } = tracking(
      async (u) => new Promise((r) => setTimeout(() => r(`<h2>${u}</h2>`), 5)),
    );
    await renderDocsPages(urls(8), render, { concurrency: 4 });
    expect(state.peak).toBeGreaterThan(1);
  });

  it('never exceeds the cap', async () => {
    const { render, state } = tracking(
      async (u) => new Promise((r) => setTimeout(() => r(`<h2>${u}</h2>`), 5)),
    );
    await renderDocsPages(urls(12), render, { concurrency: 3 });
    expect(state.peak).toBeLessThanOrEqual(3);
  });

  it('renders every page exactly once', async () => {
    const { render, state } = tracking();
    const out = await renderDocsPages(urls(7), render, { concurrency: 2 });
    expect(state.calls).toHaveLength(7);
    expect(out.size).toBe(7);
  });

  // A loop inside the component walk could not do this: two components
  // pointing at one page used to cost two renders.
  it('renders a duplicated URL once and gives both askers the result', async () => {
    const { render, state } = tracking();
    const one = 'https://example.test/docs/shared';
    const out = await renderDocsPages([one, one, one], render);
    expect(state.calls).toEqual([one]);
    expect(out.size).toBe(1);
    expect(out.get(one)).toEqual({ html: `<h2>${one}</h2>` });
  });

  // The invariant that matters most. Promise.all would abandon the remaining
  // pages on the first rejection, leaving components that are documented
  // indistinguishable from components that are not.
  it('keeps rendering after a page fails, and attaches the failure to that URL', async () => {
    const { render, state } = tracking(async (u) => {
      if (u.endsWith('/3')) throw new Error('net::ERR_NAME_NOT_RESOLVED');
      return `<h2>${u}</h2>`;
    });
    const list = urls(6);
    const out = await renderDocsPages(list, render, { concurrency: 2 });

    expect(state.calls).toHaveLength(6);
    expect(out.get(list[3])).toEqual({ error: 'net::ERR_NAME_NOT_RESOLVED' });
    for (const u of list.filter((_, i) => i !== 3)) {
      expect(out.get(u)).toEqual({ html: `<h2>${u}</h2>` });
    }
  });

  it('survives every page failing', async () => {
    const { render } = tracking(async () => {
      throw new Error('down');
    });
    const out = await renderDocsPages(urls(4), render, { concurrency: 2 });
    expect([...out.values()].every((v) => 'error' in v)).toBe(true);
  });

  it('does not touch the renderer when there is nothing to render', async () => {
    const { render, state } = tracking();
    const out = await renderDocsPages([], render);
    expect(state.calls).toEqual([]);
    expect(out.size).toBe(0);
  });

  it('clamps a nonsense cap to one rather than stalling', async () => {
    const { render, state } = tracking();
    await renderDocsPages(urls(3), render, { concurrency: 0 });
    expect(state.calls).toHaveLength(3);
    expect(state.peak).toBe(1);
  });

  it('caps the worker count at the number of pages', async () => {
    const { render, state } = tracking(
      async (u) => new Promise((r) => setTimeout(() => r(`<h2>${u}</h2>`), 5)),
    );
    await renderDocsPages(urls(2), render, { concurrency: 16 });
    expect(state.peak).toBeLessThanOrEqual(2);
  });

  it('defaults to a small cap, not unbounded', async () => {
    expect(DEFAULT_DOCS_CONCURRENCY).toBeLessThanOrEqual(6);
    const { render, state } = tracking(
      async (u) => new Promise((r) => setTimeout(() => r(`<h2>${u}</h2>`), 5)),
    );
    await renderDocsPages(urls(20), render);
    expect(state.peak).toBeLessThanOrEqual(DEFAULT_DOCS_CONCURRENCY);
  });
});

describe('hosted documentation, rendered concurrently', () => {
  const TWO = `
components:
  Button:
    docs: "https://example.test/docs/button"
  Card:
    docs: "https://example.test/docs/card"
`;

  it('renders a whole scan\u2019s pages concurrently', async () => {
    const dir = repoWith(TWO);
    let inFlight = 0;
    let peak = 0;
    await scanRepo({
      repoRoot: dir,
      config: parseConfig(polder(TWO)),
      answers: new Map(),
      renderDocs: async (url) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return `<h2>Usage</h2><h2>${url}</h2>`;
      },
    });
    expect(peak).toBe(2);
  });

  // "Could not look" and "looked and found nothing" have to stay apart even
  // when the failure happens next to a success.
  it('fails one page without costing the other its score', async () => {
    const dir = repoWith(TWO);
    const report = await scanRepo({
      repoRoot: dir,
      config: parseConfig(polder(TWO)),
      answers: new Map(),
      renderDocs: async (url) => {
        if (url.endsWith('/card')) throw new Error('403 Forbidden');
        return '<h1>Button</h1><h2>Usage</h2><h2>Anatomy</h2>';
      },
    });

    const [button, card] = report.components;
    expect(button.name).toBe('Button');
    expect(card.name).toBe('Card');

    expect(button.presence.docs).toBe('present');
    expect(docMetrics(button).some((m) => m.answer === 'Yes')).toBe(true);

    expect(docMetrics(card).every((m) => m.answer === 'N/A')).toBe(true);
    expect(docMetrics(card)[0].evidence).toContain('403 Forbidden');
    expect(card.scores.documentation.score).toBeNull();
  });

  it('reports components in config order regardless of which page finished first', async () => {
    const dir = repoWith(TWO);
    const report = await scanRepo({
      repoRoot: dir,
      config: parseConfig(polder(TWO)),
      answers: new Map(),
      // Card resolves first; the report must still read Button, Card.
      renderDocs: async (url) => {
        const delay = url.endsWith('/button') ? 20 : 1;
        await new Promise((r) => setTimeout(r, delay));
        return '<h2>Usage</h2>';
      },
    });
    expect(report.components.map((c) => c.name)).toEqual(['Button', 'Card']);
  });

  it('renders one page once when two components share a URL', async () => {
    const shared = `
components:
  Button:
    docs: "https://example.test/docs/all"
  Card:
    docs: "https://example.test/docs/all"
`;
    const dir = repoWith(shared);
    const seen: string[] = [];
    const report = await scanRepo({
      repoRoot: dir,
      config: parseConfig(polder(shared)),
      answers: new Map(),
      renderDocs: async (url) => {
        seen.push(url);
        return '<h2>Usage</h2><h2>Anatomy</h2>';
      },
    });
    expect(seen).toHaveLength(1);
    expect(report.components.every((c) => c.presence.docs === 'present')).toBe(true);
  });
});
