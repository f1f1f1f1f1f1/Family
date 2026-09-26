import { describe, it, expect } from 'vitest';
import { eventOccursOnDay, lastDayOfAllDayEvent, allDayEndAfter, moveAllDayEvent } from './event-dates';

const day = (d: number) => new Date(2026, 8, d); // September 2026, local time

describe('eventOccursOnDay', () => {
  it('shows a multi-day all-day event on each of its days, not the day it ends', () => {
    const holiday = { start: '2026-09-28', end: '2026-10-01' }; // 28th, 29th, 30th
    expect(eventOccursOnDay(holiday, day(27))).toBe(false);
    expect(eventOccursOnDay(holiday, day(28))).toBe(true);
    expect(eventOccursOnDay(holiday, day(29))).toBe(true);
    expect(eventOccursOnDay(holiday, day(30))).toBe(true);
    expect(eventOccursOnDay(holiday, new Date(2026, 9, 1))).toBe(false);
  });

  it('shows a late event that runs past midnight on both days', () => {
    const movie = { start: '2026-09-26T22:00:00', end: '2026-09-27T00:30:00' };
    expect(eventOccursOnDay(movie, day(26))).toBe(true);
    expect(eventOccursOnDay(movie, day(27))).toBe(true);
    expect(eventOccursOnDay(movie, day(28))).toBe(false);
  });

  it("doesn't carry an event that ends at midnight into the next day", () => {
    const evening = { start: '2026-09-26T19:00:00', end: '2026-09-27T00:00:00' };
    expect(eventOccursOnDay(evening, day(27))).toBe(false);
  });

  it('keeps a zero-length event on the day it starts', () => {
    const reminder = { start: '2026-09-26T09:00:00', end: '2026-09-26T09:00:00' };
    expect(eventOccursOnDay(reminder, day(26))).toBe(true);
    expect(eventOccursOnDay(reminder, day(27))).toBe(false);
  });
});

describe('all-day end dates', () => {
  it("shows Home Assistant's end date as the event's last day", () => {
    expect(lastDayOfAllDayEvent('2026-09-24', '2026-09-25')).toBe('2026-09-24');
    expect(lastDayOfAllDayEvent('2026-09-28', '2026-10-01')).toBe('2026-09-30');
    // A malformed event whose end isn't after its start.
    expect(lastDayOfAllDayEvent('2026-09-24', '2026-09-24')).toBe('2026-09-24');
  });

  it('sends the day after the last day, keeping every picked day', () => {
    expect(allDayEndAfter('2026-09-24', '2026-09-24')).toBe('2026-09-25');
    expect(allDayEndAfter('2026-09-24', '2026-09-26')).toBe('2026-09-27');
    expect(allDayEndAfter('2026-09-30', '2026-10-01')).toBe('2026-10-02');
    // A last day before the start is taken as a one-day event.
    expect(allDayEndAfter('2026-09-24', '2026-09-20')).toBe('2026-09-25');
  });
});

describe('moveAllDayEvent', () => {
  it('keeps the number of days', () => {
    expect(moveAllDayEvent({ start: '2026-09-24', end: '2026-09-25' }, '2026-09-29'))
      .toEqual({ start_date: '2026-09-29', end_date: '2026-09-30' });
    expect(moveAllDayEvent({ start: '2026-09-28', end: '2026-10-01' }, '2026-10-05'))
      .toEqual({ start_date: '2026-10-05', end_date: '2026-10-08' });
  });

  it('keeps the number of days across a daylight-saving change', () => {
    // NZ clocks go forward on 27 Sep 2026; US clocks go back on 1 Nov 2026.
    expect(moveAllDayEvent({ start: '2026-09-20', end: '2026-09-21' }, '2026-09-27'))
      .toEqual({ start_date: '2026-09-27', end_date: '2026-09-28' });
    expect(moveAllDayEvent({ start: '2026-10-31', end: '2026-11-02' }, '2026-11-01'))
      .toEqual({ start_date: '2026-11-01', end_date: '2026-11-03' });
  });
});
