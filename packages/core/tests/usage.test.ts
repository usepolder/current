import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  CurrentError,
  ParseError,
  PathTraversalError,
  loadUsage,
  parseConfig,
  parseReachUsage,
  resolveUsageFile,
  usagePriority,
  weakestAxis,
} from '@usepolder/current-core';

const reach = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ schemaVersion: 2, tool: 'reach', usage: { Button: 412, Divider: 9 }, ...over });

describe('parseReachUsage', () => {
  it('reads per-component usage', () => {
    expect([...parseReachUsage(reach(), 'reach.json')]).toEqual([
      ['Button', 412],
      ['Divider', 9],
    ]);
  });

  it('accepts a repo that uses nothing', () => {
    expect(parseReachUsage(reach({ usage: {} }), 'reach.json').size).toBe(0);
  });

  it('rejects a v1 report instead of reading it as "nothing is used"', () => {
    const v1 = JSON.stringify({ schemaVersion: 1, tool: 'reach', counts: {} });
    expect(() => parseReachUsage(v1, 'reach.json')).toThrow(/before per-component usage/);
  });

  it('rejects a report from another tool', () => {
    expect(() => parseReachUsage(reach({ tool: 'drift' }), 'x.json')).toThrow(/not a Reach report/);
  });

  it('rejects invalid JSON with the file name', () => {
    expect(() => parseReachUsage('{nope', 'reach.json')).toThrow(ParseError);
    expect(() => parseReachUsage('[]', 'reach.json')).toThrow(ConfigValidationError);
  });

  it('rejects a missing or malformed usage object', () => {
    expect(() => parseReachUsage(reach({ usage: undefined }), 'r.json')).toThrow(/no `usage`/);
    expect(() => parseReachUsage(reach({ usage: { Button: -1 } }), 'r.json')).toThrow(/usage\.Button/);
    expect(() => parseReachUsage(reach({ usage: { Button: '12' } }), 'r.json')).toThrow(/usage\.Button/);
  });
});

describe('weakestAxis', () => {
  it('picks the lower of code and design', () => {
    expect(weakestAxis(80, 40)).toEqual({ axis: 'design', score: 40 });
    expect(weakestAxis(30, 40)).toEqual({ axis: 'code', score: 30 });
  });

  it('uses the one axis that was measured', () => {
    expect(weakestAxis(55, null)).toEqual({ axis: 'code', score: 55 });
    expect(weakestAxis(null, 55)).toEqual({ axis: 'design', score: 55 });
  });

  it('is null when neither was measured', () => {
    expect(weakestAxis(null, null)).toBeNull();
  });
});

describe('usagePriority', () => {
  it('makes a broken Button outrank an equally broken Divider', () => {
    const button = usagePriority(20, 90, 400, 400);
    const divider = usagePriority(20, 90, 4, 400);
    expect(button).toBe(80);
    expect(divider).toBe(0.8);
  });

  it('scales linearly with use', () => {
    expect(usagePriority(40, 40, 100, 200)).toBe(30);
  });

  it('is zero for a perfect component and for an unused one', () => {
    expect(usagePriority(100, 100, 400, 400)).toBe(0);
    expect(usagePriority(0, 0, 0, 400)).toBe(0);
  });

  it('is zero, not NaN, when nothing at all is used', () => {
    expect(usagePriority(0, 0, 0, 0)).toBe(0);
  });

  it('is null when nothing was scored, so unmeasured is never ranked as fine', () => {
    expect(usagePriority(null, null, 400, 400)).toBeNull();
  });
});

describe('usage file resolution', () => {
  const temps: string[] = [];
  afterEach(() => {
    while (temps.length > 0) fs.rmSync(temps.pop()!, { recursive: true, force: true });
  });
  const cfg = (extra: string) =>
    parseConfig(`current:\n  components:\n    Button:\n      code: "b.tsx"\n${extra}`);

  it('is null when the config sets none', () => {
    expect(resolveUsageFile(cfg(''), '/repo')).toBeNull();
  });

  it('resolves inside the repo', () => {
    expect(resolveUsageFile(cfg('  usage: "reach.json"\n'), '/repo')).toBe('/repo/reach.json');
  });

  it('refuses a path that escapes the repo — config comes off PR branches', () => {
    expect(() => resolveUsageFile(cfg('  usage: "../secrets.json"\n'), '/repo')).toThrow(
      PathTraversalError,
    );
    expect(() => resolveUsageFile(cfg('  usage: "/etc/passwd"\n'), '/repo')).toThrow(
      PathTraversalError,
    );
  });

  it('rejects a non-string usage key', () => {
    expect(() => cfg('  usage: 12\n')).toThrow(/Reach JSON report/);
    expect(() => cfg('  usage: ""\n')).toThrow(/Reach JSON report/);
  });

  it('loadUsage says how to produce the file when it is missing', () => {
    expect(() => loadUsage('/nope/reach.json')).toThrow(CurrentError);
    expect(() => loadUsage('/nope/reach.json')).toThrow(/Run Reach first/);
  });

  it('loadUsage reads a real file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-usage-'));
    temps.push(dir);
    fs.writeFileSync(path.join(dir, 'reach.json'), reach());
    expect(loadUsage(path.join(dir, 'reach.json')).get('Button')).toBe(412);
  });
});
