// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';

/*
 * airplay-relay.cjs turns UxPlay's RTP output (H.264 video, L16 audio, sent
 * to the add-on server over a pipe) into WebSocket messages for the AirPlay
 * screen. These tests feed it hand-built RTP packets the way GStreamer's
 * rtph264pay / rtpL16pay / rtpstreampay send them.
 */

const relayModule = createRequire(import.meta.url)('./airplay-relay.cjs');
const {
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
} = relayModule;

const START = Buffer.from([0, 0, 0, 1]);
const SPS = Buffer.from([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40]);
const PPS = Buffer.from([0x68, 0xeb, 0xe3, 0xcb]);
/** A slice NAL: type 5 (IDR) or 1 (non-IDR). 0x88 / 0x9a start a slice at macroblock 0. */
const slice = (type: 5 | 1, fill: number, length = 8, firstMb0 = true) =>
  Buffer.concat([Buffer.from([type === 5 ? 0x65 : 0x41, firstMb0 ? 0x88 : 0x08]), Buffer.alloc(length - 2, fill)]);
const annexB = (...nals: Buffer[]) => Buffer.concat(nals.flatMap((nal) => [START, nal]));

interface RtpOptions { seq: number; ts?: number; marker?: boolean; pt?: number; ssrc?: number; csrc?: number; extensionWords?: number; padding?: number }
function rtp(payload: Buffer, { seq, ts = 1000, marker = false, pt = 96, ssrc = 0x1234, csrc = 0, extensionWords = 0, padding = 0 }: RtpOptions) {
  const header = Buffer.alloc(12 + csrc * 4);
  header[0] = 0x80 | (padding ? 0x20 : 0) | (extensionWords ? 0x10 : 0) | csrc;
  header[1] = (marker ? 0x80 : 0) | pt;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  const extension = extensionWords ? Buffer.alloc(4 + extensionWords * 4, 0xee) : Buffer.alloc(0);
  if (extensionWords) extension.writeUInt16BE(extensionWords, 2);
  const pad = padding ? Buffer.concat([Buffer.alloc(padding - 1), Buffer.from([padding])]) : Buffer.alloc(0);
  return Buffer.concat([header, extension, payload, pad]);
}
const stapA = (...nals: Buffer[]) => Buffer.concat([
  Buffer.from([0x78]),
  ...nals.flatMap((nal) => { const size = Buffer.alloc(2); size.writeUInt16BE(nal.length); return [size, nal]; }),
]);
/** Splits a NAL into FU-A payloads of `size` bytes of NAL data each. */
function fuA(nal: Buffer, size: number): Buffer[] {
  const body = nal.subarray(1);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < body.length; offset += size) {
    const start = offset === 0;
    const end = offset + size >= body.length;
    const indicator = (nal[0] & 0xe0) | 28;
    const header = (start ? 0x80 : 0) | (end ? 0x40 : 0) | (nal[0] & 0x1f);
    parts.push(Buffer.concat([Buffer.from([indicator, header]), body.subarray(offset, offset + size)]));
  }
  return parts;
}

describe('parseRtpPacket', () => {
  it('reads the header and finds the payload past CSRCs, an extension and padding', () => {
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    const packet = parseRtpPacket(rtp(payload, { seq: 65535, ts: 0xfffffffe, marker: true, pt: 97, csrc: 2, extensionWords: 1, padding: 3 }));
    expect(packet).toMatchObject({ sequence: 65535, timestamp: 0xfffffffe, marker: true, payloadType: 97, ssrc: 0x1234 });
    expect(Buffer.from(packet.payload)).toEqual(payload);
  });

  it('rejects packets that are not RTP version 2 or are cut short', () => {
    expect(parseRtpPacket(Buffer.alloc(8))).toBeNull();
    const wrongVersion = rtp(Buffer.from([1]), { seq: 1 });
    wrongVersion[0] = 0x40;
    expect(parseRtpPacket(wrongVersion)).toBeNull();
    const badPadding = rtp(Buffer.from([1]), { seq: 1 });
    badPadding[0] |= 0x20;
    badPadding[badPadding.length - 1] = 200;
    expect(parseRtpPacket(badPadding)).toBeNull();
  });
});

