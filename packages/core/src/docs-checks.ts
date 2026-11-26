import type { CheckResult } from './code-checks';

export interface DocsFacts {
  componentName: string;
  /** Headings found in the doc, or null when there is no doc to read. */
  headings: readonly string[] | null;
  /** Why there are no headings, when there are none. */
  absence: 'unmapped' | 'missing' | 'no-renderer' | 'unreadable' | null;
  /** Detail for the absence, e.g. the fetch error. */
  absenceDetail?: string;
  /** Heading synonyms that satisfy this metric. */
  wanted: readonly string[];
}

const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm;
/** MDX/JSX docs often use <Section title="Usage"> instead of a heading. */
const TITLE_PROP = /\b(?:title|heading|label)\s*=\s*["']([^"']+)["']/g;

export function extractHeadings(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(MARKDOWN_HEADING)) out.push(match[1].trim());
  for (const match of source.matchAll(TITLE_PROP)) out.push(match[1].trim());
  return out;
}

const HTML_HEADING = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;

/** Headings from rendered HTML. Tag-stripped and entity-decoded, nothing fancier. */
export function extractHtmlHeadings(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(HTML_HEADING)) {
    const text = match[1]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (text !== '') out.push(text);
  }
  return out;
}

/**
 * Real docs often head one section with two topics, e.g. "Behaviour / States"
 * or "Content & tone". Each side of such a separator is its own topic, so a
 * heading is matched segment by segment.
 */
function headingSegments(heading: string): string[] {
  return heading
    .split(/\s*(?:[/|&+,;•·—–]|\band\b|\bor\b)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * A heading satisfies a metric when one of its segments STARTS with one of the
 * synonyms, on a word boundary.
 *
 * Start-anchored on purpose. A plain substring test let Button's "Icon Usage"
 * satisfy "usage guidelines are documented", which it does not — that section
 * is about icons, not about when to use the component. Requiring the synonym
 * at the front of a segment keeps "Usage", "Usage guidelines", "When to use"
 * and "Behaviour / States" while dropping "Icon Usage".
 */
export function headingMatches(heading: string, needle: string): boolean {
  const n = needle.toLowerCase().trim();
  return headingSegments(heading).some((segment) => segmentMatches(segment, n));
}

function segmentMatches(segment: string, n: string): boolean {
  const h = segment.toLowerCase().trim();
  if (!h.startsWith(n)) return false;
  // Tolerate a plural: real docs head a section "Variants" while the synonym
  // list says "variant". "Stateful" still fails, because the next character
  // is not an 's'.
  const after = h[n.length] === 's' ? h.slice(n.length + 1) : h.slice(n.length);
  const next = after[0];
  return next === undefined || !/[a-z0-9]/.test(next);
}

export function checkDocSection(facts: DocsFacts): CheckResult {
  if (facts.headings === null) {
    switch (facts.absence) {
      case 'missing':
        return { answer: 'No', evidence: 'docs are mapped in .polder.yml but missing on disk' };
      case 'no-renderer':
        return {
          answer: 'N/A',
          evidence:
            'docs are a URL, and no page renderer is installed — run `npm i playwright` to score hosted docs',
        };
      case 'unreadable':
        return {
          answer: 'N/A',
          evidence: `docs page could not be read: ${facts.absenceDetail ?? 'unknown error'}`,
        };
      default:
        return { answer: 'N/A', evidence: 'no docs mapped for this component' };
    }
  }

  if (facts.headings.length === 0) {
    return { answer: 'No', evidence: 'docs have no headings or titled sections to match against' };
  }

  const hit = facts.headings.find((h) => facts.wanted.some((n) => headingMatches(h, n)));
  if (hit !== undefined) return { answer: 'Yes', evidence: `matched heading "${hit}"` };

  return {
    answer: 'No',
    evidence: `no heading starting with ${facts.wanted
      .map((n) => `"${n}"`)
      .join(' / ')} (found: ${facts.headings.slice(0, 8).join(', ')})`,
  };
}

/** What DO10 compares: the docs' own text and the code's props. */
export interface DocsPropsFacts {
  componentName: string;
  /** The local docs file's text, or null when there is none to read. */
  source: string | null;
  /** The docs are a hosted page, read for headings only. */
  hosted: boolean;
  absence: DocsFacts['absence'];
  /** Props the component declares (CO9's collector), or null with no code. */
  codeProps: readonly string[] | null;
}

/**
 * Tags that render a props table FROM THE COMPONENT'S TYPES at build time.
 * A table generated from the types cannot drift from them, which is the best
 * answer this norm has.
 */
const GENERATED_TABLE = /<(ArgTypes|ArgsTable|PropsTable|Controls|Props)\b/;

/** A heading that introduces the props table. */
const PROPS_HEADING = /\b(props|properties|api)\b/i;

/** First-column headers a props table uses. */
const PROPS_COLUMN = new Set(['prop', 'props', 'property', 'properties', 'name', 'attribute']);

/**
 * Props a docs table conventionally leaves to "and all the usual HTML
 * attributes". Requiring them would fail nearly every system for a table
 * that is, in practice, complete.
 */
const PASSTHROUGH_PROPS = new Set(['classname', 'style', 'ref', 'key']);

function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** `` `size?` ``, `**size**`, `size *` → `size`. */
function propCell(cell: string): string | null {
  const m = cell.replace(/[`*_]/g, '').match(/[A-Za-z_$][\w$-]*/);
  return m === null ? null : m[0];
}

/**
 * The prop names in the first props table under a props/API heading, or null
 * when there is no such table.
 */
export function documentedProps(source: string): string[] | null {
  const lines = source.split(/\r?\n/);
  let underPropsHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading !== null) {
      underPropsHeading = PROPS_HEADING.test(heading[1]);
      continue;
    }
    if (!underPropsHeading) continue;
    const header = tableCells(lines[i]);
    const divider = i + 1 < lines.length ? tableCells(lines[i + 1]) : null;
    if (header === null || divider === null || !divider.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!PROPS_COLUMN.has(header[0].replace(/[`*_]/g, '').toLowerCase())) continue;

    const names: string[] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const row = tableCells(lines[j]);
      if (row === null) break;
      const name = propCell(row[0] ?? '');
      if (name !== null) names.push(name);
    }
    return names;
  }
  return null;
}

