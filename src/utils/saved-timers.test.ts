import { describe, it, expect } from 'vitest';
import { hasActiveSavedTimers, loadSavedTimers, saveTimers, type SavedTimer } from './saved-timers';

const timer = (over: Partial<SavedTimer> = {}): SavedTimer => ({
  id: 't-1-1', name: 'Pasta', totalMs: 60_000, elapsedMs: 0, savedAt: 0, running: true, finished: false, ...over,
});

describe('saved timers', () => {
  it('loads what was saved, and forgets them once none are left', () => {
    saveTimers([timer()]);
    expect(loadSavedTimers()).toEqual([timer()]);

    saveTimers([]);
    expect(localStorage.getItem('beacon-timers')).toBeNull();
  });

  it("skips anything that isn't a saved timer", () => {
    localStorage.setItem('beacon-timers', JSON.stringify([timer(), { id: 't-2-2' }, null, 'x']));
    expect(loadSavedTimers()).toEqual([timer()]);

    localStorage.setItem('beacon-timers', '{not json');
    expect(loadSavedTimers()).toEqual([]);
  });

  it('needs the Timer screen at startup only for a timer counting down or ringing', () => {
    expect(hasActiveSavedTimers()).toBe(false);
    saveTimers([timer({ running: false })]);
    expect(hasActiveSavedTimers()).toBe(false);
    saveTimers([timer({ running: false, finished: true })]);
    expect(hasActiveSavedTimers()).toBe(true);
    saveTimers([timer()]);
    expect(hasActiveSavedTimers()).toBe(true);
  });
});
