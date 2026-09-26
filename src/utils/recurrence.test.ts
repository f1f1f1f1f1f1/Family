import { describe, it, expect } from 'vitest';
import { endOfDay, parseISO } from 'date-fns';
import { buildRrule, parseRrule } from './recurrence';

describe('parseRrule', () => {
  const saturday = '2026-09-26T16:00:00';

  it('reads the rules the form offers', () => {
    expect(parseRrule(undefined, saturday)).toEqual({ recurrence: 'none', recurrenceEnd: '' });
    expect(parseRrule('FREQ=DAILY', saturday)).toEqual({ recurrence: 'daily', recurrenceEnd: '' });
    expect(parseRrule('FREQ=MONTHLY;UNTIL=20261231', saturday)).toEqual({ recurrence: 'monthly', recurrenceEnd: '2026-12-31' });
    // Providers often spell out the start's own weekday, and INTERVAL=1.
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=1;BYDAY=SA', saturday)).toEqual({ recurrence: 'weekly', recurrenceEnd: '' });
  });

  it('reads a UTC UNTIL as the local day it falls on', () => {
    const until = new Date(2026, 11, 31, 23, 59, 59).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    expect(parseRrule(`FREQ=DAILY;UNTIL=${until}`, saturday).recurrenceEnd).toBe('2026-12-31');
  });

  it('leaves rules the form cannot show as custom', () => {
    for (const rule of ['FREQ=WEEKLY;INTERVAL=2', 'FREQ=DAILY;COUNT=5', 'FREQ=WEEKLY;BYDAY=MO,WE', 'FREQ=WEEKLY;BYDAY=MO', 'FREQ=YEARLY']) {
      expect(parseRrule(rule, saturday).recurrence, rule).toBe('custom');
    }
  });
});

describe('buildRrule', () => {
  // RFC 5545: an all-day event's UNTIL is a date, like its start.
  it('ends all-day events with a date', () => {
    expect(buildRrule('weekly', '2026-12-31', true)).toBe('FREQ=WEEKLY;UNTIL=20261231');
  });

  // A fixed "T235959Z" ended the series hours before the last day's
  // occurrence west of UTC (a 7pm event on the 31st is 03:00Z on the 1st).
  it('ends timed events at the end of the last day, in UTC', () => {
    const rule = buildRrule('daily', '2026-12-31', false);
    const m = /UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(rule)!;
    const until = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    expect(Math.floor(endOfDay(parseISO('2026-12-31')).getTime() / 1000) * 1000).toBe(until);
  });

  it('has no UNTIL without an end date', () => {
    expect(buildRrule('monthly', '', false)).toBe('FREQ=MONTHLY');
  });
});
