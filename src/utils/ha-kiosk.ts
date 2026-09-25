/**
 * Options for Home Assistant's add-on panel.
 *
 * HA's app panel (frontend src/panels/app/ha-panel-app.ts, HA 2026.1+)
 * listens for postMessages from the add-on's iframe. Subscribing to its
 * properties can ask for:
 * - `kioskMode`: hide HA's top bar and sidebar. Only unsubscribing turns
 *   it back off; HA also turns it off when the user leaves the add-on.
 * - `handleSafeArea`: stop HA padding the iframe for the notch / home bar,
 *   so the add-on can draw edge to edge. HA then sends the inset sizes in
 *   `home-assistant/properties` messages.
 * Older HA versions ignore these messages.
 */

import { isAddOn } from './ha-env';

let kioskMode = false;
let fullBleedRequests = 0;

function postToHa(message: Record<string, unknown>): void {
  if (!isAddOn() || window.parent === window) return;
  // The ingress iframe is served from HA's own origin.
  window.parent.postMessage(message, window.location.origin);
}

/** Send the current combination of panel options to HA. */
function syncPanel(): void {
  const handleSafeArea = fullBleedRequests > 0;
  if (!kioskMode && !handleSafeArea) {
    postToHa({ type: 'home-assistant/unsubscribe-properties' });
    return;
  }
  // Re-subscribing updates handleSafeArea; kioskMode only ever turns on
  // this way (turning it off needs the unsubscribe in setHaKioskMode).
  postToHa({ type: 'home-assistant/subscribe-properties', kioskMode, handleSafeArea });
}

export function setHaKioskMode(enabled: boolean): void {
  if (kioskMode && !enabled) postToHa({ type: 'home-assistant/unsubscribe-properties' });
  kioskMode = enabled;
  syncPanel();
}

/**
 * Let a full-screen view (photo slideshow, photo screensaver) draw under
 * the notch and home bar instead of inside HA's safe-area padding. Returns
 * a function that releases the request; HA's padding comes back once no
 * view needs it.
 */
export function requestFullBleed(): () => void {
  fullBleedRequests += 1;
  if (fullBleedRequests === 1) syncPanel();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fullBleedRequests -= 1;
    if (fullBleedRequests === 0) syncPanel();
  };
}

// While drawing edge to edge, HA reports the safe-area insets; expose them
// as CSS variables (--ha-safe-top/right/bottom/left) so overlays such as
// the photo clock and controls stay clear of the notch and home bar.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== 'home-assistant/properties') return;
    const insets = event.data.safeAreaInsets as Record<string, string> | undefined;
    if (!insets) return;
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      document.documentElement.style.setProperty(`--ha-safe-${side}`, insets[side] || '0px');
    }
  });
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
