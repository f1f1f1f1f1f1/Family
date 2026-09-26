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
});
