// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * airplay.cjs runs UxPlay for the add-on and tells the AirPlay screen what
 * it's doing. These tests give it fake processes and files.
 */

const {
  createAirPlay,
  parseEstablishedInodes,
  parseMetadata,
  coverImageType,
  uxplayArgs,
  airplayOptionsError,
  receiverName,
  readUntrustedFile,
  parseDbusReply,
  readAvahiState,
  LINE_BUFFER_LIBRARY,
} = createRequire(import.meta.url)('./airplay.cjs');

const RUN_DIR = '/tmp/airplay';
/** UxPlay's own folder: the files it writes, and its HOME. */
const FILES_DIR = `${RUN_DIR}/uxplay`;

/**
 * What Avahi says about itself: its connection to D-Bus (another each time
 * it starts), its state (2 once it's running) and then its host name.
 */
interface AvahiReply { instance: string; state: number; host: string | null }
const AVAHI_RUNNING: AvahiReply = { instance: ':1.4', state: 2, host: 'family-airplay.local' };

describe('parseDbusReply', () => {
  it("reads who answered, and what, from dbus-send's reply", () => {
    expect(parseDbusReply(
      'method return time=1727560000.123456 sender=:1.4 -> destination=:1.9 serial=21 reply_serial=2\n   int32 2\n',
    )).toEqual({ sender: ':1.4', value: 2 });
    expect(parseDbusReply('method return sender=:1.12 -> destination=:1.30 serial=5 reply_serial=2\n   string "family-airplay-2.local"\n'))
      .toEqual({ sender: ':1.12', value: 'family-airplay-2.local' });
  });

  it('has nothing without both', () => {
    expect(parseDbusReply('')).toBeNull();
    expect(parseDbusReply('method return sender=:1.4 -> destination=:1.9 serial=21 reply_serial=2\n')).toBeNull();
    expect(parseDbusReply('   int32 2\n')).toBeNull();
  });
});

describe('readAvahiState', () => {
  it("asks Avahi on the system bus with dbus-send, and has nothing while Avahi isn't on it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'family-dbus-'));
    const calls = join(dir, 'calls');
    /** A dbus-send that notes what it's asked, and answers as `answers` says. */
    const script = (answers: string) => {
      writeFileSync(calls, '');
      writeFileSync(join(dir, 'dbus-send'), `#!/bin/sh\necho "$*" >> '${calls}'\ncase "$*" in\n${answers}\nesac\n`);
      chmodSync(join(dir, 'dbus-send'), 0o755);
    };
    const reply = (sender: string, value: string) =>
      `echo 'method return time=1.5 sender=${sender} -> destination=:1.9 serial=21 reply_serial=2'; echo '   ${value}'`;
    const ask = (method: string) =>
      `--system --print-reply --reply-timeout=3000 --dest=org.freedesktop.Avahi / org.freedesktop.Avahi.Server.${method}`;
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
    try {
      script(`*.GetState) ${reply(':1.4', 'int32 2')} ;;\n*.GetHostNameFqdn) ${reply(':1.4', 'string "family-airplay.local"')} ;;`);
      expect(await readAvahiState()).toEqual({ instance: ':1.4', state: 2, host: 'family-airplay.local' });
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([ask('GetState'), ask('GetHostNameFqdn')]);

      // Still claiming its host name: which one doesn't matter yet.
      script(`*.GetState) ${reply(':1.4', 'int32 1')} ;;`);
      expect(await readAvahiState()).toEqual({ instance: ':1.4', state: 1, host: null });
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([ask('GetState')]);

      // Another Avahi answered the second question.
      script(`*.GetState) ${reply(':1.4', 'int32 2')} ;;\n*.GetHostNameFqdn) ${reply(':1.7', 'string "family-airplay.local"')} ;;`);
      expect(await readAvahiState()).toBeNull();

      script("*) echo 'Error org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.Avahi was not provided by any .service files' >&2; exit 1 ;;");
      expect(await readAvahiState()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseEstablishedInodes', () => {
  it('lists the inodes of established TCP connections', () => {
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:1B58 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 31337 1 0000000000000000 100 0 0 10 0',
      '   1: 0A00000A:1B58 0B00000A:D431 01 00000000:00000000 02:000AFD4F 00000000     0        0 42424 2 0000000000000000 20 4 30 10 -1',
      '   2: 0100007F:0BB8 0100007F:A2C4 06 00000000:00000000 03:00001770 00000000     0        0 0 3 0000000000000000',
    ].join('\n');
    expect([...parseEstablishedInodes(table)]).toEqual(['42424']);
  });
});

describe('parseMetadata', () => {
  it("reads the track from UxPlay's metadata file", () => {
    expect(parseMetadata('Album: Record\nArtist: Band\nTitle: Song\nGenre: Pop\nFormat: 7a\n\0')).toEqual({
      title: 'Song', artist: 'Band', album: 'Record',
    });
  });

  it('has nothing for "no data" or an empty file', () => {
    expect(parseMetadata('no data\n\0')).toBeNull();
    expect(parseMetadata('')).toBeNull();
  });
});

const jpeg = (size = 400) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 6, 7), Buffer.from([0xff, 0xd9])]);
const png = (size = 400) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(size - 20, 1),
  Buffer.from('IEND'),
  Buffer.from([0xae, 0x42, 0x60, 0x82]),
  Buffer.alloc(4),
]);
/** UxPlay writes a 1x1 PNG when a track has no cover art. */
const PLACEHOLDER = png(95);

