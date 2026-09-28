// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The stylesheets index.html links, and whatever they @import, hold up the
 * page and its scripts until they load. A display on a home network with no
 * internet access waited for fonts.googleapis.com that way, and every
 * display told Google when it started. Inter now ships with the app.
 */
const root = import.meta.dirname;
const FROM_ANOTHER_SITE = /(?:https?:)?\/\//;

describe('startup fonts', () => {
  it("doesn't import stylesheets from another site into the app's own", () => {
    const src = join(root, 'src');
    const sheets = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.css'));
    expect(sheets.length).toBeGreaterThan(0);
    for (const sheet of sheets) {
      const imports = readFileSync(join(src, sheet), 'utf8').match(/@import[^;]*;/g) ?? [];
      for (const rule of imports) expect(rule, sheet).not.toMatch(FROM_ANOTHER_SITE);
    }
  });

  it("doesn't load anything from another site in index.html", () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).not.toMatch(new RegExp(`^${FROM_ANOTHER_SITE.source}`));
  });

  it('ships Inter in the weights the app uses', () => {
    const css = readFileSync(join(root, 'src', 'styles', 'beacon.css'), 'utf8');
    for (const weight of [300, 400, 500, 600, 700]) {
      expect(css).toContain(`@import '@fontsource/inter/${weight}.css';`);
      expect(existsSync(join(root, 'node_modules', '@fontsource', 'inter', `${weight}.css`))).toBe(true);
    }
  });
});
