import { useCallback, useEffect, useRef } from 'react';
import { Chore, FamilyMember } from '../types/family';
import { FamilyStore, notifyFamilyDataChanged } from '../api/family';
import { callBeaconAction, callHaService, hasToken } from '../api/ha-rest';
import { getTodoItems } from '../api/ha-services';
import {
  getCollection,
  addToCollection,
  updateInCollection,
  removeFromCollection,
} from '../api/beacon-collection';

/**
 * Bidirectional sync between Beacon chores and Google Tasks, one list per family member (accessed through HA's `todo`
 * integration — Beacon never talks to Google's API directly).
 *
 * CHORES: each family member who has a list configured gets their own
 * synced copy of every chore assigned to them, as a task in THEIR list.
 * A chore assigned to two people (each with their own list) creates one
 * task in each person's list, completable independently — that's what
 * preserves Beacon's per-person completion tracking through a sync to a
 * system that has no concept of multiple assignees.
 *
 * ROUTINES are not synced. Google Tasks subtasks aren't visible through
 * HA's todo integration, and one task per routine step cluttered the
 * lists. Routine tasks created by earlier versions (tracked in
 * beacon_routine_sync_links) are removed from Google Tasks on the next
 * pass.
 *
 * Chores reset automatically with no special "daily reset" logic: Beacon's
 * own completion tracking is already date-scoped (completionsToday), so
 * once a new day starts it naturally goes
 * back to "not completed" on Beacon's side — the very next sync pass
 * compares that against what was last pushed to the task and un-checks
 * it, the same as any other change.
 *
 * New tasks added directly in someone's Google Tasks app are imported
 * as chores assigned to that member.
 *
 * Tasks carry nothing in their notes: they're matched by uid through the
 * link records below. If a link is lost, an unlinked task with the
 * chore's title in that member's list is adopted rather than imported as
 * a new chore. Earlier builds wrote a "[beacon-sync] chore_id:…" tag into
 * each task's notes; it's still recognized, and stripped on the next pass.
 *
 * Sync link records (via the atomic collection API — beacon-collection.ts
 * / server.js) track which task (by uid, within that member's list)
 * corresponds to which chore, plus the status Beacon and
 * the task last agreed on — that's what lets a sync pass tell a genuine
 * change apart from one it already applied.
 */

interface ChoreSyncLink {
  id: string; // record id, assigned by the collection API — not meaningful
  chore_id: string;
  member_id: string;
  uid: string;
  last_synced_status: 'needs_action' | 'completed';
}

/** Left by versions that also synced routine tasks; only read for cleanup. */
interface LegacyRoutineSyncLink {
  id: string;
  member_id: string;
  uid: string;
}

const LINKS_COLLECTION = 'beacon_chores_sync_links';

/**
 * Links are looked up by the chore and member they belong to. Their `id`
 * is assigned by the server when the record is added, so it can't be
 * used as this key — doing so meant no link was ever found: every pass
 * re-linked each chore and then deleted its Google task as orphaned.
 */
function choreLinkKey(link: Pick<ChoreSyncLink, 'chore_id' | 'member_id'>): string {
  return `${link.chore_id}:${link.member_id}`;
}
const LEGACY_ROUTINE_LINKS_COLLECTION = 'beacon_routine_sync_links';
/** Tag earlier builds wrote into task notes; no longer written. */
const LEGACY_MARKER_PREFIX = '[beacon-sync]';

interface TodoItem {
  uid?: string;
  summary: string;
  status: 'needs_action' | 'completed';
  description?: string;
}

function formatChoreTitle(chore: Chore): string {
  const icon = chore.icon ? `${chore.icon} ` : '';
  return `${icon}${chore.name}`;
}

function legacyChoreMarker(choreId: string, memberId: string): string {
  return `${LEGACY_MARKER_PREFIX} chore_id:${choreId} member_id:${memberId}`;
}

