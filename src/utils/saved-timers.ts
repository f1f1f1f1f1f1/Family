/**
 * The Timer screen's countdowns and stopwatch, kept in this browser's
 * localStorage so a reload (an add-on update reloads the page too) doesn't
 * lose them. Each is saved with how much of it had run at a moment on the
 * wall clock, because performance.now(), which the screen counts with,
 * starts again in a reloaded page.
 */
const SAVED_TIMERS_KEY = 'beacon-timers';
const SAVED_STOPWATCH_KEY = 'beacon-stopwatch';

export interface SavedTimer {
  id: string;
  name: string;
  totalMs: number;
  /** How much had run at `savedAt`. */
  elapsedMs: number;
  /** Date.now() when saved. */
  savedAt: number;
  running: boolean;
  finished: boolean;
}

function isSavedTimer(value: unknown): value is SavedTimer {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return typeof t.id === 'string' && typeof t.name === 'string'
    && Number.isFinite(t.totalMs) && Number.isFinite(t.elapsedMs) && Number.isFinite(t.savedAt)
    && typeof t.running === 'boolean' && typeof t.finished === 'boolean';
}

export function loadSavedTimers(): SavedTimer[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SAVED_TIMERS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isSavedTimer) : [];
  } catch {
    return [];
  }
}

export function saveTimers(timers: SavedTimer[]): void {
  try {
    if (timers.length === 0) localStorage.removeItem(SAVED_TIMERS_KEY);
    else localStorage.setItem(SAVED_TIMERS_KEY, JSON.stringify(timers));
  } catch { /* storage unavailable: the timers just won't outlast a reload */ }
}

/**
 * Whether a saved timer is counting down or ringing, so the Timer screen
 * has to be mounted (hidden) at startup for it to ring.
 */
export function hasActiveSavedTimers(): boolean {
  return loadSavedTimers().some((t) => t.running || t.finished);
}

export interface SavedStopwatch {
  /** The time on it at `savedAt`. */
  elapsedMs: number;
  /** Date.now() when saved. */
  savedAt: number;
  running: boolean;
  /** Its reading at each lap. */
  laps: number[];
}

function isSavedStopwatch(value: unknown): value is SavedStopwatch {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return Number.isFinite(s.elapsedMs) && Number.isFinite(s.savedAt) && typeof s.running === 'boolean'
    && Array.isArray(s.laps) && s.laps.every((lap) => Number.isFinite(lap));
}

export function loadSavedStopwatch(): SavedStopwatch | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SAVED_STOPWATCH_KEY) ?? 'null');
    return isSavedStopwatch(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Saves the stopwatch; null (it was reset) forgets it. */
export function saveStopwatch(stopwatch: SavedStopwatch | null): void {
  try {
    if (stopwatch) localStorage.setItem(SAVED_STOPWATCH_KEY, JSON.stringify(stopwatch));
    else localStorage.removeItem(SAVED_STOPWATCH_KEY);
  } catch { /* storage unavailable: the stopwatch just won't outlast a reload */ }
}
