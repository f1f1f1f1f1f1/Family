'use strict';

/**
 * The add-on's AirPlay receiver.
 *
 * UxPlay (https://github.com/FDH2/UxPlay, GPLv3) does the AirPlay part: it
 * advertises the receiver, takes the connection from an iPhone, iPad or Mac
 * and decrypts what it sends. It's a separate program in the add-on image,
 * started here with -vrtp / -artp so that instead of showing the picture
 * and playing the sound itself, it writes them as RTP to two pipes it
 * inherits from this server (fds 3 and 4). airplay-relay.cjs passes them on
 * to the AirPlay screen's WebSocket.
 *
 * Pipes rather than UDP: nothing is dropped while this server is busy (an
 * iPhone sends few keyframes, so a lost packet can spoil the picture for
 * minutes), nothing else on the host can send packets into the stream,
 * and a UxPlay left behind by a crashed server stops at its next write.
 *
 * This module starts UxPlay (again, when it stops), and works out what's
 * going on for the screens: nobody connected, a device connected, its
 * screen being mirrored, or its music playing (with the track and cover
 * art UxPlay writes to files).
 *
 * UxPlay advertises the receiver through Avahi's dns_sd library, which
 * gives up when Avahi isn't on D-Bus yet, and, given the name while Avahi
 * is still starting, advertises it only once the program has read Avahi's
 * reply, which UxPlay never does. So UxPlay starts once Avahi is running
 * (asked over D-Bus with dbus-send). What it registered goes when Avahi
 * starts over, or takes another host name because another device has its
 * own, so UxPlay starts again then, once no device is connected.
 *
 * UxPlay handles whatever any device on the network sends it, so in the
 * add-on it runs as its own user (BEACON_AIRPLAY_UID/GID, set by run.sh),
 * never as root, and can write only its own two folders: one for the files
 * it writes (and its HOME), and the one with its key. Those files are read
 * here as UxPlay's, not this server's: never through a link, and only so
 * much of them.
 */

const childProcess = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const { createAirPlayRelay, createRtpStreamReader } = require('./airplay-relay.cjs');

const DEFAULT_NAME = 'Family';
const MAX_NAME_LENGTH = 50;
/** UxPlay's own minimum (MIN_PASSWORD_LENGTH). */
const MIN_PASSWORD_LENGTH = 4;

/** Seconds to wait before starting UxPlay again after it stops; the count starts over after a minute's run. */
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];
const STEADY_RUN_MS = 60_000;
const TICK_MS = 1000;
const STATUS_HEARTBEAT_MS = 15_000;
const PING_MS = 30_000;
/** Video or sound this recent means a device is connected, whatever else says. */
const RECENT_MEDIA_MS = 5000;
/** When UxPlay's connections can't be read, a mirrored screen counts as connected this long after its last frame. */
const FALLBACK_VIDEO_MS = 30_000;
/** UxPlay's "no cover art" placeholder is a 95-byte PNG. */
const MIN_COVER_BYTES = 128;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

/** Avahi's state once it has its host name and advertises what it's given (AVAHI_SERVER_RUNNING). */
const AVAHI_RUNNING = 2;
/** How often to ask while waiting for Avahi, and how long before the screens say so. */
const AVAHI_POLL_MS = 1000;
const AVAHI_SLOW_MS = 15_000;
/** How often to check that Avahi is still the one UxPlay registered with, as it was. */
const AVAHI_WATCH_MS = 10_000;
const AVAHI_CALL = ['--system', '--print-reply', '--reply-timeout=3000', '--dest=org.freedesktop.Avahi', '/'];
/**
 * coreutils' stdbuf library (what `stdbuf -oL` preloads): with _STDBUF_O=L,
 * UxPlay writes what it prints a line at a time, not a kilobyte at a time.
 */
const LINE_BUFFER_LIBRARY = '/usr/local/lib/uxplay/libstdbuf.so';

const ESTABLISHED = '01';

/** The inodes of the established connections in a /proc/net/tcp or tcp6 table. */
function parseEstablishedInodes(table) {
  const inodes = new Set();
  for (const line of String(table).split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length > 9 && fields[3] === ESTABLISHED && fields[9] !== '0') inodes.add(fields[9]);
  }
  return inodes;
}

