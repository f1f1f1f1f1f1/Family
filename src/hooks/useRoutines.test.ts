import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const db = vi.hoisted(() => ({ collections: new Map<string, object[]>(), nextId: 0 }));

vi.mock('../api/beacon-collection', () => {
  const coll = (name: string) => {
    if (!db.collections.has(name)) db.collections.set(name, []);
    return db.collections.get(name)!;
  };
  return {
    getCollection: async (name: string) => coll(name).map((it) => ({ ...it })),
    getCollectionSync: (name: string) => coll(name).map((it) => ({ ...it })),
    addToCollection: async (name: string, item: object) => {
      const created = { ...item, id: `rec-${++db.nextId}` };
      coll(name).push(created);
      return { ...created };
    },
    updateInCollection: async () => null,
    removeFromCollection: async () => false,
  };
});

import { useRoutines } from './useRoutines';

afterEach(() => {
  vi.useRealTimers();
});

describe('useRoutines', () => {
  // Only the Kid Display reloaded at midnight; now every screen using the
  // hook does, so yesterday's ticks clear.
  it("clears yesterday's ticks at midnight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 26, 23, 58));
    const routine = { id: 'r1', member_id: 'kai', name: 'Evening', tasks: [{ id: 't1', title: 'Brush teeth' }] };
    db.collections.set('beacon_routines', [routine]);
    db.collections.set('beacon_routine_completions', []);

    const { result } = renderHook(() => useRoutines('kai'));
    await waitFor(() => expect(result.current.routines).toHaveLength(1));
    await act(async () => { await result.current.toggleTask(result.current.routines[0], 't1'); });
    expect(result.current.isTaskCompletedToday('r1', 't1', 'kai')).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60 * 1000); }); // 00:01
    await waitFor(() => expect(result.current.isTaskCompletedToday('r1', 't1', 'kai')).toBe(false));
  });
});
