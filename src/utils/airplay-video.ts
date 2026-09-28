import type { AirPlayMedia } from '../api/airplay';
import {
  NAL_IDR,
  NAL_PPS,
  NAL_SPS,
  TIMESCALE,
  avccSample,
  initSegment,
  mediaSegment,
  parseSps,
  splitAnnexB,
  type VideoConfig,
} from './fmp4';

/**
 * Shows a mirrored screen: each H.264 frame from the add-on goes into a
 * <video> through Media Source Extensions as a fragment of MP4 (fmp4.ts).
 *
 * A mirrored screen sends frames only when its picture changes, so a
 * frame lasts until the next one is due going by how they have been
 * arriving; when nothing new comes, the video waits on its last frame and
 * carries on when the next comes. It's kept to the newest frame: a little
 * behind (after a burst of frames), it plays faster for a moment; further
 * behind (catching up on connecting), it jumps.
 *
 * WebCodecs would skip the MP4 wrapping but needs a secure context, and
 * Home Assistant is often opened over plain http at home.
 */

type MediaSourceConstructor = typeof MediaSource;

/** ManagedMediaSource (Safari on iPhone, 17.1 on) or MediaSource, or null. */
export function findMediaSource(scope: object = window): MediaSourceConstructor | null {
  const found = scope as { ManagedMediaSource?: MediaSourceConstructor; MediaSource?: MediaSourceConstructor };
  return found.ManagedMediaSource ?? found.MediaSource ?? null;
}

/** Whether this browser can show a mirrored screen. */
export function canPlayAirPlayVideo(scope: object = window): boolean {
  try {
    return findMediaSource(scope)?.isTypeSupported('video/mp4; codecs="avc1.640028"') ?? false;
  } catch {
    return false;
  }
}

const DEFAULT_FRAME_MS = 1000 / 60;
const MIN_FRAME_MS = 8;
const MAX_FRAME_MS = 100;
/** Behind the newest frame by more than this, playback jumps to it. */
const MAX_LAG_S = 0.5;
/** Behind by more than this, it plays a little faster to catch up… */
const CATCH_UP_S = 0.15;
/** …until it's this close. */
const CAUGHT_UP_S = 0.06;
const CATCH_UP_RATE = 1.25;
/** Where a jump lands: inside the newest frame (frames last at least MIN_FRAME_MS). */
const LIVE_EDGE_S = 0.005;
/** Shown frames are freed once playback is this far past a later keyframe… */
const KEEP_BEHIND_S = 3;
/** …and there are at least this many seconds of them. */
const MIN_TRIM_S = 5;

/** How long a frame lasts (TIMESCALE units): as long as the gap since the previous one. */
export function frameDuration(previousAt: number | null, receivedAt: number): number {
  const ms = previousAt === null
    ? DEFAULT_FRAME_MS
    : Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, receivedAt - previousAt));
  return Math.round(ms * TIMESCALE / 1000);
}

interface Ranges {
  length: number;
  start(index: number): number;
  end(index: number): number;
}

/** Where to jump to reach the newest frame, or null if playback is close enough. */
export function liveSeekTarget(buffered: Ranges, currentTime: number): number | null {
  if (!buffered.length) return null;
  const start = buffered.start(buffered.length - 1);
  const end = buffered.end(buffered.length - 1);
  if (currentTime >= start && end - currentTime <= MAX_LAG_S) return null;
  return Math.max(start, end - LIVE_EDGE_S);
}

/**
 * How fast to play, given how far behind the newest frame playback is: a
 * burst of frames would otherwise leave the picture that far behind for good.
 */
export function catchUpRate(lag: number, currentRate: number): number {
  if (lag > CATCH_UP_S) return CATCH_UP_RATE;
  if (lag < CAUGHT_UP_S) return 1;
  return currentRate === CATCH_UP_RATE ? CATCH_UP_RATE : 1;
}

/**
 * Up to where shown frames can be freed: just before the newest keyframe
 * playback is well past, as frames after it are decoded from it. Null
 * when that's too little to bother.
 */
