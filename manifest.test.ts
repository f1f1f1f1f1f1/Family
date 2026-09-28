// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Vite copies public/manifest.json into the build unchanged, and the add-on
 * serves the page under HA's ingress path, so the manifest's URLs have to be
 * relative to it and point at files in public/.
 */
const root = import.meta.dirname;
const publicDir = join(root, 'public');
const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.json'), 'utf8')) as {
  start_url: string;
  icons: { src: string; sizes: string; type: string }[];
};

describe('web app manifest', () => {
  it('opens the app at its own address, not the site root', () => {
    expect(manifest.start_url).toBe('./');
  });

  it('points every icon at a file shipped in public/', () => {
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      expect(icon.src, icon.src).not.toMatch(/^(\/|[a-z]+:)/i);
      expect(existsSync(join(publicDir, icon.src)), icon.src).toBe(true);
    }
  });

  it('gives each PNG icon its real size', () => {
    for (const icon of manifest.icons.filter((i) => i.type === 'image/png')) {
      const png = readFileSync(join(publicDir, icon.src));
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.src).toBe(icon.sizes);
    }
  });

  it('ships the same SVG icon as the source one', () => {
    expect(readFileSync(join(publicDir, 'icons', 'beacon-app-icon.svg'), 'utf8')).toBe(
      readFileSync(join(root, 'src', 'assets', 'beacon-app-icon.svg'), 'utf8'),
    );
  });

  it('links the manifest and icons index.html uses to existing files', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const hrefs = [...html.matchAll(/<link rel="(?:manifest|icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(hrefs.length).toBeGreaterThanOrEqual(4);
    for (const href of hrefs) {
      expect(existsSync(join(publicDir, href)) || existsSync(join(root, href)), href).toBe(true);
    }
  });
});
