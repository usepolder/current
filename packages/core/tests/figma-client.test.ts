import { describe, expect, it } from 'vitest';
import { FigmaClient, FigmaError, collectComponents, type FigmaNode } from '@usepolder/current-core';

interface StubResponse {
  status: number;
  body?: unknown;
  retryAfter?: string;
}

function stubFetcher(responses: StubResponse[]) {
  const calls: string[] = [];
  const queue = [...responses];
  const fetcher = async (url: string) => {
    calls.push(url);
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request: ${url}`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'retry-after' ? (next.retryAfter ?? null) : null,
      },
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
  return { fetcher, calls };
}

const node = (id: string): FigmaNode => ({ id, name: `Node ${id}`, type: 'COMPONENT' });

describe('FigmaClient.fetchNodes', () => {
  it('fetches every node id in a single batched request', async () => {
    const { fetcher, calls } = stubFetcher([
      { status: 200, body: { nodes: { '1:1': { document: node('1:1') }, '2:2': { document: node('2:2') } } } },
    ]);
    const client = new FigmaClient({ token: 't', fileKey: 'abc', fetcher });

    const result = await client.fetchNodes(['1:1', '2:2']);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('ids=1%3A1,2%3A2');
    expect(result.size).toBe(2);
  });

  it('chunks when there are more ids than the batch size', async () => {
    const { fetcher, calls } = stubFetcher([
      { status: 200, body: { nodes: { '1:1': { document: node('1:1') } } } },
      { status: 200, body: { nodes: { '2:2': { document: node('2:2') } } } },
    ]);
    const client = new FigmaClient({ token: 't', fileKey: 'abc', fetcher, batchSize: 1 });

    const result = await client.fetchNodes(['1:1', '2:2']);

    expect(calls).toHaveLength(2);
    expect(result.size).toBe(2);
  });

  it('de-duplicates repeated ids', async () => {
    const { fetcher, calls } = stubFetcher([
      { status: 200, body: { nodes: { '1:1': { document: node('1:1') } } } },
    ]);
    const client = new FigmaClient({ token: 't', fileKey: 'abc', fetcher, batchSize: 10 });

    await client.fetchNodes(['1:1', '1:1', '1:1']);

    expect(calls[0]).toContain('ids=1%3A1');
    expect(calls[0]).not.toContain(',');
  });

  it('retries a 429 and succeeds, honouring Retry-After', async () => {
    const slept: number[] = [];
    const { fetcher, calls } = stubFetcher([
      { status: 429, retryAfter: '2' },
      { status: 200, body: { nodes: { '1:1': { document: node('1:1') } } } },
    ]);
    const client = new FigmaClient({
      token: 't',
      fileKey: 'abc',
      fetcher,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    const result = await client.fetchNodes(['1:1']);

    expect(calls).toHaveLength(2);
    expect(slept).toEqual([2000]);
    expect(result.size).toBe(1);
  });

  it('backs off exponentially when Retry-After is absent', async () => {
    const slept: number[] = [];
    const { fetcher } = stubFetcher([
      { status: 429 },
      { status: 429 },
      { status: 200, body: { nodes: {} } },
    ]);
    const client = new FigmaClient({
      token: 't',
      fileKey: 'abc',
      fetcher,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await client.fetchNodes(['1:1']);

    expect(slept).toEqual([1000, 2000]);
  });

  it('gives up after the retry budget and says so', async () => {
    const { fetcher, calls } = stubFetcher([
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 429 },
    ]);
    const client = new FigmaClient({
      token: 't',
      fileKey: 'abc',
      fetcher,
      maxRetries: 3,
      sleep: async () => {},
    });

    await expect(client.fetchNodes(['1:1'])).rejects.toThrow(/rate limit still in effect/);
    expect(calls).toHaveLength(4);
  });

  it('does not retry an auth failure', async () => {
    const { fetcher, calls } = stubFetcher([{ status: 403 }]);
    const client = new FigmaClient({ token: 't', fileKey: 'abc', fetcher, sleep: async () => {} });

    await expect(client.fetchNodes(['1:1'])).rejects.toThrow(/rejected the token/);
    expect(calls).toHaveLength(1);
  });

  it('names the file key on a 404', async () => {
    const { fetcher } = stubFetcher([{ status: 404 }]);
    const client = new FigmaClient({ token: 't', fileKey: 'missing-key', fetcher });

    await expect(client.fetchNodes(['1:1'])).rejects.toThrow(/missing-key/);
  });

  it('reports non-JSON responses as a FigmaError, not a raw SyntaxError', async () => {
    const fetcher = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<html>maintenance</html>',
    });
    const client = new FigmaClient({ token: 't', fileKey: 'abc', fetcher });

    await expect(client.fetchNodes(['1:1'])).rejects.toBeInstanceOf(FigmaError);
  });

  it('skips node ids the file does not contain instead of inventing entries', async () => {
    const { fetcher } = stubFetcher([
      { status: 200, body: { nodes: { '1:1': { document: node('1:1') }, '9:9': null } } },
    ]);
    const client = new FigmaClient({ token: 't', fileKey: 'abc', fetcher });

    const result = await client.fetchNodes(['1:1', '9:9']);

    expect(result.has('1:1')).toBe(true);
    expect(result.has('9:9')).toBe(false);
  });
});

describe('collectComponents', () => {
  const document: FigmaNode = {
    id: '0:0',
    name: 'Document',
    type: 'DOCUMENT',
    children: [
      {
        id: '1:0',
        name: 'Foundations',
        type: 'CANVAS',
        children: [{ id: '1:1', name: 'Colour', type: 'FRAME' }],
      },
      {
        id: '2:0',
        name: 'Components',
        type: 'CANVAS',
        children: [
          {
            id: '2:1',
            name: 'Section',
            type: 'SECTION',
            children: [
              {
                id: '2:2',
                name: 'Inputs',
                type: 'FRAME',
                children: [
                  { id: '2:3', name: 'Button', type: 'COMPONENT_SET', children: [
                    { id: '2:4', name: 'Size=Large', type: 'COMPONENT' },
                  ] },
                  { id: '2:5', name: 'Checkbox', type: 'COMPONENT' },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  it('finds components nested several levels deep inside pages, sections and frames', () => {
    const found = collectComponents(document);
    expect(found.map((c) => c.name).sort()).toEqual(['Button', 'Checkbox']);
  });

  it('records which page each component lives on', () => {
    const found = collectComponents(document);
    expect(found.every((c) => c.page === 'Components')).toBe(true);
  });

  it('lists a component set once instead of one row per variant', () => {
    const found = collectComponents(document);
    const button = found.find((c) => c.name === 'Button');
    expect(button?.type).toBe('COMPONENT_SET');
    expect(found.filter((c) => c.name.startsWith('Size='))).toHaveLength(0);
  });

  it('returns nothing for a file with no components', () => {
    expect(collectComponents({ id: '0:0', name: 'Empty', type: 'DOCUMENT' })).toEqual([]);
  });
});
