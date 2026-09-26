import { describe, it, expect, afterEach } from 'vitest';
import { applyFontScale, applyStoredFontScale } from './font-scale';

const root = document.documentElement;

afterEach(() => {
  root.removeAttribute('data-font-scale');
  root.style.fontSize = '';
});

describe('applyFontScale', () => {
  it.each([
    ['normal', '100%'],
    ['large', '112.5%'],
    ['extra-large', '125%'],
  ])('%s sets the root attribute and font size to %s', (scale, size) => {
    applyFontScale(scale);
    expect(root.getAttribute('data-font-scale')).toBe(scale);
    expect(root.style.fontSize).toBe(size);
  });

  it('follows the setting when it changes back', () => {
    applyFontScale('extra-large');
    applyFontScale('normal');
    expect(root.getAttribute('data-font-scale')).toBe('normal');
    expect(root.style.fontSize).toBe('100%');
  });

  it('treats unknown or missing values as normal', () => {
    applyFontScale('huge');
    expect(root.getAttribute('data-font-scale')).toBe('normal');
    applyFontScale(undefined);
    expect(root.style.fontSize).toBe('100%');
  });
});

describe('applyStoredFontScale', () => {
  it('applies the cached setting before the app loads', () => {
    localStorage.setItem('beacon-settings', JSON.stringify({ fontScale: 'large' }));
    applyStoredFontScale();
    expect(root.getAttribute('data-font-scale')).toBe('large');
    expect(root.style.fontSize).toBe('112.5%');
  });

  it('falls back to normal without cached settings', () => {
    applyStoredFontScale();
    expect(root.getAttribute('data-font-scale')).toBe('normal');
  });

  it('falls back to normal when the cache is unreadable', () => {
    localStorage.setItem('beacon-settings', '{not json');
    applyStoredFontScale();
    expect(root.getAttribute('data-font-scale')).toBe('normal');
  });
});
