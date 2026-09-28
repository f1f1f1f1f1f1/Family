// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/*
 * Runs run.sh's port and AirPlay steps in bash, with bashio's functions
 * stubbed (options come from `options`; anything else is "null", as in
 * bashio), the permission changes recorded instead of made, and a stand-in
 * `uxplay` on the PATH unless `uxplay` is false.
 */
describe('run.sh port and AirPlay receiver', () => {
  const HOST_NETWORK = '{"data":{"slug":"abc_family","ingress_port":3000,"host_network":true}}';
  const BRIDGED = '{"data":{"slug":"abc_family","ingress_port":3000,"host_network":false}}';

  function run(
    options: Record<string, string>,
    { body = BRIDGED, env = { SUPERVISOR_TOKEN: 'test' } as Record<string, string>, uxplay = true } = {},
  ) {
    const script = readFileSync(join(import.meta.dirname, 'run.sh'), 'utf8');
    const block = script.slice(script.indexOf('# The port Home Assistant'), script.indexOf('# The server reaches Home Assistant'));
    const dir = mkdtempSync(join(tmpdir(), 'family-run-sh-'));
    try {
      const portFile = join(dir, 'port');
      const decisionFile = join(dir, 'airplay');
      const callsFile = join(dir, 'calls');
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      if (uxplay) writeFileSync(join(bin, 'uxplay'), '#!/bin/sh\n', { mode: 0o755 });
      const cases = Object.entries(options).map(([key, value]) => `${key}) echo '${value}' ;;`).join(' ');
      const shell = [
        `bashio::config() { case "$1" in ${cases} *) echo null ;; esac; }`,
        'bashio::log.info() { echo "INFO $*" >&2; }',
        'bashio::log.warning() { echo "WARNING $*" >&2; }',
        'id() { case "$1" in -u) echo 101 ;; -g) echo 102 ;; esac; }',
        `umask() { echo "umask $*" >> '${callsFile}'; }`,
        `chmod() { echo "chmod $*" >> '${callsFile}'; }`,
        `find() { echo "find $*" >> '${callsFile}'; }`,
        `ADDON_SELF_BODY='${body}'`,
        block.replaceAll('/tmp/beacon-port', portFile).replaceAll('/run/family-airplay', decisionFile),
        'printf "PORT=%s AIRPLAY=%s NAME=%s PASSWORD=%s USER=%s:%s" "$BEACON_PORT" "${BEACON_AIRPLAY:-}" '
          + '"${BEACON_AIRPLAY_NAME:-}" "${BEACON_AIRPLAY_PASSWORD:-}" "${BEACON_AIRPLAY_UID:-}" "${BEACON_AIRPLAY_GID:-}"',
      ].join('\n');
      const result = spawnSync('bash', ['-c', shell], {
        encoding: 'utf8',
        env: { PATH: `${bin}:${process.env.PATH}`, ...env },
      });
      expect(result.status, result.stderr).toBe(0);
      return {
        out: result.stdout,
        log: result.stderr,
        port: readFileSync(portFile, 'utf8').trim(),
        decision: readFileSync(decisionFile, 'utf8').trim(),
        calls: existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [],
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('serves on the port the Supervisor gave ingress', () => {
    const picked = run({}, { body: '{"data":{"slug":"abc_family","ingress_port":61234}}' });
    expect(picked.out).toContain('PORT=61234 ');
    expect(picked.port).toBe('61234');
    const unknown = run({}, { body: '' });
    expect(unknown.out).toContain('PORT=3000 ');
    expect(unknown.port).toBe('3000');
    expect(unknown.log).toContain('WARNING');
  });

  it('keeps a standalone port, and runs no AirPlay receiver outside the add-on', () => {
    const standalone = run({ airplay: 'true' }, { body: HOST_NETWORK, env: { BEACON_PORT: '8080' } });
    expect(standalone.out).toBe('PORT=8080 AIRPLAY= NAME= PASSWORD= USER=:');
    expect(standalone.decision).toBe('off');
    expect(run({}, { env: {} }).out).toContain('PORT=3000 ');
  });

  it("keeps AirPlay off, without a word, in an image that doesn't have UxPlay", () => {
    const missing = run({ airplay: 'true' }, { body: HOST_NETWORK, uxplay: false });
    expect(missing.out).toBe('PORT=3000 AIRPLAY= NAME= PASSWORD= USER=:');
    expect(missing.decision).toBe('off');
    expect(missing.log).not.toContain('AirPlay');
    expect(missing.calls).toEqual([]);
  });

  it("keeps AirPlay off while the add-on isn't on the host's network, where devices could find it", () => {
    const bridged = run({ airplay: 'true' });
    expect(bridged.out).toBe('PORT=3000 AIRPLAY= NAME= PASSWORD= USER=:');
    expect(bridged.decision).toBe('off');
    expect(bridged.log).toMatch(/host.s network/);
    expect(bridged.calls).toEqual([]);
    expect(run({ airplay: 'true' }, { body: '' }).decision).toBe('off');
  });

  it('runs AirPlay on the host network unless it is switched off, without logging its password', () => {
    const on = run({ airplay: 'true', airplay_name: 'Kitchen' }, { body: HOST_NETWORK });
    expect(on.out).toBe('PORT=3000 AIRPLAY=1 NAME=Kitchen PASSWORD= USER=101:102');
    expect(on.decision).toBe('on');
    expect(run({}, { body: HOST_NETWORK }).out).toContain('AIRPLAY=1 NAME=Family '); // an install from before the options
    expect(run({ airplay: 'true', airplay_name: '' }, { body: HOST_NETWORK }).out).toContain('NAME=Family ');

    const locked = run({ airplay: 'true', airplay_password: 'open sesame' }, { body: HOST_NETWORK });
    expect(locked.out).toContain('PASSWORD=open sesame ');
    expect(locked.log).toContain('password');
    expect(locked.log).not.toContain('open sesame');

    const off = run({ airplay: 'false', airplay_name: 'Kitchen' }, { body: HOST_NETWORK });
    expect(off.out).toBe('PORT=3000 AIRPLAY= NAME= PASSWORD= USER=:');
    expect(off.decision).toBe('off');
    expect(off.calls).toEqual([]);
  });

  it("keeps the add-on's token, options and data from UxPlay's user", () => {
    expect(run({ airplay: 'true' }, { body: HOST_NETWORK }).calls).toEqual([
      'umask 077',
      'chmod 0700 /run/s6/container_environment /tmp/.bashio',
      'chmod 0711 /data',
      'find /data -mindepth 1 -maxdepth 1 ! -name airplay -exec chmod go-rwx {} +',
    ]);
  });
});
