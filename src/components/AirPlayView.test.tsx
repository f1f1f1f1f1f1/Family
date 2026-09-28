import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AirPlayStatus } from '../api/airplay';

vi.mock('../utils/ha-env', () => ({
  isAddOn: () => true,
  getIngressBasePath: () => '/ingress',
}));

interface FakeVideoPlayer { pushed: unknown[]; closed: boolean; onFatal?: (reason: string) => void }
interface FakeAudioPlayer {
  pushed: Uint8Array[];
  closed: boolean;
  unlock: ReturnType<typeof vi.fn>;
  onBlockedChange?: (blocked: boolean) => void;
}

const players = vi.hoisted(() => ({
  canPlay: true,
  video: [] as FakeVideoPlayer[],
  audio: [] as FakeAudioPlayer[],
  suspended: 0,
}));

vi.mock('../utils/airplay-video', () => ({
  canPlayAirPlayVideo: () => players.canPlay,
  createAirPlayVideo: (_video: HTMLVideoElement, options: { onFatal?: (reason: string) => void }) => {
    const player: FakeVideoPlayer = { pushed: [], closed: false, onFatal: options.onFatal };
    players.video.push(player);
    return { push: (media: unknown) => player.pushed.push(media), close: () => { player.closed = true; } };
  },
}));

vi.mock('../utils/airplay-audio', () => ({
  createAirPlayAudio: (options: { onBlockedChange?: (blocked: boolean) => void }) => {
    const player: FakeAudioPlayer = { pushed: [], closed: false, unlock: vi.fn(async () => {}), onBlockedChange: options.onBlockedChange };
    players.audio.push(player);
    return {
      push: (pcm: Uint8Array) => player.pushed.push(pcm),
      unlock: player.unlock,
      close: () => { player.closed = true; },
      blocked: false,
    };
  },
  suspendSharedAudio: () => { players.suspended++; },
}));

import { AirPlayView } from './AirPlayView';

class FakeSocket {
  static instances: FakeSocket[] = [];
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  open() { this.onopen?.(); }
  receive(data: unknown) { this.onmessage?.({ data }); }
  drop() { this.onclose?.(); }
}

const status = (over: Partial<AirPlayStatus> = {}): AirPlayStatus => ({
  enabled: true,
  available: true,
  name: 'Family Room',
  state: 'idle',
  passwordRequired: false,
  metadata: null,
  coverVersion: 0,
  error: null,
  ...over,
});

/** A binary message as the add-on sends it. */
function message(type: number, flags: number, receivedAt: number, body: number[]): ArrayBuffer {
  const data = new Uint8Array(10 + body.length);
  const view = new DataView(data.buffer);
  view.setUint8(0, type);
  view.setUint8(1, flags);
  view.setFloat64(2, receivedAt);
  data.set(body, 10);
  return data.buffer;
}

function show(initial: AirPlayStatus | null) {
  const onStatus = vi.fn();
  const onBack = vi.fn();
  const view = render(<AirPlayView status={initial} onStatus={onStatus} onBack={onBack} />);
  const update = (next: AirPlayStatus | null) => view.rerender(<AirPlayView status={next} onStatus={onStatus} onBack={onBack} />);
  return { ...view, update, onStatus, onBack };
}