/**
 * DO10 — the props the docs document are the props the code accepts.
 *
 * Docs are where people learn the system. A props table that lists a prop
 * that was removed, or misses one that was added, has consumers building
 * against an API that does not exist — drift in the place it costs most.
 *
 * Names compare case-insensitively and otherwise exactly. Unlike CO9, which
 * pairs Figma's `Disabled` with code's `isDisabled`, a docs table saying
 * `disabled` for a prop called `isDisabled` is itself the bug: the docs are
 * meant to be the API.
 */
export function checkDocumentedProps(facts: DocsPropsFacts): CheckResult {
  if (facts.hosted) {
    return { answer: 'N/A', evidence: 'docs are a hosted page, which is read for headings only' };
  }
  if (facts.source === null) {
    return {
      answer: 'N/A',
      evidence:
        facts.absence === 'missing'
          ? 'docs are mapped but missing on disk, so there is no props table to compare'
          : 'no docs mapped for this component',
    };
  }
  if (facts.codeProps === null) {
    return { answer: 'N/A', evidence: 'no code to compare the documented props against' };
  }
  const generated = facts.source.match(GENERATED_TABLE);
  if (generated !== null) {
    return {
      answer: 'Yes',
      evidence: `the props table is generated from the component's types (<${generated[1]}>), so it cannot drift`,
    };
  }

  const documented = documentedProps(facts.source);
  if (documented === null) {
    return {
      answer: 'N/A',
      evidence: 'no props table found under a props or API heading (DO6 asks whether variations are documented)',
    };
  }

  const lower = (xs: readonly string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const doc = lower(documented);
  const code = lower(facts.codeProps);
  const docOnly = documented.filter((p) => !code.has(p.toLowerCase()));
  const codeOnly = facts.codeProps.filter(
    (p) => !doc.has(p.toLowerCase()) && !PASSTHROUGH_PROPS.has(p.toLowerCase()) && !/^(data|aria)-/.test(p),
  );

  if (docOnly.length === 0 && codeOnly.length === 0) {
    return {
      answer: 'Yes',
      evidence: `the props table lists the ${documented.length} prop(s) the code accepts`,
    };
  }
  const parts: string[] = [];
  if (docOnly.length > 0) parts.push(`documented but not in the code: ${[...new Set(docOnly)].join(', ')}`);
  if (codeOnly.length > 0) parts.push(`in the code but not documented: ${[...new Set(codeOnly)].join(', ')}`);
  return {
    answer: 'No',
    evidence: `${parts.join('; ')} (className, style and ref are not required in the table)`,
  };
}
