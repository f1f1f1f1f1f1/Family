// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * The add-on's image (Dockerfile) only has the files it copies, from what
 * .dockerignore lets into the build, and runs the services in rootfs/.
 */
const root = import.meta.dirname;
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8');

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The server's own modules: server.js and what it requires, transitively. */
function serverModules(file = 'server.js', found = new Set<string>()): Set<string> {
  found.add(file);
  const source = readFileSync(join(root, file), 'utf8');
  for (const [, name] of source.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
    if (!found.has(name)) serverModules(name, found);
  }
  return found;
}

describe('add-on image', () => {
  it('copies every module the server needs, and lets the build see them', () => {
    const modules = [...serverModules()];
    expect(modules).toEqual(expect.arrayContaining(['server.js', 'airplay.cjs', 'airplay-relay.cjs']));
    for (const name of modules) {
      expect(dockerfile, name).toMatch(new RegExp(`^COPY ${escape(name)} /app/${escape(name)}$`, 'm'));
      expect(dockerignore, name).toMatch(new RegExp(`^!${escape(name)}$`, 'm'));
    }
  });

  it('installs the services in rootfs/, runnable', () => {
    expect(dockerfile).toMatch(/^COPY rootfs\/ \/$/m);
    expect(dockerignore).toMatch(/^!rootfs\/\*\*$/m);
    for (const service of ['dbus', 'avahi']) {
      const run = join(root, 'rootfs', 'etc', 'services.d', service, 'run');
      expect(statSync(run).mode & 0o111, service).not.toBe(0);
      expect(dockerfile).toContain(`/etc/services.d/${service}/run`);
      expect(spawnSync('sh', ['-n', run]).status, service).toBe(0);
    }
  });

  it('checks health on the port run.sh serves on', () => {
    expect(dockerfile).toMatch(/^HEALTHCHECK [^]*\$\(cat \/tmp\/beacon-port/m);
  });
});

/*
 * D-Bus and Avahi (which tells devices about the AirPlay receiver) run only
 * once run.sh has decided AirPlay is on. They're run here with the daemons
 * and `sleep` replaced by scripts that record how they were called.
 */
describe('AirPlay services', () => {
  const dirs: string[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function runService(service: string, decision: string, { dbusUp = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'family-service-'));
    dirs.push(dir);
    const bin = join(dir, 'bin');
    const calls = join(dir, 'calls');
    mkdirSync(bin);
    for (const command of ['sleep', 'dbus-daemon', 'dbus-uuidgen', 'avahi-daemon']) {
      writeFileSync(join(bin, command), `#!/bin/sh\necho "${command} $*" >> '${calls}'\n`);
      chmodSync(join(bin, command), 0o755);
    }
    const run = join(dir, 'run');
    const dbusDir = join(dir, 'dbus');
    writeFileSync(join(dir, 'airplay'), decision);
    if (dbusUp) {
      mkdirSync(dbusDir);
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(join(dbusDir, 'system_bus_socket'), resolve));
    }
    const script = readFileSync(join(root, 'rootfs', 'etc', 'services.d', service, 'run'), 'utf8')
      .replaceAll('/run/family-airplay', join(dir, 'airplay'))
      .replaceAll('/run/dbus', dbusDir)
      .replaceAll('/run/avahi-daemon', join(dir, 'avahi'));
    writeFileSync(run, script);
    const result = spawnSync('sh', [run], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(result.status, result.stderr).toBe(0);
    return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  }

  it("don't start the daemons while AirPlay is off", async () => {
    expect(await runService('dbus', 'off\n')).toEqual(['sleep 2147483647']);
    expect(await runService('avahi', 'off\n', { dbusUp: false })).toEqual(['sleep 2147483647']);
  });

  it('start the system bus, then Avahi on it, while AirPlay is on', async () => {
    expect(await runService('dbus', 'on\n', { dbusUp: false })).toEqual([
      'dbus-uuidgen --ensure',
      'dbus-daemon --system --nofork --nopidfile',
    ]);
    expect(await runService('avahi', 'on\n')).toEqual(['avahi-daemon --no-chroot --no-rlimits']);
  });

  it("aren't given the add-on's environment, with its Supervisor token", () => {
    for (const service of ['dbus', 'avahi']) {
      const script = readFileSync(join(root, 'rootfs', 'etc', 'services.d', service, 'run'), 'utf8');
      expect(script.split('\n')[0], service).toBe('#!/bin/sh');
    }
  });

  it('has Avahi answer for its own name, beside Home Assistant on the host network', () => {
    const conf = readFileSync(join(root, 'rootfs', 'etc', 'avahi', 'avahi-daemon.conf'), 'utf8');
    expect(conf).toMatch(/^host-name=family-airplay$/m); // not homeassistant.local
    expect(conf).toMatch(/^disallow-other-stacks=no$/m); // Home Assistant has its own mDNS responder
    expect(conf).toMatch(/^deny-interfaces=docker0,hassio$/m);
    expect(conf).toMatch(/^enable-dbus=yes$/m); // UxPlay registers through it
    expect(conf).toMatch(/^enable-reflector=no$/m);
  });
});
