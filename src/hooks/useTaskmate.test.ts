import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTaskmate } from './useTaskmate';
import { resetStatesCache } from '../api/ha-rest';

vi.mock('../utils/ha-env', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/ha-env')>(),
  isAddOn: () => true,
}));

const requests: string[] = [];
let completions: object[] = [];

const states = () => [
  { entity_id: 'sensor.taskmate_overview', state: 'ok', attributes: { children: [{ id: 'k1', name: 'Kai' }] } },
  { entity_id: 'sensor.taskmate_chores', state: 'ok', attributes: { todays_completions: completions } },
  { entity_id: 'todo.kai', state: '2', attributes: {} },
  { entity_id: 'sensor.kai_stats', state: 'ok', attributes: { child_id: 'k1' } },
];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetStatesCache();
  requests.length = 0;
  completions = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.replace(/^.*?(\/api\/)/, '$1');
    requests.push(path);
    const body = path === '/api/states' ? states() : states().find((s) => `/api/states/${s.entity_id}` === path);
    return new Response(JSON.stringify(body));
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useTaskmate', () => {
  // Every minute it downloaded every entity's state, to read one sensor.
  it('finds its entities now and then, and reads completions each minute', async () => {
    const { result } = renderHook(() => useTaskmate(true));
    await waitFor(() => expect(result.current.users).toEqual([{ childId: 'k1', name: 'Kai', todoListId: 'todo.kai' }]));

    completions = [{ chore_id: 'c1', child_id: 'k1', chore_name: 'Dishes', completed_at: '2026-09-26T10:00:00' }];
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });

    await waitFor(() => expect(result.current.completions.map((c) => c.summary)).toEqual(['Dishes']));
    expect(requests.filter((r) => r === '/api/states')).toHaveLength(1);
    expect(requests.filter((r) => r === '/api/states/sensor.taskmate_chores').length).toBeGreaterThanOrEqual(5);
  });
});
