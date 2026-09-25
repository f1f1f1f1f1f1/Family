import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./ha-env', () => ({ isAddOn: () => true }));

const posted: Record<string, unknown>[] = [];
Object.defineProperty(window, 'parent', {
  configurable: true,
  value: { postMessage: (message: Record<string, unknown>) => posted.push(message) },
});

import { requestFullBleed, setHaKioskMode } from './ha-kiosk';

beforeEach(() => {
  posted.length = 0;
});

describe('HA panel options', () => {
  it('asks HA to stop safe-area padding while a full-screen view is open, and restores it after', () => {
    const release = requestFullBleed();
    expect(posted).toEqual([
      { type: 'home-assistant/subscribe-properties', kioskMode: false, handleSafeArea: true },
    ]);
    release();
    expect(posted.at(-1)).toEqual({ type: 'home-assistant/unsubscribe-properties' });
  });

  it('keeps kiosk mode on when a full-screen view closes', () => {
    setHaKioskMode(true);
    const release = requestFullBleed();
    expect(posted.at(-1)).toEqual({ type: 'home-assistant/subscribe-properties', kioskMode: true, handleSafeArea: true });
    release();
    expect(posted.at(-1)).toEqual({ type: 'home-assistant/subscribe-properties', kioskMode: true, handleSafeArea: false });
    setHaKioskMode(false);
  });

  it('only restores padding once every full-screen view has closed', () => {
    const a = requestFullBleed();
    const b = requestFullBleed();
    posted.length = 0;
    a();
    expect(posted).toEqual([]);
    b();
    expect(posted).toEqual([{ type: 'home-assistant/unsubscribe-properties' }]);
  });

  it('sets CSS variables from the insets HA reports', () => {
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent as MessageEventSource,
      data: { type: 'home-assistant/properties', safeAreaInsets: { top: '47px', right: '0px', bottom: '34px', left: '0px' } },
    }));
    expect(document.documentElement.style.getPropertyValue('--ha-safe-top')).toBe('47px');
    expect(document.documentElement.style.getPropertyValue('--ha-safe-bottom')).toBe('34px');
  });
});
