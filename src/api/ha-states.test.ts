import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchAllStates, resetStatesCache } from './ha-rest';
import { getMediaPlayers, refreshMediaPlayers } from './music';

/*
 * Counts requests by path through a stubbed global fetch, so the tests can
 * check how many full /api/states downloads happen.
 */
const requests: string[] = [];
const states = [
  { entity_id: 'media_player.kitchen', state: 'playing', attributes: { friendly_name: 'Kitchen' } },
  { entity_id: 'media_player.lounge', state: 'idle', attributes: { friendly_name: 'Lounge' } },
  { entity_id: 'light.porch', state: 'on', attributes: {} },
];

beforeEach(() => {
  requests.length = 0;
  resetStatesCache();
  (window as unknown as { __BEACON_CONFIG__?: object }).__BEACON_CONFIG__ = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://ha.local').pathname.replace(/^.*?(\/api\/)/, '/api/');
    requests.push(path);
    const body = path === '/api/states'
      ? states
      : states.find((s) => `/api/states/${s.entity_id}` === path) ?? null;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (window as unknown as { __BEACON_CONFIG__?: object }).__BEACON_CONFIG__;
});

const fullDownloads = () => requests.filter((p) => p === '/api/states').length;

describe('fetchAllStates', () => {
  it('shares one download between callers that ask at the same time', async () => {
    const results = await Promise.all([fetchAllStates(), fetchAllStates(), fetchAllStates()]);
    expect(fullDownloads()).toBe(1);
    expect(results[0]).toHaveLength(3);
    expect(results[1]).toBe(results[0]);
  });

  it('reuses a recent copy and downloads again once it is older than maxAge', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
    await fetchAllStates(10_000);
    vi.setSystemTime(new Date('2026-09-25T10:00:05Z'));
    await fetchAllStates(10_000);
    expect(fullDownloads()).toBe(1);
    vi.setSystemTime(new Date('2026-09-25T10:00:11Z'));
    await fetchAllStates(10_000);
    expect(fullDownloads()).toBe(2);
  });
});

describe('refreshMediaPlayers', () => {
  it('polls only the players found by discovery, not every entity', async () => {
    await getMediaPlayers(null);
    expect(fullDownloads()).toBe(1);
    requests.length = 0;

    const players = await refreshMediaPlayers();
    expect(fullDownloads()).toBe(0);
    expect(requests.sort()).toEqual(['/api/states/media_player.kitchen', '/api/states/media_player.lounge']);
    expect(players.map((p) => p.entity_id).sort()).toEqual(['media_player.kitchen', 'media_player.lounge']);
  });
});