/** Notes with the legacy tag line removed; null when nothing else is left. */
function stripLegacyMarker(description: string): string | null {
  const kept = description
    .split('\n')
    .filter((line) => !line.includes(LEGACY_MARKER_PREFIX))
    .join('\n')
    .trim();
  return kept || null;
}

/**
 * Returns null (not []) when the response can't be parsed, so callers can
 * skip that list instead of treating every linked task as deleted.
 *
 * `refresh` forces HA to re-poll the backing integration first. Google
 * Tasks' coordinator only polls every 30 minutes, and get_items answers
 * from that cache — so without this, a task checked off in the Google
 * Tasks app stays "needs_action" from Beacon's view for up to 30 min.
 */
async function fetchTodoItems(entityId: string, refresh = false): Promise<TodoItem[] | null> {
  if (refresh) {
    await callHaService('homeassistant', 'update_entity', { entity_id: entityId }).catch((err) => {
      console.warn(`Beacon: couldn't refresh ${entityId}, using cached items`, err);
    });
  }
  return getTodoItems(entityId, ['needs_action', 'completed']);
}

/**
 * An unlinked task in this list that belongs to the chore: one tagged
 * for it by an earlier build, else one with the chore's title.
 */
function findUnlinkedTask(items: TodoItem[], known: Set<string>, chore: Chore, memberId: string): TodoItem | undefined {
  const unlinked = items.filter((it) => it.uid && !known.has(it.uid));
  const marker = legacyChoreMarker(chore.id, memberId);
  return unlinked.find((it) => it.description?.includes(marker))
    ?? unlinked.find((it) => it.summary === formatChoreTitle(chore));
}

/** Push/pull one (task-in-a-list) pair against its sync link. */
async function reconcileOne<T extends { id: string; uid: string; last_synced_status: 'needs_action' | 'completed' }>(
  entityId: string,
  link: T | undefined,
  beaconStatus: 'needs_action' | 'completed',
  itemsByUid: Map<string, TodoItem>,
  linksCollection: string,
  onPull: (status: 'needs_action' | 'completed') => Promise<void>,
): Promise<{ changed: boolean; action: string }> {
  if (!link) return { changed: false, action: 'no link' }; // caller handles creation separately

  const task = itemsByUid.get(link.uid);
  if (!task) {
    // Deleted on the Google Tasks side — drop the link rather than
    // recreating it, so a deliberate delete doesn't just come back.
    await removeFromCollection(linksCollection, link.id);
    return { changed: false, action: `Google task ${link.uid} not found, link dropped` };
  }

  const beaconChanged = beaconStatus !== link.last_synced_status;
  const taskChanged = task.status !== link.last_synced_status;

  if (beaconChanged && !taskChanged) {
    await callHaService('todo', 'update_item', { entity_id: entityId, item: link.uid, status: beaconStatus });
    await updateInCollection<T>(linksCollection, link.id, { last_synced_status: beaconStatus } as Partial<T>);
    return { changed: false, action: `pushed ${beaconStatus} to Google` };
  }
  if (taskChanged && !beaconChanged) {
    await onPull(task.status);
    await updateInCollection<T>(linksCollection, link.id, { last_synced_status: task.status } as Partial<T>);
    return { changed: true, action: `pulled ${task.status} into Family` };
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
    return { changed, action: `both changed, resolved to ${resolved}` };
  }
  if (beaconChanged && taskChanged) {
    // Both sides changed the same way. Record it, or a later change on
    // one side would be mistaken for the other side changing back.
    await updateInCollection<T>(linksCollection, link.id, { last_synced_status: beaconStatus } as Partial<T>);
    return { changed: false, action: `both changed to ${beaconStatus}, recorded` };
  }
  return { changed: false, action: 'in sync' };
}