/** An RTP packet framed for a stream (RFC 4571), the way rtpstreampay writes it. */
const framed = (packet: Buffer) => {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(packet.length);
  return Buffer.concat([length, packet]);
};

describe('createRtpStreamReader', () => {
  let packets: Buffer[];
  let reader: { push: (chunk: Buffer) => void };
  beforeEach(() => {
    packets = [];
    reader = createRtpStreamReader((packet: Buffer) => packets.push(Buffer.from(packet)));
  });

  it('splits the stream into packets, however it arrives', () => {
    const a = rtp(Buffer.alloc(300, 1), { seq: 1 });
    const b = rtp(Buffer.alloc(5, 2), { seq: 2 });
    const c = rtp(Buffer.alloc(70_000 - 12 - 5_000, 3), { seq: 3 });
    const stream = Buffer.concat([framed(a), framed(b), framed(c)]);
    for (let offset = 0; offset < stream.length; offset += 7) reader.push(stream.subarray(offset, offset + 7));
    expect(packets).toEqual([a, b, c]);
  });

  it('finds the packets again after a stretch that isn’t one', () => {
    const a = rtp(Buffer.alloc(20, 1), { seq: 1 });
    const b = rtp(Buffer.alloc(20, 2), { seq: 2 });
    reader.push(Buffer.concat([framed(a), Buffer.from([0x00, 0x30, 0x12, 0x34, 0x56]), framed(b)]));
    expect(packets).toEqual([a, b]);
  });
});

