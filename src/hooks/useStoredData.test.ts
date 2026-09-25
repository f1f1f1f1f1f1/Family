import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const server = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  saves: [] as { key: string; value: unknown }[],
  patches: [] as { key: string; patch: unknown }[],
}));

vi.mock('../api/beacon-store', () => ({
  loadDataSync: (key: string, fallback: unknown) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  },
  loadData: async (key: string, fallback: unknown) => (server.data.has(key) ? server.data.get(key) : fallback),
  saveData: async (key: string, value: unknown) => {
    server.saves.push({ key, value });
    server.data.set(key, value);
  },
  saveDataPatch: async (key: string, patch: object) => {
    server.patches.push({ key, patch });
    server.data.set(key, { ...(server.data.get(key) as object), ...patch });
  },
}));

import { useStoredData } from './useStoredData';
import { useSettings } from './useSettings';

beforeEach(() => {
  server.data.clear();
  server.saves = [];
  server.patches = [];
});

describe('useStoredData', () => {
  it('never writes a stale local copy back to the server on load', async () => {
    localStorage.setItem('k', JSON.stringify(['stale']));
    server.data.set('k', ['newer from another device']);
    const { result } = renderHook(() => useStoredData<string[]>('k', []));
    expect(result.current[0]).toEqual(['stale']);
    await waitFor(() => expect(result.current[0]).toEqual(['newer from another device']));
    expect(server.saves).toEqual([]);
    expect(server.data.get('k')).toEqual(['newer from another device']);
  });

  it('saves changes made through update', async () => {
    server.data.set('k', ['a']);
    const { result } = renderHook(() => useStoredData<string[]>('k', []));
    await waitFor(() => expect(result.current[0]).toEqual(['a']));
    act(() => { result.current[1]((prev) => [...prev, 'b']); });
    expect(result.current[0]).toEqual(['a', 'b']);
    expect(server.saves).toEqual([{ key: 'k', value: ['a', 'b'] }]);
  });
});

describe('useSettings', () => {
  it('sends only the changed fields, keeping settings changed on another device', async () => {
    localStorage.setItem('beacon-settings', JSON.stringify({ familyName: 'Stale', timeFormat: '12h' }));
    const { result } = renderHook(() => useSettings());
    // Another device changes the time format before this one refreshes.
    server.data.set('beacon-settings', { familyName: 'Stale', timeFormat: '24h' });
    act(() => { result.current.updateSettings({ familyName: 'Smiths' }); });
    expect(server.patches).toEqual([{ key: 'beacon-settings', patch: { familyName: 'Smiths' } }]);
    expect(server.data.get('beacon-settings')).toEqual({ familyName: 'Smiths', timeFormat: '24h' });
    expect(server.saves).toEqual([]);
  });
});
