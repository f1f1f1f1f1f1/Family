'use strict';

/**
 * Relays an AirPlay stream to the AirPlay screen (src/components/AirPlayView).
 *
 * UxPlay (started by airplay.cjs) decrypts what an iPhone, iPad or Mac
 * sends and, instead of showing it, sends it to this server as RTP over a
 * pipe (see createRtpStreamReader): the H.264 video as rtph264pay packets,
 * the decoded audio as rtpL16pay packets (44.1 kHz stereo, 16-bit
 * big-endian). This module turns those packets back into whole video
 * frames and audio chunks and sends them to every connected screen over
 * its WebSocket, as binary messages:
 *
 *   byte 0      MESSAGE_VIDEO (an H.264 access unit, Annex B) or MESSAGE_AUDIO (PCM)
 *   byte 1      flags: FLAG_KEY (an IDR frame), FLAG_REPLAY (sent to catch
 *               a screen up, not live), FLAG_MORE (continued in the next message)
 *   bytes 2-9   when the relay received it, in ms (float64, big-endian)
 *   bytes 10-   the frame or audio
 *
 * Messages are at most HEADER_BYTES + chunkBytes long: HA's ingress proxy
 * refuses WebSocket messages over 4 MiB, so a larger frame goes as several.
 *
 * A screen can only start decoding at a keyframe (IDR), and an iPhone sends
 * few of those, so the frames since the last one are kept (up to a limit)
 * and replayed to a screen that connects mid-stream. Past the limit, a
 * screen that connects waits for the next keyframe.
 */

const MESSAGE_VIDEO = 1;
const MESSAGE_AUDIO = 2;
const FLAG_KEY = 0x01;
const FLAG_REPLAY = 0x02;
const FLAG_MORE = 0x80;
const HEADER_BYTES = 10;

const NAL_IDR = 5;
const NAL_SEI = 6;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;
const NAL_STAP_A = 24;
const NAL_FU_A = 28;
const START_CODE = Buffer.from([0, 0, 0, 1]);

/** An RTP packet's header fields and payload (RFC 3550), or null if it isn't one. */
function parseRtpPacket(buf) {
  if (!buf || buf.length < 12 || (buf[0] >> 6) !== 2) return null;
  const csrcCount = buf[0] & 0x0f;
  let offset = 12 + csrcCount * 4;
  if (buf[0] & 0x10) {
    if (buf.length < offset + 4) return null;
    offset += 4 + buf.readUInt16BE(offset + 2) * 4;
  }
  let end = buf.length;
  if (buf[0] & 0x20) end -= buf[buf.length - 1];
  if (offset > end) return null;
  return {
    marker: (buf[1] & 0x80) !== 0,
    payloadType: buf[1] & 0x7f,
    sequence: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    payload: buf.subarray(offset, end),
  };
}

/**
 * Reads RTP packets from a stream in RFC 4571 framing (each packet after
 * its length, 16-bit big-endian), the way GStreamer's rtpstreampay writes
 * them. Should the stream stop making sense (a pipeline stopped mid-packet),
 * it skips ahead to the next thing that looks like one of UxPlay's packets.
 */
function createRtpStreamReader(onPacket, { payloadType = 96, onSkip = () => {} } = {}) {
  let pending = Buffer.alloc(0);
  const plausible = (buf, at) => buf.readUInt16BE(at) >= 12
    && (buf[at + 2] >> 6) === 2 && (buf[at + 3] & 0x7f) === payloadType;
  return {
    push(chunk) {
      const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      let skipped = 0;
      while (buf.length - offset >= 4) {
        if (!plausible(buf, offset)) {
          offset += 1;
          skipped += 1;
          continue;
        }
        const end = offset + 2 + buf.readUInt16BE(offset);
        if (end > buf.length) break;
        onPacket(buf.subarray(offset + 2, end));
        offset = end;
      }
      if (skipped) onSkip(skipped);
      pending = Buffer.from(buf.subarray(offset));
    },
  };
}

const isVcl = (type) => type >= 1 && type <= 5;
/** A slice that starts its picture (first_mb_in_slice, the first ue(v) of its header, is 0). */
const startsPicture = (nal) => nal.length > 1 && (nal[1] & 0x80) !== 0;
/** RFC 3550 A.1: further off than this, it's a new stream rather than loss or reordering. */
const MAX_DROPOUT = 3000;
const MAX_MISORDER = 100;

/**
 * Reassembles H.264 access units (one video frame's NAL units) from RTP
 * packets (RFC 6184: single NAL units, STAP-A and FU-A, which is what
 * rtph264pay sends). A frame ends at the marker bit; a new timestamp, a new
 * picture's first slice, or parameter sets / an access unit delimiter after
 * a slice end it too, in case a marker is missing. A frame that lost a
 * packet is dropped: the decoder conceals the gap better than a half frame.
 * onRestart is called when the stream starts over (UxPlay restarted it).
 */
