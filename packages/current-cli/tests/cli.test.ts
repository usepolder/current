import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { HELP, parseArgs, run } from '../src/index';

const FIXTURE = path.join(__dirname, '..', '..', 'core', 'tests', 'fixtures', 'ds');

const temps: string[] = [];

function tempCopyOfFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-cli-'));
  temps.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    fs.rmSync(temps.pop()!, { recursive: true, force: true });
  }
});

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function invoke(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
  cwd?: string,
): Promise<Captured> {
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
    cwd,
  });
  return { code, out, err };
}

describe('parseArgs', () => {
  it('defaults to scanning the current directory', () => {
    expect(parseArgs([])).toMatchObject({ command: 'scan', dir: '.', json: false });
  });

  it('accepts a directory argument', () => {
    expect(parseArgs(['packages/ds']).dir).toBe('packages/ds');
  });

  it('recognises the figma list subcommand', () => {
    expect(parseArgs(['figma', 'list']).command).toBe('figma-list');
  });

  it('accepts an explicit scan subcommand with a directory', () => {
    expect(parseArgs(['scan', 'ds'])).toMatchObject({ command: 'scan', dir: 'ds' });
  });

  it('parses the flags', () => {
    const args = parseArgs(['--json', '--verbose', '--no-report', '--record-history']);
    expect(args).toMatchObject({
      json: true,
      verbose: true,
      noReport: true,
      recordHistory: true,
    });
  });

  it('parses --usage with its value', () => {
    expect(parseArgs(['--usage', 'reach.json']).usage).toBe('reach.json');
  });

  it('rejects --usage with no value', () => {
    expect(() => parseArgs(['--usage'])).toThrow('--usage requires');
  });

  it('parses --out with its value', () => {
    expect(parseArgs(['--out', 'health.html']).out).toBe('health.html');
  });

  it('rejects --out with no value', () => {
    expect(() => parseArgs(['--out'])).toThrow(/requires a file path/);
  });

  it('rejects an unknown flag by name', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown flag: --nope/);
  });
});