describe('createH264Depacketizer', () => {
  let units: { nals: Buffer[]; keyframe: boolean }[];
  let depacketize: { push: (packet: unknown) => void; lost: number };
  const push = (payload: Buffer, options: RtpOptions) => depacketize.push(parseRtpPacket(rtp(payload, options)));

  beforeEach(() => {
    units = [];
    depacketize = createH264Depacketizer((unit: { nals: Buffer[]; keyframe: boolean }) => units.push(unit));
  });

  it('assembles an access unit from a STAP-A and FU-A fragments, ending at the marker bit', () => {
    const idr = slice(5, 0xaa, 3000);
    push(stapA(SPS, PPS), { seq: 10 });
    const fragments = fuA(idr, 1000);
    fragments.forEach((part, i) => push(part, { seq: 11 + i, marker: i === fragments.length - 1 }));

    expect(units).toHaveLength(1);
    expect(units[0].keyframe).toBe(true);
    expect(units[0].nals.map((nal) => Buffer.from(nal))).toEqual([SPS, PPS, idr]);
  });

  it('emits single-NAL packets and treats a slice as a frame', () => {
    push(slice(1, 1), { seq: 1, ts: 3000, marker: true });
    push(slice(1, 2), { seq: 2, ts: 6000, marker: true });
    expect(units.map((unit) => unit.keyframe)).toEqual([false, false]);
    expect(units[1].nals.map((nal) => Buffer.from(nal))).toEqual([slice(1, 2)]);
  });

  it('keeps several slices of one picture together', () => {
    push(slice(5, 1, 8, true), { seq: 1 });
    push(slice(5, 2, 8, false), { seq: 2, marker: true });
    expect(units).toHaveLength(1);
    expect(units[0].nals).toHaveLength(2);
  });

  it('drops a frame that lost a packet, and carries on with the next one', () => {
    const idr = slice(5, 0xbb, 3000);
    const fragments = fuA(idr, 1000);
    push(fragments[0], { seq: 20 });
    // fragments[1] (seq 21) is lost
    push(fragments[2], { seq: 22, marker: true });
    push(slice(1, 3), { seq: 23, ts: 4000, marker: true });

    expect(units).toHaveLength(1);
    expect(units[0].nals.map((nal) => Buffer.from(nal))).toEqual([slice(1, 3)]);
    expect(depacketize.lost).toBe(1);
  });

  it('drops a fragment series that starts without its first fragment', () => {
    const fragments = fuA(slice(1, 0xcc, 3000), 1000);
    push(fragments[1], { seq: 5 });
    push(fragments[2], { seq: 6, marker: true });
    push(slice(1, 4), { seq: 7, ts: 2000, marker: true });
    expect(units).toHaveLength(1);
    expect(Buffer.from(units[0].nals[0])).toEqual(slice(1, 4));
  });

  it('ignores a repeated or late packet', () => {
    push(slice(1, 1), { seq: 100, marker: true });
    push(slice(1, 1), { seq: 100, marker: true });
    push(slice(1, 9), { seq: 99, marker: true });
    expect(units).toHaveLength(1);
    expect(depacketize.lost).toBe(0);
  });

  it('follows the sequence number across its wrap', () => {
    push(slice(1, 1), { seq: 65535, marker: true });
    push(slice(1, 2), { seq: 0, marker: true });
    expect(units).toHaveLength(2);
    expect(depacketize.lost).toBe(0);
  });

  it('starts over, without counting losses, when the stream restarts', () => {
    // A restarted GStreamer pipeline sends with a new SSRC from a random sequence number.
    const restarts: number[] = [];
    depacketize = createH264Depacketizer((unit: { nals: Buffer[]; keyframe: boolean }) => units.push(unit), {
      onRestart: () => restarts.push(units.length),
    });
    push(slice(1, 1), { seq: 40000, marker: true });
    push(slice(5, 2, 8), { seq: 7, ssrc: 0x9999 });
    push(slice(5, 3, 8, false), { seq: 8, ssrc: 0x9999, marker: true });
    // Far behind the last one, as if restarted without a new SSRC.
    push(slice(5, 4), { seq: 60000, ssrc: 0x9999, marker: true });

    expect(units.map((unit) => unit.nals.length)).toEqual([1, 2, 1]);
    expect(restarts).toEqual([1, 2]);
    expect(depacketize.lost).toBe(0);
  });

  it('drops a frame whose first slice is missing', () => {
    push(slice(1, 1, 8, false), { seq: 1, marker: true });
    push(slice(1, 2), { seq: 2, marker: true });
    expect(units).toHaveLength(1);
    expect(Buffer.from(units[0].nals[0])).toEqual(slice(1, 2));
  });

  it('still splits frames when a marker bit is missing', () => {
    // A new picture's first slice, parameter sets or a new timestamp end the
    // previous frame even without its marker.
    push(slice(1, 1), { seq: 1, ts: 100 });
    push(slice(1, 2), { seq: 2, ts: 100 });
    push(SPS, { seq: 3, ts: 100 });
    push(PPS, { seq: 4, ts: 100 });
    push(slice(5, 3), { seq: 5, ts: 100 });
    push(slice(1, 4), { seq: 6, ts: 200 });
    push(Buffer.from([0x09, 0xf0]), { seq: 7, ts: 200 }); // access unit delimiter
    push(slice(1, 5), { seq: 8, ts: 200, marker: true });

    expect(units.map((unit) => unit.nals.map((nal) => nal[1] === 0x88 ? `${nal[0]}:${nal[2]}` : `${nal[0]}`))).toEqual([
      [`${0x41}:1`],
      [`${0x41}:2`],
      [`${0x67}`, `${0x68}`, `${0x65}:3`],
      [`${0x41}:4`],
      [`${0x09}`, `${0x41}:5`],
    ]);
    expect(units.map((unit) => unit.keyframe)).toEqual([false, false, true, false, false]);
  });
});

interface FakeClient {
  readyState: number;
  bufferedAmount: number;
  sent: Buffer[];
  texts: string[];
  terminated: boolean;
  send: (data: Buffer | string, options?: unknown, cb?: (err?: Error) => void) => void;
  terminate: () => void;
}
function fakeClient(): FakeClient {
  const client: FakeClient = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    texts: [],
    terminated: false,
    send(data) {
      if (typeof data === 'string') client.texts.push(data);
      else client.sent.push(Buffer.from(data));
    },
    terminate() {
      client.terminated = true;
      client.readyState = 3;
    },
  };
  return client;
}

/** The messages a client received, reassembled from their chunks. */
function received(client: FakeClient) {
  const messages: { type: number; flags: number; timestamp: number; payload: Buffer }[] = [];
  let parts: Buffer[] = [];
  client.sent.forEach((chunk, index) => {
    parts.push(chunk.subarray(HEADER_BYTES));
    if (chunk[1] & FLAG_MORE) return;
    const first = client.sent[index - parts.length + 1];
    messages.push({ type: first[0], flags: first[1] & ~FLAG_MORE, timestamp: first.readDoubleBE(2), payload: Buffer.concat(parts) });
    parts = [];
  });
  return messages;
}