export function useChoresSync(
  enabled: boolean,
  listByMember: Record<string, string>,
  members: FamilyMember[],
) {
  const store = useRef(new FamilyStore()).current;
  const syncingRef = useRef(false);

  /**
   * `verbose` (used by the Settings "Sync Now" button) writes a report of
   * every decision to the add-on log, readable in HA under the add-on's
   * Log tab. It also waits for an in-progress pass instead of skipping.
   */
  const runSync = useCallback(async (verbose = false) => {
    const report: string[] = [];
    const note = (line: string) => { if (verbose) report.push(line); };
    const memberName = (id: string) => members.find((m) => m.id === id)?.name ?? id;

    const activeMembers = members.filter((m) => listByMember[m.id]);
    if (!enabled || activeMembers.length === 0 || !hasToken()) {
      if (verbose) {
        void callBeaconAction('/beacon-action/log', {
          lines: [`skipped: enabled=${enabled} membersWithLists=${activeMembers.length} hasToken=${hasToken()}`],
        }).catch(() => {});
      }
      return;
    }
    if (syncingRef.current) {
      if (!verbose) return;
      while (syncingRef.current) await new Promise((r) => setTimeout(r, 250));
    }
    syncingRef.current = true;

    try {
      // Read chores fresh every pass rather than taking them from React
      // state: a component's copy can still be empty on mount (the first
      // pass runs immediately), and every link missing from an empty list
      // would be removed from Google Tasks as "deleted in Beacon".
      const [links, legacyRoutineLinks, chores, completionsToday] = await Promise.all([
        getCollection<ChoreSyncLink>(LINKS_COLLECTION),
        getCollection<LegacyRoutineSyncLink>(LEGACY_ROUTINE_LINKS_COLLECTION),
        store.getChores(),
        store.getCompletionsToday(),
      ]);
      note(`lists: ${activeMembers.map((m) => `${m.name} -> ${listByMember[m.id]}`).join(', ')}`);
      note(`chores=${chores.length} links=${links.length} completionsToday=${completionsToday.length}`);
      const knownUidsByList = new Map<string, Set<string>>();

      const itemsByEntity = new Map<string, TodoItem[]>();
      for (const member of activeMembers) {
        const entityId = listByMember[member.id];
        if (!itemsByEntity.has(entityId)) {
          const items = await fetchTodoItems(entityId, true);
          // Unreadable list: leave it out entirely, so nothing below
          // mistakes its tasks for deleted ones this pass.
          if (items) itemsByEntity.set(entityId, items);
          else console.warn(`Beacon: unreadable todo response for ${entityId}, skipping this sync`);
          note(items
            ? `${entityId}: ${items.length} tasks, ${items.filter((it) => it.status === 'completed').length} completed`
            : `${entityId}: unreadable response, list skipped`);
        }
      }
      // Remove routine tasks created before routines stopped syncing, and
      // drop them from this pass's item lists so they aren't imported.
      for (const link of legacyRoutineLinks) {
        const entityId = listByMember[link.member_id];
        if (entityId) {
          await callHaService('todo', 'remove_item', { entity_id: entityId, item: link.uid }, false, `chores-sync: legacy routine link ${link.id}`).catch(() => {});
          const items = itemsByEntity.get(entityId);
          if (items) itemsByEntity.set(entityId, items.filter((it) => it.uid !== link.uid));
        }
        await removeFromCollection(LEGACY_ROUTINE_LINKS_COLLECTION, link.id);
      }
      // Routine tasks whose link was already lost are still recognizable by
      // their description marker.
      for (const [entityId, items] of itemsByEntity) {
        const orphans = items.filter((it) => it.uid && it.description?.includes(`${LEGACY_MARKER_PREFIX} routine_id:`));
        for (const it of orphans) {
          await callHaService('todo', 'remove_item', { entity_id: entityId, item: it.uid }, false, 'chores-sync: orphaned routine task').catch(() => {});
        }
        if (orphans.length) itemsByEntity.set(entityId, items.filter((it) => !orphans.includes(it)));
      }

      for (const l of links) {
        const entityId = listByMember[l.member_id];
        if (!entityId) continue;
        if (!knownUidsByList.has(entityId)) knownUidsByList.set(entityId, new Set());
        knownUidsByList.get(entityId)!.add(l.uid);
      }

      // One link per (chore, member). Earlier builds could save several;
      // keep the one whose task still exists and drop the rest, deleting
      // any extra Google tasks they point at (Beacon-created duplicates).
      const linksByKey = new Map<string, ChoreSyncLink>();
      const extraLinks: ChoreSyncLink[] = [];
      for (const l of links) {
        const key = choreLinkKey(l);
        const current = linksByKey.get(key);
        if (!current) { linksByKey.set(key, l); continue; }
        const items = itemsByEntity.get(listByMember[l.member_id]);
        const exists = (link: ChoreSyncLink) => !!items?.some((it) => it.uid === link.uid);
        if (!exists(current) && exists(l)) {
          extraLinks.push(current);
          linksByKey.set(key, l);
        } else {
          extraLinks.push(l);
        }
      }
      for (const extra of extraLinks) {
        const kept = linksByKey.get(choreLinkKey(extra))!;
        const entityId = listByMember[extra.member_id];
        if (entityId && extra.uid !== kept.uid && itemsByEntity.get(entityId)?.some((it) => it.uid === extra.uid)) {
          note(`duplicate link for ${choreLinkKey(extra)}: deleting extra Google task ${extra.uid}`);
          await callHaService('todo', 'remove_item', { entity_id: entityId, item: extra.uid }, false, `chores-sync: duplicate task for ${choreLinkKey(extra)}`).catch(() => {});
          itemsByEntity.set(entityId, itemsByEntity.get(entityId)!.filter((it) => it.uid !== extra.uid));
        }
        await removeFromCollection(LINKS_COLLECTION, extra.id);
      }
      if (extraLinks.length) note(`removed ${extraLinks.length} duplicate link record(s)`);

      let choresChanged = false;
      const knownUids = (entityId: string) => {
        if (!knownUidsByList.has(entityId)) knownUidsByList.set(entityId, new Set());
        return knownUidsByList.get(entityId)!;
      };

      // Titles of chores with no link yet, per list: an unlinked task with
      // one of these titles is adopted by the reconcile step below, not
      // imported as a new chore.
      const unlinkedTitles = new Map<string, Set<string>>();
      for (const chore of chores) {
        for (const memberId of chore.assigned_to) {
          const entityId = listByMember[memberId];
          if (!entityId || linksByKey.has(`${chore.id}:${memberId}`)) continue;
          if (!unlinkedTitles.has(entityId)) unlinkedTitles.set(entityId, new Set());
          unlinkedTitles.get(entityId)!.add(formatChoreTitle(chore));
        }
      }

      // --- Pull: tasks with no known link were added directly in that
      // member's Google Tasks app. Import as a chore assigned to them. ---
      for (const member of activeMembers) {
        const entityId = listByMember[member.id];
        const items = itemsByEntity.get(entityId) ?? [];
        const known = knownUids(entityId);

        for (const item of items) {
          if (!item.uid || known.has(item.uid)) continue;
          // Family's own task whose link was lost: adopted below.
          if (item.description?.includes(LEGACY_MARKER_PREFIX)) continue;
          if (unlinkedTitles.get(entityId)?.has(item.summary)) continue;

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
          note(`imported new Google task "${item.summary}" (${item.status}) as a chore for ${memberName(member.id)}`);
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
          const items = itemsByEntity.get(entityId);
          const label = `"${chore.name}" for ${memberName(memberId)}`;
          if (!items) continue; // list unreadable this pass
          const itemsByUid = new Map(items.filter((it) => it.uid).map((it) => [it.uid as string, it]));

          if (!link) {
            const known = knownUids(entityId);
            let match = findUnlinkedTask(items, known, chore, memberId);
            const relinked = !!match;
            if (!match) {
              await callHaService('todo', 'add_item', {
                entity_id: entityId,
                item: formatChoreTitle(chore),
              });
              const fresh = await fetchTodoItems(entityId);
              if (fresh) {
                itemsByEntity.set(entityId, fresh);
                match = findUnlinkedTask(fresh, known, chore, memberId);
              }
            }
            if (match?.uid) {
              // Baseline 'needs_action', not the task's current status: a
              // re-found task may have been ticked in Google meanwhile, and
              // recording that as already agreed would make the next pass
              // push Family's "not done" over it. From this baseline a tick
              // on either side counts as a change, and done wins.
              await addToCollection<ChoreSyncLink>(LINKS_COLLECTION, {
                chore_id: chore.id, member_id: memberId, uid: match.uid, last_synced_status: 'needs_action',
              });
              known.add(match.uid);
              note(`${label}: ${relinked ? 're-linked existing' : 'created'} Google task ${match.uid} (google=${match.status} family=${beaconStatus})`);
            } else {
              note(`${label}: created Google task but couldn't find it afterwards`);
            }
            continue;
          }

          // Other Beacon-created tasks for this same chore are duplicates
          // left by earlier builds. Only removed while the linked task
          // exists, so the last copy is never deleted.
          if (itemsByUid.has(link.uid)) {
            const marker = legacyChoreMarker(chore.id, memberId);
            const dups = items.filter((it) => it.uid && it.uid !== link.uid && it.description?.includes(marker));
            for (const dup of dups) {
              note(`${label}: deleting duplicate Google task ${dup.uid}`);
              await callHaService('todo', 'remove_item', { entity_id: entityId, item: dup.uid }, false, `chores-sync: duplicate task for ${key}`).catch(() => {});
            }
          }

          const linkedTask = itemsByUid.get(link.uid);
          if (linkedTask?.description?.includes(LEGACY_MARKER_PREFIX)) {
            note(`${label}: removing legacy tag from task notes`);
            await callHaService('todo', 'update_item', {
              entity_id: entityId, item: link.uid, description: stripLegacyMarker(linkedTask.description),
            }).catch((err) => note(`${label}: couldn't clean notes: ${err instanceof Error ? err.message : String(err)}`));
          }

          const googleStatus = linkedTask?.status ?? 'missing';
          const { changed, action } = await reconcileOne(
            entityId, link, beaconStatus, itemsByUid, LINKS_COLLECTION,
            async (status) => {
              if (status === 'completed') await store.completeChore(chore.id, memberId);
              else await store.uncompleteChore(chore.id, memberId);
            },
          );
          note(`${label}: family=${beaconStatus} google=${googleStatus} lastAgreed=${link.last_synced_status} -> ${action}`);
          if (changed) choresChanged = true;
        }
      }

      for (const link of linksByKey.values()) {
        if (desiredChoreKeys.has(choreLinkKey(link))) continue;
        const entityId = listByMember[link.member_id];
        note(`link for ${choreLinkKey(link)} has no matching assigned chore: deleting Google task ${link.uid}`);
        if (entityId) {
          await callHaService('todo', 'remove_item', { entity_id: entityId, item: link.uid }, false, `chores-sync: chore link ${choreLinkKey(link)} no longer matches an assigned chore`).catch(() => {});
        }
        await removeFromCollection(LINKS_COLLECTION, link.id);
      }

      if (choresChanged) notifyFamilyDataChanged();
    } catch (err) {
      console.warn('Beacon: chores sync failed', err);
      note(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      syncingRef.current = false;
      if (verbose) void callBeaconAction('/beacon-action/log', { lines: report }).catch(() => {});
    }
  }, [enabled, listByMember, members, store]);

  // The interval below outlives renders; calling through this ref makes
  // each tick use the latest chores/completions instead of the ones from
  // when the interval was created.
  const runSyncRef = useRef(runSync);
  runSyncRef.current = runSync;

  useEffect(() => {
    const hasAnyList = Object.keys(listByMember).length > 0;
    if (!enabled || !hasAnyList) return;
    void runSyncRef.current();
    const interval = setInterval(() => void runSyncRef.current(), 60_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, JSON.stringify(listByMember), members.length]);

  return { runSync };
}