const socket = (i = 0) => FakeSocket.instances[i];
const video = () => document.querySelector('video')!;
const tapScreen = () => fireEvent.click(document.querySelector('.airplay-view')!);

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  FakeSocket.instances = [];
  players.canPlay = true;
  players.video = [];
  players.audio = [];
  players.suspended = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  act(() => setHidden(false));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AirPlayView', () => {
  it('says how to send a screen or sound to it', () => {
    show(status({ passwordRequired: true }));
    expect(screen.getByText(/Screen Mirroring/)).toBeTruthy();
    expect(screen.getAllByText(/Family Room/).length).toBeGreaterThan(0);
    expect(screen.getByText(/password/i)).toBeTruthy();
  });

  it("says why it can't take anything", () => {
    show(status({ available: false, error: 'UxPlay stopped (exit code 1)' }));
    expect(screen.getByText(/isn't running/i)).toBeTruthy();
    expect(screen.getByText('UxPlay stopped (exit code 1)')).toBeTruthy();
  });

  it('takes the stream while shown', () => {
    const { unmount } = show(status());
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket().url).toBe(`ws://${window.location.host}/ingress/beacon-action/airplay/stream`);
    expect(socket().binaryType).toBe('arraybuffer');

    unmount();
    expect(socket().close).toHaveBeenCalled();
    expect(players.video[0].closed).toBe(true);
    expect(players.audio[0].closed).toBe(true);
    expect(players.suspended).toBe(1);
  });

  it('passes on the status the stream sends', () => {
    const { onStatus } = show(status());
    act(() => socket().receive(JSON.stringify(status({ state: 'mirroring' }))));
    expect(onStatus).toHaveBeenCalledWith(status({ state: 'mirroring' }));
    act(() => socket().receive('not a status'));
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it('plays the picture and the sound', () => {
    show(status({ state: 'mirroring' }));
    act(() => {
      socket().receive(message(1, 1, 5, [0, 0, 0, 1, 0x65]));
      socket().receive(message(2, 0, 6, [1, 2, 3, 4]));
    });
    expect(players.video[0].pushed).toEqual([expect.objectContaining({ kind: 'video', keyframe: true, receivedAt: 5 })]);
    expect(players.audio[0].pushed).toEqual([new Uint8Array([1, 2, 3, 4])]);
  });

  it('shows the picture only while a screen is mirrored', () => {
    const { update } = show(status());
    expect(video().classList.contains('airplay-video--shown')).toBe(false);
    update(status({ state: 'mirroring' }));
    expect(video().classList.contains('airplay-video--shown')).toBe(true);
    expect(video().muted).toBe(true);
    expect(screen.queryByText(/Screen Mirroring/)).toBeNull();
  });

  it("says when this browser can't show a mirrored screen", () => {
    players.canPlay = false;
    show(status({ state: 'mirroring' }));
    expect(players.video).toHaveLength(0);
    expect(screen.getByText(/can't show a mirrored screen/i)).toBeTruthy();
  });

  it("shows what's playing", () => {
    show(status({ state: 'audio', metadata: { title: 'Song', artist: 'Band', album: 'Record' }, coverVersion: 3 }));
    expect(screen.getByText('Song')).toBeTruthy();
    expect(screen.getByText('Band')).toBeTruthy();
    expect(screen.getByText('Record')).toBeTruthy();
    expect(document.querySelector('.airplay-cover')?.getAttribute('src')).toBe('/ingress/beacon-action/airplay/cover?v=3');
  });

  it('asks for a tap when the browser holds the sound back', () => {
    show(status({ state: 'audio' }));
    expect(screen.queryByRole('button', { name: /tap for sound/i })).toBeNull();
    act(() => players.audio[0].onBlockedChange?.(true));
    fireEvent.click(screen.getByRole('button', { name: /tap for sound/i }));
    expect(players.audio[0].unlock).toHaveBeenCalled();
  });

  it('lets any tap turn the sound on', () => {
    show(status({ state: 'mirroring' }));
    tapScreen();
    expect(players.audio[0].unlock).toHaveBeenCalled();
  });

  it('shows the back button when the picture is tapped', () => {
    vi.useFakeTimers();
    const { onBack } = show(status({ state: 'mirroring' }));
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
    tapScreen();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalled();

    tapScreen();
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
    tapScreen();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
  });

  it('keeps the back button up while nothing is playing', () => {
    show(status());
    expect(screen.getByRole('button', { name: /back/i })).toBeTruthy();
  });

  it('reconnects, waiting longer each time it fails', () => {
    vi.useFakeTimers();
    show(status());
    act(() => socket(0).drop());
    act(() => { vi.advanceTimersByTime(999); });
    expect(FakeSocket.instances).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(FakeSocket.instances).toHaveLength(2);

    act(() => socket(1).drop());
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeSocket.instances).toHaveLength(3);

    act(() => {
      socket(2).open();
      socket(2).drop();
    });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it('starts the picture afresh when it breaks', () => {
    vi.useFakeTimers();
    show(status({ state: 'mirroring' }));
    act(() => players.video[0].onFatal?.('The picture couldn\'t be played'));
    expect(socket(0).close).toHaveBeenCalled();
    expect(players.video[0].closed).toBe(true);
    expect(screen.getByText("The picture couldn't be played")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeSocket.instances).toHaveLength(2);
    expect(players.video).toHaveLength(2);

    fireEvent.playing(video());
    expect(screen.queryByText("The picture couldn't be played")).toBeNull();
  });

  it('lets go of the stream while the page is hidden', () => {
    show(status());
    act(() => setHidden(true));
    expect(socket(0).close).toHaveBeenCalled();
    act(() => setHidden(false));
    expect(FakeSocket.instances).toHaveLength(2);
  });
});