describe('createAirPlayRelay', () => {
  let clock: number;
  let seq: number;
  let ssrc: number;
  let relay: ReturnType<typeof createAirPlayRelay>;
  const options = { maxGopBytes: 64 * 1024, maxGopFrames: 100, maxBufferedBytes: 1024 * 1024, chunkBytes: 1500 };

  beforeEach(() => {
    clock = 0;
    seq = 0;
    ssrc = 0x1234;
    relay = createAirPlayRelay({ now: () => clock, ...options });
  });

  /** One frame, as single-NAL packets, the last with the marker bit. */
  function sendFrame(...nals: Buffer[]) {
    clock += 33;
    nals.forEach((nal, i) => relay.handleVideoPacket(rtp(nal, { seq: seq++, ts: clock * 90, ssrc, marker: i === nals.length - 1 })));
  }

  it('sends each frame to connected screens as Annex B with its time and keyframe flag', () => {
    const client = fakeClient();
    relay.addClient(client);
    sendFrame(SPS, PPS, slice(5, 1));
    sendFrame(slice(1, 2));

    expect(received(client)).toEqual([
      { type: MESSAGE_VIDEO, flags: FLAG_KEY, timestamp: 33, payload: annexB(SPS, PPS, slice(5, 1)) },
      { type: MESSAGE_VIDEO, flags: 0, timestamp: 66, payload: annexB(slice(1, 2)) },
    ]);
  });

  it('starts a screen that joins mid-stream at the last keyframe, replaying the frames since', () => {
    sendFrame(slice(1, 0)); // before any keyframe: can't be decoded, never replayed
    sendFrame(SPS, PPS, slice(5, 1));
    sendFrame(slice(1, 2));
    sendFrame(slice(1, 3));

    const late = fakeClient();
    relay.addClient(late);
    sendFrame(slice(1, 4));

    expect(received(late).map(({ flags, payload }) => ({ flags, payload }))).toEqual([
      { flags: FLAG_KEY | FLAG_REPLAY, payload: annexB(SPS, PPS, slice(5, 1)) },
      { flags: FLAG_REPLAY, payload: annexB(slice(1, 2)) },
      { flags: FLAG_REPLAY, payload: annexB(slice(1, 3)) },
      { flags: 0, payload: annexB(slice(1, 4)) },
    ]);
  });

  it('gives a replayed keyframe the parameter sets it was sent without', () => {
    sendFrame(SPS, PPS, slice(5, 1));
    sendFrame(slice(5, 2)); // IDR without SPS/PPS
    const late = fakeClient();
    relay.addClient(late);
    expect(received(late)[0].payload).toEqual(annexB(SPS, PPS, slice(5, 2)));
  });

  it('makes a screen that joins before any keyframe wait for one', () => {
    const early = fakeClient();
    relay.addClient(early);
    sendFrame(slice(1, 1));
    sendFrame(SPS, PPS, slice(5, 2));
    sendFrame(slice(1, 3));
    expect(received(early).map(({ flags }) => flags)).toEqual([FLAG_KEY, 0]);
  });

  it('stops replaying a picture that has grown too long, until the next keyframe', () => {
    sendFrame(SPS, PPS, slice(5, 1));
    for (let i = 0; i < 20; i++) sendFrame(slice(1, i, 4000)); // 80 KB: over maxGopBytes
    const late = fakeClient();
    relay.addClient(late);
    sendFrame(slice(1, 99));
    expect(received(late)).toEqual([]);

    sendFrame(SPS, PPS, slice(5, 5));
    expect(received(late).map(({ flags }) => flags)).toEqual([FLAG_KEY]);
    expect(relay.stats()).toMatchObject({ gopFrames: 1 });
  });

  it('makes screens wait for a keyframe when the stream restarts', () => {
    const client = fakeClient();
    relay.addClient(client);
    sendFrame(SPS, PPS, slice(5, 1));
    ssrc = 0x4321;
    seq = 30000;
    sendFrame(slice(1, 2)); // refers to a keyframe of the new stream that never came
    expect(relay.stats()).toMatchObject({ gopFrames: 0 });
    sendFrame(SPS, PPS, slice(5, 3));

    expect(received(client).map(({ flags, payload }) => ({ flags, payload }))).toEqual([
      { flags: FLAG_KEY, payload: annexB(SPS, PPS, slice(5, 1)) },
      { flags: FLAG_KEY, payload: annexB(SPS, PPS, slice(5, 3)) },
    ]);
  });

  it('splits a frame larger than a message into chunks', () => {
    const client = fakeClient();
    relay.addClient(client);
    const big = slice(5, 7, 5000);
    sendFrame(SPS, PPS, big);

    expect(client.sent.length).toBe(4);
    expect(client.sent.slice(0, -1).every((chunk) => chunk[1] & FLAG_MORE)).toBe(true);
    expect(client.sent.every((chunk) => chunk.length <= HEADER_BYTES + options.chunkBytes)).toBe(true);
    expect(received(client)).toEqual([{ type: MESSAGE_VIDEO, flags: FLAG_KEY, timestamp: 33, payload: annexB(SPS, PPS, big) }]);
  });

  it('forwards audio without its RTP header and never replays it', () => {
    const client = fakeClient();
    relay.addClient(client);
    clock = 500;
    const pcm = Buffer.from([0, 1, 0, 2, 0, 3, 0, 4]);
    relay.handleAudioPacket(rtp(pcm, { seq: 1 }));
    expect(received(client)).toEqual([{ type: MESSAGE_AUDIO, flags: 0, timestamp: 500, payload: pcm }]);

    const late = fakeClient();
    relay.addClient(late);
    expect(received(late)).toEqual([]);
    expect(relay.stats()).toMatchObject({ lastAudioAt: 500 });
  });

  it('disconnects a screen that has fallen far behind, so it rejoins at a keyframe', () => {
    const slow = fakeClient();
    const fine = fakeClient();
    relay.addClient(slow);
    relay.addClient(fine);
    sendFrame(SPS, PPS, slice(5, 1));
    clock += 30_000; // past the catch-up allowance after joining
    slow.bufferedAmount = options.maxBufferedBytes + 1;
    sendFrame(slice(1, 2));

    expect(slow.terminated).toBe(true);
    expect(fine.terminated).toBe(false);
    expect(received(fine)).toHaveLength(2);
    expect(relay.stats().clients).toBe(1);
  });

  it('lets a screen that just joined catch up on the replay', () => {
    sendFrame(SPS, PPS, slice(5, 1));
    const late = fakeClient();
    relay.addClient(late);
    late.bufferedAmount = options.maxBufferedBytes + 1;
    sendFrame(slice(1, 2));
    expect(late.terminated).toBe(false);
  });

  it('forgets the picture when the session ends', () => {
    sendFrame(SPS, PPS, slice(5, 1));
    relay.reset();
    const late = fakeClient();
    relay.addClient(late);
    expect(received(late)).toEqual([]);
    expect(relay.stats()).toMatchObject({ gopFrames: 0 });
  });

  it('removes a screen whose send fails, and stops sending to closed ones', () => {
    const broken = fakeClient();
    broken.send = () => { throw new Error('socket gone'); };
    const closed = fakeClient();
    relay.addClient(broken);
    relay.addClient(closed);
    closed.readyState = 3;
    sendFrame(SPS, PPS, slice(5, 1));
    expect(closed.sent).toEqual([]);
    expect(relay.stats().clients).toBe(0);
  });

  it('sends text (status) to every screen', () => {
    const a = fakeClient();
    const b = fakeClient();
    relay.addClient(a);
    relay.addClient(b);
    relay.removeClient(b);
    relay.broadcastText('{"state":"idle"}');
    expect(a.texts).toEqual(['{"state":"idle"}']);
    expect(b.texts).toEqual([]);
  });

  it('ignores datagrams that are not RTP', () => {
    const client = fakeClient();
    relay.addClient(client);
    relay.handleVideoPacket(Buffer.from('hello'));
    relay.handleAudioPacket(Buffer.alloc(3));
    expect(client.sent).toEqual([]);
  });
});
