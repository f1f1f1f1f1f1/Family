/**
 * A test image of the given size: white circles on blue, coloured bands on
 * each edge (red top, blue bottom, green left, yellow right) and a red dot
 * at its exact centre. Shown in place of the photo to check where the
 * centre of an image lands on screen.
 */
export function testPatternUrl(w = 1448, h = 1930): string {
  const step = Math.round(Math.min(w, h) / 7);
  let circles = '';
  for (let x = step / 2; x < w; x += step) {
    for (let y = step / 2; y < h; y += step) {
      circles += `<circle cx="${x}" cy="${y}" r="${step * 0.3}" fill="none" stroke="#fff" stroke-width="6"/>`;
    }
  }
  const band = Math.round(Math.min(w, h) * 0.04);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<rect width="${w}" height="${h}" fill="#2a6f97"/>${circles}`
    + `<rect width="${w}" height="${band}" fill="#d62828"/><rect y="${h - band}" width="${w}" height="${band}" fill="#1d4ed8"/>`
    + `<rect width="${band}" height="${h}" fill="#2a9d3a"/><rect x="${w - band}" width="${band}" height="${h}" fill="#f2c200"/>`
    + `<circle cx="${w / 2}" cy="${h / 2}" r="${step * 0.45}" fill="#e63946"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