describe('coverImageType', () => {
  it('recognizes complete JPEG and PNG cover art', () => {
    expect(coverImageType(jpeg())).toBe('image/jpeg');
    expect(coverImageType(png())).toBe('image/png');
  });

  it("ignores UxPlay's placeholder, half-written files and anything else", () => {
    expect(coverImageType(PLACEHOLDER)).toBeNull();
    expect(coverImageType(jpeg().subarray(0, 300))).toBeNull();
    expect(coverImageType(Buffer.alloc(400, 0x41))).toBeNull();
  });
});

describe('UxPlay options', () => {
  it('sends video and audio down the pipes it inherits and keeps its key in /data', () => {
    const args = uxplayArgs({ name: 'Kitchen', password: '', filesDir: FILES_DIR, keyFile: '/data/airplay/key.pem' });
    expect(args).toEqual([
      '-n', 'Kitchen', '-nh', '-nohold',
      '-key', '/data/airplay/key.pem',
      '-md', `${FILES_DIR}/metadata.txt`,
      '-ca', `${FILES_DIR}/cover`,
      '-dacp', `${FILES_DIR}/dacp`,
      '-vrtp', 'config-interval=-1 mtu=60000 ! rtpstreampay ! fdsink fd=3 sync=false',
      '-artp', 'pt=96 ! rtpstreampay ! fdsink fd=4 sync=false',
    ]);
    expect(uxplayArgs({ name: 'Kitchen', password: 'open sesame', filesDir: FILES_DIR, keyFile: 'k' }))
      .toEqual(expect.arrayContaining(['-pw', 'open sesame']));
  });

  it('refuses a password UxPlay would reject or misread, instead of running without one', () => {
    expect(airplayOptionsError({ password: '' })).toBeNull();
    expect(airplayOptionsError({ password: 'abcd' })).toBeNull();
    expect(airplayOptionsError({ password: 'abc' })).toMatch(/at least 4/);
    expect(airplayOptionsError({ password: '-abcd' })).toMatch(/-/);
  });

  it('makes a receiver name UxPlay accepts', () => {
    expect(receiverName('  Living room  ')).toBe('Living room');
    expect(receiverName('--Den')).toBe('Den');
    expect(receiverName('Bad\u0007name\n')).toBe('Badname');
    expect(receiverName('')).toBe('Family');
    expect(receiverName(undefined)).toBe('Family');
    expect(receiverName('x'.repeat(80))).toHaveLength(50);
  });
});

