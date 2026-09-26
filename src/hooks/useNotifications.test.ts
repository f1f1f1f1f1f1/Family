import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNotifications } from './useNotifications';
import type { CalendarEvent } from '../types';

const shown: string[] = [];

beforeEach(() => {
  shown.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 26, 15, 50));
  vi.stubGlobal('Notification', Object.assign(
    function Notification(title: string) { shown.push(title); },
    { permission: 'granted', requestPermission: vi.fn() },
  ));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const at = (id: string, start: string): CalendarEvent => ({
  id, title: id, start, end: start, allDay: false, calendarId: 'c', calendarName: 'C', color: '#000',
});

describe('useNotifications', () => {
  // Settings > Notification Timing was ignored: it was always 15 minutes.
  it('notifies the chosen number of minutes ahead', () => {
    const events = [at('in-4-min', '2026-09-26T15:54:00'), at('in-10-min', '2026-09-26T16:00:00')];
    renderHook(() => useNotifications(events, () => null, true, 5));
    expect(shown).toEqual(['in-4-min']);
  });

  it('notifies each occurrence of a repeating event', () => {
    const events = [at('series-1::20260926T155500', '2026-09-26T15:55:00'), at('series-1::20260926T155800', '2026-09-26T15:58:00')];
    renderHook(() => useNotifications(events, () => null, true, 10));
    expect(shown).toHaveLength(2);
  });
});
