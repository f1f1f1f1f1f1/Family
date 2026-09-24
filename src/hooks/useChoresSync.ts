import { useCallback, useEffect, useRef } from 'react';
import { Chore, FamilyMember, ChoreCompletion } from '../types/family';
import { FamilyStore } from '../api/family';
import { callHaService, hasToken } from '../api/ha-rest';
import {
  getCollection,
  addToCollection,
  updateInCollection,
  removeFromCollection,
} from '../api/beacon-collection';

/**
 * Bidirectional sync between Beacon chores and Google Tasks, one list per
 * family member (accessed through HA's `todo` integration — Beacon never
 * talks to Google's API directly).
 *
 * Each family member who has a list configured gets their own synced
 * copy of every chore assigned to them, as a task in THEIR list. A
 * chore assigned to two people (each with their own list) creates one
 * task in each person's list, completable independently — that's what
 * preserves Beacon's per-person completion tracking through a sync to a
 * system that has no concept of multiple assignees.
 *
 * Because each list belongs to exactly one member, a task added
 * directly in someone's Google Tasks app can be imported as a chore
 * assigned to THEM specifically — no separate "claim this" step needed,
 * unlike a single shared list where there'd be no way to know who a new
 * item was for.
 *
 * A small "link" record (id `${chore_id}:${member_id}`, via the atomic
 * collection API — beacon-collection.ts / server.js) tracks which task
 * (by uid, within that member's list) corresponds to which chore, plus
 * the status Beacon and the task last agreed on — that's what lets a
 * sync pass tell a genuine change apart from one it already applied.
 */

interface ChoreSyncLink {
  id: string; // `${chore_id}:${member_id}`
  chore_id: string;
  member_id: string;
  uid: string; // Google Tasks item uid, within that member's list
  last_synced_status: 'needs_action' | 'completed';
}

const LINKS_COLLECTION = 'beacon_chores_sync_links';
const SYNC_MARKER_PREFIX = '[beacon-sync]';

interface TodoItem {
  uid?: string;
  summary: string;
  status: 'needs_action' | 'completed';
}

function formatTaskTitle(chore: Chore): string {
  const icon = chore.icon ? `${chore.icon} ` : '';
  return `${icon}${chore.name}`;
}

function formatDescription(choreId: string, memberId: string): string {
  return `${SYNC_MARKER_PREFIX} chore_id:${choreId} member_id:${memberId}`;
}

async function fetchTodoItems(entityId: string): Promise<TodoItem[]> {
  const result = await callHaService(
    'todo',
    'get_items',
    { entity_id: entityId, status: ['needs_action', 'completed'] },
    true,
  ) as { service_response?: Record<string, { items: TodoItem[] }> } | { [key: string]: { items: TodoItem[] } };

  const svcResponse = (result as { service_response?: Record<string, { items: TodoItem[] }> })?.service_response ?? result;
  const items = (svcResponse as Record<string, { items: TodoItem[] }>)?.[entityId]?.items;
  return Array.isArray(items) ? items : [];
}