describe('run', () => {
  it('prints help and exits clean', async () => {
    const { code, out } = await invoke(['--help']);
    expect(code).toBe(0);
    expect(out).toContain(HELP.split('\n')[0]);
  });

  it('prints the version', async () => {
    const { code, out } = await invoke(['--version']);
    expect(code).toBe(0);
    expect(out.trim()).toBe('0.1.0-test');
  });

  it('explains how to get started when there is no config', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'current-empty-'));
    temps.push(empty);
    const { code, err } = await invoke([empty]);
    expect(code).toBe(2);
    expect(err).toContain('No .polder.yml found');
    expect(err).toContain('components:');
  });

  it('scans the fixture and writes an HTML report', async () => {
    const dir = tempCopyOfFixture();
    const { code, out } = await invoke([dir]);

    expect(code).toBe(0);
    expect(out).toContain('Current — component health');
    expect(out).toContain('Button');
    const html = fs.readFileSync(path.join(dir, 'current-report.html'), 'utf8');
    expect(html).toContain('<svg');
    expect(html).toContain('Button');
  });

  it('resolves --out against the cwd, not the scanned directory', async () => {
    // `current ../ds --out report.html` should land next to the user, not
    // inside the repo being scanned.
    const dir = tempCopyOfFixture();
    const here = fs.mkdtempSync(path.join(os.tmpdir(), 'current-cwd-'));
    temps.push(here);

    const { code } = await invoke([dir, '--out', 'health.html'], {}, here);

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(here, 'health.html'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'health.html'))).toBe(false);
  });

  it('writes the default report into the scanned directory', async () => {
    const dir = tempCopyOfFixture();
    const here = fs.mkdtempSync(path.join(os.tmpdir(), 'current-cwd-'));
    temps.push(here);

    await invoke([dir], {}, here);

    expect(fs.existsSync(path.join(dir, 'current-report.html'))).toBe(true);
    expect(fs.existsSync(path.join(here, 'current-report.html'))).toBe(false);
  });

  it('reports an unwritable report path cleanly instead of crashing', async () => {
    const dir = tempCopyOfFixture();
    const { code, err } = await invoke([dir, '--out', 'no/such/dir/report.html']);
    expect(code).toBe(2);
    expect(err).toContain('that directory does not exist');
    expect(err).not.toContain('    at ');
  });

  it('writes no report with --no-report', async () => {
    const dir = tempCopyOfFixture();
    await invoke([dir, '--no-report']);
    expect(fs.existsSync(path.join(dir, 'current-report.html'))).toBe(false);
  });

  it('emits a machine-readable report with --json', async () => {
    const dir = tempCopyOfFixture();
    const { out } = await invoke([dir, '--json']);
    const report = JSON.parse(out);
    expect(report.schemaVersion).toBe(1);
    expect(report.components.map((c: { name: string }) => c.name)).toContain('Button');
  });

  describe('--usage', () => {
    const reachReport = (usage: Record<string, number>, over: Record<string, unknown> = {}) =>
      JSON.stringify({ schemaVersion: 2, tool: 'reach', usage, ...over });

    it('ranks what to fix first by use', async () => {
      const dir = tempCopyOfFixture();
      fs.writeFileSync(path.join(dir, 'reach.json'), reachReport({ Button: 40, Wrapper: 300, Icon: 12 }));
      const { code, out } = await invoke([dir, '--no-report', '--usage', path.join(dir, 'reach.json')]);
      expect(code).toBe(0);
      expect(out).toContain('Fix first');
      expect(out).toMatch(/1\. Wrapper\s+\w+ [\d.]+%\s+300 uses/);
      expect(out).toContain('In use but not mapped in .polder.yml: Icon (12)');
    });

    it('prints no ranking without usage data', async () => {
      const { out } = await invoke([tempCopyOfFixture(), '--no-report']);
      expect(out).not.toContain('Fix first');
    });

    it('resolves --usage against the cwd, like --out', async () => {
      const dir = tempCopyOfFixture();
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'current-cwd-'));
      temps.push(elsewhere);
      fs.writeFileSync(path.join(elsewhere, 'r.json'), reachReport({ Wrapper: 5 }));
      const { code, out } = await invoke([dir, '--no-report', '--usage', 'r.json'], {}, elsewhere);
      expect(code).toBe(0);
      expect(out).toContain('Fix first');
    });

    it('reads `usage:` from the config, confined to the repo', async () => {
      const dir = tempCopyOfFixture();
      const cfgPath = path.join(dir, '.polder.yml');
      fs.writeFileSync(cfgPath, `${fs.readFileSync(cfgPath, 'utf8')}\n  usage: "reach.json"\n`);
      fs.writeFileSync(path.join(dir, 'reach.json'), reachReport({ Wrapper: 5 }));
      expect((await invoke([dir, '--no-report'])).out).toContain('Fix first');

      fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace('reach.json', '../reach.json'));
      const escaped = await invoke([dir, '--no-report']);
      expect(escaped.code).toBe(2);
      expect(escaped.err).toContain('outside the repo root');
    });

    it('exits 2 with a clear message for a pre-usage Reach report', async () => {
      const dir = tempCopyOfFixture();
      fs.writeFileSync(path.join(dir, 'reach.json'), JSON.stringify({ schemaVersion: 1, tool: 'reach' }));
      const { code, err } = await invoke([dir, '--no-report', '--usage', path.join(dir, 'reach.json')]);
      expect(code).toBe(2);
      expect(err).toContain('before per-component usage');
    });

    it('exits 2 when the usage file does not exist', async () => {
      const { code, err } = await invoke([tempCopyOfFixture(), '--no-report', '--usage', '/nope/r.json']);
      expect(code).toBe(2);
      expect(err).toContain('Run Reach first');
    });
  });

  it('traces every metric to stderr with --verbose', async () => {
    const dir = tempCopyOfFixture();
    const { err } = await invoke([dir, '--verbose', '--no-report']);
    expect(err).toContain('Button/CO2');
    expect(err).toMatch(/Button\/DE\d+/);
  });

  it('stays silent on stderr without --verbose', async () => {
    const dir = tempCopyOfFixture();
    const { err } = await invoke([dir, '--no-report']);
    expect(err).toBe('');
  });

  it('appends one history entry with --record-history', async () => {
    const dir = tempCopyOfFixture();
    await invoke([dir, '--record-history', '--no-report']);
    await invoke([dir, '--record-history', '--no-report']);

    const lines = fs
      .readFileSync(path.join(dir, '.current', 'history.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toHaveProperty('metricsHash');
  });

  it('writes no history unless asked', async () => {
    const dir = tempCopyOfFixture();
    await invoke([dir, '--no-report']);
    expect(fs.existsSync(path.join(dir, '.current', 'history.jsonl'))).toBe(false);
  });

  it('reports a malformed config as a clean error, not a stack trace', async () => {
    const dir = tempCopyOfFixture();
    fs.writeFileSync(path.join(dir, '.polder.yml'), 'current:\n  components:\n    Button:\n     code: "a"\n   \tbad\n');
    const { code, err } = await invoke([dir]);
    expect(code).toBe(2);
    expect(err).toContain('.polder.yml:');
    expect(err).not.toContain('    at ');
  });

  it('reports an unparseable component file with file and line', async () => {
    const dir = tempCopyOfFixture();
    fs.writeFileSync(path.join(dir, 'src', 'Button', 'Button.tsx'), 'export const B = (<div>\n');
    const { code, err } = await invoke([dir]);
    expect(code).toBe(2);
    expect(err).toMatch(/Button\.tsx:\d+/);
    expect(err).not.toContain('    at ');
  });

  it('refuses a path that escapes the repo root', async () => {
    const dir = tempCopyOfFixture();
    fs.writeFileSync(
      path.join(dir, '.polder.yml'),
      'current:\n  components:\n    Evil:\n      code: "../../../../etc/passwd"\n',
    );
    const { code, err } = await invoke([dir]);
    expect(code).toBe(2);
    expect(err).toContain('resolves outside the repo root');
  });

  it('exits 1 when the score is below fail_under', async () => {
    const dir = tempCopyOfFixture();
    fs.appendFileSync(path.join(dir, '.polder.yml'), '\n  fail_under: 99\n');
    const { code, err } = await invoke([dir, '--no-report']);
    expect(code).toBe(1);
    expect(err).toContain('below fail_under');
  });

  it('exits 0 when the score clears fail_under', async () => {
    const dir = tempCopyOfFixture();
    fs.appendFileSync(path.join(dir, '.polder.yml'), '\n  fail_under: 1\n');
    expect((await invoke([dir, '--no-report'])).code).toBe(0);
  });

  it('tells the user how to set the token when figma list has none', async () => {
    const dir = tempCopyOfFixture();
    const { code, err } = await invoke(['figma', 'list', dir], {});
    expect(code).toBe(2);
    expect(err).toContain('CURRENT_FIGMA_TOKEN');
  });
});
