import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

const RELOAD_KEY = 'beacon-lazy-reload-at';
/** Don't reload again this soon, so a file that's genuinely broken can't cause a reload loop. */
const RELOAD_GUARD_MS = 60_000;

/**
 * After an add-on update the previous build's files are gone, but a wall
 * display that hasn't reloaded since still asks for them (and gets
 * index.html back), so its import fails. Reload once to pick up the new
 * build. Returns false if we already did that moments ago.
 */
function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < RELOAD_GUARD_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

// `any` matches React.lazy's own constraint; prop types still flow through.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

export type PreloadableComponent<T extends AnyComponent> = LazyExoticComponent<T> & {
  /** Start downloading now, e.g. for the screen a device opens on. */
  preload: () => void;
};

/**
 * React.lazy for a named export: the module is downloaded the first time the
 * component renders (or `preload()` is called). Render it inside a
 * <LazyBoundary>.
 */
export function lazyNamed<K extends string, M extends Record<K, AnyComponent>>(
  load: () => Promise<M>,
  exportName: K,
): PreloadableComponent<M[K]> {
  let loading: Promise<{ default: M[K] }> | undefined;
  const loadOnce = () =>
    (loading ??= load().then(
      (module) => ({ default: module[exportName] }),
      (err) => {
        // Keep showing the loading fallback while the page reloads.
        if (reloadForNewBuild()) return new Promise<never>(() => {});
        throw err;
      },
    ));
  return Object.assign(lazy(loadOnce), {
    preload: () => {
      loadOnce().catch(() => {
        // Reported by <LazyBoundary> when the component renders.
      });
    },
  });
}