describe('readUntrustedFile', () => {
  it("reads a file UxPlay wrote, but not through a link or a pipe, nor more than it's asked for", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'family-airplay-'));
    try {
      const file = join(dir, 'metadata.txt');
      writeFileSync(file, 'Title: Song\n');
      symlinkSync(file, join(dir, 'link'));
      execFileSync('mkfifo', [join(dir, 'fifo')]);
      expect(String(await readUntrustedFile(file, 100))).toBe('Title: Song\n');
      await expect(readUntrustedFile(join(dir, 'link'), 100)).rejects.toThrow();
      await expect(readUntrustedFile(join(dir, 'fifo'), 100)).rejects.toThrow(/isn't a file/);
      await expect(readUntrustedFile(dir, 100)).rejects.toThrow(/isn't a file/);
      await expect(readUntrustedFile(file, 4)).rejects.toThrow(/too big/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

class FakeChild extends EventEmitter {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  /** UxPlay's video and audio come out of fds 3 and 4. */
  stdio = [null, this.stdout, this.stderr, new PassThrough(), new PassThrough()];
  signals: string[] = [];
  exited = false;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(signal = 'SIGTERM') {
    this.signals.push(signal);
    if (!this.exited) {
      this.exited = true;
      queueMicrotask(() => this.emit('exit', null, signal));
    }
    return true;
  }
}

function enoent(path: string) {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
}

function fakeIo() {
  const files = new Map<string, { data: Buffer; version: number; link?: boolean }>();
  /** What was read of the files UxPlay writes. */
  const reads: string[] = [];
  let version = 0;
  const children: FakeChild[] = [];
  const killed: [number, string | number][] = [];
  const alive = new Set<number>();
  let connections: Set<string> | null = new Set();
  let spawnError: (Error & { code?: string }) | null = null;
  let avahi: AvahiReply | null = AVAHI_RUNNING;
  const io = {
    spawn: vi.fn((_command: string, _args: string[], _options: unknown) => {
      const child = new FakeChild(1000 + children.length);
      children.push(child);
      if (spawnError) {
        const error = spawnError;
        queueMicrotask(() => child.emit('error', error));
      }
      return child;
    }),
    readFile: async (path: string) => {
      const file = files.get(path);
      if (!file) throw enoent(path);
      return file.data;
    },
    writeFile: async (path: string, data: string | Buffer) => {
      files.set(path, { data: Buffer.from(data), version: ++version });
    },
    unlink: async (path: string) => {
      files.delete(path);
    },
    readUntrusted: async (path: string, maxBytes: number) => {
      const file = files.get(path);
      if (!file) throw enoent(path);
      if (file.link) throw Object.assign(new Error(`ELOOP: ${path}`), { code: 'ELOOP' });
      if (file.data.length > maxBytes) throw new Error(`${path} is too big`);
      reads.push(path);
      return file.data;
    },
    mkdir: vi.fn(async (_path: string, _options?: unknown) => undefined),
    chmod: vi.fn(async (_path: string, _mode: number) => undefined),
    chown: vi.fn(async (_path: string, _uid: number, _gid: number) => undefined),
    /** lstat: a link is a link, not the file it points at. */
    stat: async (path: string) => {
      const file = files.get(path);
      if (!file) throw enoent(path);
      return { size: file.data.length, mtimeMs: file.version, isFile: () => !file.link };
    },
    readConnections: async () => connections,
    avahiState: vi.fn(async () => avahi),
    kill: (pid: number, signal: string | number) => {
      if (!alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      killed.push([pid, signal]);
      if (signal !== 0) alive.delete(pid);
    },
  };
  return {
    io,
    files,
    children,
    killed,
    alive,
    reads,
    /** A link UxPlay put where it should have written a file. */
    link: (path: string) => { files.set(path, { data: Buffer.from('/data/options.json'), version: ++version, link: true }); },
    setConnections: (value: Set<string> | null) => { connections = value; },
    /** What Avahi answers now (null: it isn't on D-Bus, or didn't answer). */
    setAvahi: (value: AvahiReply | null) => { avahi = value; },
    failSpawn: (error: (Error & { code?: string }) | null) => { spawnError = error; },
    write: (path: string, data: string | Buffer) => io.writeFile(path, data),
  };
}

interface FakeScreen {
  readyState: number;
  bufferedAmount: number;
  texts: string[];
  binary: Buffer[];
  send: (data: string | Buffer) => void;
  terminate: () => void;
  ping: () => void;
  on: (event: string, listener: () => void) => void;
}
function fakeScreen(): FakeScreen {
  const screen: FakeScreen = {
    readyState: 1,
    bufferedAmount: 0,
    texts: [],
    binary: [],
    send(data) {
      if (typeof data === 'string') screen.texts.push(data);
      else screen.binary.push(Buffer.from(data));
    },
    terminate() { screen.readyState = 3; },
    ping() {},
    on() {},
  };
  return screen;
}
const lastStatus = (screen: FakeScreen) => JSON.parse(screen.texts[screen.texts.length - 1]);

/** An RTP packet carrying one NAL unit (a whole frame, with the marker bit), framed as rtpstreampay does. */
function rtp(nal: Buffer, seq: number) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 0x80 | 96;
  header.writeUInt16BE(seq, 2);
  header.writeUInt32BE(seq * 3000, 4);
  header.writeUInt32BE(0xabc, 8);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(header.length + nal.length);
  return Buffer.concat([length, header, nal]);
}
const IDR = Buffer.from([0x65, 0x88, 1, 2, 3, 4]);
const PCM = Buffer.from([0, 1, 0, 2, 0, 3, 0, 4]);

describe('createAirPlay', () => {
  let fake: ReturnType<typeof fakeIo>;
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    fake = fakeIo();
    logs = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (options: Record<string, unknown> = {}) => createAirPlay({
    enabled: true,
    name: 'Family',
    password: '',
    io: fake.io,
    now: () => Date.now(),
    log: (line: string) => logs.push(line),
    root: false,
    ...options,
  });
  const tick = (ms = 1000) => vi.advanceTimersByTimeAsync(ms);
  const uxplay = () => fake.children[fake.children.length - 1];
  const sendVideo = async (packet: Buffer) => { uxplay().stdio[3]!.write(packet); await tick(0); };
  const sendAudio = async (packet: Buffer) => { uxplay().stdio[4]!.write(packet); await tick(0); };

  it('does nothing when AirPlay is off', async () => {
    const airplay = make({ enabled: false });
    await airplay.start();
    expect(fake.io.spawn).not.toHaveBeenCalled();
    expect(airplay.status()).toEqual({ enabled: false });
  });

  it('starts UxPlay without the add-on credentials in its environment', async () => {
    vi.stubEnv('SUPERVISOR_TOKEN', 'secret-token');
    try {
      const airplay = make({ name: 'Kitchen' });
      await airplay.start();
      expect(fake.io.spawn).toHaveBeenCalledTimes(1);
      const [command, args, options] = fake.io.spawn.mock.calls[0] as [string, string[], { env: Record<string, string>; stdio: unknown[] }];
      expect(command).toBe('uxplay');
      expect(args).toEqual(expect.arrayContaining(['-n', 'Kitchen']));
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe', 'pipe', 'pipe']);
      expect(JSON.stringify(options.env)).not.toContain('secret-token');
      expect(airplay.status()).toMatchObject({ enabled: true, available: true, name: 'Kitchen', state: 'idle', passwordRequired: false });
      await airplay.stop();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('has UxPlay write its log a line at a time, as it happens', async () => {
    // UxPlay doesn't flush what it prints: down a pipe, it would reach the
    // add-on's log a kilobyte at a time, or only once UxPlay stops.
    const airplay = make();
    await airplay.start();
    const { env } = fake.io.spawn.mock.calls[0][2] as { env: Record<string, string> };
    expect(LINE_BUFFER_LIBRARY).toBe('/usr/local/lib/uxplay/libstdbuf.so');
    expect(env).toMatchObject({ LD_PRELOAD: LINE_BUFFER_LIBRARY, _STDBUF_O: 'L' });
    await airplay.stop();
  });

  it('runs UxPlay as its own user, which can write only its own folders', async () => {
    const airplay = make({ uid: 101, gid: 102, root: true, keyFile: '/data/airplay/uxplay.pem' });
    await airplay.start();
    const options = fake.io.spawn.mock.calls[0][2] as { uid: number; gid: number; env: Record<string, string> };
    expect(options).toMatchObject({ uid: 101, gid: 102 });
    expect(options.env.HOME).toBe(FILES_DIR);
    // Not the folder with the pidfile: through a link there, UxPlay could have this server write anywhere.
    expect(fake.io.chmod.mock.calls).toEqual([[RUN_DIR, 0o711], [FILES_DIR, 0o700], ['/data/airplay', 0o700]]);
    expect(fake.io.chown.mock.calls).toEqual([[FILES_DIR, 101, 102], ['/data/airplay', 101, 102]]);
    expect(String(fake.files.get(`${RUN_DIR}/uxplay.pid`)?.data)).toBe(String(uxplay().pid));
    await airplay.stop();
  });

  it("won't run UxPlay as root", async () => {
    const airplay = make({ root: true });
    await airplay.start();
    expect(fake.io.spawn).not.toHaveBeenCalled();
    expect(airplay.status()).toMatchObject({ available: false, error: expect.stringMatching(/its own user/) });
  });

  it("doesn't start with a password UxPlay would reject", async () => {
    const airplay = make({ password: 'abc' });
    await airplay.start();
    expect(fake.io.spawn).not.toHaveBeenCalled();
    expect(airplay.status()).toMatchObject({ enabled: true, available: false, error: expect.stringMatching(/at least 4/) });
  });

  it('says so when UxPlay is missing, without retrying', async () => {
    fake.failSpawn(enoent('uxplay'));
    const airplay = make();
    await airplay.start();
    await tick(60_000);
    expect(fake.io.spawn).toHaveBeenCalledTimes(1);
    expect(airplay.status()).toMatchObject({ available: false, error: expect.stringMatching(/isn't installed/) });
  });

  it('restarts UxPlay when it stops, waiting longer each time', async () => {
    const airplay = make();
    await airplay.start();
    const screen = fakeScreen();
    airplay.addScreen(screen);
    await sendVideo(rtp(IDR, 1).subarray(0, 9)); // stopped mid-packet
    fake.children[0].emit('exit', 1, null);
    expect(airplay.status()).toMatchObject({ available: false, error: expect.stringMatching(/stopped/) });
    await tick(1000);
    expect(fake.io.spawn).toHaveBeenCalledTimes(2);
    expect(airplay.status()).toMatchObject({ available: true });
    await sendVideo(rtp(IDR, 1));
    expect(screen.binary).toHaveLength(1);
    fake.children[1].emit('exit', 1, null);
    await tick(1000);
    expect(fake.io.spawn).toHaveBeenCalledTimes(2);
    await tick(1000);
    expect(fake.io.spawn).toHaveBeenCalledTimes(3);
    await airplay.stop();
  });

  it("starts UxPlay once Avahi is running: a name it registers before then is never advertised", async () => {
    // Avahi's dns_sd library holds a registration made while Avahi is
    // still starting until Avahi is ready, and then needs UxPlay to read
    // its reply to go ahead, which UxPlay never does.
    fake.setAvahi(null); // not on D-Bus yet
    const airplay = make();
    const starting = airplay.start();
    await tick(0);
    expect(fake.io.spawn).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.stringMatching(/^Waiting for Avahi/));
    fake.setAvahi({ instance: ':1.4', state: 1, host: null }); // on D-Bus, still claiming its host name
    await tick(1000);
    await tick(1000);
    expect(fake.io.spawn).not.toHaveBeenCalled();
    expect(airplay.status()).toMatchObject({ available: false });
    fake.setAvahi(AVAHI_RUNNING);
    await tick(1000);
    await starting;
    expect(fake.io.spawn).toHaveBeenCalledTimes(1);
    expect(airplay.status()).toMatchObject({ available: true });
    expect(airplay.status().error).toBeUndefined();
    await airplay.stop();
  });

  it("says so when Avahi doesn't start", async () => {
    fake.setAvahi(null);
    const airplay = make();
    void airplay.start();
    await tick(14_000);
    expect(airplay.status()).toMatchObject({ available: false });
    expect(airplay.status().error).toBeUndefined();
    await tick(2000);
    expect(airplay.status()).toMatchObject({ available: false, error: expect.stringMatching(/Avahi/) });
    expect(logs).toContainEqual(airplay.status().error);
    fake.setAvahi(AVAHI_RUNNING);
    await tick(1000);
    expect(fake.io.spawn).toHaveBeenCalledTimes(1);
    expect(airplay.status()).toMatchObject({ available: true });
    expect(airplay.status().error).toBeUndefined();
    await airplay.stop();
  });

  it('starts UxPlay again when Avahi starts over or takes another host name, once no device is connected', async () => {
    const airplay = make();
    await airplay.start();
    const screen = fakeScreen();
    airplay.addScreen(screen);
    await fake.write(`${FILES_DIR}/dacp`, 'ABC\n123\n'); // a device is connected
    await tick();
    expect(airplay.status().state).toBe('connected');

    // Avahi restarted: what UxPlay registered went with it.
    fake.setAvahi({ ...AVAHI_RUNNING, instance: ':1.20' });
    await tick(20_000);
    expect(fake.children[0].signals).toEqual([]); // the connected device doesn't need to find it
    await fake.io.unlink(`${FILES_DIR}/dacp`);
    await tick(10_000);
    expect(fake.children[0].signals).toEqual(['SIGTERM']);
    expect(fake.io.spawn).toHaveBeenCalledTimes(2);
    expect(logs).toContainEqual(expect.stringMatching(/^Avahi started over/));
    expect(logs.filter((line) => /UxPlay stopped/.test(line))).toEqual([]);
    expect(airplay.status()).toMatchObject({ available: true });
    expect(airplay.status().error).toBeUndefined();
    expect(screen.texts.map((text) => JSON.parse(text).error).filter(Boolean)).toEqual([]);

    // Another device has Avahi's host name: Avahi takes another, and what
    // UxPlay registered still points at the old one.
    fake.setAvahi({ instance: ':1.20', state: 3, host: null });
    await tick(10_000);
    expect(fake.children[1].signals).toEqual(['SIGTERM']);
    expect(fake.io.spawn).toHaveBeenCalledTimes(2); // until Avahi's running again
    fake.setAvahi({ instance: ':1.20', state: 2, host: 'family-airplay-2.local' });
    await tick(1000);
    expect(fake.io.spawn).toHaveBeenCalledTimes(3);
    // The same, over between two looks.
    fake.setAvahi({ instance: ':1.20', state: 2, host: 'family-airplay-3.local' });
    await tick(10_000);
    expect(fake.children[2].signals).toEqual(['SIGTERM']);
    expect(fake.io.spawn).toHaveBeenCalledTimes(4);
    expect(logs).toContainEqual(expect.stringMatching(/^Avahi changed its host name/));
    await tick(30_000);
    expect(fake.io.spawn).toHaveBeenCalledTimes(4);

    // Starting again for Avahi isn't UxPlay failing: after a crash, it's started again a second later.
    fake.children[3].emit('exit', 1, null);
    await tick(1000);
    expect(fake.io.spawn).toHaveBeenCalledTimes(5);
    await airplay.stop();
  });

  it("leaves UxPlay running while Avahi doesn't answer", async () => {
    const airplay = make();
    await airplay.start();
    fake.setAvahi(null); // dbus-send failed or timed out
    await tick(30_000);
    fake.setAvahi(AVAHI_RUNNING);
    await tick(30_000);
    expect(fake.children[0].signals).toEqual([]);
    expect(fake.io.spawn).toHaveBeenCalledTimes(1);
    expect(fake.io.avahiState.mock.calls.length).toBeGreaterThanOrEqual(6);
    await airplay.stop();
  });

  it('stops waiting for Avahi when stopped', async () => {
    fake.setAvahi(null);
    const airplay = make();
    const starting = airplay.start();
    await tick(3000);
    await airplay.stop();
    await tick(1000);
    await starting;
    const asked = fake.io.avahiState.mock.calls.length;
    fake.setAvahi(AVAHI_RUNNING);
    await tick(60_000);
    expect(fake.io.spawn).not.toHaveBeenCalled();
    expect(fake.io.avahiState.mock.calls.length).toBe(asked);
  });

  it('stops a UxPlay left running by an earlier server, but nothing else', async () => {
    fake.alive.add(77);
    fake.alive.add(88);
    await fake.write(`${RUN_DIR}/uxplay.pid`, '77');
    await fake.write('/proc/77/cmdline', 'uxplay\0-n\0Family\0');
    await make().start();
    expect(fake.killed).toContainEqual([77, 'SIGTERM']);

    const other = fakeIo();
    other.alive.add(88);
    await other.write(`${RUN_DIR}/uxplay.pid`, '88');
    await other.write('/proc/88/cmdline', 'node\0server.js\0');
    fake = other;
    await make().start();
    expect(other.killed).toEqual([]);
  });

  it('follows a mirroring session from connection to the end, and forgets its picture after', async () => {
    const airplay = make();
    await airplay.start();
    const screen = fakeScreen();
    airplay.addScreen(screen);
    expect(lastStatus(screen)).toMatchObject({ state: 'idle' });

    fake.setConnections(new Set(['5001']));
    await tick();
    expect(airplay.status().state).toBe('idle'); // a connection has to last to count (not a device's quick look)
    await tick();
    expect(airplay.status().state).toBe('connected');
    expect(lastStatus(screen)).toMatchObject({ state: 'connected' });

    await sendVideo(rtp(IDR, 1));
    expect(screen.binary).toHaveLength(1);
    await tick();
    expect(lastStatus(screen)).toMatchObject({ state: 'mirroring' });

    // A still screen sends no frames for a while; the connection keeps the session.
    await tick(20_000);
    expect(airplay.status().state).toBe('mirroring');

    fake.setConnections(new Set());
    await tick();
    expect(lastStatus(screen)).toMatchObject({ state: 'idle' });
    const late = fakeScreen();
    airplay.addScreen(late);
    expect(late.binary).toEqual([]);
    await airplay.stop();
  });

  it('counts a session from its video alone when the connections can’t be read', async () => {
    fake.setConnections(null);
    const airplay = make();
    await airplay.start();
    await sendVideo(rtp(IDR, 1));
    await tick();
    expect(airplay.status().state).toBe('mirroring');
    await tick(10_000);
    expect(airplay.status().state).toBe('mirroring');
    await tick(30_000);
    expect(airplay.status().state).toBe('idle');
    await airplay.stop();
  });

  it('shows what an audio session is playing, with its cover art', async () => {
    const airplay = make();
    await airplay.start();
    await fake.write(`${FILES_DIR}/dacp`, 'ABC\n123\n');
    await fake.write(`${FILES_DIR}/metadata.txt`, 'Title: Song\nArtist: Band\nAlbum: Record\n\0');
    await fake.write(`${FILES_DIR}/cover`, jpeg());
    await sendAudio(rtp(PCM, 1));
    await tick();

    expect(airplay.status()).toMatchObject({
      state: 'audio',
      metadata: { title: 'Song', artist: 'Band', album: 'Record' },
      coverVersion: 1,
    });
    expect(airplay.cover()).toEqual({ type: 'image/jpeg', data: jpeg() });

    // The next track has no art: UxPlay writes its placeholder.
    await fake.write(`${FILES_DIR}/cover`, PLACEHOLDER);
    await tick();
    expect(airplay.status().coverVersion).toBe(0);
    expect(airplay.cover()).toBeNull();

    await fake.write(`${FILES_DIR}/cover`, png());
    await tick();
    expect(airplay.status().coverVersion).toBe(2);

    // Paused: connected, no sound.
    await tick(6000);
    expect(airplay.status().state).toBe('connected');

    await fake.io.unlink(`${FILES_DIR}/dacp`);
    await tick();
    expect(airplay.status()).toMatchObject({ state: 'idle', metadata: null, coverVersion: 0 });
    expect(airplay.cover()).toBeNull();

    // The next session shows its own track once UxPlay writes it, not the last one's until then.
    await fake.write(`${FILES_DIR}/dacp`, 'DEF\n456\n');
    await sendAudio(rtp(PCM, 2));
    await tick();
    expect(airplay.status()).toMatchObject({ state: 'audio', metadata: null, coverVersion: 0 });
    await fake.write(`${FILES_DIR}/metadata.txt`, 'Title: Next\n\0');
    await tick();
    expect(airplay.status().metadata).toEqual({ title: 'Next', artist: null, album: null });
    await airplay.stop();
  });

  it('reads only files UxPlay wrote there itself, and only so much of them', async () => {
    const airplay = make();
    await airplay.start();
    await fake.write(`${FILES_DIR}/dacp`, 'ABC\n123\n');
    fake.link(`${FILES_DIR}/metadata.txt`);
    await fake.write(`${FILES_DIR}/cover`, Buffer.concat([jpeg(), Buffer.alloc(9 * 1024 * 1024)]));
    await tick();
    expect(airplay.status()).toMatchObject({ state: 'connected', metadata: null, coverVersion: 0 });
    expect(fake.reads).toEqual([]);

    await fake.write(`${FILES_DIR}/metadata.txt`, 'Title: Song\n\0');
    await tick();
    expect(airplay.status().metadata).toEqual({ title: 'Song', artist: null, album: null });
    expect(fake.reads).toEqual([`${FILES_DIR}/metadata.txt`]);
    await airplay.stop();
  });

  it('tells screens that a password is needed', async () => {
    const airplay = make({ password: 'open sesame' });
    await airplay.start();
    expect(fake.io.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['-pw', 'open sesame']));
    expect(airplay.status()).toMatchObject({ passwordRequired: true });
    expect(JSON.stringify(airplay.status())).not.toContain('open sesame');
    await airplay.stop();
  });

  it('stops UxPlay for good', async () => {
    const airplay = make();
    await airplay.start();
    await airplay.stop();
    expect(fake.children[0].signals).toEqual(['SIGTERM']);
    await tick(10_000);
    expect(fake.io.spawn).toHaveBeenCalledTimes(1);
  });

  it("passes UxPlay's output to the log", async () => {
    const airplay = make();
    await airplay.start();
    fake.children[0].stdout.write('Accepted IPv4 client on socket 31\npartial');
    fake.children[0].stdout.write(' line\n');
    await tick(0);
    expect(logs).toEqual(expect.arrayContaining(['Accepted IPv4 client on socket 31', 'partial line']));
    await airplay.stop();
  });
});