/**
 * The established TCP connections a process has open: its sockets'
 * inodes, from /proc/<pid>/fd, that are in its network namespace's
 * connection tables. null when /proc can't be read.
 */
async function readConnections(pid) {
  let fds;
  try {
    fds = await fsp.readdir(`/proc/${pid}/fd`);
  } catch {
    return null;
  }
  const sockets = new Set();
  await Promise.all(fds.map(async (fd) => {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(await fsp.readlink(`/proc/${pid}/fd/${fd}`));
      if (match) sockets.add(match[1]);
    } catch { /* closed meanwhile */ }
  }));
  const connections = new Set();
  let readable = false;
  for (const table of ['tcp', 'tcp6']) {
    try {
      for (const inode of parseEstablishedInodes(await fsp.readFile(`/proc/${pid}/net/${table}`, 'utf8'))) {
        if (sockets.has(inode)) connections.add(inode);
      }
      readable = true;
    } catch { /* no IPv6 */ }
  }
  return readable ? connections : null;
}

const METADATA_FIELDS = { Title: 'title', Artist: 'artist', Album: 'album' };

/** The track in UxPlay's -md file ("Title: …" lines), or null. */
function parseMetadata(text) {
  const track = {};
  for (const line of String(text).replace(/\0/g, '').split('\n')) {
    const match = /^([A-Za-z ]+): (.*)$/.exec(line.trim());
    const field = match && METADATA_FIELDS[match[1]];
    if (field && match[2].trim()) track[field] = match[2].trim().slice(0, 300);
  }
  return Object.keys(track).length ? { title: null, artist: null, album: null, ...track } : null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The type of the cover art in UxPlay's -ca file, or null for its
 * placeholder, a file it's still writing, or anything else.
 */
function coverImageType(data) {
  if (!Buffer.isBuffer(data) || data.length < MIN_COVER_BYTES || data.length > MAX_COVER_BYTES) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9 ? 'image/jpeg' : null;
  }
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return data.lastIndexOf('IEND') >= data.length - 12 ? 'image/png' : null;
  }
  return null;
}

/** The receiver name as UxPlay takes it (it reads a leading "-" as its next option). */
function receiverName(value) {
  const name = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^-+\s*/, '')
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return name || DEFAULT_NAME;
}

/** Why UxPlay can't use these options, or null. */
function airplayOptionsError({ password }) {
  if (!password) return null;
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The AirPlay password must be at least ${MIN_PASSWORD_LENGTH} characters. AirPlay is off until it's changed.`;
  }
  if (password.startsWith('-')) {
    return "The AirPlay password can't start with -. AirPlay is off until it's changed.";
  }
  return null;
}

/**
 * A file UxPlay wrote, read without following a link (UxPlay could put one
 * there pointing at the add-on's secrets) or waiting on a pipe, and only if
 * it's at most maxBytes.
 */
async function readUntrustedFile(path, maxBytes) {
  const handle = await fsp.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path} isn't a file`);
    if (info.size > maxBytes) throw new Error(`${path} is too big`);
    const data = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    return data.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const VIDEO_FD = 3;
const AUDIO_FD = 4;

function uxplayArgs({ name, password, filesDir, keyFile }) {
  const args = [
    '-n', name,
    '-nh', // just the name, without "@hostname"
    '-nohold', // a device can take over from one already connected
    '-key', keyFile, // the same identity after a restart, so devices know it
    '-md', `${filesDir}/metadata.txt`,
    '-ca', `${filesDir}/cover`,
    '-dacp', `${filesDir}/dacp`, // exists while a device is connected
    // Big packets (they only go down a pipe, and fewer are less work), each
    // after its length (RFC 4571), as they arrive rather than on a clock.
    '-vrtp', `config-interval=-1 mtu=60000 ! rtpstreampay ! fdsink fd=${VIDEO_FD} sync=false`,
    '-artp', `pt=96 ! rtpstreampay ! fdsink fd=${AUDIO_FD} sync=false`,
  ];
  if (password) args.push('-pw', password);
  return args;
}

/** Which D-Bus connection answered, and the int32 or string it answered with, from dbus-send --print-reply. */
function parseDbusReply(output) {
  const text = String(output || '');
  const sender = /^method return\b.*?\bsender=(:\S+)/m.exec(text);
  const value = /^\s+(?:int32 (-?\d+)|string "(.*)")\s*$/m.exec(text);
  if (!sender || !value) return null;
  return { sender: sender[1], value: value[1] !== undefined ? Number(value[1]) : value[2] };
}

