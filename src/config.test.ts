import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadConfig(runtime: Record<string, unknown>) {
  window.__BEACON_CONFIG__ = runtime;
  vi.resetModules();
  const { getConfig } = await import('./config');
  return getConfig();
}

describe('getConfig', () => {
  afterEach(() => {
    delete window.__BEACON_CONFIG__;
  });

  // The add-on option accepts any int. 0 used to start the screen saver
  // within seconds of every touch.
  it.each([0, -3])('uses the default screen saver timeout for %i', async (minutes) => {
    expect((await loadConfig({ screen_saver_timeout: minutes })).screen_saver_timeout).toBe(5);
  });

  it('keeps a positive screen saver timeout', async () => {
    expect((await loadConfig({ screen_saver_timeout: 20 })).screen_saver_timeout).toBe(20);
  });
});
