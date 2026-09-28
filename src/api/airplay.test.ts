import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIRPLAY_OFF,
  FLAG_KEY,
  FLAG_MORE,
  FLAG_REPLAY,
  MESSAGE_AUDIO,
  MESSAGE_VIDEO,
  airPlayCoverUrl,
  airPlayStreamUrl,
  createMediaAssembler,
  fetchAirPlayStatus,
  parseAirPlayStatus,
  type AirPlayMedia,
} from './airplay';

/** A message as airplay-relay.cjs encodeMessages() sends it. */
function message(type: number, flags: number, receivedAt: number, payload: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(10 + payload.length);
  const view = new DataView(buffer);
  view.setUint8(0, type);
  view.setUint8(1, flags);
  view.setFloat64(2, receivedAt);
  new Uint8Array(buffer, 10).set(payload);
  return buffer;
}

function collect() {
  const media: AirPlayMedia[] = [];
  return { media, push: createMediaAssembler((item) => media.push(item)) };
}

describe('parseAirPlayStatus', () => {
  it('reads what the receiver is doing', () => {
    expect(parseAirPlayStatus({
      enabled: true,
      available: true,
      name: 'Kitchen',
      state: 'audio',
      passwordRequired: true,
      metadata: { title: 'Song', artist: 'Band', album: null },
      coverVersion: 3,
      error: 'UxPlay stopped',
    })).toEqual({
      enabled: true,
      available: true,
      name: 'Kitchen',
      state: 'audio',
      passwordRequired: true,
      metadata: { title: 'Song', artist: 'Band', album: null },
      coverVersion: 3,
      error: 'UxPlay stopped',
    });
  });

  it('is off when the add-on has no receiver', () => {
    expect(parseAirPlayStatus({ enabled: false })).toEqual(AIRPLAY_OFF);
  });

  it('fills in what is missing or malformed', () => {
    expect(parseAirPlayStatus({
      enabled: true,
      available: 'yes',
      name: 7,
      state: 'dancing',
      metadata: { title: 5, artist: 'Band' },
      coverVersion: -1,
      error: {},
    })).toEqual({
      enabled: true,
      available: false,
      name: '',
      state: 'idle',
      passwordRequired: false,
      metadata: { title: null, artist: 'Band', album: null },
      coverVersion: 0,
      error: null,
    });
  });

  it('is nothing for an answer that is not a status', () => {
    expect(parseAirPlayStatus(null)).toBeNull();
    expect(parseAirPlayStatus('on')).toBeNull();
    expect(parseAirPlayStatus({ state: 'idle' })).toBeNull();
    expect(parseAirPlayStatus([])).toBeNull();
  });
});

describe('AirPlay addresses', () => {
  beforeEach(() => {
    window.__BEACON_CONFIG__ = { ha_url: '', ha_token: '', ha_available: true };
    window.history.replaceState({}, '', '/api/hassio_ingress/abc123/');
  });

  afterEach(() => {
    delete window.__BEACON_CONFIG__;
    window.history.replaceState({}, '', '/');
    vi.unstubAllGlobals();
  });

  it('go through the ingress path', () => {
    expect(airPlayCoverUrl(4)).toBe('/api/hassio_ingress/abc123/beacon-action/airplay/cover?v=4');
    expect(airPlayStreamUrl({ protocol: 'http:', host: 'ha.local:8123' }))
      .toBe('ws://ha.local:8123/api/hassio_ingress/abc123/beacon-action/airplay/stream');
    expect(airPlayStreamUrl({ protocol: 'https:', host: 'ha.example.com' }))
      .toBe('wss://ha.example.com/api/hassio_ingress/abc123/beacon-action/airplay/stream');
  });

  it('fetches the status without the cache', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ enabled: true, state: 'mirroring', name: 'Family' })));
    vi.stubGlobal('fetch', fetchMock);
    const status = await fetchAirPlayStatus();
    expect(fetchMock).toHaveBeenCalledWith('/api/hassio_ingress/abc123/beacon-action/airplay', { cache: 'no-store' });
    expect(status).toMatchObject({ enabled: true, state: 'mirroring', name: 'Family' });
  });

  it('counts a refused status as no receiver, and an unanswered one as unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    expect(await fetchAirPlayStatus()).toEqual(AIRPLAY_OFF);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    expect(await fetchAirPlayStatus()).toEqual(AIRPLAY_OFF);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    expect(await fetchAirPlayStatus()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await fetchAirPlayStatus()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>')));
    expect(await fetchAirPlayStatus()).toBeNull();
  });
});

describe('createMediaAssembler', () => {
  it('passes on a frame and its flags', () => {
    const { media, push } = collect();
    push(message(MESSAGE_VIDEO, FLAG_KEY | FLAG_REPLAY, 1234.5, [0, 0, 0, 1, 0x65]));
    expect(media).toEqual([{
      kind: 'video',
      keyframe: true,
      replay: true,
      receivedAt: 1234.5,
      data: new Uint8Array([0, 0, 0, 1, 0x65]),
    }]);
  });

  it('passes on audio', () => {
    const { media, push } = collect();
    push(message(MESSAGE_AUDIO, 0, 10, [1, 2, 3, 4]));
    expect(media).toEqual([{ kind: 'audio', keyframe: false, replay: false, receivedAt: 10, data: new Uint8Array([1, 2, 3, 4]) }]);
  });

  it('joins a frame sent in parts', () => {
    const { media, push } = collect();
    push(message(MESSAGE_VIDEO, FLAG_KEY | FLAG_MORE, 50, [1, 2]));
    push(message(MESSAGE_VIDEO, FLAG_KEY | FLAG_MORE, 50, [3]));
    expect(media).toEqual([]);
    push(message(MESSAGE_VIDEO, FLAG_KEY, 50, [4, 5]));
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ kind: 'video', keyframe: true, receivedAt: 50 });
    expect(media[0].data).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('drops a frame whose parts stop coming', () => {
    const { media, push } = collect();
    push(message(MESSAGE_VIDEO, FLAG_MORE, 50, [1, 2]));
    push(message(MESSAGE_VIDEO, 0, 60, [9]));
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ receivedAt: 60, data: new Uint8Array([9]) });
  });

  it('ignores what is not a media message', () => {
    const { media, push } = collect();
    push(new ArrayBuffer(4));
    push(message(7, 0, 1, [1]));
    expect(media).toEqual([]);
  });

  it('drops a frame over the size limit', () => {
    const media: AirPlayMedia[] = [];
    const push = createMediaAssembler((item) => media.push(item), { maxBytes: 4 });
    push(message(MESSAGE_VIDEO, FLAG_MORE, 1, [1, 2, 3]));
    push(message(MESSAGE_VIDEO, 0, 1, [4, 5]));
    push(message(MESSAGE_VIDEO, 0, 2, [6, 7, 8, 9]));
    expect(media).toHaveLength(1);
    expect(media[0].data).toEqual(new Uint8Array([6, 7, 8, 9]));
  });

  it('skips the rest of a frame dropped for its size', () => {
    const media: AirPlayMedia[] = [];
    const push = createMediaAssembler((item) => media.push(item), { maxBytes: 4 });
    push(message(MESSAGE_VIDEO, FLAG_MORE, 1, [1, 2, 3]));
    push(message(MESSAGE_VIDEO, FLAG_MORE, 1, [4, 5]));
    push(message(MESSAGE_VIDEO, 0, 1, [6]));
    expect(media).toEqual([]);
  });
});
