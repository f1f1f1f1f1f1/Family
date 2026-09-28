import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AirPlayMedia } from '../api/airplay';
import { IDR, PPS, P_SLICE, annexB, sps } from '../test/h264';
import { TIMESCALE } from './fmp4';
import { catchUpRate, createAirPlayVideo, frameDuration, liveSeekTarget, trimEnd } from './airplay-video';

class FakeSourceBuffer extends EventTarget {
  updating = false;
  appended: Uint8Array[] = [];
  removed: [number, number][] = [];
  failWith: Error | null = null;

  constructor(readonly type: string) {
    super();
  }

  appendBuffer(data: Uint8Array) {
    if (this.failWith) throw this.failWith;
    this.appended.push(new Uint8Array(data));
    this.updating = true;
  }

  remove(start: number, end: number) {
    this.removed.push([start, end]);
    this.updating = true;
  }

  finish() {
    this.updating = false;
    this.dispatchEvent(new Event('updateend'));
  }
}

class FakeMediaSource extends EventTarget {
  static supported = true;
  static instances: FakeMediaSource[] = [];
  static isTypeSupported = vi.fn(() => FakeMediaSource.supported);
  readyState: 'closed' | 'open' = 'closed';
  duration = NaN;
  sourceBuffers: FakeSourceBuffer[] = [];

  constructor() {
    super();
    FakeMediaSource.instances.push(this);
  }

  addSourceBuffer(type: string) {
    const buffer = new FakeSourceBuffer(type);
    this.sourceBuffers.push(buffer);
    return buffer;
  }

  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('sourceopen'));
  }
}

function ranges(list: [number, number][]) {
  return { length: list.length, start: (i: number) => list[i][0], end: (i: number) => list[i][1] };
}

function fakeVideo() {
  const video = Object.assign(new EventTarget(), {
    src: '',
    currentTime: 0,
    playbackRate: 1,
    paused: true,
    seeking: false,
    disableRemotePlayback: false,
    bufferedRanges: [] as [number, number][],
    play: vi.fn(async () => { video.paused = false; }),
    load: vi.fn(),
    removeAttribute: vi.fn((name: string) => { if (name === 'src') video.src = ''; }),
  });
  Object.defineProperty(video, 'buffered', { get: () => ranges(video.bufferedRanges) });
  return video;
}

const HIGH_1080 = sps({ profile: 100, level: 40, widthMbs: 120, heightMapUnits: 68, crop: [0, 0, 0, 4] });
const PORTRAIT = sps({ profile: 100, level: 40, widthMbs: 68, heightMapUnits: 120, crop: [0, 4, 0, 0] });
const MAIN = sps({ profile: 77, level: 31, widthMbs: 80, heightMapUnits: 45 });

function frame(receivedAt: number, ...nals: Uint8Array[]): AirPlayMedia {
  const keyframe = nals.some((nal) => (nal[0] & 0x1f) === 5);
  return { kind: 'video', keyframe, replay: false, receivedAt, data: annexB(...nals) };
}

const hasBox = (data: Uint8Array, type: string) => new TextDecoder('latin1').decode(data).includes(type);

/** The decode times (tfdt) of the media segments in appended data. */
function decodeTimes(data: Uint8Array): number[] {
  const text = new TextDecoder('latin1').decode(data);
  const view = new DataView(data.buffer, data.byteOffset);
  const times: number[] = [];
  for (let at = text.indexOf('tfdt'); at >= 0; at = text.indexOf('tfdt', at + 4)) {
    times.push(view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12));
  }
  return times;
}

let video: ReturnType<typeof fakeVideo>;

