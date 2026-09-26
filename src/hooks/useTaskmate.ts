import { useState, useEffect } from 'react';
import { fetchAllStates, getEntityState, hasToken, ENTITY_LIST_MAX_AGE_MS } from '../api/ha-rest';
import { TaskmateUser, TaskmateCompletion } from '../types/taskmate';
import { refreshWhileAwake } from '../utils/display-sleep';

interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

interface OverviewChild {
  id: string;
  name: string;
}

interface CompletionRaw {
  chore_id?: string;
  child_id?: string;
  chore_name?: string;
  completed_at?: string;
}

export interface UseTaskmateResult {
  users: TaskmateUser[];
  listByUser: Record<string, TaskmateUser>;
  completions: TaskmateCompletion[];
}

function findOverview(states: HaState[]): HaState | undefined {
  return states.find(
    (s) =>
      s.entity_id.startsWith('sensor.') &&
      s.entity_id.endsWith('_overview') &&
      Array.isArray(s.attributes.children),
  );
}

/** `enabled: false` stops the minute-by-minute refresh; turning it back on fetches at once. */
export function useTaskmate(connected: boolean, enabled = true): UseTaskmateResult {
  const [users, setUsers] = useState<TaskmateUser[]>([]);
  const [completions, setCompletions] = useState<TaskmateCompletion[]>([]);

  useEffect(() => {
    if (!enabled || (!connected && !hasToken())) return;

    async function fetchTaskmate() {
      try {
        // Which lists and sensors are TaskMate's comes from a copy of all
        // states up to ENTITY_LIST_MAX_AGE_MS old; today's completions are
        // read fresh from their sensor below.
        const states = (await fetchAllStates(ENTITY_LIST_MAX_AGE_MS)) as HaState[];
        const byEntity = new Map(states.map((s) => [s.entity_id, s]));

        const overview = findOverview(states);
        if (!overview) {
          setUsers([]);
          setCompletions([]);
          return;
        }

        const byChildId = new Map(
          ((overview.attributes.children as OverviewChild[]) ?? []).map((c) => [c.id, c]),
        );

        const resolved: TaskmateUser[] = [];
        const seen = new Set<string>();

        for (const s of states) {
          if (!s.entity_id.startsWith('todo.') || s.state === 'unavailable') continue;
          const stats = byEntity.get(`sensor.${s.entity_id.slice('todo.'.length)}_stats`);
          const childId = stats ? (stats.attributes.child_id as string | undefined) : undefined;
          const child = childId ? byChildId.get(childId) : undefined;
          if (!child || seen.has(child.id)) continue;
          seen.add(child.id);

          resolved.push({ childId: child.id, name: child.name, todoListId: s.entity_id });
        }

        resolved.sort((a, b) => a.name.localeCompare(b.name));
        setUsers(resolved);

        const listed = states.find((s) => Array.isArray(s.attributes.todays_completions));
        const choresSensor = listed ? (await getEntityState(listed.entity_id)) ?? listed : undefined;
        const raw = (choresSensor?.attributes.todays_completions as CompletionRaw[] | undefined) ?? [];
        const seenComp = new Set<string>();
        const done: TaskmateCompletion[] = [];
        for (const c of raw) {
          if (!c.chore_id || !c.child_id) continue;
          const key = `${c.child_id}:${c.chore_id}`;
          if (seenComp.has(key)) continue;
          seenComp.add(key);
          done.push({
            uid: c.chore_id,
            summary: c.chore_name ?? '',
            userId: c.child_id,
            completedAt: c.completed_at ?? '',
          });
        }
        setCompletions(done);
      } catch (err) {
        console.warn('Failed to fetch TaskMate users:', err);
      }
    }

    fetchTaskmate();
    return refreshWhileAwake(fetchTaskmate, 60_000);
  }, [connected, enabled]);

  const listByUser: Record<string, TaskmateUser> = {};
  for (const u of users) listByUser[u.todoListId] = u;

  return { users, listByUser, completions };
}
