import { FigmaError } from './errors';
import { silentLogger, type Logger } from './logger';

export const FIGMA_API = 'https://api.figma.com';
export const TOKEN_ENV_VAR = 'CURRENT_FIGMA_TOKEN';

/** A Figma document node, loosely typed — we only read a handful of fields. */
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  layoutMode?: string;
  cornerRadius?: number;
  boundVariables?: Record<string, unknown>;
  styles?: Record<string, string>;
  fills?: Array<Record<string, unknown>>;
  strokes?: Array<Record<string, unknown>>;
  style?: Record<string, unknown>;
  transitionNodeID?: string | null;
  interactions?: unknown[];
  componentPropertyDefinitions?: Record<string, unknown>;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  [key: string]: unknown;
}

export interface FigmaFetcher {
  (url: string, init: { headers: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}

export interface FigmaClientOptions {
  token: string;
  fileKey: string;
  fetcher?: FigmaFetcher;
  logger?: Logger;
  /** Node ids per request. Figma's URL has a practical length limit. */
  batchSize?: number;
  maxRetries?: number;
  /** Injected so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRIES = 3;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FigmaClient {
  private readonly token: string;
  private readonly fileKey: string;
  private readonly fetcher: FigmaFetcher;
  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: FigmaClientOptions) {
    this.token = opts.token;
    this.fileKey = opts.fileKey;
    this.fetcher = opts.fetcher ?? ((globalThis as { fetch?: FigmaFetcher }).fetch as FigmaFetcher);
    this.logger = opts.logger ?? silentLogger;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = opts.sleep ?? defaultSleep;
    if (typeof this.fetcher !== 'function') {
      throw new FigmaError('No fetch implementation available (Node 20+ required)');
    }
  }

  /**
   * Fetch many nodes in one call instead of one request per component. A
   * 32-component design system is one request here and 32 sequentially
   * otherwise, which also keeps us well clear of the per-token rate limit.
   */
  async fetchNodes(nodeIds: readonly string[]): Promise<Map<string, FigmaNode>> {
    const out = new Map<string, FigmaNode>();
    const unique = [...new Set(nodeIds)];
    for (let i = 0; i < unique.length; i += this.batchSize) {
      const batch = unique.slice(i, i + this.batchSize);
      const ids = batch.map(encodeURIComponent).join(',');
      const url = `${FIGMA_API}/v1/files/${encodeURIComponent(this.fileKey)}/nodes?ids=${ids}`;
      this.logger.trace(`figma: fetching ${batch.length} node(s) in one request`);
      const payload = await this.request<{ nodes: Record<string, { document?: FigmaNode } | null> }>(url);
      for (const [id, entry] of Object.entries(payload.nodes ?? {})) {
        if (entry && entry.document) out.set(id, entry.document);
      }
    }
    return out;
  }

  /** Whole-file document tree, used by `current figma list`. */
  async fetchFile(): Promise<FigmaNode> {
    const url = `${FIGMA_API}/v1/files/${encodeURIComponent(this.fileKey)}`;
    this.logger.trace('figma: fetching full file document');
    const payload = await this.request<{ document: FigmaNode }>(url);
    if (!payload.document) {
      throw new FigmaError('Figma returned a file with no document tree');
    }
    return payload.document;
  }

  private async request<T>(url: string): Promise<T> {
    let attempt = 0;
    for (;;) {
      const res = await this.fetcher(url, { headers: { 'X-Figma-Token': this.token } });
      if (res.ok) {
        const body = await res.text();
        try {
          return JSON.parse(body) as T;
        } catch {
          throw new FigmaError('Figma returned a response that is not valid JSON');
        }
      }

      if (res.status === 401 || res.status === 403) {
        throw new FigmaError(
          `Figma rejected the token (HTTP ${res.status}). Check $${TOKEN_ENV_VAR} and that the ` +
            'token has access to this file.',
          { status: res.status },
        );
      }
      if (res.status === 404) {
        throw new FigmaError(
          `Figma file "${this.fileKey}" not found (HTTP 404). Check figma.file_key in .current.yml.`,
          { status: 404 },
        );
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        throw new FigmaError(
          res.status === 429
            ? `Figma rate limit still in effect after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`
            : `Figma request failed (HTTP ${res.status})`,
          { status: res.status, retryable },
        );
      }

      attempt += 1;
      const retryAfter = Number(res.headers.get('Retry-After'));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 500, 8000);
      this.logger.trace(
        `figma: HTTP ${res.status}, retry ${attempt}/${this.maxRetries} in ${waitMs}ms`,
      );
      await this.sleep(waitMs);
    }
  }
}

/**
 * Recursively collect every COMPONENT / COMPONENT_SET in a file. Real design
 * systems nest components inside pages, sections and frames, so a flat scan
 * of the document's direct children finds almost nothing.
 */
export interface FigmaComponentSummary {
  id: string;
  name: string;
  type: string;
  page: string;
}

export function collectComponents(document: FigmaNode): FigmaComponentSummary[] {
  const out: FigmaComponentSummary[] = [];

  const visit = (node: FigmaNode, page: string): void => {
    const currentPage = node.type === 'CANVAS' ? node.name : page;
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      out.push({ id: node.id, name: node.name, type: node.type, page: currentPage });
      // A COMPONENT_SET's children are its variants; listing each variant
      // separately would bury the set itself in noise.
      if (node.type === 'COMPONENT_SET') return;
    }
    for (const child of node.children ?? []) visit(child, currentPage);
  };

  visit(document, '');
  return out;
}
