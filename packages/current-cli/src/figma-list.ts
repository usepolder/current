import { collectComponents, type FigmaClient } from '@usepolder/current-core';

/**
 * Print every component in the file with its node id, ready to paste into
 * `.current.yml`. Real design systems bury components inside pages, sections
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
    'Paste the ones you want into the `components:` block of .current.yml:',
    '',
  ];

  for (const [page, list] of byPage) {
    lines.push(`# ${page || 'Untitled page'}`);
    const width = Math.max(...list.map((c) => c.name.length));
    for (const c of list) {
      const suffix = c.type === 'COMPONENT_SET' ? '  # component set' : '';
      lines.push(`  ${c.name}:${' '.repeat(width - c.name.length)}  { figma: "${c.id}" }${suffix}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
