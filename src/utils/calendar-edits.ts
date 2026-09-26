import { format } from 'date-fns';
import type { CalendarEvent } from '../types';
import type { EventFormData } from '../components/EventModal';
import { allDayEndAfter, moveAllDayEvent } from './event-dates';
import { buildRrule } from './recurrence';

/** Which occurrences of a repeating event an edit or delete applies to. */
export type EditScope = 'this' | 'following';

/** An event as sent to Home Assistant (or the built-in calendar). */
export interface EventPayload {
  summary: string;
  start_date?: string;
  end_date?: string;
  start_date_time?: string;
  end_date_time?: string;
  description?: string;
  location?: string;
  rrule?: string;
}

/** Which occurrence(s) of a repeating HA event a change is for. */
export interface OccurrenceTarget {
  recurrenceId: string;
  /** Unset: just this occurrence. */
  recurrenceRange?: 'THISANDFUTURE';
}

/**
 * The occurrence(s) an edit or delete of `event` in `scope` means, or
 * undefined for an event that isn't an occurrence of a repeating one (the
 * whole event). Sending just the series uid for an occurrence changed or
 * deleted every occurrence.
 */
export function occurrenceTarget(event: CalendarEvent, scope: EditScope): OccurrenceTarget | undefined {
  if (!event.recurrenceId) return undefined;
  return scope === 'following'
    ? { recurrenceId: event.recurrenceId, recurrenceRange: 'THISANDFUTURE' }
    : { recurrenceId: event.recurrenceId };
}

/** The repeat rule for the form's repeat options, if it repeats. */
export function formRrule(data: EventFormData): string | undefined {
  if (data.recurrence === 'none') return undefined;
  if (data.recurrence === 'custom') return data.rrule || undefined;
  return buildRrule(data.recurrence, data.recurrenceEnd, data.allDay);
}

/**
 * What to send for the event form: a new event, or (with `existing`) an
 * edit of it in `data.scope`. Home Assistant replaces the whole event on
 * update, so fields the form doesn't show (location) come from `existing`,
 * and the repeat rule goes along unless one occurrence is changed alone.
 */
export function formToPayload(data: EventFormData, existing?: CalendarEvent | null): EventPayload {
  const payload: EventPayload = data.allDay
    ? {
        summary: data.summary,
        start_date: data.startDate,
        // The form's end date is the event's last day; HA's is the day
        // after it (and it rejects an end equal to the start).
        end_date: allDayEndAfter(data.startDate, data.endDate),
      }
    : {
        summary: data.summary,
        start_date_time: `${data.startDate}T${data.startTime}:00`,
        end_date_time: `${data.endDate}T${data.endTime}:00`,
      };
  if (data.description) payload.description = data.description;
  if (existing?.location) payload.location = existing.location;

  const oneOccurrence = !!existing?.recurrenceId && data.scope === 'this';
  const rrule = oneOccurrence ? undefined : formRrule(data);
  if (rrule) payload.rrule = rrule;
  return payload;
}

/**
 * `event` moved to start on `newDate` (and, for timed events, at
 * `newHour`), keeping its length and everything else. HA requires the
 * title on every update; the drag used to send only the new times, which
 * HA rejected.
 */
export function movedPayload(event: CalendarEvent, newDate: string, newHour: number): EventPayload {
  const payload: EventPayload = { summary: event.title };
  if (event.allDay) {
    Object.assign(payload, moveAllDayEvent(event, newDate));
  } else {
    const start = new Date(`${newDate}T${String(newHour).padStart(2, '0')}:00:00`);
    const end = new Date(start.getTime() + (new Date(event.end).getTime() - new Date(event.start).getTime()));
    payload.start_date_time = format(start, "yyyy-MM-dd'T'HH:mm:ss");
    payload.end_date_time = format(end, "yyyy-MM-dd'T'HH:mm:ss");
  }
  if (event.description) payload.description = event.description;
  if (event.location) payload.location = event.location;
  // A dragged occurrence moves on its own; a repeating event that isn't an
  // occurrence keeps its rule.
  if (event.rrule && !event.recurrenceId) payload.rrule = event.rrule;
  return payload;
}
