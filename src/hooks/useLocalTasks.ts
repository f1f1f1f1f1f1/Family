import { useCallback } from 'react';
import { useStoredData } from './useStoredData';

/**
 * Built-in local task/todo list synced via beacon-store.
 * Server is source of truth in add-on mode; localStorage is offline cache.
 */

export interface LocalTask {
  id: string;
  summary: string;
  status: 'needs_action' | 'completed';
  listId: string;
  createdAt: string;
  completedAt?: string;
}

export interface LocalTaskList {
  id: string;
  name: string;
}

const STORAGE_KEY = 'beacon-local-tasks';
const LISTS_KEY = 'beacon-local-task-lists';

// Default built-in lists
const DEFAULT_LISTS: LocalTaskList[] = [
  { id: 'beacon-todo', name: 'To-Do' },
  { id: 'beacon-shopping', name: 'Shopping List' },
];

const NO_TASKS: LocalTask[] = [];

export function useLocalTasks() {
  const [lists, setLists, refreshLists] = useStoredData<LocalTaskList[]>(LISTS_KEY, DEFAULT_LISTS);
  const [tasks, setTasks, refreshTasks] = useStoredData<LocalTask[]>(STORAGE_KEY, NO_TASKS);

  /** Re-fetch tasks and lists from server. */
  const refresh = useCallback(async () => {
    await Promise.all([refreshLists(), refreshTasks()]);
  }, [refreshLists, refreshTasks]);

  const getTasksForList = useCallback((listId: string) => {
    return tasks.filter(t => t.listId === listId);
  }, [tasks]);

  const addTask = useCallback((listId: string, summary: string) => {
    const task: LocalTask = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      summary,
      status: 'needs_action',
      listId,
      createdAt: new Date().toISOString(),
    };
    setTasks(prev => [...prev, task]);
    return task;
  }, [setTasks]);

  const toggleTask = useCallback((taskId: string) => {
    setTasks(prev => prev.map(t =>
      t.id === taskId
        ? t.status === 'needs_action'
          ? { ...t, status: 'completed', completedAt: new Date().toISOString() }
          : { ...t, status: 'needs_action', completedAt: undefined }
        : t
    ));
  }, [setTasks]);

  const removeTask = useCallback((taskId: string) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
  }, [setTasks]);

  const addList = useCallback((name: string) => {
    const list: LocalTaskList = {
      id: `beacon-${Date.now()}`,
      name,
    };
    setLists(prev => [...prev, list]);
    return list;
  }, [setLists]);

  const removeList = useCallback((listId: string) => {
    setLists(prev => prev.filter(l => l.id !== listId));
    setTasks(prev => prev.filter(t => t.listId !== listId));
  }, [setLists, setTasks]);

  return {
    lists,
    tasks,
    getTasksForList,
    addTask,
    toggleTask,
    removeTask,
    addList,
    removeList,
    refresh,
  };
}