export function useChoresSync(
  enabled: boolean,
  listByMember: Record<string, string>,
  chores: Chore[],
  members: FamilyMember[],
  completionsToday: ChoreCompletion[],
  refreshChores: () => Promise<void>,
) {
  const store = useRef(new FamilyStore()).current;
  const syncingRef = useRef(false);

  const runSync = useCallback(async () => {
    const activeMembers = members.filter((m) => listByMember[m.id]);
    if (!enabled || activeMembers.length === 0 || !hasToken() || syncingRef.current) return;
    syncingRef.current = true;

    try {
      const links = await getCollection<ChoreSyncLink>(LINKS_COLLECTION);
      const linksByKey = new Map(links.map((l) => [l.id, l]));
      const knownUidsByList = new Map<string, Set<string>>(); // entityId -> uids we already know about

      // Fetch each active member's list once.
      const itemsByEntity = new Map<string, TodoItem[]>();
      for (const member of activeMembers) {
        const entityId = listByMember[member.id];
        if (!itemsByEntity.has(entityId)) {
          itemsByEntity.set(entityId, await fetchTodoItems(entityId));
        }
      }
      for (const link of links) {
        const entityId = listByMember[link.member_id];
        if (!entityId) continue;
        if (!knownUidsByList.has(entityId)) knownUidsByList.set(entityId, new Set());
        knownUidsByList.get(entityId)!.add(link.uid);
      }

      let choresChanged = false;

      // --- Pull: tasks with no known link were added directly in that
      // member's Google Tasks app. Import as a chore assigned to them. ---
      for (const member of activeMembers) {
        const entityId = listByMember[member.id];
        const items = itemsByEntity.get(entityId) ?? [];
        const known = knownUidsByList.get(entityId) ?? new Set<string>();

        for (const item of items) {
          if (!item.uid || known.has(item.uid)) continue;
          if (item.summary.includes(SYNC_MARKER_PREFIX)) continue;

          const newChore = await store.addChore({
            name: item.summary,
            assigned_to: [member.id],
            frequency: 'once',
            value_cents: 0,
          });
          await addToCollection<ChoreSyncLink>(LINKS_COLLECTION, {
            chore_id: newChore.id,
            member_id: member.id,
            uid: item.uid,
            last_synced_status: item.status,
          });
          known.add(item.uid);
          if (item.status === 'completed') {
            await store.completeChore(newChore.id, member.id);
          }
          choresChanged = true;
        }
      }

      // --- Reconcile every (chore, assigned+synced member) pair ---
      const desiredKeys = new Set<string>();
      for (const chore of chores) {
        for (const memberId of chore.assigned_to) {
          const entityId = listByMember[memberId];
          if (!entityId) continue; // this member doesn't have a synced list
          const key = `${chore.id}:${memberId}`;
          desiredKeys.add(key);

          const beaconCompleted = completionsToday.some(
            (c) => c.chore_id === chore.id && c.member_id === memberId,
          );
          const beaconStatus: 'needs_action' | 'completed' = beaconCompleted ? 'completed' : 'needs_action';
          const link = linksByKey.get(key);
          const items = itemsByEntity.get(entityId) ?? [];
          const itemsByUid = new Map(items.filter((it) => it.uid).map((it) => [it.uid as string, it]));

          if (!link) {
            await callHaService('todo', 'add_item', {
              entity_id: entityId,
              item: formatTaskTitle(chore),
              description: formatDescription(chore.id, memberId),
              status: beaconStatus,
            });
            const fresh = await fetchTodoItems(entityId);
            itemsByEntity.set(entityId, fresh);
            const known = knownUidsByList.get(entityId) ?? new Set<string>();
            const match = fresh.find(
              (it) => it.summary === formatTaskTitle(chore) && it.uid && !known.has(it.uid),
            );
            if (match?.uid) {
              await addToCollection<ChoreSyncLink>(LINKS_COLLECTION, {
                chore_id: chore.id,
                member_id: memberId,
                uid: match.uid,
                last_synced_status: beaconStatus,
              });
              known.add(match.uid);
              knownUidsByList.set(entityId, known);
            }
            continue;
          }

          const task = itemsByUid.get(link.uid);
          if (!task) {
            // Deleted on the Google Tasks side — drop the link rather than
            // recreating it, so a deliberate delete doesn't just come back.
            await removeFromCollection(LINKS_COLLECTION, link.id);
            continue;
          }

          const beaconChanged = beaconStatus !== link.last_synced_status;
          const taskChanged = task.status !== link.last_synced_status;

          if (beaconChanged && !taskChanged) {
            await callHaService('todo', 'update_item', {
              entity_id: entityId,
              item: link.uid,
              status: beaconStatus,
            });
            await updateInCollection<ChoreSyncLink>(LINKS_COLLECTION, link.id, { last_synced_status: beaconStatus });
          } else if (taskChanged && !beaconChanged) {
            if (task.status === 'completed') {
              await store.completeChore(chore.id, memberId);
            } else {
              await store.uncompleteChore(chore.id, memberId);
            }
            await updateInCollection<ChoreSyncLink>(LINKS_COLLECTION, link.id, { last_synced_status: task.status });
            choresChanged = true;
          } else if (beaconChanged && taskChanged && beaconStatus !== task.status) {
            // Genuine simultaneous conflict — "completed" wins either way.
            const resolved = beaconStatus === 'completed' || task.status === 'completed' ? 'completed' : 'needs_action';
            if (resolved !== beaconStatus) {
              if (resolved === 'completed') await store.completeChore(chore.id, memberId);
              else await store.uncompleteChore(chore.id, memberId);
              choresChanged = true;
            }
            if (resolved !== task.status) {
              await callHaService('todo', 'update_item', { entity_id: entityId, item: link.uid, status: resolved });
            }
            await updateInCollection<ChoreSyncLink>(LINKS_COLLECTION, link.id, { last_synced_status: resolved });
          }
        }
      }

      // --- Clean up links for pairs that no longer exist (chore deleted,
      // member unassigned, or member's list disconnected) — remove both
      // the link and the task. ---
      for (const link of links) {
        if (desiredKeys.has(link.id)) continue;
        const entityId = listByMember[link.member_id];
        if (entityId) {
          await callHaService('todo', 'remove_item', { entity_id: entityId, item: link.uid }).catch(() => {
            /* task may already be gone — fine either way */
          });
        }
        await removeFromCollection(LINKS_COLLECTION, link.id);
      }

      if (choresChanged) await refreshChores();
    } catch (err) {
      console.warn('Beacon: chores sync failed', err);
    } finally {
      syncingRef.current = false;
    }
  }, [enabled, listByMember, chores, members, completionsToday, refreshChores, store]);

  // Run on enable/list change, then periodically.
  useEffect(() => {
    const hasAnyList = Object.keys(listByMember).length > 0;
    if (!enabled || !hasAnyList) return;
    void runSync();
    const interval = setInterval(() => void runSync(), 60_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, JSON.stringify(listByMember)]);

  return { runSync };
}
