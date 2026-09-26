import { addDays, differenceInCalendarDays, format, parseISO, startOfDay } from 'date-fns';
import type { CalendarEvent } from '../types';

/**
 * Whether an event takes up any part of `day` — not only the day it starts
 * on. A holiday running all week shows on each of its days, and a late
 * event that runs past midnight shows on the next morning too.
 *
 * Ends are exclusive, as Home Assistant sends them: an all-day event ending
 * "2026-09-30" is over by the 30th, and one ending at midnight isn't on the
 * next day.
 */
export function eventOccursOnDay(event: Pick<CalendarEvent, 'start' | 'end'>, day: Date): boolean {
  const dayStart = startOfDay(day);
  const nextDay = addDays(dayStart, 1);
  const start = parseISO(event.start);
  const end = parseISO(event.end);
  // No usable end (or a zero-length event): it's on the day it starts.
  if (!(end > start)) return start >= dayStart && start < nextDay;
  return start < nextDay && end > dayStart;
}

/**
 * All-day events: Home Assistant's end date is the day after the event's
 * last day, while the event form shows (and people pick) the last day
 * itself. These convert between the two ("yyyy-MM-dd" strings).
 */
export function lastDayOfAllDayEvent(start: string, end: string): string {
  const last = addDays(parseISO(end), -1);
  return format(last < parseISO(start) ? parseISO(start) : last, 'yyyy-MM-dd');
}

export function allDayEndAfter(startDate: string, lastDate: string): string {
  const last = lastDate < startDate ? startDate : lastDate;
  return format(addDays(parseISO(last), 1), 'yyyy-MM-dd');
}

/**
 * Where an all-day event lands when moved to start on `newStartDate`,
 * keeping its length. Works in whole calendar days, so it's the same in
 * every time zone and across daylight-saving changes.
 */
export function moveAllDayEvent(event: Pick<CalendarEvent, 'start' | 'end'>, newStartDate: string) {
  const days = Math.max(1, differenceInCalendarDays(parseISO(event.end), parseISO(event.start)));
  return {
    start_date: newStartDate,
    end_date: format(addDays(parseISO(newStartDate), days), 'yyyy-MM-dd'),
  };
}