function createH264Depacketizer(onAccessUnit, { onRestart = () => {} } = {}) {
  let nals = [];
  let hasVcl = false;
  let broken = false;
  let fragments = null;
  let lastSequence = null;
  let ssrc = null;
  let timestamp = null;
  const state = { lost: 0, push };

  function flush() {
    if (fragments) broken = true; // a NAL unit's last fragment never came
    fragments = null;
    if (!hasVcl && !broken) return; // parameter sets on their own: they go with the next frame
    if (!broken) onAccessUnit({ nals, keyframe: nals.some((nal) => (nal[0] & 0x1f) === NAL_IDR) });
    nals = [];
    hasVcl = false;
    broken = false;
  }

  function addNal(nal) {
    if (nal.length === 0) return;
    const type = nal[0] & 0x1f;
    if (hasVcl && ((isVcl(type) && startsPicture(nal)) || type === NAL_AUD || type === NAL_SPS || type === NAL_PPS || type === NAL_SEI)) {
      flush();
    }
    if (isVcl(type) && !hasVcl && !startsPicture(nal)) broken = true; // its first slice was lost
    nals.push(nal);
    if (isVcl(type)) hasVcl = true;
  }

  function restart() {
    nals = [];
    hasVcl = false;
    broken = false;
    fragments = null;
    timestamp = null;
    onRestart();
  }

  function push(packet) {
    if (!packet) return;
    if (ssrc !== null && packet.ssrc !== ssrc) {
      restart();
    } else if (lastSequence !== null) {
      const ahead = (packet.sequence - lastSequence) & 0xffff;
      if (ahead > MAX_DROPOUT && ahead < 0x10000 - MAX_MISORDER) {
        restart();
      } else if (ahead === 0 || ahead > MAX_DROPOUT) {
        return; // a repeat or a late arrival
      } else if (ahead > 1) {
        state.lost += ahead - 1;
        broken = true;
        fragments = null;
      }
    }
    ssrc = packet.ssrc;
    lastSequence = packet.sequence;
    if (timestamp !== null && packet.timestamp !== timestamp) flush();
    timestamp = packet.timestamp;

    const payload = packet.payload;
    if (payload.length > 0) {
      const type = payload[0] & 0x1f;
      if (type >= 1 && type <= 23) {
        if (fragments) broken = true;
        fragments = null;
        addNal(payload);
      } else if (type === NAL_STAP_A) {
        if (fragments) broken = true;
        fragments = null;
        for (let offset = 1; offset < payload.length;) {
          const size = offset + 2 <= payload.length ? payload.readUInt16BE(offset) : 0;
          if (size === 0 || offset + 2 + size > payload.length) {
            broken = true;
            break;
          }
          addNal(payload.subarray(offset + 2, offset + 2 + size));
          offset += 2 + size;
        }
      } else if (type === NAL_FU_A && payload.length >= 2) {
        const header = payload[1];
        if (header & 0x80) {
          if (fragments) broken = true;
          fragments = [Buffer.from([(payload[0] & 0xe0) | (header & 0x1f)])];
        }
        if (!fragments) {
          broken = true; // its first fragment never came
        } else {
          fragments.push(payload.subarray(2));
          if (header & 0x40) {
            const nal = Buffer.concat(fragments);
            fragments = null;
            addNal(nal);
          }
        }
      }
      // STAP-B, MTAP and FU-B are for interleaved streams, which rtph264pay doesn't send.
    }
    if (packet.marker) flush();
  }

  return state;
}

function annexB(nals) {
  const parts = [];
  for (const nal of nals) parts.push(START_CODE, nal);
  return Buffer.concat(parts);
}

/** A frame or audio chunk as one or more messages (see the top of this file). */
function encodeMessages(type, flags, timestamp, payload, chunkBytes) {
  const messages = [];
  for (let offset = 0; offset === 0 || offset < payload.length; offset += chunkBytes) {
    const part = payload.subarray(offset, offset + chunkBytes);
    const message = Buffer.allocUnsafe(HEADER_BYTES + part.length);
    message[0] = type;
    message[1] = flags | (offset + chunkBytes < payload.length ? FLAG_MORE : 0);
    message.writeDoubleBE(timestamp, 2);
    part.copy(message, HEADER_BYTES);
    messages.push(message);
  }
  return messages;
}

const OPEN = 1;
/**
 * A screen that just connected gets this long, plus time to take in its
 * replay at CATCH_UP_BYTES_PER_MS (4 Mbit/s), before it counts as too slow.
 */
const CATCH_UP_MS = 15_000;
const CATCH_UP_BYTES_PER_MS = 500;

/**
 * The relay: takes UDP datagrams from UxPlay and sends frames and audio to
 * the connected screens (ws WebSocket objects, or anything with the same
 * send / bufferedAmount / readyState / terminate).
 */
