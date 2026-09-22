import type { CheckResult } from './code-checks';

export interface DocsFacts {
  componentName: string;
  /** Doc file contents, or null when the file is unmapped or missing. */
  source: string | null;
  /** True when `docs:` was mapped but the file is not on disk. */
  missing: boolean;
  headings: readonly string[];
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

/**
 * Does the doc contain a section matching any of the metric's synonyms?
 *
 * This proves a section exists, not that it says anything useful — a heading
 * check is the honest ceiling for static analysis of prose. `--verbose`
 * prints the exact headings searched and the ones found, and any of these
 * metrics can be flipped to manual in `.current.yml` if the heuristic does
 * not fit a team's doc conventions.
 */
export function checkDocSection(facts: DocsFacts): CheckResult {
  if (facts.source === null) {
    return {
      answer: facts.missing ? 'No' : 'N/A',
      evidence: facts.missing
        ? 'docs file is mapped in .current.yml but missing on disk'
        : 'no docs file mapped for this component',
    };
  }
  const headings = extractHeadings(facts.source);
  if (headings.length === 0) {
    return {
      answer: 'No',
      evidence: 'docs file has no headings or titled sections to match against',
    };
  }
  const needles = facts.headings.map((h) => h.toLowerCase());
  const hit = headings.find((h) => needles.some((n) => h.toLowerCase().includes(n)));
  if (hit !== undefined) {
    return { answer: 'Yes', evidence: `matched heading "${hit}"` };
  }
  return {
    answer: 'No',
    evidence: `no heading matching ${needles.map((n) => `"${n}"`).join(' / ')} (found: ${headings
      .slice(0, 6)
      .join(', ')})`,
  };
}
