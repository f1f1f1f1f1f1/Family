import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { AirPlayState, AirPlayStatus } from './api/airplay';

// App with Home Assistant connected, and an AirPlay receiver whose status
// each test sets.
const mocks = vi.hoisted(() => {
  let status: AirPlayStatus | null = null;
  const listeners = new Set<() => void>();
  return {
    calendarEvents: {
      calendars: [],
      events: [] as unknown[],
      loading: false,
      fetchCalendars: async () => [],
      fetchEvents: async () => {},
      createEvent: async () => {},
      updateEvent: async () => {},
      deleteEvent: async () => {},
    },
    homeAssistant: { client: () => null, connected: true },
    auth: {
      state: { isOnboarded: true, loading: false, haUrl: '', haToken: '' },
      saveManualToken: async () => {},
      logout: async () => {},
    },
    tasks: { items: [], toggleItem: async () => {}, users: [] },
    airplay: {
      get: () => status,
      set(next: AirPlayStatus | null) {
        status = next;
        listeners.forEach((listener) => listener());
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
  };
});

vi.mock('./hooks/useHomeAssistant', () => ({ useHomeAssistant: () => mocks.homeAssistant }));
vi.mock('./hooks/useHaAuth', () => ({ useHaAuth: () => mocks.auth }));
vi.mock('./hooks/useCalendarEvents', () => ({
  CalendarNotSupportedError: class extends Error {},
  useCalendarEvents: () => mocks.calendarEvents,
}));
vi.mock('./hooks/useDashboardTasks', () => ({ useDashboardTasks: () => mocks.tasks }));
vi.mock('./hooks/useNotifications', () => ({ useNotifications: () => {} }));
vi.mock('./hooks/useAirPlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hooks/useAirPlay')>();
  const { useSyncExternalStore } = await import('react');
  return {
    ...actual,
    useAirPlayStatus: () => ({
      status: useSyncExternalStore(mocks.airplay.subscribe, mocks.airplay.get),
      report: mocks.airplay.set,
    }),
  };
});
vi.mock('./components/AirPlayView', () => ({
  AirPlayView: ({ onBack }: { onBack: () => void }) => (
    <button type="button" onClick={onBack}>Leave AirPlay</button>
  ),
}));
vi.mock('./components/ScreenSaver', () => ({
  ScreenSaver: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="screen-saver" data-enabled={String(enabled)} />
  ),
}));

import { App } from './App';
import { resetStoredData } from './hooks/useStoredData';

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

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const send = async (status: AirPlayStatus | null) => {
  act(() => mocks.airplay.set(status));
  await settle();
};

const airPlayScreen = () => screen.queryByRole('button', { name: 'Leave AirPlay' });
const screenSaverOn = () => screen.getByTestId('screen-saver').dataset.enabled === 'true';
const sidebarButton = (name: string) =>
  document.querySelector<HTMLElement>(`.sidebar--desktop button[aria-label="${name}"]`);

let wakeLock: { request: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

beforeEach(() => {
  resetStoredData();
  mocks.airplay.set(null);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const release = vi.fn(async () => {});
  wakeLock = {
    release,
    request: vi.fn(async () => ({ release, addEventListener: () => {} })),
  };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: wakeLock });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { wakeLock?: unknown }).wakeLock;
});

describe('App: AirPlay', () => {
  it("offers the AirPlay screen only while the add-on's receiver is on", async () => {
    render(<App />);
    await settle();
    expect(sidebarButton('AirPlay')).toBeNull();

    await send(on());
    expect(sidebarButton('AirPlay')).not.toBeNull();

    await send({ ...on(), enabled: false });
    expect(sidebarButton('AirPlay')).toBeNull();
  });

  it('opens AirPlay while a phone mirrors to it, awake and without the screen saver, then goes back', async () => {
    render(<App />);
    await settle();
    fireEvent.click(sidebarButton('Calendar')!);
    await send(on());
    expect(wakeLock.request).not.toHaveBeenCalled();

    await send(on('mirroring'));
    expect(airPlayScreen()).not.toBeNull();
    expect(wakeLock.request).toHaveBeenCalledWith('screen');
    expect(screenSaverOn()).toBe(false);

    await send(on('idle'));
    expect(airPlayScreen()).toBeNull();
    expect(sidebarButton('Calendar')!.classList.contains('sidebar-icon--active')).toBe(true);
    expect(wakeLock.release).toHaveBeenCalled();
    expect(screenSaverOn()).toBe(true);
  });

  it("stays put on a display that's set not to open it", async () => {
    localStorage.setItem('beacon_airplay_auto_open', 'off');
    render(<App />);
    await settle();
    await send(on());
    await send(on('audio'));
    expect(airPlayScreen()).toBeNull();
    expect(screenSaverOn()).toBe(true);
    expect(wakeLock.request).not.toHaveBeenCalled();
  });

  it('can be left while the phone is still sending, and not reopened by it', async () => {
    render(<App />);
    await settle();
    await send(on());
    await send(on('mirroring'));
    fireEvent.click(airPlayScreen()!);
    await settle();
    expect(airPlayScreen()).toBeNull();
    expect(sidebarButton('Dashboard')!.classList.contains('sidebar-icon--active')).toBe(true);
    expect(screenSaverOn()).toBe(true);

    await send({ ...on('mirroring'), name: 'Family room' });
    expect(airPlayScreen()).toBeNull();
  });

  it("changes only this display's choice from Settings", async () => {
    render(<App />);
    await settle();
    await send(on());
    fireEvent.click(sidebarButton('Settings')!);
    fireEvent.click(await screen.findByText('Display', {}, { timeout: 5000 }));
    const row = screen.getByText('Open AirPlay Automatically').closest<HTMLElement>('.settings-row')!;
    fireEvent.click(row.querySelector('input')!);
    expect(localStorage.getItem('beacon_airplay_auto_open')).toBe('off');
    expect(JSON.parse(localStorage.getItem('beacon-settings') ?? '{}')).not.toHaveProperty('airplayAutoOpen');
  });
});
