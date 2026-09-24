import { useCallback, useEffect, useRef } from 'react';
import { Chore, FamilyMember, ChoreCompletion, Routine, RoutineTaskCompletion } from '../types/family';
import { FamilyStore } from '../api/family';
import { callHaService, hasToken } from '../api/ha-rest';
import {
  getCollection,
  addToCollection,
  updateInCollection,
  removeFromCollection,
} from '../api/beacon-collection';

/**
 * Bidirectional sync between Beacon (chores + routine tasks) and Google
 * Tasks, one list per family member (accessed through HA's `todo`
 * integration — Beacon never talks to Google's API directly).
 *
 * CHORES: each family member who has a list configured gets their own
 * synced copy of every chore assigned to them, as a task in THEIR list.
 * A chore assigned to two people (each with their own list) creates one
 * task in each person's list, completable independently — that's what
 * preserves Beacon's per-person completion tracking through a sync to a
 * system that has no concept of multiple assignees.
 *
 * ROUTINE TASKS: each task within a member's routines also gets its own
 * synced task, titled "[Routine Name] Task Name" so it's distinguishable
 * from plain chores sharing the same list. Routines only ever belong to
 * one member (Routine.member_id), so there's no multi-assignee case to
 * handle there.
 *
 * Both reset automatically with no special "daily reset" logic: Beacon's
 * own completion tracking is already date-scoped (completionsToday /
 * routine completionsToday), so once a new day starts it naturally goes
 * back to "not completed" on Beacon's side — the very next sync pass
 * compares that against what was last pushed to the task and un-checks
 * it, the same as any other change.
 *
 * New tasks added directly in someone's Google Tasks app are imported
 * as CHORES ONLY (assigned to that member) — there's no way to tell
 * from a bare new task whether it was meant as a one-off chore or a
 * step in some routine, so that ambiguity is resolved in favor of the
 * simpler, originally-requested behavior.
 *
 * Sync link records (via the atomic collection API — beacon-collection.ts
 * / server.js) track which task (by uid, within that member's list)
 * corresponds to which chore or routine task, plus the status Beacon and
 * the task last agreed on — that's what lets a sync pass tell a genuine
 * change apart from one it already applied.
 */

interface ChoreSyncLink {
  id: string; // `${chore_id}:${member_id}`
  chore_id: string;
  member_id: string;
  uid: string;
  last_synced_status: 'needs_action' | 'completed';
}

interface RoutineSyncLink {
  id: string; // `${routine_id}:${task_id}:${member_id}`
  routine_id: string;
  task_id: string;
  member_id: string;
  uid: string;
  last_synced_status: 'needs_action' | 'completed';
}

const LINKS_COLLECTION = 'beacon_chores_sync_links';
const ROUTINE_LINKS_COLLECTION = 'beacon_routine_sync_links';
const SYNC_MARKER_PREFIX = '[beacon-sync]';

interface TodoItem {
  uid?: string;
  summary: string;
  status: 'needs_action' | 'completed';
}

function formatChoreTitle(chore: Chore): string {
  const icon = chore.icon ? `${chore.icon} ` : '';
  return `${icon}${chore.name}`;
}

function formatChoreDescription(choreId: string, memberId: string): string {
  return `${SYNC_MARKER_PREFIX} chore_id:${choreId} member_id:${memberId}`;
}

function formatRoutineTaskTitle(routine: Routine, taskName: string): string {
  return `[${routine.name}] ${taskName}`;
}

