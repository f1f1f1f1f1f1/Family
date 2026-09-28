// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Runs run.sh's runtime-config.js step (the add-on's options for the page)
 * in bash, writing to a temporary file instead of /app/dist.
 */
describe('run.sh runtime config', () => {
  it('defaults the add-on parent PIN and entity blocklist to blank', () => {
    const manifest = readFileSync(join(import.meta.dirname, 'config.yaml'), 'utf8');
    expect(manifest).toMatch(/^  parent_pin: ""$/m);
    expect(manifest).toMatch(/^  blocked_entities: ""$/m);
    expect(manifest).toMatch(/^  parent_pin: password\?$/m);
    expect(manifest).not.toMatch(/^  allowed_entities: ""$/m);
  });

  it('treats an older installation with parent_pin=null as an unset PIN', () => {
    const script = readFileSync(join(import.meta.dirname, 'run.sh'), 'utf8');
    const block = script.slice(
      script.indexOf('if [ -n "${SUPERVISOR_TOKEN:-}" ]; then'),
      script.indexOf('# Fetch this add-on'),
    );
    const shell = [
      'bashio::config() { case "$1" in parent_pin) echo null ;; blocked_entities) echo todo.private ;; *) return 1 ;; esac; }',
      'bashio::log.warning() { :; }',
      block,
      'printf "PIN=%s BLOCKED=%s" "$BEACON_PARENT_PIN" "$BEACON_BLOCKED_ENTITIES"',
    ].join('\n');
    const output = execFileSync('bash', ['-c', shell], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SUPERVISOR_TOKEN: 'test' },
    });
    expect(output).toBe('PIN= BLOCKED=todo.private');
  });

  function generate(vars: string) {
    const script = readFileSync(join(import.meta.dirname, 'run.sh'), 'utf8');
    const start = script.indexOf('# Generate runtime-config.js');
    const end = script.indexOf('# Inject the runtime-config script tag');
    const dir = mkdtempSync(join(tmpdir(), 'family-run-sh-'));
    try {
      const out = join(dir, 'runtime-config.js');
      const block = script.slice(start, end).replace('CONFIG_JS="/app/dist/runtime-config.js"', `CONFIG_JS="${out}"`);
      execFileSync('bash', ['-c', vars + block]);

      const written = readFileSync(out, 'utf8');
      const config = JSON.parse(written.replace(/^window\.__BEACON_CONFIG__ = /, '').replace(/;$/, ''));
      return { config, written };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The options followed `node -e "…"` as arguments rather than preceding it
  // as environment, so every add-on option was ignored.
  it("passes the add-on's options to the page without its Supervisor token", () => {
    const { config, written } = generate(
      'export SUPERVISOR_TOKEN="server-only-addon-token"; export BEACON_PARENT_PIN="654321"; '
      + 'THEME="midnight"; AUTO_DARK_MODE="false"; '
      + 'WEATHER_ENTITY="weather.forecast_home"; PHOTO_DIRECTORY="/media/pics"; PHOTO_INTERVAL="45"; '
      + 'SCREEN_SAVER_TIMEOUT="12"; ADDON_SLUG="abc123_family"\n',
    );
    expect(config).toEqual({
      ha_url: '', ha_token: '', ha_available: true, parent_pin_required: true,
      theme: 'midnight', auto_dark_mode: false,
      weather_entity: 'weather.forecast_home', photo_directory: '/media/pics', photo_interval: 45,
      screen_saver_timeout: 12, addon_slug: 'abc123_family',
    });
    expect(written).not.toContain('server-only-addon-token');
  });

  it('never sends the standalone HA URL or token to the browser', () => {
    const { config, written } = generate(
      'export HA_URL="https://ha.local:8123"; export HA_TOKEN="server-only-standalone-token"; '
      + 'export BEACON_PARENT_PIN=""; '
      + 'THEME="forest"; AUTO_DARK_MODE="true"; WEATHER_ENTITY="weather.home"; '
      + 'PHOTO_DIRECTORY="/media/photos"; PHOTO_INTERVAL="60"; SCREEN_SAVER_TIMEOUT="10"; ADDON_SLUG=""\n',
    );
    expect(config).toMatchObject({
      ha_url: '', ha_token: '', ha_available: true, parent_pin_required: false,
      theme: 'forest', photo_interval: 60,
    });
    expect(written).not.toContain('https://ha.local:8123');
    expect(written).not.toContain('server-only-standalone-token');
  });

  it('marks standalone local-only mode as not connected to Home Assistant', () => {
    const { config } = generate(
      'export BEACON_PARENT_PIN=""; THEME="skylight"; AUTO_DARK_MODE="true"; WEATHER_ENTITY="weather.home"; '
      + 'PHOTO_DIRECTORY="/media/photos"; PHOTO_INTERVAL="30"; SCREEN_SAVER_TIMEOUT="5"; ADDON_SLUG=""\n',
    );
    expect(config).toMatchObject({
      ha_url: '', ha_token: '', ha_available: false, parent_pin_required: false,
    });
  });
});
