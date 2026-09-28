import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAirPlayStatus, type AirPlayStatus } from '../api/airplay';
import type { SidebarView } from '../components/Sidebar';
import { isAddOn } from '../utils/ha-env';

/**
 * Whether the add-on has an AirPlay receiver, and whether something is
 * being sent to it, so the AirPlay screen can be offered and opened.
 *
 * This isn't paused under the screen saver (refreshWhileAwake): a phone
 * starting to mirror should wake the display. It is while the page is
 * hidden, and while `active` is false (the Kid Display replacing the app).
 */

/** While the receiver is on: how soon a screen notices something being sent. */
const POLL_ON_MS = 3_000;
/** While it's off, in case it's turned on. */
const POLL_OFF_MS = 5 * 60_000;
/** When the add-on has never answered. */
const POLL_RETRY_MS = 30_000;

export function isAirPlayStreaming(status: AirPlayStatus | null): boolean {
  return !!status?.enabled && (status.state === 'mirroring' || status.state === 'audio');
}

const sameStatus = (a: AirPlayStatus, b: AirPlayStatus) => JSON.stringify(a) === JSON.stringify(b);

export function useAirPlayStatus(active = true) {
  const available = isAddOn() && active;
  const [status, setStatus] = useState<AirPlayStatus | null>(null);
  const statusRef = useRef<AirPlayStatus | null>(null);

  /** Also takes the status the AirPlay screen gets over its stream, which is sooner. */
  const report = useCallback((next: AirPlayStatus) => {
    if (statusRef.current && sameStatus(statusRef.current, next)) return;
    statusRef.current = next;
    setStatus(next);
  }, []);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let missed = false;

    const poll = async () => {
      const next = await fetchAirPlayStatus();
      if (cancelled) return;
      if (next) report(next);
      const known = statusRef.current;
      timer = setTimeout(tick, !known ? POLL_RETRY_MS : known.enabled ? POLL_ON_MS : POLL_OFF_MS);
    };
    const tick = () => {
      if (document.hidden) missed = true;
      else void poll();
    };
    const onVisibilityChange = () => {
      if (document.hidden || !missed) return;
      missed = false;
      void poll();
    };

    tick();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [available, report]);

  return { status, report };
}

const AUTO_OPEN_KEY = 'beacon_airplay_auto_open';

function readAutoOpen(): boolean {
  try {
    return localStorage.getItem(AUTO_OPEN_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * Whether this display opens the AirPlay screen by itself. Kept on the
 * device rather than in BeaconSettings, which every display shares: with
 * several displays, only the ones chosen should show what's sent, and
 * play its sound.
 */
export function useAirPlayAutoOpenSetting(): [boolean, (on: boolean) => void] {
  const [autoOpen, setAutoOpen] = useState(readAutoOpen);
  const change = useCallback((on: boolean) => {
    setAutoOpen(on);
    try {
      if (on) localStorage.removeItem(AUTO_OPEN_KEY);
      else localStorage.setItem(AUTO_OPEN_KEY, 'off');
    } catch {
      /* localStorage unavailable: for this visit only */
    }
  }, []);
  return [autoOpen, change];
}

/**
 * With `autoOpen` (Settings → Display, see useAirPlayAutoOpenSetting), opens the AirPlay screen
 * when a device starts sending to the receiver, and goes back to the
 * screen it was on when the device disconnects, unless someone has moved
 * on from the AirPlay screen since. A pause (connected, sending nothing)
 * stays put. The AirPlay screen is left if the receiver is turned off.
 */
export function useAirPlayAutoOpen(
  status: AirPlayStatus | null,
  activeView: SidebarView,
  changeView: (view: SidebarView) => void,
  autoOpen: boolean,
) {
  const seenRef = useRef<AirPlayStatus | null>(null);
  const returnToRef = useRef<SidebarView | null>(null);

  useEffect(() => {
    if (activeView !== 'airplay') returnToRef.current = null;
  }, [activeView]);

  useEffect(() => {
    if (!status) return;
    const seen = seenRef.current;
    seenRef.current = status;
    if (!status.enabled) {
      if (activeView === 'airplay') changeView(returnToRef.current ?? 'dashboard');
      returnToRef.current = null;
      return;
    }
    if (status === seen) return;
    if (isAirPlayStreaming(status) && !isAirPlayStreaming(seen)) {
      if (autoOpen && activeView !== 'airplay') {
        returnToRef.current = activeView;
        changeView('airplay');
      }
    } else if (status.state === 'idle' && seen && seen.state !== 'idle') {
      const back = returnToRef.current;
      returnToRef.current = null;
      if (back && activeView === 'airplay') changeView(back);
    }
  }, [status, activeView, changeView, autoOpen]);
}
