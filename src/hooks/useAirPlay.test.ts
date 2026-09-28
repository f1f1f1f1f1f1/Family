import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ addOn: true }));
vi.mock('../utils/ha-env', () => ({
  isAddOn: () => env.addOn,
  getIngressBasePath: () => '/ingress',
}));

import { AIRPLAY_OFF, type AirPlayState, type AirPlayStatus } from '../api/airplay';
import type { SidebarView } from '../components/Sidebar';
import { isAirPlayStreaming, useAirPlayAutoOpen, useAirPlayAutoOpenSetting, useAirPlayStatus } from './useAirPlay';

const on = (state: AirPlayState = 'idle'): AirPlayStatus => ({
  enabled: true,
  available: true,
  name: 'Family',
  state,
  passwordRequired: false,
  metadata: null,
  coverVersion: 0,
  error: null,
});

let serverStatus: unknown;
let answer: () => Response;
let requests: string[];

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  env.addOn = true;
  requests = [];
  serverStatus = on();
  answer = () => new Response(JSON.stringify(serverStatus), { status: 200 });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url);
    return answer();
  }));
});

afterEach(() => {
  setHidden(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isAirPlayStreaming', () => {
  it('is on while a screen or sound is coming in', () => {
    expect(isAirPlayStreaming(on('mirroring'))).toBe(true);
    expect(isAirPlayStreaming(on('audio'))).toBe(true);
    expect(isAirPlayStreaming(on('connected'))).toBe(false);
    expect(isAirPlayStreaming(on('idle'))).toBe(false);
    expect(isAirPlayStreaming(AIRPLAY_OFF)).toBe(false);
    expect(isAirPlayStreaming(null)).toBe(false);
  });
});

describe('useAirPlayStatus', () => {
  it("reads the add-on's receiver, often while it's on", async () => {
    const { result } = renderHook(() => useAirPlayStatus());
    await wait(0);
    expect(requests).toEqual(['/ingress/beacon-action/airplay']);
    expect(result.current.status).toEqual(on());

    serverStatus = on('mirroring');
    await wait(3000);
    expect(requests).toHaveLength(2);
    expect(result.current.status?.state).toBe('mirroring');
  });

  it("checks rarely while it's off", async () => {
    serverStatus = { enabled: false };
    const { result } = renderHook(() => useAirPlayStatus());
    await wait(0);
    expect(result.current.status).toEqual(AIRPLAY_OFF);
    await wait(60_000);
    expect(requests).toHaveLength(1);
    await wait(4 * 60_000);
    expect(requests).toHaveLength(2);
  });

  it("keeps what it knew when the add-on doesn't answer", async () => {
    const { result } = renderHook(() => useAirPlayStatus());
    await wait(0);
    answer = () => new Response('', { status: 502 });
    await wait(3000);
    expect(requests).toHaveLength(2);
    expect(result.current.status).toEqual(on());
  });

  it('asks again soon when it has never had an answer', async () => {
    answer = () => new Response('', { status: 502 });
    const { result } = renderHook(() => useAirPlayStatus());
    await wait(0);
    expect(result.current.status).toBeNull();
    await wait(29_000);
    expect(requests).toHaveLength(1);
    await wait(1000);
    expect(requests).toHaveLength(2);
  });

  it('waits while the page is hidden, and asks as soon as it is shown', async () => {
    renderHook(() => useAirPlayStatus());
    await wait(0);
    setHidden(true);
    await wait(30_000);
    expect(requests).toHaveLength(1);
    setHidden(false);
    await wait(0);
    expect(requests).toHaveLength(2);
    await wait(3000);
    expect(requests).toHaveLength(3);
  });

  it('takes the status the AirPlay screen gets from its stream', async () => {
    const { result } = renderHook(() => useAirPlayStatus());
    await wait(0);
    act(() => result.current.report(on('audio')));
    expect(result.current.status?.state).toBe('audio');
  });

  it('pauses while the Kid Display is shown instead of the app', async () => {
    const { rerender } = renderHook(({ active }) => useAirPlayStatus(active), { initialProps: { active: false } });
    await wait(60_000);
    expect(requests).toEqual([]);
    rerender({ active: true });
    await wait(0);
    expect(requests).toHaveLength(1);
    rerender({ active: false });
    await wait(60_000);
    expect(requests).toHaveLength(1);
  });

  it("doesn't ask outside the add-on", async () => {
    env.addOn = false;
    const { result } = renderHook(() => useAirPlayStatus());
    await wait(10 * 60_000);
    expect(requests).toEqual([]);
    expect(result.current.status).toBeNull();
  });
});

describe('useAirPlayAutoOpen', () => {
  function screen(initialView: SidebarView = 'calendar', autoOpen = true) {
    const changeView = vi.fn();
    const hook = renderHook(
      ({ status, view, auto }) => useAirPlayAutoOpen(status, view, changeView, auto),
      { initialProps: { status: on() as AirPlayStatus | null, view: initialView, auto: autoOpen } },
    );
    let view = initialView;
    const show = (status: AirPlayStatus | null, nextView = view, auto = autoOpen) => {
      view = nextView;
      hook.rerender({ status, view, auto });
    };
    return { changeView, show };
  }

  it('opens when something is sent, and goes back when it ends', () => {
    const { changeView, show } = screen('calendar');
    show(on('mirroring'));
    expect(changeView).toHaveBeenLastCalledWith('airplay');
    show(on('mirroring'), 'airplay');
    show(on('connected'), 'airplay');
    expect(changeView).toHaveBeenCalledTimes(1);
    show(on('idle'), 'airplay');
    expect(changeView).toHaveBeenLastCalledWith('calendar');
  });

  it('stays where someone has gone since', () => {
    const { changeView, show } = screen('calendar');
    show(on('audio'));
    show(on('audio'), 'airplay');
    show(on('audio'), 'chores');
    show(on('idle'), 'chores');
    expect(changeView).toHaveBeenCalledTimes(1);
  });

  it('stays on the AirPlay screen opened by hand', () => {
    const { changeView, show } = screen('airplay');
    show(on('mirroring'), 'airplay');
    show(on('idle'), 'airplay');
    expect(changeView).not.toHaveBeenCalled();
  });

  it("doesn't open with the setting off", () => {
    const { changeView, show } = screen('calendar', false);
    show(on('mirroring'));
    expect(changeView).not.toHaveBeenCalled();
  });

  it('leaves the AirPlay screen when AirPlay is turned off', () => {
    const { changeView, show } = screen('airplay');
    show(AIRPLAY_OFF, 'airplay');
    expect(changeView).toHaveBeenLastCalledWith('dashboard');
  });

  it("doesn't count an unanswered check as the end", () => {
    const { changeView, show } = screen('calendar');
    show(on('mirroring'));
    show(on('mirroring'), 'airplay');
    show(null, 'airplay');
    expect(changeView).toHaveBeenCalledTimes(1);
  });
});

describe('useAirPlayAutoOpenSetting', () => {
  it('is on until this display turns it off, and remembers', () => {
    const first = renderHook(() => useAirPlayAutoOpenSetting());
    expect(first.result.current[0]).toBe(true);
    act(() => first.result.current[1](false));
    expect(first.result.current[0]).toBe(false);
    first.unmount();

    const next = renderHook(() => useAirPlayAutoOpenSetting());
    expect(next.result.current[0]).toBe(false);
    act(() => next.result.current[1](true));
    next.unmount();
    expect(renderHook(() => useAirPlayAutoOpenSetting()).result.current[0]).toBe(true);
  });

  it("stays with this display, out of the settings every display shares", () => {
    const { result } = renderHook(() => useAirPlayAutoOpenSetting());
    act(() => result.current[1](false));
    expect(localStorage.getItem('beacon-settings')).toBeNull();
    expect(localStorage.length).toBe(1);
  });

  it('still works for this visit without storage', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      const { result } = renderHook(() => useAirPlayAutoOpenSetting());
      expect(result.current[0]).toBe(true);
      act(() => result.current[1](false));
      expect(result.current[0]).toBe(false);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