function createAirPlayRelay({
  now = () => performance.now(),
  maxGopBytes = 32 * 1024 * 1024,
  maxGopFrames = 7200,
  maxBufferedBytes = 4 * 1024 * 1024,
  chunkBytes = 1024 * 1024,
  log = () => {},
} = {}) {
  /** Screen → { needsKey, graceUntil, allowance } */
  const clients = new Map();
  /** Frames since the last keyframe (a keyframe first), while under the limits. */
  let gop = [];
  let gopBytes = 0;
  let sps = null;
  let pps = null;
  const stats = { frames: 0, keyframes: 0, lastVideoAt: null, lastAudioAt: null };

  function send(client, info, messages) {
    if (client.readyState !== OPEN) {
      clients.delete(client);
      return;
    }
    const limit = maxBufferedBytes + (now() < info.graceUntil ? info.allowance : 0);
    if (client.bufferedAmount > limit) {
      log(`A screen fell ${Math.round(client.bufferedAmount / 1024)} KB behind; disconnecting it so it can start again`);
      clients.delete(client);
      client.terminate();
      return;
    }
    try {
      for (const message of messages) client.send(message, { binary: true });
    } catch {
      clients.delete(client);
      try { client.terminate(); } catch { /* already gone */ }
    }
  }

  const depacketizer = createH264Depacketizer(({ nals, keyframe }) => {
    const at = now();
    for (const nal of nals) {
      const type = nal[0] & 0x1f;
      if (type === NAL_SPS) sps = Buffer.from(nal);
      else if (type === NAL_PPS) pps = Buffer.from(nal);
    }
    if (keyframe) {
      // A screen can start here only with the parameter sets (a later IDR can come without them).
      const types = new Set(nals.map((nal) => nal[0] & 0x1f));
      nals = [
        ...(!types.has(NAL_SPS) && sps ? [sps] : []),
        ...(!types.has(NAL_PPS) && pps ? [pps] : []),
        ...nals,
      ];
    }
    const payload = annexB(nals);
    stats.frames += 1;
    stats.lastVideoAt = at;

    if (keyframe) {
      stats.keyframes += 1;
      gop = [{ timestamp: at, keyframe: true, payload }];
      gopBytes = payload.length;
    } else if (gop.length) {
      gop.push({ timestamp: at, keyframe: false, payload });
      gopBytes += payload.length;
      if (gopBytes > maxGopBytes || gop.length > maxGopFrames) {
        log(`The picture since the last keyframe is over ${gop.length} frames / ${Math.round(gopBytes / 1024)} KB; screens that connect now wait for the next keyframe`);
        gop = [];
        gopBytes = 0;
      }
    }

    const messages = encodeMessages(MESSAGE_VIDEO, keyframe ? FLAG_KEY : 0, at, payload, chunkBytes);
    for (const [client, info] of clients) {
      if (info.needsKey) {
        if (!keyframe) continue;
        info.needsKey = false;
      }
      send(client, info, messages);
    }
  }, { onRestart: () => reset() });

  function handleVideoPacket(datagram) {
    depacketizer.push(parseRtpPacket(datagram));
  }

  function handleAudioPacket(datagram) {
    const packet = parseRtpPacket(datagram);
    if (!packet || packet.payload.length === 0) return;
    const at = now();
    stats.lastAudioAt = at;
    if (clients.size === 0) return;
    const messages = encodeMessages(MESSAGE_AUDIO, 0, at, packet.payload, chunkBytes);
    for (const [client, info] of clients) send(client, info, messages);
  }

  function addClient(client) {
    const info = { needsKey: gop.length === 0, graceUntil: Infinity, allowance: 0 };
    clients.set(client, info);
    for (const frame of gop) {
      const flags = FLAG_REPLAY | (frame.keyframe ? FLAG_KEY : 0);
      info.allowance += frame.payload.length;
      send(client, info, encodeMessages(MESSAGE_VIDEO, flags, frame.timestamp, frame.payload, chunkBytes));
      if (!clients.has(client)) return;
    }
    info.graceUntil = now() + CATCH_UP_MS + info.allowance / CATCH_UP_BYTES_PER_MS;
  }

  function removeClient(client) {
    clients.delete(client);
  }

  /** The sender disconnected: its picture can't be continued. */
  function reset() {
    gop = [];
    gopBytes = 0;
    sps = null;
    pps = null;
    for (const info of clients.values()) info.needsKey = true;
  }

  function broadcastText(text) {
    for (const client of clients.keys()) {
      if (client.readyState !== OPEN) {
        clients.delete(client);
        continue;
      }
      try {
        client.send(text);
      } catch {
        clients.delete(client);
      }
    }
  }

  return {
    handleVideoPacket,
    handleAudioPacket,
    addClient,
    removeClient,
    reset,
    broadcastText,
    stats: () => ({
      ...stats,
      clients: clients.size,
      gopFrames: gop.length,
      gopBytes,
      lost: depacketizer.lost,
    }),
  };
}

module.exports = {
  parseRtpPacket,
  createRtpStreamReader,
  createH264Depacketizer,
  createAirPlayRelay,
  MESSAGE_VIDEO,
  MESSAGE_AUDIO,
  FLAG_KEY,
  FLAG_REPLAY,
  FLAG_MORE,
  HEADER_BYTES,
};
