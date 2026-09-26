import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCalendarEvents, CALENDAR_LIST_MAX_AGE_MS } from './useCalendarEvents';
import { haFetch } from '../api/ha-rest';

vi.mock('../api/ha-rest', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/ha-rest')>(),
  hasToken: () => true,
  haFetch: vi.fn(),
}));

const calendarLists = () => vi.mocked(haFetch).mock.calls.filter(([path]) => path === '/api/calendars');

describe('useCalendarEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(haFetch).mockReset();
    vi.mocked(haFetch).mockImplementation(async (path: string) => {
      if (path === '/api/calendars') {
        return [
          { entity_id: 'calendar.family', name: 'Family' },
          { entity_id: 'calendar.work', name: 'Work' },
        ];
      }
      if (path.startsWith('/api/calendars/calendar.family')) {
        return [{ uid: 'a', summary: 'Soccer', start: { dateTime: '2026-09-26T16:00:00' }, end: { dateTime: '2026-09-26T17:00:00' } }];
      }
      return [{ summary: 'Standup', start: { dateTime: '2026-09-26T09:00:00' }, end: { dateTime: '2026-09-26T09:15:00' } }];
    });
  });

  afterEach(() => vi.useRealTimers());

  // Changing week or calendar colors used to ask HA for the calendar list
  // each time, on top of the events themselves.
  it('reuses the calendar list until it is CALENDAR_LIST_MAX_AGE_MS old', async () => {
    const { result } = renderHook(() => useCalendarEvents(true));

    await act(() => result.current.fetchCalendars());
    await act(() => result.current.fetchCalendars());
    expect(calendarLists()).toHaveLength(1);

    vi.setSystemTime(Date.now() + CALENDAR_LIST_MAX_AGE_MS);
    await act(() => result.current.fetchCalendars());
    expect(calendarLists()).toHaveLength(2);
  });

  it('recolors cached calendars with the latest settings', async () => {
    let colors: Record<string, string> = {};
    const { result, rerender } = renderHook(() => useCalendarEvents(true, { calendarColors: colors }));
    await act(() => result.current.fetchCalendars());

    colors = { 'calendar.family': '#123456' };
    rerender();
    await act(() => result.current.fetchCalendars());

    expect(calendarLists()).toHaveLength(1);
    expect(result.current.calendars.find((c) => c.id === 'calendar.family')?.color).toBe('#123456');
  });

  it("loads every calendar's events, in start order", async () => {
    const { result } = renderHook(() => useCalendarEvents(true));
    await act(() => result.current.fetchEvents('2026-09-25T00:00:00Z', '2026-09-28T00:00:00Z'));

    expect(result.current.events.map((e) => [e.title, e.calendarId, e.hasStableId])).toEqual([
      ['Standup', 'calendar.work', false],
      ['Soccer', 'calendar.family', true],
    ]);
  });
});
