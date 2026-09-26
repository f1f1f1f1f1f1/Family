import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCalendarEvents, CALENDAR_LIST_MAX_AGE_MS } from './useCalendarEvents';
import { callBeaconAction, haFetch } from '../api/ha-rest';

vi.mock('../api/ha-rest', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/ha-rest')>(),
  hasToken: () => true,
  haFetch: vi.fn(),
  callBeaconAction: vi.fn(),
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

  // Every occurrence of a repeating event carries the series' uid. They all
  // got that uid as their id, so an edit or delete of one hit them all.
  it('gives each occurrence of a repeating event its own id', async () => {
    const weekly = (day: string) => ({
      uid: 'series-1',
      recurrence_id: `202609${day}T160000`,
      rrule: 'FREQ=WEEKLY',
      summary: 'Soccer',
      start: { dateTime: `2026-09-${day}T16:00:00` },
      end: { dateTime: `2026-09-${day}T17:00:00` },
    });
    vi.mocked(haFetch).mockImplementation(async (path: string) =>
      path === '/api/calendars' ? [{ entity_id: 'calendar.family', name: 'Family' }] : [weekly('19'), weekly('26')]);
    const { result } = renderHook(() => useCalendarEvents(true));
    await act(() => result.current.fetchEvents('2026-09-18T00:00:00Z', '2026-09-28T00:00:00Z'));

    expect(result.current.events.map((e) => [e.id, e.uid, e.recurrenceId, e.recurrence])).toEqual([
      ['series-1::20260919T160000', 'series-1', '20260919T160000', 'weekly'],
      ['series-1::20260926T160000', 'series-1', '20260926T160000', 'weekly'],
    ]);
  });

  // Switching weeks quickly: the answer for the week left behind can
  // arrive last, and used to replace the events of the week on screen.
  it('drops events for a week no longer asked for', async () => {
    let answerFirst: (v: unknown) => void = () => {};
    vi.mocked(haFetch).mockImplementation(async (path: string) => {
      if (path === '/api/calendars') return [{ entity_id: 'calendar.family', name: 'Family' }];
      if (path.includes('2026-09-01')) return new Promise((resolve) => { answerFirst = resolve; });
      return [{ uid: 'b', summary: 'Second week', start: { dateTime: '2026-09-09T09:00:00' }, end: { dateTime: '2026-09-09T10:00:00' } }];
    });
    const { result } = renderHook(() => useCalendarEvents(true));
    await act(() => result.current.fetchCalendars());

    let first!: Promise<void>;
    act(() => { first = result.current.fetchEvents('2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z'); });
    await act(() => result.current.fetchEvents('2026-09-08T00:00:00Z', '2026-09-15T00:00:00Z'));
    await act(async () => {
      answerFirst([{ uid: 'a', summary: 'First week', start: { dateTime: '2026-09-02T09:00:00' }, end: { dateTime: '2026-09-02T10:00:00' } }]);
      await first;
    });

    expect(result.current.events.map((e) => e.title)).toEqual(['Second week']);
    expect(result.current.loading).toBe(false);
  });

  it('sends which occurrences an update or delete is for', async () => {
    const { result } = renderHook(() => useCalendarEvents(true));
    const event = { summary: 'Soccer', start_date_time: '2026-09-26T17:00:00', end_date_time: '2026-09-26T18:00:00' };
    await act(() => result.current.updateEvent('calendar.family', 'series-1', event, { recurrenceId: 'r1' }));
    await act(() => result.current.deleteEvent('calendar.family', 'series-1', { recurrenceId: 'r1', recurrenceRange: 'THISANDFUTURE' }));

    expect(vi.mocked(callBeaconAction).mock.calls).toEqual([
      ['/beacon-action/calendar-event', expect.objectContaining({ op: 'update', uid: 'series-1', recurrence_id: 'r1' })],
      ['/beacon-action/calendar-event', { op: 'delete', entity_id: 'calendar.family', uid: 'series-1', recurrence_id: 'r1', recurrence_range: 'THISANDFUTURE' }],
    ]);
  });
});
