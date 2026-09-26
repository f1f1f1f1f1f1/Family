/**
 * Whether the screen saver covers the app (its clock / photo stage, not the
 * dim stage, where the screen is still readable). A wall display spends
 * most of the day there, so background refreshes skip their turn while it
 * does — and while the page is hidden — and catch up the moment the screen
 * is looked at again.
 */

let asleep = false;
const wakeListeners = new Set<() => void>();

export function isDisplayAsleep(): boolean {
  return asleep;
}

/** Set by ScreenSaver. */
export function setDisplayAsleep(value: boolean): void {
  if (value === asleep) return;
  asleep = value;
  if (!asleep) wakeListeners.forEach((listener) => listener());
}

/**
 * Calls `refresh` every `intervalMs` while the display is awake and the page
 * visible. A turn skipped while it wasn't is made up as soon as it is again.
 * Returns the cleanup.
 */
export function refreshWhileAwake(refresh: () => void, intervalMs: number): () => void {
  let missed = false;
  const tick = () => {
    if (document.hidden || asleep) {
      missed = true;
      return;
    }
    refresh();
  };
  const catchUp = () => {
    if (!missed || document.hidden || asleep) return;
    missed = false;
    refresh();
  };

  const interval = setInterval(tick, intervalMs);
  wakeListeners.add(catchUp);
  document.addEventListener('visibilitychange', catchUp);
  return () => {
    clearInterval(interval);
    wakeListeners.delete(catchUp);
    document.removeEventListener('visibilitychange', catchUp);
  };
}
