// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

/** The Dockerfile's stages, each from its FROM line. */
const stages = dockerfile.split(/^(?=FROM )/m).slice(1);
/** Lines, with those continued by a backslash joined. */
const logicalLines = (text: string) => text.replace(/\s*\\\n\s*/g, ' ').split('\n');
const { uxplayArgs } = createRequire(import.meta.url)('./airplay.cjs');

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

  it('declares every build argument in each stage that uses one', () => {
    // An ARG before the first FROM is only seen by FROM lines; a stage
    // that uses it without declaring it again gets it empty.
    for (const stage of stages) {
      const [from, ...body] = stage.split('\n');
      const declared = new Set(body.flatMap((line) => line.match(/^(?:ARG|ENV) ([A-Za-z_]\w*)/)?.[1] ?? []));
      for (const [, name] of body.join('\n').matchAll(/\$\{([A-Za-z_]\w*)\}/g)) {
        expect([...declared], `${name} in ${from}`).toContain(name);
      }
    }
  });
});

/*
 * UxPlay, the AirPlay receiver airplay.cjs runs, is built from its source
 * in a stage of its own. Only the program and its licences reach the
 * add-on, which has what UxPlay needs to run.
 */
describe('UxPlay in the add-on image', () => {
  const uxplayStage = stages.find((stage) => stage.startsWith('FROM ${BUILD_FROM} AS uxplay\n')) ?? '';
  const runtime = stages.at(-1) ?? '';
  const runtimeLines = logicalLines(runtime);
  const install = runtimeLines.find((line) => line.startsWith('RUN apk add --no-cache ')) ?? '';
  const check = runtimeLines.find((line) => line.startsWith('RUN uxplay -v ')) ?? '';

  it('is built from its release source, checked, on the add-on\'s own base', () => {
    const version = dockerfile.match(/^ARG UXPLAY_VERSION=(\d+)\.(\d+)\.(\d+)$/m)?.slice(1).map(Number) ?? [];
    expect(version).toHaveLength(3);
    // 1.73.7 fixed a stack overflow any device on the network could cause
    // before pairing (GHSA-479c-ww7g-wgp8).
    expect(version[0] * 1e6 + version[1] * 1e3 + version[2]).toBeGreaterThanOrEqual(1_073_007);
    expect(dockerfile).toMatch(/^ARG UXPLAY_SHA512=[0-9a-f]{128}$/m);

    // The same base as the add-on, so it links against the libraries there.
    expect(uxplayStage).not.toBe('');
    expect(runtime).toMatch(/^FROM \$\{BUILD_FROM\}\n/);
    const fetched = uxplayStage.indexOf('"https://github.com/FDH2/UxPlay/archive/refs/tags/v${UXPLAY_VERSION}.tar.gz"');
    const checked = uxplayStage.indexOf('| sha512sum -c -');
    const unpacked = uxplayStage.indexOf('tar -xzf');
    expect(fetched).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(fetched);
    expect(unpacked).toBeGreaterThan(checked);
    expect(uxplayStage).toContain('echo "${UXPLAY_SHA512}  uxplay.tar.gz" | sha512sum -c -');
  });

  it('runs on any CPU of its architecture, without X11', () => {
    // UxPlay otherwise builds for the build machine's own x86 CPU, which a
    // backup restored onto another machine may not have.
    expect(uxplayStage).toMatch(/^\s*&& cmake -S \. -B build -DNO_MARCH_NATIVE=ON -DNO_X11_DEPS=ON \\$/m);
  });

  it('lets its development packages update the libraries the base image pins', () => {
    // The base pins the libcrypto3, libssl3 and musl it was made with, and
    // openssl-dev and musl-dev need the exact versions Alpine has now:
    // naming them without a version replaces those pins.
    const buildInstall = logicalLines(uxplayStage).find((line) => line.startsWith('RUN apk add --no-cache ')) ?? '';
    const packages = buildInstall.replace('RUN apk add --no-cache', '').trim().split(/\s+/);
    expect(packages).toEqual(expect.arrayContaining(['libcrypto3', 'libssl3', 'musl', 'build-base', 'openssl-dev']));
  });

  it('puts only UxPlay, its licences and where its source is into the add-on', () => {
    const copies = [...runtime.matchAll(/^COPY --from=uxplay (.*)$/gm)].map((match) => match[1]);
    expect(copies).toEqual([
      '/usr/local/bin/uxplay /usr/local/bin/uxplay',
      '/usr/share/licenses/uxplay/ /usr/share/licenses/uxplay/',
    ]);
    // GPL-3.0 (UxPlay, and the playfair code in it) and MIT (llhttp).
    for (const licence of ['LICENSE', 'lib/playfair/LICENSE.md', 'lib/llhttp/LICENSE-MIT']) {
      expect(uxplayStage, licence).toMatch(new RegExp(`install -D -m 644 ${escape(licence)} /usr/share/licenses/uxplay/\\S+`));
    }
    expect(uxplayStage).toContain(
      'echo "https://github.com/FDH2/UxPlay/archive/refs/tags/v${UXPLAY_VERSION}.tar.gz sha512:${UXPLAY_SHA512}" > /usr/share/licenses/uxplay/SOURCE',
    );
  });

  it('installs what UxPlay runs with, before rootfs/ replaces the Avahi settings', () => {
    const packages = install.split('&&')[0].replace('RUN apk add --no-cache', '').trim().split(/\s+/);
    expect(packages).toEqual(expect.arrayContaining([
      'nodejs', 'dbus', 'avahi', 'avahi-compat-libdns_sd', 'libplist',
      'gstreamer', 'gstreamer-tools', 'gst-plugins-base', 'gst-plugins-good', 'gst-plugins-bad', 'gst-libav',
    ]));
    expect(runtime.indexOf('RUN apk add')).toBeLessThan(runtime.indexOf('COPY rootfs/ /'));
    // Avahi's package would also advertise SSH and SFTP, which the add-on doesn't have.
    expect(install).toMatch(/ && rm -f \/etc\/avahi\/services\/\*\.service(?: |$)/);
  });

  it('runs UxPlay as its own user, with IDs that stay the same from one build to the next', () => {
    // So the key UxPlay keeps in /data stays its own after an update.
    // Packages' users get the first free ID from 100 up, so it's above those.
    const group = install.match(/&& addgroup -S -g (\d+) airplay(?: |$)/)?.[1];
    const user = install.match(/&& adduser -S -D -H -u (\d+) -G airplay -s \/sbin\/nologin airplay(?: |$)/)?.[1];
    expect(group).toBeDefined();
    expect(user).toBe(group);
    expect(Number(user)).toBeGreaterThanOrEqual(1000);
  });

  it("fails the build if UxPlay wouldn't start or GStreamer lacks an element it uses", () => {
    // Running it needs every library it links.
    expect(check).toMatch(/^RUN uxplay -v \| grep -F "UxPlay version \$\{UXPLAY_VERSION\};" && /);
    expect(runtime.indexOf('RUN uxplay -v')).toBeGreaterThan(runtime.indexOf('COPY --from=uxplay /usr/local/bin/uxplay'));
    expect(check).toContain('gst-inspect-1.0 --exists "$element" || { echo "GStreamer element $element is missing" >&2; exit 1; }');
    const elements = check.match(/ for element in ([^;]+); do /)?.[1].trim().split(/\s+/) ?? [];
    // UxPlay won't start without the app, playback, autodetect, libav and
    // videoparsersbad plugins, and builds its pipelines from these.
    expect(elements).toEqual(expect.arrayContaining([
      'appsrc', 'playbin', 'autoaudiosink', 'queue', 'h264parse', 'rtph264pay',
      'avdec_aac', 'avdec_alac', 'audioconvert', 'audioresample', 'volume', 'rtpL16pay',
    ]));
    // The elements airplay.cjs adds after them, to write to its pipes.
    const args: string[] = uxplayArgs({ name: 'Family', password: '', filesDir: '/tmp/airplay/uxplay', keyFile: '/data/airplay/uxplay.pem' });
    for (const option of ['-vrtp', '-artp']) {
      const added = args[args.indexOf(option) + 1].split('!').slice(1).map((part) => part.trim().split(/\s+/)[0]);
      expect(added.length, option).toBeGreaterThan(0);
      for (const element of added) expect(elements, `${option}: ${element}`).toContain(element);
    }
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
