import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const db = vi.hoisted(() => ({ collections: new Map<string, { id: string }[]>(), nextId: 0 }));

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
    removeFromCollection: async (name: string, id: string) => {
      const items = coll(name);
      const idx = items.findIndex((x) => x.id === id);
      if (idx >= 0) items.splice(idx, 1);
      return idx >= 0;
    },
  };
});

import { useChores } from './useChores';

describe('useChores', () => {
  it('keeps separate instances in sync (e.g. dashboard card and Chores screen)', async () => {
    db.collections.set('beacon_chores', [
      { id: 'c1', name: 'Vacuum', assigned_to: ['kai'], frequency: 'daily', value_cents: 0 } as { id: string },
    ]);
    const dashboard = renderHook(() => useChores());
    const choresScreen = renderHook(() => useChores());
    await waitFor(() => expect(dashboard.result.current.chores).toHaveLength(1));

    await act(async () => { await choresScreen.result.current.completeChore('c1', 'kai'); });

    await waitFor(() => expect(dashboard.result.current.isChoreCompletedToday('c1', 'kai')).toBe(true));
  });

  it('while paused (Kid Display up), ignores changes, then catches up when resumed', async () => {
    db.collections.set('beacon_chores', [
      { id: 'c2', name: 'Feed cat', assigned_to: ['kai'], frequency: 'daily', value_cents: 0 } as { id: string },
    ]);
    db.collections.set('beacon_completions', []);
    const app = renderHook(({ enabled }) => useChores(enabled), { initialProps: { enabled: false } });
    const kidDisplay = renderHook(() => useChores());
    await waitFor(() => expect(kidDisplay.result.current.chores).toHaveLength(1));

    await act(async () => { await kidDisplay.result.current.completeChore('c2', 'kai'); });
    expect(app.result.current.isChoreCompletedToday('c2', 'kai')).toBe(false);

    app.rerender({ enabled: true });
    await waitFor(() => expect(app.result.current.isChoreCompletedToday('c2', 'kai')).toBe(true));
  });
});
