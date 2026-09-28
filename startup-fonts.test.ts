// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The stylesheets index.html links, and whatever they @import, hold up the
 * page and its scripts until they load. A display on a home network with no
 * internet access waited for fonts.googleapis.com that way, so the web font
 * is linked from index.html in a way that doesn't hold anything up.
 */
const root = import.meta.dirname;

describe('startup fonts', () => {
  it("doesn't import stylesheets from another site into the app's own", () => {
    const src = join(root, 'src');
    const sheets = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.css'));
    expect(sheets.length).toBeGreaterThan(0);
    for (const sheet of sheets) {
      expect(readFileSync(join(src, sheet), 'utf8'), sheet).not.toMatch(/@import\s+(?:url\(\s*)?['"]?(?:https?:)?\/\//);
    }
  });

  it('loads the web font without holding up startup', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const links = [...html.matchAll(/<link [^>]*href="https:\/\/fonts\.googleapis\.com\/[^>]*>/g)].map((m) => m[0]);
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('media="print"');
    expect(links[0]).toContain(`onload="this.media='all'"`);
  });
});
