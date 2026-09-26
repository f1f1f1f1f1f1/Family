import { endOfDay, format, getDay, parseISO } from 'date-fns';
import type { RecurrenceFrequency } from '../types';

/** The repeat options the event form offers. */
export type SimpleFrequency = Exclude<RecurrenceFrequency, 'none' | 'custom'>;

const FREQUENCIES: Record<string, SimpleFrequency> = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' };
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Reads an RFC 5545 rule (as Home Assistant returns it) into the form's
 * terms: how often, and the last day it repeats on (yyyy-MM-dd, '' for no
 * end). Anything the form can't show as-is — every other week, a count,
 * several weekdays — is 'custom', and kept unchanged when saved.
 *
 * `start` is the event's start (ISO), used to tell a plain weekly rule
 * apart from one on other weekdays.
 */
export function parseRrule(rrule: string | undefined, start: string): { recurrence: RecurrenceFrequency; recurrenceEnd: string } {
  if (!rrule) return { recurrence: 'none', recurrenceEnd: '' };
  const parts = new Map(
    rrule.replace(/^RRULE:/i, '').split(';').filter(Boolean).map((p) => {
      const [k, v = ''] = p.split('=');
      return [k.toUpperCase(), v.toUpperCase()] as const;
    }),
  );
  const custom = { recurrence: 'custom' as const, recurrenceEnd: '' };
  const frequency = FREQUENCIES[parts.get('FREQ') ?? ''];
  if (!frequency) return custom;
  parts.delete('FREQ');

  // A weekly rule naming just the start's own weekday is plain weekly
  // (some providers always spell it out).
  const byDay = parts.get('BYDAY');
  if (byDay !== undefined) {
    if (frequency !== 'weekly' || byDay !== WEEKDAYS[getDay(parseISO(start))]) return custom;
    parts.delete('BYDAY');
  }
  if (parts.get('INTERVAL') === '1') parts.delete('INTERVAL');

  const until = parts.get('UNTIL');
  parts.delete('UNTIL');
  if (parts.size > 0) return custom;

  return { recurrence: frequency, recurrenceEnd: until ? untilToDate(until) : '' };
}

/** "20261231", "20261231T235959" or "20261231T045959Z" → the local day it falls on. */
function untilToDate(until: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(until);
  if (!m) return '';
  const [, y, mo, d, h, mi, s, utc] = m;
  if (!h) return `${y}-${mo}-${d}`;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${utc ? 'Z' : ''}`;
  return format(new Date(iso), 'yyyy-MM-dd');
}

/**
 * The rule to send for the form's repeat options. `lastDate` is the last
 * day it repeats on ('' for no end).
 *
 * RFC 5545 wants UNTIL to match the event's start: a date for all-day
 * events, and for timed ones a UTC time — here the end of `lastDate` in the
 * display's time zone, so an evening event still happens on its last day
 * west of UTC (a fixed "T235959Z" ended it hours early there).
 */
export function buildRrule(frequency: SimpleFrequency, lastDate: string, allDay: boolean): string {
  const rule = `FREQ=${frequency.toUpperCase()}`;
  if (!lastDate) return rule;
  if (allDay) return `${rule};UNTIL=${lastDate.replace(/-/g, '')}`;
  const until = endOfDay(parseISO(lastDate)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `${rule};UNTIL=${until}`;
}
