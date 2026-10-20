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
 * A heading satisfies a metric when it STARTS with one of the synonyms, on a
 * word boundary.
 *
 * Start-anchored on purpose. A plain substring test let Button's "Icon Usage"
 * satisfy "usage guidelines are documented", which it does not — that section
 * is about icons, not about when to use the component. Requiring the synonym
 * at the front keeps "Usage", "Usage guidelines" and "When to use" while
 * dropping "Icon Usage".
 */
export function headingMatches(heading: string, needle: string): boolean {
  const h = heading.toLowerCase().trim();
  const n = needle.toLowerCase().trim();
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
