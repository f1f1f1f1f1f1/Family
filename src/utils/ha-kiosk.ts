/**
 * Home Assistant kiosk mode for the add-on panel.
 *
 * HA's app panel (frontend src/panels/app/ha-panel-app.ts, HA 2026.1+)
 * listens for postMessages from the add-on's iframe. Subscribing to its
 * properties with `kioskMode: true` switches HA into kiosk mode, hiding
 * its top bar and sidebar; unsubscribing turns it back off, and HA also
 * turns it off by itself when the user leaves the add-on. Older HA
 * versions ignore these messages.
 */

import { isAddOn } from './ha-env';

function postToHa(message: Record<string, unknown>): void {
  if (!isAddOn() || window.parent === window) return;
  // The ingress iframe is served from HA's own origin.
  window.parent.postMessage(message, window.location.origin);
}

export function setHaKioskMode(enabled: boolean): void {
  postToHa(enabled
    ? { type: 'home-assistant/subscribe-properties', kioskMode: true }
    : { type: 'home-assistant/unsubscribe-properties' });
}

/** Whether Family is shown inside Home Assistant's add-on panel. */
export function isInHaPanel(): boolean {
  return isAddOn() && window.parent !== window;
}

/** Leave kiosk mode and go to Home Assistant's default dashboard. */
export function exitToHomeAssistant(): void {
  setHaKioskMode(false);
  postToHa({ type: 'home-assistant/navigate', path: '/' });
}