beforeEach(() => {
  FakeMediaSource.instances = [];
  FakeMediaSource.supported = true;
  video = fakeVideo();
  vi.stubGlobal('URL', Object.assign(Object.create(URL), {
    createObjectURL: vi.fn(() => 'blob:airplay'),
    revokeObjectURL: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function player(onFatal = vi.fn()) {
  const created = createAirPlayVideo(video as unknown as HTMLVideoElement, {
    MediaSource: FakeMediaSource as unknown as typeof MediaSource,
    onFatal,
  });
  return { ...created, onFatal };
}

describe('frameDuration', () => {
  it('lasts until the next frame is due, going by when frames arrive', () => {
    expect(frameDuration(null, 100)).toBe(1500);
    expect(frameDuration(100, 133)).toBe(33 * 90);
    expect(frameDuration(100, 101)).toBe(8 * 90);
    expect(frameDuration(100, 5100)).toBe(100 * 90);
  });
});

describe('liveSeekTarget', () => {
  it('jumps to the newest frame when playback falls behind', () => {
    expect(liveSeekTarget(ranges([[0, 3]]), 2.8)).toBeNull();
    expect(liveSeekTarget(ranges([[0, 3]]), 1)).toBeCloseTo(2.995);
    expect(liveSeekTarget(ranges([[0, 1], [2, 4]]), 0.5)).toBeCloseTo(3.995);
    expect(liveSeekTarget(ranges([[2, 2.2]]), 0)).toBeCloseTo(2.195);
    expect(liveSeekTarget(ranges([]), 0)).toBeNull();
  });
});

describe('catchUpRate', () => {
  it('plays a little faster while behind, until nearly caught up', () => {
    expect(catchUpRate(0.05, 1)).toBe(1);
    expect(catchUpRate(0.1, 1)).toBe(1);
    expect(catchUpRate(0.2, 1)).toBe(1.25);
    expect(catchUpRate(0.1, 1.25)).toBe(1.25);
    expect(catchUpRate(0.05, 1.25)).toBe(1);
  });
});

describe('trimEnd', () => {
  it('keeps the keyframe the picture on screen was decoded from', () => {
    expect(trimEnd([0, 10, 20], 0, 25)).toBeCloseTo(19.999);
    expect(trimEnd([0, 10, 20], 0, 21)).toBeCloseTo(9.999);
    expect(trimEnd([0, 10, 20], 0, 12)).toBeNull();
    expect(trimEnd([0, 10], 8, 30)).toBeNull();
  });
});

describe('createAirPlayVideo', () => {
  it('starts at a keyframe with its parameter sets', () => {
    const { push } = player();
    push(frame(0, P_SLICE));
    push(frame(10, IDR));
    expect(FakeMediaSource.instances).toHaveLength(0);

    push(frame(20, HIGH_1080, PPS, IDR));
    expect(FakeMediaSource.instances).toHaveLength(1);
    expect(video.src).toBe('blob:airplay');
    expect(video.disableRemotePlayback).toBe(true);
    push(frame(36, P_SLICE));

    const source = FakeMediaSource.instances[0];
    source.open();
    expect(source.sourceBuffers.map((buffer) => buffer.type)).toEqual(['video/mp4; codecs="avc1.640028"']);
    const [buffer] = source.sourceBuffers;
    expect(buffer.appended).toHaveLength(1);
    expect(hasBox(buffer.appended[0], 'ftyp')).toBe(true);
    expect(decodeTimes(buffer.appended[0])).toEqual([0, 1500]);
  });

  it('appends frames that come while the browser is busy all at once', () => {
    const { push } = player();
    push(frame(0, HIGH_1080, PPS, IDR));
    FakeMediaSource.instances[0].open();
    const [buffer] = FakeMediaSource.instances[0].sourceBuffers;
    push(frame(20, P_SLICE));
    push(frame(40, P_SLICE));
    expect(buffer.appended).toHaveLength(1);
    buffer.finish();
    expect(buffer.appended).toHaveLength(2);
    expect(hasBox(buffer.appended[1], 'ftyp')).toBe(false);
    expect(decodeTimes(buffer.appended[1])).toEqual([1500, 1500 + 20 * 90]);
  });

  it('starts the picture and keeps it live', () => {
    const { push } = player();
    push(frame(0, HIGH_1080, PPS, IDR));
    FakeMediaSource.instances[0].open();
    const [buffer] = FakeMediaSource.instances[0].sourceBuffers;
    video.bufferedRanges = [[0, 0.02]];
    buffer.finish();
    expect(video.play).toHaveBeenCalled();
    expect(video.currentTime).toBe(0);

    push(frame(20, P_SLICE));
    video.bufferedRanges = [[0, 2]];
    video.currentTime = 1;
    buffer.finish();
    expect(video.currentTime).toBeCloseTo(1.995);
    expect(video.playbackRate).toBe(1);

    push(frame(40, P_SLICE));
    video.bufferedRanges = [[0, 2.3]];
    video.currentTime = 2;
    buffer.finish();
    expect(video.currentTime).toBe(2);
    expect(video.playbackRate).toBe(1.25);

    push(frame(60, P_SLICE));
    video.currentTime = 2.26;
    buffer.finish();
    expect(video.playbackRate).toBe(1);
  });

  it('frees what it has shown, back to a keyframe', () => {
    const { push } = player();
    push(frame(0, HIGH_1080, PPS, IDR));
    FakeMediaSource.instances[0].open();
    const [buffer] = FakeMediaSource.instances[0].sourceBuffers;
    buffer.finish();
    // A keyframe after 99 frames.
    for (let i = 1; i < 100; i++) push(frame(i * 100, P_SLICE));
    buffer.finish();
    push(frame(10_000, IDR));
    buffer.finish();
    video.bufferedRanges = [[0, 10.1]];
    video.currentTime = 10.09;
    push(frame(10_100, P_SLICE));
    buffer.finish();
    expect(buffer.removed).toEqual([]);

    // Well past it, what's before it goes.
    video.currentTime = 16;
    video.bufferedRanges = [[0, 16.1]];
    push(frame(10_200, P_SLICE));
    buffer.finish();
    buffer.finish();
    expect(buffer.removed).toHaveLength(1);
    expect(buffer.removed[0][0]).toBe(0);
    // The first frame lasts 1/60 s (nothing to go by yet), the others 0.1 s.
    expect(buffer.removed[0][1]).toBeCloseTo((1500 + 99 * 9000) / TIMESCALE - 0.001, 6);
  });

  it('takes a new picture size in the same buffer, and a new codec in a new one', () => {
    const { push } = player();
    push(frame(0, HIGH_1080, PPS, IDR));
    FakeMediaSource.instances[0].open();
    const [buffer] = FakeMediaSource.instances[0].sourceBuffers;
    buffer.finish();

    // Rotated: same codec, new size.
    push(frame(20, PORTRAIT, PPS, IDR));
    expect(FakeMediaSource.instances).toHaveLength(1);
    expect(hasBox(buffer.appended[1], 'ftyp')).toBe(true);
    expect(decodeTimes(buffer.appended[1])).toEqual([1500]);

    // The same parameter sets again: no new init segment.
    buffer.finish();
    push(frame(40, PORTRAIT, PPS, IDR));
    expect(hasBox(buffer.appended[2], 'ftyp')).toBe(false);

    push(frame(60, MAIN, PPS, IDR));
    expect(FakeMediaSource.instances).toHaveLength(2);
    FakeMediaSource.instances[1].open();
    const [next] = FakeMediaSource.instances[1].sourceBuffers;
    expect(next.type).toBe('video/mp4; codecs="avc1.4d001f"');
    expect(decodeTimes(next.appended[0])).toEqual([0]);
  });

  it('gives up when the browser cannot play the stream', () => {
    FakeMediaSource.supported = false;
    const { push, onFatal } = player();
    push(frame(0, HIGH_1080, PPS, IDR));
    FakeMediaSource.instances[0].open();
    expect(onFatal).toHaveBeenCalledWith(expect.stringContaining('avc1.640028'));
  });

  it('gives up when the browser refuses the data', () => {
    const { push, onFatal } = player();
    push(frame(0, HIGH_1080, PPS, IDR));
    FakeMediaSource.instances[0].open();
    const [buffer] = FakeMediaSource.instances[0].sourceBuffers;
    buffer.failWith = new DOMException('full', 'QuotaExceededError');
    push(frame(20, P_SLICE));
    buffer.finish();
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('gives up when the picture cannot be decoded', () => {
    const { push, onFatal } = player();
    push(frame(0, HIGH_1080, PPS, IDR));
    video.dispatchEvent(new Event('error'));
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('lets go of the video when closed', () => {
    const { push, close } = player();
    push(frame(0, HIGH_1080, PPS, IDR));
    FakeMediaSource.instances[0].open();
    close();
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
    expect(video.load).toHaveBeenCalled();
    push(frame(20, HIGH_1080, PPS, IDR));
    expect(FakeMediaSource.instances).toHaveLength(1);
  });

  it('ignores audio', () => {
    const { push } = player();
    push({ kind: 'audio', keyframe: false, replay: false, receivedAt: 0, data: new Uint8Array(8) });
    expect(FakeMediaSource.instances).toHaveLength(0);
  });
});

describe('fMP4 timing', () => {
  it('uses a 90 kHz timescale', () => {
    expect(TIMESCALE).toBe(90_000);
  });
});
