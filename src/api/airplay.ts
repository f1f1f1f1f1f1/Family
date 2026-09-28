import { getIngressBasePath } from '../utils/ha-env';

/**
 * The add-on's AirPlay receiver (airplay.cjs, when the add-on has UxPlay
 * and runs on the host network): its status, the cover art of what's
 * playing, and the stream the AirPlay screen shows.
 */

export type AirPlayState = 'idle' | 'connected' | 'mirroring' | 'audio';

export interface AirPlayTrack {
  title: string | null;
  artist: string | null;
  album: string | null;
}

export interface AirPlayStatus {
  /** This add-on has the receiver turned on. */
  enabled: boolean;
  /** UxPlay is running, so devices can find the receiver. */
  available: boolean;
  /** The name devices list the receiver under. */
  name: string;
  /** mirroring: showing a screen; audio: playing sound; connected: a device is connected but sends nothing. */
  state: AirPlayState;
  passwordRequired: boolean;
  metadata: AirPlayTrack | null;
  /** Moves on with each new cover; 0 when there's none. */
  coverVersion: number;
  error: string | null;
}

export const AIRPLAY_OFF: AirPlayStatus = Object.freeze({
  enabled: false,
  available: false,
  name: '',
  state: 'idle',
  passwordRequired: false,
  metadata: null,
  coverVersion: 0,
  error: null,
});

const STATES: readonly AirPlayState[] = ['idle', 'connected', 'mirroring', 'audio'];
const STATUS_PATH = '/beacon-action/airplay';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A status from the add-on (JSON from the status route or the stream), or null if it isn't one. */
export function parseAirPlayStatus(value: unknown): AirPlayStatus | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return null;
  if (!value.enabled) return AIRPLAY_OFF;
  const metadata = isRecord(value.metadata)
    ? { title: text(value.metadata.title), artist: text(value.metadata.artist), album: text(value.metadata.album) }
    : null;
  const coverVersion = value.coverVersion;
  return {
    enabled: true,
    available: value.available === true,
    name: text(value.name) ?? '',
    state: STATES.includes(value.state as AirPlayState) ? value.state as AirPlayState : 'idle',
    passwordRequired: value.passwordRequired === true,
    metadata,
    coverVersion: typeof coverVersion === 'number' && Number.isFinite(coverVersion) && coverVersion > 0 ? coverVersion : 0,
    error: text(value.error),
  };
}

/**
 * The receiver's status: AIRPLAY_OFF when the add-on has none or won't
 * say (a Kid Display, or a locked screen), null when it didn't answer.
 */
export async function fetchAirPlayStatus(): Promise<AirPlayStatus | null> {
  try {
    const res = await fetch(`${getIngressBasePath()}${STATUS_PATH}`, { cache: 'no-store' });
    if (res.status === 401 || res.status === 403 || res.status === 404) return AIRPLAY_OFF;
    if (!res.ok) return null;
    return parseAirPlayStatus(await res.json());
  } catch {
    return null;
  }
}

export function airPlayCoverUrl(version: number): string {
  return `${getIngressBasePath()}${STATUS_PATH}/cover?v=${version}`;
}

export function airPlayStreamUrl(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${getIngressBasePath()}${STATUS_PATH}/stream`;
}

// The stream's binary messages (see airplay-relay.cjs):
//   byte 0      MESSAGE_VIDEO (an H.264 access unit, Annex B) or MESSAGE_AUDIO
//               (PCM: 44.1 kHz, stereo, 16-bit big-endian)
//   byte 1      flags
//   bytes 2-9   when the add-on received it, in ms (float64, big-endian)
//   bytes 10-   the frame or audio
export const MESSAGE_VIDEO = 1;
export const MESSAGE_AUDIO = 2;
/** An IDR frame, where a decoder can start. */
export const FLAG_KEY = 0x01;
/** Sent to catch this screen up on connecting, not live. */
export const FLAG_REPLAY = 0x02;
/** Continued in the next message. */
export const FLAG_MORE = 0x80;
const HEADER_BYTES = 10;

export interface AirPlayMedia {
  kind: 'video' | 'audio';
  keyframe: boolean;
  replay: boolean;
  /** When the add-on received it, in ms on the add-on's clock. */
  receivedAt: number;
  data: Uint8Array;
}

/**
 * Takes the stream's binary messages and hands on whole frames and audio
 * chunks, joining the parts of a frame sent as several messages.
 */
export function createMediaAssembler(
  onMedia: (media: AirPlayMedia) => void,
  { maxBytes = 64 * 1024 * 1024 }: { maxBytes?: number } = {},
): (message: ArrayBuffer) => void {
  let pending: {
    type: number;
    flags: number;
    receivedAt: number;
    parts: Uint8Array[];
    bytes: number;
    /** Over maxBytes: its remaining parts are skipped. */
    dropped: boolean;
  } | null = null;

  return (message) => {
    if (message.byteLength < HEADER_BYTES) return;
    const view = new DataView(message);
    const type = view.getUint8(0);
    const flags = view.getUint8(1);
    const receivedAt = view.getFloat64(2);
    if (type !== MESSAGE_VIDEO && type !== MESSAGE_AUDIO) {
      pending = null;
      return;
    }
    const part = new Uint8Array(message, HEADER_BYTES);
    // The parts of a frame come one after the other, so anything else means the rest was lost.
    if (pending && (pending.type !== type || pending.receivedAt !== receivedAt)) pending = null;
    if (!pending) pending = { type, flags, receivedAt, parts: [], bytes: 0, dropped: false };
    if (!pending.dropped) {
      pending.bytes += part.length;
      if (pending.bytes > maxBytes) {
        pending.dropped = true;
        pending.parts = [];
      } else {
        pending.parts.push(part);
      }
    }
    if (flags & FLAG_MORE) return;

    const { parts, bytes, dropped } = pending;
    pending = null;
    if (dropped) return;
    let data: Uint8Array;
    if (parts.length === 1) {
      data = parts[0];
    } else {
      data = new Uint8Array(bytes);
      let offset = 0;
      for (const piece of parts) {
        data.set(piece, offset);
        offset += piece.length;
      }
    }
    onMedia({
      kind: type === MESSAGE_VIDEO ? 'video' : 'audio',
      keyframe: (flags & FLAG_KEY) !== 0,
      replay: (flags & FLAG_REPLAY) !== 0,
      receivedAt,
      data,
    });
  };
}
