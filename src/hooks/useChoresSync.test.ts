import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/*
 * The sync itself runs in the add-on and is tested in chores-sync.test.ts.
 * This covers the screen's side: reading the status, refreshing chore
 * data when the sync changed it, and Sync Now.
 */

const env = vi.hoisted(() => ({ addOn: true }));
vi.mock('../utils/ha-env', () => ({
  isAddOn: () => env.addOn,
  getIngressBasePath: () => '/ingress',
}));

import { useChoresSync, type ChoresSyncStatus } from './useChoresSync';
import { FAMILY_DATA_CHANGED_EVENT } from '../api/family';

let serverStatus: ChoresSyncStatus;
const requests: { method: string; url: string }[] = [];
let refreshes = 0;
const onRefresh = () => { refreshes++; };

beforeEach(() => {
  env.addOn = true;
  requests.length = 0;
  refreshes = 0;
  serverStatus = { running: false, lastSyncedAt: '2026-09-26T10:00:00Z', lastError: null, lastChangeAt: null, problems: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({ method, url });
    const body = method === 'POST' ? { ...serverStatus, outcome: 'ok', report: [] } : serverStatus;
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  window.addEventListener(FAMILY_DATA_CHANGED_EVENT, onRefresh);
});

afterEach(() => {
  window.removeEventListener(FAMILY_DATA_CHANGED_EVENT, onRefresh);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useChoresSync', () => {
  it("shows the add-on's sync status", async () => {
    const { result } = renderHook(() => useChoresSync(true));
    await waitFor(() => expect(result.current.status?.lastSyncedAt).toBe('2026-09-26T10:00:00Z'));
    expect(requests).toEqual([{ method: 'GET', url: '/ingress/beacon-action/chores-sync' }]);
    expect(refreshes).toBe(0);
  });

  it('refreshes chore data when the sync has changed it', async () => {
    // Only the hook's 30s poll is faked. (waitFor polls with setInterval,
    // so wait with real timeouts instead.)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { result } = renderHook(() => useChoresSync(true));
    await act(async () => {
      for (let i = 0; i < 50 && !result.current.status; i++) await new Promise((r) => setTimeout(r, 10));
    });
    expect(result.current.status).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(requests).toHaveLength(2);
    expect(refreshes).toBe(0); // nothing new

    serverStatus = { ...serverStatus, lastChangeAt: '2026-09-26T10:01:00Z' };
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(refreshes).toBe(1);
  });

  it('Sync Now asks the add-on for a pass and shows the result', async () => {
    const { result } = renderHook(() => useChoresSync(true));
    serverStatus = { ...serverStatus, lastSyncedAt: '2026-09-26T10:05:00Z' };
    await act(async () => { await result.current.runSync(); });
    expect(requests.some((r) => r.method === 'POST' && r.url === '/ingress/beacon-action/chores-sync')).toBe(true);
    expect(result.current.status?.lastSyncedAt).toBe('2026-09-26T10:05:00Z');
  });

  it("doesn't poll while sync is off, or outside the add-on", async () => {
    renderHook(() => useChoresSync(false));
    env.addOn = false;
    const { result } = renderHook(() => useChoresSync(true));
    await Promise.resolve();
    expect(requests).toEqual([]);
    expect(result.current.available).toBe(false);
  });
});
