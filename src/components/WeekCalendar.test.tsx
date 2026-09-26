import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { WeekCalendar } from './WeekCalendar';

describe('WeekCalendar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // jsdom has no matchMedia; the calendar uses it to pick the mobile layout.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // A wall display stays open for days. It used to keep showing (and
  // fetching events for) the old week after Saturday midnight until the
  // page was reloaded.
  it('moves on to the new week after Saturday midnight', () => {
    vi.setSystemTime(new Date(2026, 9, 3, 22, 0)); // Sat 3 Oct 2026, 10pm
    const onVisibleWeekChange = vi.fn();
    const props = {
      hiddenCalendars: new Set<string>(),
      onEventClick: vi.fn(),
      onSlotClick: vi.fn(),
      onVisibleWeekChange,
    };

    const { rerender } = render(<WeekCalendar events={[]} {...props} />);
    expect(onVisibleWeekChange).toHaveBeenLastCalledWith(new Date(2026, 8, 27)); // Sun 27 Sep

    vi.setSystemTime(new Date(2026, 9, 4, 7, 0)); // Sun 4 Oct, 7am
    // Any later re-render (the 5-minute event refresh, a weather update, ...).
    rerender(<WeekCalendar events={[]} {...props} />);
    expect(onVisibleWeekChange).toHaveBeenLastCalledWith(new Date(2026, 9, 4)); // Sun 4 Oct
  });

  it('starts the week on Monday when set to', () => {
    vi.setSystemTime(new Date(2026, 8, 27, 10, 0)); // Sun 27 Sep 2026
    const onVisibleWeekChange = vi.fn();
    render(
      <WeekCalendar
        events={[]}
        hiddenCalendars={new Set()}
        onEventClick={vi.fn()}
        onSlotClick={vi.fn()}
        onVisibleWeekChange={onVisibleWeekChange}
        weekStartsOn={1}
      />,
    );
    // Sunday is the last day of the week that started on Monday 21 Sep.
    expect(onVisibleWeekChange).toHaveBeenLastCalledWith(new Date(2026, 8, 21));
  });

  // Hour rows are var(--hour-height) tall, which is 64px or less on
  // tablets and phones; events were placed as if every row were 72px, so
  // a 4pm event showed up around 5pm and the error grew through the day.
  it('places timed events in units of the hour-row height', () => {
    vi.setSystemTime(new Date(2026, 8, 26, 10, 0));
    const { container } = render(
      <WeekCalendar
        events={[{
          id: 'ev-1',
          title: 'Soccer practice',
          start: '2026-09-26T16:00:00',
          end: '2026-09-26T17:30:00',
          allDay: false,
          calendarId: 'calendar.family',
          calendarName: 'Family',
          color: '#22c55e',
        }]}
        hiddenCalendars={new Set()}
        onEventClick={vi.fn()}
        onSlotClick={vi.fn()}
      />,
    );
    const block = container.querySelector<HTMLElement>('.event-block')!;
    expect(block.style.top).toBe('calc(var(--hour-height) * 9)'); // 4pm is 9 hours below 7am
    expect(block.style.height).toBe('max(22px, calc(var(--hour-height) * 1.5))');
  });
  // Phones show the week a few days at a time. Multi-day bars were laid out
  // against the visible days rather than the week, so on any page but the
  // first they were dropped, leaving an empty all-day row.
  it('shows multi-day events on later pages of the phone layout', () => {
    vi.setSystemTime(new Date(2026, 8, 26, 10, 0)); // Sat 26 Sep: the last page
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { container } = render(
      <WeekCalendar
        events={[{
          id: 'ev-vacation',
          title: 'Vacation',
          start: '2026-09-25',
          end: '2026-09-29',
          allDay: true,
          calendarId: 'calendar.family',
          calendarName: 'Family',
          color: '#22c55e',
        }]}
        hiddenCalendars={new Set()}
        onEventClick={vi.fn()}
        onSlotClick={vi.fn()}
      />,
    );
    const bars = container.querySelectorAll<HTMLElement>('.event-block--multiday');
    expect(bars).toHaveLength(1);
    expect(bars[0].textContent).toContain('Vacation');
  });
});