function askAvahi(method) {
  return new Promise((resolve) => {
    childProcess.execFile('dbus-send', [...AVAHI_CALL, `org.freedesktop.Avahi.Server.${method}`], { timeout: 5000 },
      (err, stdout) => resolve(err ? null : parseDbusReply(stdout)));
  });
}

/**
 * Which Avahi is on D-Bus (its connection, another each time it starts),
 * its state and, once it's running, its host name; null when it didn't
 * answer.
 */
async function readAvahiState() {
  const state = await askAvahi('GetState');
  if (!state || typeof state.value !== 'number') return null;
  if (state.value !== AVAHI_RUNNING) return { instance: state.sender, state: state.value, host: null };
  const host = await askAvahi('GetHostNameFqdn');
  if (!host || host.sender !== state.sender || typeof host.value !== 'string') return null;
  return { instance: state.sender, state: state.value, host: host.value };
}

const defaultIo = {
  spawn: childProcess.spawn,
  readFile: (path) => fsp.readFile(path),
  readUntrusted: readUntrustedFile,
  writeFile: (path, data) => fsp.writeFile(path, data),
  unlink: (path) => fsp.unlink(path),
  mkdir: (path, options) => fsp.mkdir(path, options),
  chmod: (path, mode) => fsp.chmod(path, mode),
  chown: (path, uid, gid) => fsp.chown(path, uid, gid),
  stat: (path) => fsp.lstat(path),
  readConnections,
  avahiState: readAvahiState,
  kill: (pid, signal) => process.kill(pid, signal),
};

