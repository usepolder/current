import { collectComponents, type FigmaClient } from '@usepolder/current-core';

/**
 * Flatten a Figma-supplied string to a single line.
 *
 * Figma puts no constraints on component or page names: pasting styled text
 * into a layer name is enough to embed a newline. This output is a block the
 * reader is told to paste into `.polder.yml`, so a name that ends its own
 * line turns one mapping entry into two lines of something else.
 *
 * (`current init` grew the same helper in `init.ts` on PR usepolder/current#21;
 * when both have landed they should share one copy.)
 */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * A bare YAML key, or a quoted one when bare would not round-trip.
 *
 * `figma list` output is pasted verbatim and then parsed, so this quotes
 * unless the name is provably safe — an allowlist, rather than `init`'s
 * denylist of characters that read badly inside a comment. The failure modes
 * differ: a case missed in a comment is cosmetic, while a case missed here
 * either fails to load or silently maps a key the reader never typed
 * (`on:` becomes `true`, `404:` becomes the number 404).
 */
export function yamlKey(name: string): string {
  const flat = oneLine(name);
  if (SAFE_KEY.test(flat) && !RESERVED_KEY.test(flat)) return flat;
  return `"${flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Letters, digits and the punctuation design systems actually use in
 * component names. Deliberately excludes every YAML indicator character,
 * `:` and `#` among them, and anything that could start a plain scalar
 * ambiguously.
 */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9 _.\-/]*$/;

/** Plain scalars YAML would read as a boolean or null rather than a name. */
const RESERVED_KEY =
  /^(y|Y|n|N|yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|null|Null|NULL|~)$/;

/**
 * Print every component in the file with its node id, ready to paste into
 * `.polder.yml`. Real design systems bury components inside pages, sections
 * and frames, so this walks the whole document tree — a scan of the
 * document's direct children finds almost nothing.
 */
export async function figmaList(client: FigmaClient): Promise<string> {
  const document = await client.fetchFile();
  const components = collectComponents(document);

  if (components.length === 0) {
    return 'No components or component sets found in this Figma file.';
  }

  const byPage = new Map<string, typeof components>();
  for (const c of components) {
    const list = byPage.get(c.page) ?? [];
    list.push(c);
    byPage.set(c.page, list);
  }

  const lines: string[] = [
    `Found ${components.length} component${components.length === 1 ? '' : 's'}.`,
    'Paste these under `current.components` in .polder.yml:',
    '',
  ];

  for (const [page, list] of byPage) {
    lines.push(`# ${oneLine(page) || 'Untitled page'}`);
    // Width comes from the rendered key, not the raw name: quoting changes
    // its length, and a newline in the raw name made the old padding wrong
    // for every entry on the page.
    const keys = list.map((c) => yamlKey(c.name));
    const width = Math.max(...keys.map((k) => k.length));
    list.forEach((c, i) => {
      const key = keys[i];
      const suffix = c.type === 'COMPONENT_SET' ? '  # component set' : '';
      lines.push(`  ${key}:${' '.repeat(width - key.length)}  { figma: "${c.id}" }${suffix}`);
    });
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