function formatRoutineDescription(routineId: string, taskId: string, memberId: string): string {
  return `${SYNC_MARKER_PREFIX} routine_id:${routineId} task_id:${taskId} member_id:${memberId}`;
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

/** Push/pull one (task-in-a-list) pair against its sync link. Shared logic for chores and routine tasks. */
async function reconcileOne<T extends { id: string; uid: string; last_synced_status: 'needs_action' | 'completed' }>(
  entityId: string,
  link: T | undefined,
  beaconStatus: 'needs_action' | 'completed',
  itemsByUid: Map<string, TodoItem>,
  linksCollection: string,
  onPull: (status: 'needs_action' | 'completed') => Promise<void>,
): Promise<{ changed: boolean }> {
  if (!link) return { changed: false }; // caller handles creation separately

  const task = itemsByUid.get(link.uid);
  if (!task) {
    // Deleted on the Google Tasks side — drop the link rather than
    // recreating it, so a deliberate delete doesn't just come back.
    await removeFromCollection(linksCollection, link.id);
    return { changed: false };
  }

  const beaconChanged = beaconStatus !== link.last_synced_status;
  const taskChanged = task.status !== link.last_synced_status;

  if (beaconChanged && !taskChanged) {
    await callHaService('todo', 'update_item', { entity_id: entityId, item: link.uid, status: beaconStatus });
    await updateInCollection<T>(linksCollection, link.id, { last_synced_status: beaconStatus } as Partial<T>);
    return { changed: false };
  }
  if (taskChanged && !beaconChanged) {
    await onPull(task.status);
    await updateInCollection<T>(linksCollection, link.id, { last_synced_status: task.status } as Partial<T>);
    return { changed: true };
  }
  if (beaconChanged && taskChanged && beaconStatus !== task.status) {
    const resolved = beaconStatus === 'completed' || task.status === 'completed' ? 'completed' : 'needs_action';
    let changed = false;
    if (resolved !== beaconStatus) {
      await onPull(resolved);
      changed = true;
    }
    if (resolved !== task.status) {
      await callHaService('todo', 'update_item', { entity_id: entityId, item: link.uid, status: resolved });
    }
    await updateInCollection<T>(linksCollection, link.id, { last_synced_status: resolved } as Partial<T>);
    return { changed };
  }
  return { changed: false };
}

export function useChoresSync(
  enabled: boolean,
  listByMember: Record<string, string>,
  chores: Chore[],
  members: FamilyMember[],
  completionsToday: ChoreCompletion[],
  refreshChores: () => Promise<void>,
  routines: Routine[] = [],
  routineCompletionsToday: RoutineTaskCompletion[] = [],
  refreshRoutines: () => Promise<void> = async () => {},
) {
  const store = useRef(new FamilyStore()).current;
  const syncingRef = useRef(false);

  const runSync = useCallback(async () => {
    const activeMembers = members.filter((m) => listByMember[m.id]);
    if (!enabled || activeMembers.length === 0 || !hasToken() || syncingRef.current) return;
    syncingRef.current = true;

    try {
      const [links, routineLinks] = await Promise.all([
        getCollection<ChoreSyncLink>(LINKS_COLLECTION),
        getCollection<RoutineSyncLink>(ROUTINE_LINKS_COLLECTION),
      ]);
      const linksByKey = new Map(links.map((l) => [l.id, l]));
      const routineLinksByKey = new Map(routineLinks.map((l) => [l.id, l]));
      const knownUidsByList = new Map<string, Set<string>>();

      const itemsByEntity = new Map<string, TodoItem[]>();
      for (const member of activeMembers) {
        const entityId = listByMember[member.id];
        if (!itemsByEntity.has(entityId)) {
          itemsByEntity.set(entityId, await fetchTodoItems(entityId));
        }
      }
      for (const l of [...links, ...routineLinks]) {
        const entityId = listByMember[l.member_id];
        if (!entityId) continue;
        if (!knownUidsByList.has(entityId)) knownUidsByList.set(entityId, new Set());
        knownUidsByList.get(entityId)!.add(l.uid);
      }

      let choresChanged = false;
      let routinesChanged = false;

      // --- Pull: tasks with no known link were added directly in that
      // member's Google Tasks app. Import as a chore assigned to them
      // (never as a routine task — see file header for why). ---
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
      const desiredChoreKeys = new Set<string>();
      for (const chore of chores) {
        for (const memberId of chore.assigned_to) {
          const entityId = listByMember[memberId];
          if (!entityId) continue;
          const key = `${chore.id}:${memberId}`;
          desiredChoreKeys.add(key);

          const beaconStatus: 'needs_action' | 'completed' = completionsToday.some(
            (c) => c.chore_id === chore.id && c.member_id === memberId,
          ) ? 'completed' : 'needs_action';
          const link = linksByKey.get(key);
          const items = itemsByEntity.get(entityId) ?? [];
          const itemsByUid = new Map(items.filter((it) => it.uid).map((it) => [it.uid as string, it]));

          if (!link) {
            await callHaService('todo', 'add_item', {
              entity_id: entityId,
              item: formatChoreTitle(chore),
              description: formatChoreDescription(chore.id, memberId),
              status: beaconStatus,
            });
            const fresh = await fetchTodoItems(entityId);
            itemsByEntity.set(entityId, fresh);
            const known = knownUidsByList.get(entityId) ?? new Set<string>();
            const match = fresh.find((it) => it.summary === formatChoreTitle(chore) && it.uid && !known.has(it.uid));
            if (match?.uid) {
              await addToCollection<ChoreSyncLink>(LINKS_COLLECTION, {
                chore_id: chore.id, member_id: memberId, uid: match.uid, last_synced_status: beaconStatus,
              });
              known.add(match.uid);
              knownUidsByList.set(entityId, known);
            }
            continue;
          }

          const { changed } = await reconcileOne(
            entityId, link, beaconStatus, itemsByUid, LINKS_COLLECTION,
            async (status) => {
              if (status === 'completed') await store.completeChore(chore.id, memberId);
              else await store.uncompleteChore(chore.id, memberId);
            },
          );
          if (changed) choresChanged = true;
        }
      }

      for (const link of links) {
        if (desiredChoreKeys.has(link.id)) continue;
        const entityId = listByMember[link.member_id];
        if (entityId) {
          await callHaService('todo', 'remove_item', { entity_id: entityId, item: link.uid }).catch(() => {});
        }
        await removeFromCollection(LINKS_COLLECTION, link.id);
      }

      // --- Reconcile every routine task for members with a synced list ---
      const desiredRoutineKeys = new Set<string>();
      for (const routine of routines) {
        const entityId = listByMember[routine.member_id];
        if (!entityId) continue;

        for (const task of routine.tasks) {
          const key = `${routine.id}:${task.id}:${routine.member_id}`;
          desiredRoutineKeys.add(key);

          const beaconStatus: 'needs_action' | 'completed' = routineCompletionsToday.some(
            (c) => c.routine_id === routine.id && c.task_id === task.id && c.member_id === routine.member_id,
          ) ? 'completed' : 'needs_action';
          const link = routineLinksByKey.get(key);
          const items = itemsByEntity.get(entityId) ?? [];
          const itemsByUid = new Map(items.filter((it) => it.uid).map((it) => [it.uid as string, it]));
          const title = formatRoutineTaskTitle(routine, task.name);

          if (!link) {
            await callHaService('todo', 'add_item', {
              entity_id: entityId,
              item: title,
              description: formatRoutineDescription(routine.id, task.id, routine.member_id),
              status: beaconStatus,
            });
            const fresh = await fetchTodoItems(entityId);
            itemsByEntity.set(entityId, fresh);
            const known = knownUidsByList.get(entityId) ?? new Set<string>();
            const match = fresh.find((it) => it.summary === title && it.uid && !known.has(it.uid));
            if (match?.uid) {
              await addToCollection<RoutineSyncLink>(ROUTINE_LINKS_COLLECTION, {
                routine_id: routine.id, task_id: task.id, member_id: routine.member_id,
                uid: match.uid, last_synced_status: beaconStatus,
              });
              known.add(match.uid);
              knownUidsByList.set(entityId, known);
            }
            continue;
          }

          const { changed } = await reconcileOne(
            entityId, link, beaconStatus, itemsByUid, ROUTINE_LINKS_COLLECTION,
            async (status) => {
              if (status === 'completed') await store.completeRoutineTask(routine.id, task.id, routine.member_id);
              else await store.uncompleteRoutineTask(routine.id, task.id, routine.member_id);
            },
          );
          if (changed) routinesChanged = true;
        }
      }

      for (const link of routineLinks) {
        if (desiredRoutineKeys.has(link.id)) continue;
        const entityId = listByMember[link.member_id];
        if (entityId) {
          await callHaService('todo', 'remove_item', { entity_id: entityId, item: link.uid }).catch(() => {});
        }
        await removeFromCollection(ROUTINE_LINKS_COLLECTION, link.id);
      }

      if (choresChanged) await refreshChores();
      if (routinesChanged) await refreshRoutines();
    } catch (err) {
      console.warn('Beacon: chores/routines sync failed', err);
    } finally {
      syncingRef.current = false;
    }
  }, [enabled, listByMember, chores, members, completionsToday, refreshChores, routines, routineCompletionsToday, refreshRoutines, store]);

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