export function trimEnd(keyframeTimes: number[], bufferedStart: number, currentTime: number): number | null {
  let keyframe: number | null = null;
  for (const time of keyframeTimes) {
    if (currentTime - time >= KEEP_BEHIND_S) keyframe = time;
  }
  if (keyframe === null || keyframe - bufferedStart < MIN_TRIM_S) return null;
  return keyframe - 0.001;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface AirPlayVideoPlayer {
  push(media: AirPlayMedia): void;
  close(): void;
}

export interface AirPlayVideoOptions {
  MediaSource?: MediaSourceConstructor | null;
  /** The picture can't go on here; a fresh start (reconnecting) may work. */
  onFatal?: (reason: string) => void;
}

export function createAirPlayVideo(
  video: HTMLVideoElement,
  { MediaSource: Source = findMediaSource(), onFatal = () => {} }: AirPlayVideoOptions = {},
): AirPlayVideoPlayer {
  let closed = false;
  let config: (VideoConfig & { codec: string }) | null = null;
  let source: MediaSource | null = null;
  let buffer: SourceBuffer | null = null;
  let objectUrl: string | null = null;
  let queue: Uint8Array[] = [];
  let pendingRemove: [number, number] | null = null;
  let trimmedTo = 0;
  let keyframeTimes: number[] = [];
  let decodeTime = 0;
  let sequence = 1;
  let lastReceivedAt: number | null = null;
  let waitingForKey = true;

  function fatal(reason: string) {
    if (closed) return;
    close();
    onFatal(reason);
  }

  function onVideoError() {
    const error = video.error;
    fatal(`The picture couldn't be played${error ? ` (${error.message || `error ${error.code}`})` : ''}`);
  }
  video.addEventListener('error', onVideoError);

  function detach() {
    buffer?.removeEventListener('updateend', onUpdateEnd);
    buffer = null;
    source = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  /** A new MediaSource for this configuration, its timeline from 0. */
  function start(next: VideoConfig & { codec: string }) {
    detach();
    if (!Source) {
      fatal("This browser can't show AirPlay video");
      return;
    }
    config = next;
    queue = [initSegment(next)];
    pendingRemove = null;
    trimmedTo = 0;
    keyframeTimes = [];
    decodeTime = 0;
    sequence = 1;
    lastReceivedAt = null;
    const created = new Source();
    source = created;
    created.addEventListener('sourceopen', () => {
      if (source !== created || closed) return;
      try {
        created.duration = Infinity;
      } catch { /* the default is fine */ }
      const type = `video/mp4; codecs="${next.codec}"`;
      if (!Source.isTypeSupported(type)) {
        fatal(`This browser can't play this AirPlay video (${next.codec})`);
        return;
      }
      try {
        buffer = created.addSourceBuffer(type);
      } catch (err) {
        fatal(`This browser can't play this AirPlay video (${err instanceof Error ? err.message : next.codec})`);
        return;
      }
      buffer.addEventListener('updateend', onUpdateEnd);
      pump();
    }, { once: true });
    // Safari's ManagedMediaSource only plays in a video that can't be sent on over AirPlay.
    video.disableRemotePlayback = true;
    objectUrl = URL.createObjectURL(created);
    video.src = objectUrl;
  }

  function pump() {
    if (!buffer || buffer.updating || closed) return;
    try {
      if (pendingRemove) {
        const [from, to] = pendingRemove;
        pendingRemove = null;
        buffer.remove(from, to);
        return;
      }
      if (queue.length) {
        const data = concat(queue);
        queue = [];
        buffer.appendBuffer(data as Uint8Array<ArrayBuffer>);
      }
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      fatal(name === 'QuotaExceededError'
        ? 'The picture is too much for this screen to hold'
        : `The picture couldn't be played (${err instanceof Error ? err.message : 'error'})`);
    }
  }

  function keepLive() {
    const { buffered } = video;
    if (!buffered.length) return;
    const target = liveSeekTarget(buffered, video.currentTime);
    if (target !== null && !video.seeking) video.currentTime = target;
    const rate = catchUpRate(buffered.end(buffered.length - 1) - (target ?? video.currentTime), video.playbackRate);
    if (video.playbackRate !== rate) video.playbackRate = rate;
    if (video.paused) video.play().catch(() => {});
    const end = trimEnd(keyframeTimes, Math.max(buffered.start(0), trimmedTo), video.currentTime);
    if (end !== null && !pendingRemove) {
      pendingRemove = [buffered.start(0), end];
      trimmedTo = end;
      keyframeTimes = keyframeTimes.filter((time) => time > end);
    }
  }

  function onUpdateEnd() {
    if (closed) return;
    keepLive();
    pump();
  }

  function push(media: AirPlayMedia) {
    if (closed || media.kind !== 'video') return;
    const nals = splitAnnexB(media.data);
    let sps: Uint8Array | null = null;
    let pps: Uint8Array | null = null;
    let keyframe = media.keyframe;
    for (const nal of nals) {
      const type = nal[0] & 0x1f;
      if (type === NAL_SPS) sps = nal;
      else if (type === NAL_PPS) pps = nal;
      else if (type === NAL_IDR) keyframe = true;
    }

    if (sps && pps && (!config || !sameBytes(sps, config.sps) || !sameBytes(pps, config.pps))) {
      const parsed = parseSps(sps);
      if (parsed) {
        const next = { sps: sps.slice(), pps: pps.slice(), ...parsed };
        if (!config || !source || next.codec !== config.codec) {
          start(next);
          if (closed) return;
          waitingForKey = true;
        } else {
          // A new picture size (the device turned): same codec, same buffer.
          config = next;
          queue.push(initSegment(next));
        }
      }
    }
    if (!config) return;
    if (waitingForKey) {
      if (!keyframe) return;
      waitingForKey = false;
    }

    const data = avccSample(nals);
    if (!data.length) return;
    const duration = frameDuration(lastReceivedAt, media.receivedAt);
    lastReceivedAt = media.receivedAt;
    if (keyframe) keyframeTimes.push(decodeTime / TIMESCALE);
    queue.push(mediaSegment(sequence++, decodeTime, [{ data, duration, keyframe }]));
    decodeTime += duration;
    pump();
  }

  function close() {
    if (closed) return;
    closed = true;
    video.removeEventListener('error', onVideoError);
    detach();
    queue = [];
    video.removeAttribute('src');
    video.load();
  }

  return { push, close };
}
