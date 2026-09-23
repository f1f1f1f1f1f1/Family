/**
 * Unified read/write helper for Beacon data persistence.
 *
 * Server (/beacon-data/:key) is the source of truth when running as an
 * HA add-on.  localStorage serves as an offline cache and as the primary
 * store during local development (no add-on server).
 */

function isAddOn(): boolean {
  return !!window.__BEACON_CONFIG__;
}

function getIngressBasePath(): string {
  return window.location.pathname.replace(/\/$/, '');
}

/**
 * Read from server first, fall back to localStorage.
 * In non-add-on mode, reads from localStorage only.
 */
export async function loadData<T>(key: string, fallback: T): Promise<T> {
  if (isAddOn()) {
    try {
      const base = getIngressBasePath();
      const res = await fetch(`${base}/beacon-data/${key}`);
      if (res.ok) {
        const data = await res.json();
        if (data !== null) {
          // Cache to localStorage for offline/speed
          localStorage.setItem(key, JSON.stringify(data));
          return data as T;
        }
      }
    } catch {
      /* fall through to localStorage */
    }
  }
  // Fall back to localStorage
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* ignore */
  }
  return fallback;
}

/**
 * Read from localStorage only (synchronous, for initial render).
 * Used to provide instant data before the async server fetch completes.
 */
export function loadDataSync<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* ignore */
  }
  return fallback;
}

/**
 * Write to localStorage AND server (best-effort, but using sendBeacon for
 * reliable delivery).
 *
 * A plain fetch() here can be silently cut off if the page/device goes
 * away (power off, app kill) before the request completes — since the
 * server copy is treated as the source of truth on next load (for
 * multi-device sync), a lost write here means the NEXT boot re-fetches a
 * stale server value and overwrites the correct local one, effectively
 * reverting the change. navigator.sendBeacon is built specifically for
 * "this page may disappear any moment, but deliver this anyway" — the
 * browser queues it at the OS/process level rather than tying it to the
 * page's lifetime, so it reliably survives a close/reload/power-off in a
 * way fetch does not.
 */
export async function saveData<T>(key: string, data: T): Promise<void> {
  const json = JSON.stringify(data);
  try {
    localStorage.setItem(key, json);
  } catch {
    /* localStorage unavailable */
  }
  if (isAddOn()) {
    const base = getIngressBasePath();
    const url = `${base}/beacon-data/${key}`;
    const delivered = 'sendBeacon' in navigator
      ? navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }))
      : false;
    if (!delivered) {
      // sendBeacon unsupported, or its queue was full (payload too large /
      // too many pending beacons) — fall back to a normal fetch.
      fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      }).catch(() => {
        /* server persistence is best-effort */
      });
    }
  }
}