/** A user or group ID from the environment, or undefined. */
function idFromEnv(value) {
  return /^\d+$/.test(value || '') ? Number(value) : undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createAirPlay({
  enabled = process.env.BEACON_AIRPLAY === '1',
  name = process.env.BEACON_AIRPLAY_NAME,
  password = process.env.BEACON_AIRPLAY_PASSWORD || '',
  binary = 'uxplay',
  runDir = '/tmp/airplay',
  keyFile = '/data/airplay/uxplay.pem',
  /** UxPlay's own user and group. */
  uid = idFromEnv(process.env.BEACON_AIRPLAY_UID),
  gid = idFromEnv(process.env.BEACON_AIRPLAY_GID),
  root = typeof process.getuid === 'function' && process.getuid() === 0,
  io = defaultIo,
  now = () => performance.now(),
  log = () => {},
  relayOptions = {},
} = {}) {
  const displayName = receiverName(name);
  const relay = createAirPlayRelay({ now, log, ...relayOptions });
  const user = uid !== undefined && gid !== undefined ? { uid, gid } : null;
  // UxPlay can write here, so nothing of this server's goes in it.
  const filesDir = `${runDir}/uxplay`;
  const keyDir = keyFile.slice(0, keyFile.lastIndexOf('/')) || '.';
  const paths = {
    pid: `${runDir}/uxplay.pid`,
    metadata: `${filesDir}/metadata.txt`,
    cover: `${filesDir}/cover`,
    dacp: `${filesDir}/dacp`,
  };

  let started = false;
  let stopping = false;
  let child = null;
  let launchedAt = 0;
  let failures = 0;
  let error = null;
  let restartTimer = null;
  let tickTimer = null;
  let heartbeatTimer = null;
  let pingTimer = null;
  let ticking = false;
  let avahiTimer = null;
  let waitingForAvahi = false;
  let watchingAvahi = false;
  /** The Avahi UxPlay registered with, and its host name then. */
  let avahi = null;
  /** Why what UxPlay registered is lost since then, if it is. */
  let avahiChanged = null;
  /** The UxPlay being stopped to start again for Avahi. */
  let restarting = null;

  let session = null; // { startedAt, video }
  let previousConnections = new Set();
  let state = 'idle';
  let metadata = null;
  let cover = null; // { type, data }
  let coverVersion = 0;
  let coverCount = 0;
  const seen = { metadata: null, cover: null };
  const screens = new Map(); // screen → { alive }
  let lastStatusText = '';

  function status() {
    if (!enabled) return { enabled: false };
    const inSession = state !== 'idle';
    return {
      enabled: true,
      available: child !== null,
      name: displayName,
      state,
      passwordRequired: Boolean(password),
      metadata: inSession ? metadata : null,
      coverVersion: inSession && cover ? coverVersion : 0,
      ...(error ? { error } : {}),
    };
  }

  function publish(force = false) {
    const text = JSON.stringify(status());
    if (!force && text === lastStatusText) return;
    lastStatusText = text;
    relay.broadcastText(text);
  }

  function setError(message) {
    error = message;
    publish();
  }

  function logFailure(err) {
    log(`AirPlay: ${err && err.message}`);
  }

  /**
   * The files' stamps stay in `seen`, so the next session shows its own
   * track once UxPlay writes it, not this session's until then.
   */
  function forgetSession() {
    session = null;
    previousConnections = new Set();
    state = 'idle';
    metadata = null;
    cover = null;
    relay.reset();
  }

  async function readIfChanged(path, key, maxBytes) {
    let info;
    try {
      info = await io.stat(path);
    } catch {
      seen[key] = null;
      return undefined;
    }
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (seen[key] === stamp) return undefined;
    if (!info.isFile() || info.size > maxBytes) {
      seen[key] = stamp; // not UxPlay's file: leave it
      return undefined;
    }
    try {
      const data = await io.readUntrusted(path, maxBytes);
      seen[key] = stamp;
      return data;
    } catch {
      return undefined;
    }
  }

  async function readTrack() {
    const text = await readIfChanged(paths.metadata, 'metadata', MAX_METADATA_BYTES);
    if (text !== undefined) metadata = parseMetadata(text);
    const image = await readIfChanged(paths.cover, 'cover', MAX_COVER_BYTES);
    if (image !== undefined) {
      const type = coverImageType(image);
      if (type) {
        cover = { type, data: image };
        coverVersion = ++coverCount;
      } else if (image.length < MIN_COVER_BYTES) {
        cover = null; // the placeholder: this track has no art
      } else {
        seen.cover = null; // still being written: read it again next time
      }
    }
  }

  async function tick() {
    if (!child || ticking) return;
    ticking = true;
    try {
      const pid = child.pid;
      const [connections, connectedFile] = await Promise.all([
        pid ? io.readConnections(pid).catch(() => null) : null,
        io.stat(paths.dacp).then(() => true, () => false),
      ]);
      if (!child) return;
      const at = now();
      // A connection seen twice in a row: a device's quick look at the receiver doesn't count.
      let lasting = false;
      if (connections) {
        for (const inode of connections) if (previousConnections.has(inode)) lasting = true;
        previousConnections = connections;
      }
      const { lastVideoAt, lastAudioAt } = relay.stats();
      const videoAgo = lastVideoAt === null ? Infinity : at - lastVideoAt;
      const audioAgo = lastAudioAt === null ? Infinity : at - lastAudioAt;
      const connected = connectedFile || lasting || videoAgo < RECENT_MEDIA_MS || audioAgo < RECENT_MEDIA_MS
        || (connections === null && videoAgo < FALLBACK_VIDEO_MS);

      if (!connected) {
        if (session) forgetSession();
      } else {
        if (!session) session = { startedAt: at, video: false };
        if (lastVideoAt !== null && lastVideoAt >= session.startedAt - RECENT_MEDIA_MS) session.video = true;
        state = session.video ? 'mirroring' : audioAgo < RECENT_MEDIA_MS ? 'audio' : 'connected';
        if (!session.video) await readTrack();
      }
      publish();
    } finally {
      ticking = false;
    }
  }

  function forwardOutput(stream) {
    if (!stream) return;
    let partial = '';
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk) => {
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop().slice(-2000);
      for (const line of lines) if (line.trim()) log(line.slice(0, 500));
    });
    stream.on('error', () => {});
  }

  function scheduleRestart() {
    if (stopping || restartTimer) return;
    const delay = RESTART_DELAYS_MS[Math.min(failures, RESTART_DELAYS_MS.length) - 1];
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launchWhenAvahiRuns().catch(logFailure);
    }, delay);
  }

  /** Start UxPlay once Avahi is running (see the top of this file), however long that takes. */
  async function launchWhenAvahiRuns() {
    if (stopping || child || waitingForAvahi) return;
    waitingForAvahi = true;
    const since = now();
    let said = false;
    let slow = false;
    let reply = null;
    try {
      for (;;) {
        reply = await io.avahiState().catch(() => null);
        if (stopping) return;
        if (reply && reply.state === AVAHI_RUNNING) break;
        if (!said) {
          said = true;
          log('Waiting for Avahi, which lets devices find the receiver, before starting UxPlay.');
        }
        if (!slow && now() - since >= AVAHI_SLOW_MS) {
          slow = true;
          setError("Avahi, which lets devices find the receiver, hasn't started yet, and UxPlay waits for it.");
          log(error);
        }
        await sleep(AVAHI_POLL_MS);
        if (stopping) return;
      }
    } finally {
      waitingForAvahi = false;
    }
    avahi = { instance: reply.instance, host: reply.host };
    avahiChanged = null;
    launch();
  }

  /**
   * What UxPlay registered went with the Avahi it registered with, or
   * still names Avahi's old host name: start it again to register again,
   * once no device is connected (a connected device doesn't need to find it).
   */
  async function watchAvahi() {
    const proc = child;
    if (!proc || watchingAvahi || restarting) return;
    watchingAvahi = true;
    let reply;
    try {
      reply = await io.avahiState().catch(() => null);
    } finally {
      watchingAvahi = false;
    }
    if (child !== proc || restarting || stopping) return;
    // No answer is no news: Avahi may just be busy.
    if (reply && !avahiChanged) {
      if (reply.instance !== avahi?.instance) {
        avahiChanged = 'Avahi started over and lost the receiver, so UxPlay is starting again.';
      } else if (reply.state !== AVAHI_RUNNING || reply.host !== avahi?.host) {
        avahiChanged = 'Avahi changed its host name, so UxPlay is starting again under the new one.';
      }
    }
    if (!avahiChanged || state !== 'idle') return;
    restarting = proc;
    log(avahiChanged);
    await terminate(proc);
  }

  /** SIGTERM, then SIGKILL if it's still running 3 seconds later. */
  async function terminate(proc) {
    let timer;
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, 3000, 'timeout'); });
    proc.kill('SIGTERM');
    if (await Promise.race([exited, timeout]) === 'timeout') proc.kill('SIGKILL');
    clearTimeout(timer);
  }

  function launch() {
    if (stopping || child) return;
    const args = uxplayArgs({ name: displayName, password, filesDir, keyFile });
    let proc;
    try {
      proc = io.spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        // Nothing of the add-on's: UxPlay handles what devices on the network send.
        env: {
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          HOME: filesDir,
          LANG: 'C.UTF-8',
          // Its log as it happens (where the library isn't, it's left out).
          LD_PRELOAD: LINE_BUFFER_LIBRARY,
          _STDBUF_O: 'L',
        },
        ...(user || {}),
      });
    } catch (err) {
      setError(`UxPlay couldn't start: ${err.message}`);
      return;
    }
    child = proc;
    launchedAt = now();
    error = null;
    let ended = false;
    forwardOutput(proc.stdout);
    forwardOutput(proc.stderr);
    readPackets(proc.stdio?.[VIDEO_FD], 'video', (packet) => relay.handleVideoPacket(packet));
    readPackets(proc.stdio?.[AUDIO_FD], 'audio', (packet) => relay.handleAudioPacket(packet));
    if (proc.pid) io.writeFile(paths.pid, String(proc.pid)).catch(() => {});

    const end = (message, retry) => {
      if (ended) return;
      ended = true;
      const planned = restarting === proc;
      if (planned) restarting = null;
      if (child === proc) child = null;
      io.unlink(paths.pid).catch(() => {});
      if (session) forgetSession();
      if (stopping) return;
      if (planned) {
        publish();
        launchWhenAvahiRuns().catch(logFailure);
        return;
      }
      failures = now() - launchedAt >= STEADY_RUN_MS ? 1 : failures + 1;
      setError(message);
      log(message);
      if (retry) scheduleRestart();
    };
    proc.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        end("UxPlay isn't installed in this add-on image, so AirPlay can't start.", false);
      } else {
        end(`UxPlay couldn't start (${err && err.message}); starting it again.`, true);
      }
    });
    proc.on('exit', (code, signal) => {
      end(`UxPlay stopped (${signal || `exit code ${code}`}); starting it again.`, true);
    });
    publish();
  }

  /** Stop a UxPlay that an earlier run of this server left behind (it holds the name and ports). */
  async function stopLeftover() {
    let pid;
    try {
      pid = Number(String(await io.readFile(paths.pid)).trim());
    } catch {
      return;
    }
    if (!Number.isInteger(pid) || pid <= 1) return;
    try {
      const command = String(await io.readFile(`/proc/${pid}/cmdline`)).split('\0')[0];
      if (!/(^|\/)uxplay$/.test(command)) return;
      io.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
    for (let waited = 0; waited < 3000; waited += 100) {
      try {
        io.kill(pid, 0);
      } catch {
        return;
      }
      await sleep(100);
    }
    try { io.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }

  /** A fresh reader for each UxPlay: what an earlier one left half-written means nothing. */
  function readPackets(stream, kind, onPacket) {
    if (!stream) return;
    const reader = createRtpStreamReader((packet) => {
      try {
        onPacket(packet);
      } catch (err) {
        log(`AirPlay ${kind} packet dropped: ${err.message}`);
      }
    }, { onSkip: (bytes) => log(`Skipped ${bytes} bytes of UxPlay's ${kind} that weren't RTP`) });
    stream.on('data', (chunk) => reader.push(chunk));
    stream.on('error', () => {});
  }

  async function start() {
    if (!enabled || started) return;
    started = true;
    stopping = false;
    const optionsError = airplayOptionsError({ password })
      || (root && !user ? "UxPlay has to run as its own user, not root, and the add-on's airplay user wasn't found. AirPlay is off." : null);
    if (optionsError) {
      setError(optionsError);
      log(optionsError);
      return;
    }
    try {
      await io.mkdir(runDir, { recursive: true });
      await io.chmod(runDir, 0o711);
      for (const dir of [filesDir, keyDir]) {
        await io.mkdir(dir, { recursive: true });
        await io.chmod(dir, 0o700);
        if (user) await io.chown(dir, user.uid, user.gid);
      }
      await stopLeftover();
    } catch (err) {
      setError(`AirPlay couldn't start: ${err.message}`);
      log(error);
      return;
    }
    if (stopping) return;
    tickTimer = setInterval(() => { tick().catch((err) => log(`AirPlay status: ${err.message}`)); }, TICK_MS);
    heartbeatTimer = setInterval(() => publish(true), STATUS_HEARTBEAT_MS);
    pingTimer = setInterval(pingScreens, PING_MS);
    avahiTimer = setInterval(() => { watchAvahi().catch(logFailure); }, AVAHI_WATCH_MS);
    await launchWhenAvahiRuns();
  }

  async function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    clearInterval(tickTimer);
    clearInterval(heartbeatTimer);
    clearInterval(pingTimer);
    clearInterval(avahiTimer);
    restartTimer = tickTimer = heartbeatTimer = pingTimer = avahiTimer = null;
    if (child) await terminate(child);
    for (const screen of screens.keys()) {
      try { screen.terminate(); } catch { /* gone */ }
    }
    screens.clear();
    started = false;
  }

  function pingScreens() {
    for (const [screen, info] of screens) {
      if (!info.alive) {
        removeScreen(screen);
        try { screen.terminate(); } catch { /* gone */ }
        continue;
      }
      info.alive = false;
      try { screen.ping(); } catch { /* closing */ }
    }
  }

  /** A screen's WebSocket: the status now and when it changes, and the stream. */
  function addScreen(screen) {
    const info = { alive: true };
    screens.set(screen, info);
    screen.on?.('pong', () => { info.alive = true; });
    try {
      screen.send(JSON.stringify(status()));
    } catch {
      screens.delete(screen);
      return;
    }
    relay.addClient(screen);
  }

  function removeScreen(screen) {
    screens.delete(screen);
    relay.removeClient(screen);
  }

  return {
    start,
    stop,
    status,
    cover: () => (state !== 'idle' && cover ? cover : null),
    addScreen,
    removeScreen,
    get enabled() { return enabled; },
    stats: () => relay.stats(),
  };
}

module.exports = {
  createAirPlay,
  parseEstablishedInodes,
  parseMetadata,
  coverImageType,
  uxplayArgs,
  airplayOptionsError,
  receiverName,
  readConnections,
  readUntrustedFile,
  parseDbusReply,
  readAvahiState,
  LINE_BUFFER_LIBRARY,
};
