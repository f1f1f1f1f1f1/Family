import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { FamilyMember } from '../types/family';

/*
 * Runs real sync passes against a fake Home Assistant to-do list and an
 * in-memory stand-in for the server's collection API. Like the real
 * server, the fake assigns its own record ids on add — the sync must not
 * rely on those ids to find its links.
 */

interface FakeItem { uid: string; summary: string; status: 'needs_action' | 'completed'; description?: string }

const ha = vi.hoisted(() => ({
  lists: new Map<string, FakeItem[]>(),
  deletes: [] as string[],
  nextUid: 0,
}));
const db = vi.hoisted(() => ({ collections: new Map<string, { id: string }[]>(), nextId: 0 }));

vi.mock('../api/ha-rest', () => ({
  hasToken: () => true,
  callBeaconAction: async () => null,
  callHaService: async (domain: string, service: string, data: Record<string, unknown>) => {
    if (domain === 'homeassistant') return null;
    const entity = data.entity_id as string;
    const items = ha.lists.get(entity) ?? [];
    ha.lists.set(entity, items);
    const find = (key: unknown) => items.find((it) => it.uid === key || it.summary === key);
    switch (service) {
      case 'get_items':
        return { service_response: { [entity]: { items: items.map((it) => ({ ...it })) } } };
      case 'add_item':
        items.push({ uid: `task-${++ha.nextUid}`, summary: data.item as string, status: 'needs_action', description: data.description as string });
        return null;
      case 'update_item': {
        const it = find(data.item);
        if (!it) throw new Error('item_not_found');
        if (data.status) it.status = data.status as FakeItem['status'];
        if ('description' in data) it.description = (data.description as string | null) ?? undefined;
        return null;
      }
      case 'remove_item': {
        const it = find(data.item);
        if (!it) throw new Error('item_not_found');
        ha.deletes.push(it.uid);
        items.splice(items.indexOf(it), 1);
        return null;
      }
    }
    throw new Error(`unexpected service ${domain}.${service}`);
  },
}));

vi.mock('../api/beacon-collection', () => {
  const coll = (name: string) => {
    if (!db.collections.has(name)) db.collections.set(name, []);
    return db.collections.get(name)!;
  };
  return {
    getCollection: async (name: string) => coll(name).map((it) => ({ ...it })),
    getCollectionSync: (name: string) => coll(name).map((it) => ({ ...it })),
    addToCollection: async (name: string, item: object) => {
      const created = { ...item, id: `rec-${++db.nextId}` }; // server-assigned id
      coll(name).push(created);
      return { ...created };
    },
    updateInCollection: async (name: string, id: string, patch: object) => {
      const it = coll(name).find((x) => x.id === id);
      if (!it) return null;
      Object.assign(it, patch);
      return { ...it };
    },
    removeFromCollection: async (name: string, id: string) => {
      const items = coll(name);
      const idx = items.findIndex((x) => x.id === id);
      if (idx >= 0) items.splice(idx, 1);
      return idx >= 0;
    },
  };
});

import { useChoresSync } from './useChoresSync';
import { FamilyStore } from '../api/family';

const kai = { id: 'kai', name: 'Kai', avatar: '', color: '#000', role: 'child' } as FamilyMember;
const store = new FamilyStore();

async function setup() {
  const chore = await store.addChore({ name: 'Vacuum', assigned_to: ['kai'], frequency: 'daily', value_cents: 0 });
  const { result } = renderHook(() => useChoresSync(true, { kai: 'todo.kai' }, [kai]));
  const sync = () => act(async () => { await result.current.runSync(true); });
  await sync();
  return { chore, sync, task: () => ha.lists.get('todo.kai')! };
}

beforeEach(() => {
  ha.lists.clear();
  ha.deletes = [];
  db.collections.clear();
});

describe('useChoresSync', () => {
  it('creates one task per chore and keeps it across passes', async () => {
    const { sync, task } = await setup();
    await sync();
    await sync();
    expect(task()).toHaveLength(1);
    expect(ha.deletes).toEqual([]);
    expect(db.collections.get('beacon_chores_sync_links')).toHaveLength(1);
  });

  it('pushes a completion made in Family to Google without deleting the task', async () => {
    const { chore, sync, task } = await setup();
    await store.completeChore(chore.id, 'kai');
    await sync();
    expect(task()).toHaveLength(1);
    expect(task()[0].status).toBe('completed');
    expect(ha.deletes).toEqual([]);
  });

  it('pulls a completion made in Google into Family', async () => {
    const { chore, sync, task } = await setup();
    task()[0].status = 'completed';
    await sync();
    const done = await store.getCompletionsToday();
    expect(done.some((c) => c.chore_id === chore.id && c.member_id === 'kai')).toBe(true);
  });

  it('un-ticks in Google when un-ticked in Family after both sides ticked', async () => {
    const { chore, sync, task } = await setup();
    await store.completeChore(chore.id, 'kai');
    task()[0].status = 'completed';
    await sync();
    await store.uncompleteChore(chore.id, 'kai');
    await sync();
    expect(task()[0].status).toBe('needs_action');
    expect((await store.getCompletionsToday())).toHaveLength(0);
  });

  it('writes nothing into the notes of new tasks', async () => {
    const { task } = await setup();
    expect(task()[0].description).toBeUndefined();
  });

  it('strips the legacy [beacon-sync] tag but keeps other notes', async () => {
    const { chore, sync, task } = await setup();
    task()[0].description = `Use the upstairs vacuum\n[beacon-sync] chore_id:${chore.id} member_id:kai`;
    await sync();
    expect(task()[0].description).toBe('Use the upstairs vacuum');
    task()[0].description = `[beacon-sync] chore_id:${chore.id} member_id:kai`;
    await sync();
    expect(task()[0].description).toBeUndefined();
  });

  it('adopts the existing task by title when its link is lost', async () => {
    const { sync, task } = await setup();
    db.collections.set('beacon_chores_sync_links', []);
    await sync();
    expect(task()).toHaveLength(1);
    expect(await store.getChores()).toHaveLength(1); // not imported as a new chore
    expect(db.collections.get('beacon_chores_sync_links')).toHaveLength(1);
  });

  it('imports a task added in Google as a new chore', async () => {
    const { sync, task } = await setup();
    task().push({ uid: 'mine', summary: 'Feed the cat', status: 'needs_action' });
    await sync();
    const chores = await store.getChores();
    expect(chores.map((c) => c.name).sort()).toEqual(['Feed the cat', 'Vacuum']);
    expect(task()).toHaveLength(2);
  });

  it('deletes the task when the chore is deleted in Family', async () => {
    const { chore, sync, task } = await setup();
    await store.removeChore(chore.id);
    await sync();
    expect(task()).toHaveLength(0);
  });

  it('cleans up duplicate link records from earlier builds', async () => {
    const { chore, sync, task } = await setup();
    const links = db.collections.get('beacon_chores_sync_links')!;
    links.push({ ...links[0], id: 'rec-dup' } as { id: string });
    await sync();
    expect(links).toHaveLength(1);
    expect(task()).toHaveLength(1);
    expect(ha.deletes).toEqual([]);
    void chore;
  });
});
