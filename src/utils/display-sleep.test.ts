import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshWhileAwake, setDisplayAsleep } from './display-sleep';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('refreshWhileAwake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    setDisplayAsleep(false);
    setHidden(false);
    vi.useRealTimers();
  });

  it('refreshes on every interval while awake', () => {
    const refresh = vi.fn();
    const stop = refreshWhileAwake(refresh, 1000);
    vi.advanceTimersByTime(3000);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(3000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('skips turns under the screen saver and makes one up on waking', () => {
    const refresh = vi.fn();
    const stop = refreshWhileAwake(refresh, 1000);
    setDisplayAsleep(true);
    vi.advanceTimersByTime(10_000);
    expect(refresh).not.toHaveBeenCalled();

    setDisplayAsleep(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("doesn't refresh on waking when no turn was skipped", () => {
    const refresh = vi.fn();
    const stop = refreshWhileAwake(refresh, 60_000);
    setDisplayAsleep(true);
    vi.advanceTimersByTime(5000);
    setDisplayAsleep(false);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it('skips turns while the page is hidden and makes one up when shown', () => {
    const refresh = vi.fn();
    const stop = refreshWhileAwake(refresh, 1000);
    setHidden(true);
    vi.advanceTimersByTime(5000);
    expect(refresh).not.toHaveBeenCalled();

    setHidden(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });
});
