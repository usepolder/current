import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RendererUnavailableError,
  closeRenderer,
  createPlaywrightRenderer,
  parseAnswers,
  parseConfig,
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
  if (answers !== '') fs.writeFileSync(path.join(dir, '.current.answers.yml'), answers);
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

  it('closes cleanly even when it never launched a browser', async () => {
    await expect(closeRenderer(createPlaywrightRenderer())).resolves.toBeUndefined();
    await expect(closeRenderer(null)).resolves.toBeUndefined();
  });
});
