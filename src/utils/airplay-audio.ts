/**
 * Plays the sound from AirPlay: the add-on sends it as it arrives, 16-bit
 * big-endian stereo PCM at 44.1 kHz, and it's played through Web Audio in
 * short chunks queued one after another.
 *
 * Sound runs a little behind (START_AHEAD_S) so a late message doesn't
 * leave a gap. When it falls too far behind, chunks are dropped to catch up.
 *
 * Browsers only let a page play sound after a tap on it. When that's
 * holding the sound back, `blocked` is set and `unlock()`, called from a
 * tap, lets it play.
 */

export const SAMPLE_RATE = 44100;
/** Frames per chunk, about 23 ms. */
export const CHUNK_FRAMES = 1024;
const START_AHEAD_S = 0.12;
const MIN_AHEAD_S = 0.02;
const MAX_AHEAD_S = 0.5;
/** Still not playing this long after asking, the sound needs a tap. */
const BLOCKED_AFTER_MS = 300;

/** 16-bit big-endian interleaved stereo → left and right channels. */
export function pcmToChannels(data: Uint8Array): [Float32Array, Float32Array] {
  const frames = Math.floor(data.length / 4);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < frames; i++) {
    left[i] = view.getInt16(i * 4) / 32768;
    right[i] = view.getInt16(i * 4 + 2) / 32768;
  }
  return [left, right];
}

/**
 * When a chunk plays: right after the last one, or a little ahead of now
 * when that's already passed. Null when it would play too late to keep up.
 */
export function scheduleChunk(nextTime: number, now: number, duration: number): { start: number; next: number } | null {
  let start = nextTime;
  if (start < now + MIN_AHEAD_S) start = now + START_AHEAD_S;
  else if (start > now + MAX_AHEAD_S) return null;
  return { start, next: start + duration };
}

let shared: AudioContext | null | undefined;

/**
 * One AudioContext for the page: once a tap has let it play, it keeps
 * being allowed to, which a new one wouldn't be in Safari.
 */
export function sharedAudioContext(): AudioContext | null {
  if (shared !== undefined) return shared;
  const Context = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  shared = null;
  if (!Context) return shared;
  try {
    shared = new Context({ sampleRate: SAMPLE_RATE });
  } catch {
    try {
      shared = new Context();
    } catch { /* no sound then */ }
  }
  return shared;
}

/** Lets the sound hardware rest while nothing is streaming. */
export function suspendSharedAudio(): void {
  if (shared && shared.state === 'running') shared.suspend().catch(() => {});
}

export interface AirPlayAudioPlayer {
  push(pcm: Uint8Array): void;
  /** Call from a tap: lets the browser play the sound. */
  unlock(): Promise<void>;
  close(): void;
  /** The browser is holding the sound back until the screen is tapped. */
  readonly blocked: boolean;
}

export interface AirPlayAudioOptions {
  context?: () => AudioContext | null;
  onBlockedChange?: (blocked: boolean) => void;
}

export function createAirPlayAudio(
  { context: getContext = sharedAudioContext, onBlockedChange = () => {} }: AirPlayAudioOptions = {},
): AirPlayAudioPlayer {
  let closed = false;
  let context: AudioContext | null = null;
  let askedToResume = false;
  let blocked = false;
  let blockedTimer: ReturnType<typeof setTimeout> | undefined;
  let nextTime = 0;
  const left = new Float32Array(CHUNK_FRAMES);
  const right = new Float32Array(CHUNK_FRAMES);
  let filled = 0;
  const playing = new Set<AudioBufferSourceNode>();

  function setBlocked(value: boolean) {
    if (value === blocked) return;
    blocked = value;
    onBlockedChange(value);
  }

  function checkBlocked() {
    if (closed || !context) return;
    clearTimeout(blockedTimer);
    setBlocked(context.state !== 'running');
  }

  function onStateChange() {
    if (!closed && context?.state === 'running') checkBlocked();
  }

  function ensureContext(): AudioContext | null {
    if (!context) {
      context = getContext();
      context?.addEventListener('statechange', onStateChange);
    }
    return context;
  }

  function askToResume(ctx: AudioContext) {
    if (askedToResume) return;
    askedToResume = true;
    // Safari leaves the promise pending when it won't play, hence the timer too.
    blockedTimer = setTimeout(checkBlocked, BLOCKED_AFTER_MS);
    ctx.resume().then(checkBlocked, checkBlocked);
  }

  function playChunk(ctx: AudioContext) {
    const slot = scheduleChunk(nextTime, ctx.currentTime, CHUNK_FRAMES / SAMPLE_RATE);
    if (!slot) return;
    const buffer = ctx.createBuffer(2, CHUNK_FRAMES, SAMPLE_RATE);
    buffer.getChannelData(0).set(left);
    buffer.getChannelData(1).set(right);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => playing.delete(source);
    source.start(slot.start);
    playing.add(source);
    nextTime = slot.next;
  }

  return {
    get blocked() {
      return blocked;
    },

    push(pcm) {
      if (closed) return;
      const ctx = ensureContext();
      if (!ctx) return;
      if (ctx.state !== 'running') {
        askToResume(ctx);
        filled = 0;
        return;
      }
      const [l, r] = pcmToChannels(pcm);
      for (let offset = 0; offset < l.length;) {
        const count = Math.min(CHUNK_FRAMES - filled, l.length - offset);
        left.set(l.subarray(offset, offset + count), filled);
        right.set(r.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === CHUNK_FRAMES) {
          playChunk(ctx);
          filled = 0;
        }
      }
    },

    async unlock() {
      const ctx = ensureContext();
      if (!ctx || closed) return;
      askedToResume = true;
      // WebKit wants something played from the tap itself, before any await.
      try {
        const source = ctx.createBufferSource();
        source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate || SAMPLE_RATE);
        source.connect(ctx.destination);
        source.start(0);
      } catch { /* resume() alone may do */ }
      try {
        await ctx.resume();
      } catch { /* stays blocked */ }
      checkBlocked();
    },

    close() {
      if (closed) return;
      closed = true;
      clearTimeout(blockedTimer);
      context?.removeEventListener('statechange', onStateChange);
      for (const source of playing) {
        try {
          source.stop();
        } catch { /* already over */ }
      }
      playing.clear();
    },
  };
}
