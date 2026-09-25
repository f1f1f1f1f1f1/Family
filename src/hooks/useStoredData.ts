import { useCallback, useEffect, useRef, useState } from 'react';
import { loadData, loadDataSync, saveData } from '../api/beacon-store';

/**
 * State backed by a /beacon-data key (server copy is the source of truth
 * in add-on mode; localStorage is the offline cache).
 *
 * Only changes made through `update` are saved. Values that were merely
 * loaded — the local cache on first render, or the server copy on mount /
 * when the app becomes visible again — are never written back. Saving on
 * every state change used to push a device's stale local cache to the
 * server the moment it opened, overwriting newer changes made elsewhere.
 */
export function useStoredData<T>(key: string, fallback: T, normalize: (value: T) => T = (v) => v) {
  const fallbackRef = useRef(fallback);
  const normalizeRef = useRef(normalize);
  normalizeRef.current = normalize;

  const [value, setValue] = useState<T>(() => normalize(loadDataSync(key, fallback)));
  const valueRef = useRef(value);

  /** Re-fetch from the server, without saving. */
  const refresh = useCallback(async () => {
    const loaded = normalizeRef.current(await loadData(key, fallbackRef.current));
    valueRef.current = loaded;
    setValue(loaded);
  }, [key]);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  /**
   * Apply a change and save the result. Pass `save: false` when the caller
   * persists the change itself (e.g. as a partial update).
   */
  const update = useCallback((updater: (prev: T) => T, save = true): T => {
    const next = updater(valueRef.current);
    valueRef.current = next;
    setValue(next);
    if (save) void saveData(key, next);
    return next;
  }, [key]);

  return [value, update, refresh] as const;
}
