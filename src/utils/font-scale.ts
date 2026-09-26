/**
 * Settings → Appearance → Font Size.
 *
 * Text sizes in the stylesheets are in rem, so they follow the root <html>
 * font size, while layout (spacing, tap targets, icon boxes, grid widths)
 * is in px and stays put. Scaling the root therefore makes text bigger
 * without reshuffling the screen. `data-font-scale` on <html> lets CSS
 * tighten spots that get crowded at the larger sizes.
 */

import type { BeaconSettings } from '../hooks/useSettings';

export type FontScale = BeaconSettings['fontScale'];

/** Root font size for each setting, as a % of the browser default (16px). */
export const FONT_SCALE_PERCENT: Record<FontScale, number> = {
  normal: 100,
  large: 112.5,
  'extra-large': 125,
};

/** Unknown or missing values (e.g. old saved settings) fall back to normal. */
function toFontScale(value: unknown): FontScale {
  return value === 'large' || value === 'extra-large' ? value : 'normal';
}

export function applyFontScale(value: unknown): void {
  const scale = toFontScale(value);
  const root = document.documentElement;
  root.setAttribute('data-font-scale', scale);
  root.style.fontSize = `${FONT_SCALE_PERCENT[scale]}%`;
}

/**
 * Apply the locally cached setting before React renders, so text doesn't
 * jump size on load.
 */
export function applyStoredFontScale(): void {
  let stored: unknown;
  try {
    const raw = localStorage.getItem('beacon-settings');
    if (raw) stored = JSON.parse(raw)?.fontScale;
  } catch {
    /* no cached settings */
  }
  applyFontScale(stored);
}
