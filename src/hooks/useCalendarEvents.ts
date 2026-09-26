import { useState, useCallback, useRef } from 'react';
import { CalendarEvent, CalendarInfo, CalendarColorMember, resolveCalendarColor } from '../types';
import { haFetch, hasToken, callBeaconAction, BeaconActionError } from '../api/ha-rest';
import { HomeAssistantClient, toWsEventPayload, toWsTarget } from '../api/homeassistant';
import type { EventPayload, OccurrenceTarget } from '../utils/calendar-edits';
import { parseRrule } from '../utils/recurrence';

/**
 * Re-thrown by createEvent/updateEvent/deleteEvent when HA reports the calendar
 * doesn't support that operation (CalendarEntityFeature.CREATE_EVENT /
 * UPDATE_EVENT / DELETE_EVENT unset — common for many read-only or limited
 * providers). Callers can catch this specifically to offer a fallback (e.g.
 * delete + recreate for updates) instead of showing a raw error.
 */
export class CalendarNotSupportedError extends Error {
  constructor(op: 'create' | 'update' | 'delete') {
    super(`This calendar does not support event ${op === 'create' ? 'creation' : op === 'update' ? 'editing' : 'deletion'}.`);
    this.name = 'CalendarNotSupportedError';
  }
}

/**
 * How long the list of HA calendars is reused. Changing week or calendar
 * colors used to ask HA for it again every time; a calendar added in HA
 * still shows up within this long (the 5-minute refresh picks it up).
 */
export const CALENDAR_LIST_MAX_AGE_MS = 10 * 60 * 1000;

type HaCalendarListEntry = { entity_id: string; name: string };

type HaCalendarEvent = {
  uid?: string | null;
  summary: string;
  start: string | { dateTime: string; date: string };
  end: string | { dateTime: string; date: string };
  description?: string | null;
  location?: string | null;
  recurrence_id?: string | null;
  rrule?: string | null;
};

function isNotSupported(err: unknown): boolean {
  if (err instanceof BeaconActionError) return err.code === 'not_supported';
  if (err && typeof err === 'object' && 'code' in err) return (err as { code?: string }).code === 'not_supported';
  return false;
}

/**
 * Calendar events hook — uses HA REST API via haFetch.
 * Works with both direct HA connections and the add-on API proxy.
 * The `connected` flag indicates whether the HA API is reachable.
 *
 * `colorOptions` lets callers pass user-customized calendar colors and
 * family members so calendar/event colors resolve identically here as on
 * the Dashboard (user override > family-member-linked color > positional
 * palette fallback) — see resolveCalendarColor in ../types.
 */
export function useCalendarEvents(
  connected: boolean,
  colorOptions?: {
    calendarColors?: Record<string, string>;
    members?: CalendarColorMember[];
  },
  getClient?: () => HomeAssistantClient | null,
) {
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const calendarsRef = useRef<CalendarInfo[]>([]);
  const calendarListRef = useRef<{ list: HaCalendarListEntry[]; fetchedAt: number } | null>(null);
  /** Counts fetchEvents calls, so a slow answer for a week no longer shown is dropped. */
  const eventsRequestRef = useRef(0);
  const colorOptionsRef = useRef(colorOptions);
  colorOptionsRef.current = colorOptions;

  /**
   * The HA calendars, with colors resolved from the latest settings. The
   * list itself comes from HA at most every `maxAgeMs`.
   */
  const fetchCalendars = useCallback(async (maxAgeMs = CALENDAR_LIST_MAX_AGE_MS) => {
    if (!connected && !hasToken()) return [];

    try {
      const cached = calendarListRef.current;
      let data: HaCalendarListEntry[];
      if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
        data = cached.list;
      } else {
        data = await haFetch('/api/calendars') as HaCalendarListEntry[];
        calendarListRef.current = { list: data, fetchedAt: Date.now() };
      }
      const cals = data.map((cal, index) => ({
        id: cal.entity_id,
        name: cal.name,
        color: resolveCalendarColor(cal.entity_id, index, colorOptionsRef.current),
      }));
      calendarsRef.current = cals;
      setCalendars(cals);
      return cals;
    } catch (err) {
      console.error('Failed to fetch calendars:', err);
      return [];
    }
  }, [connected]);

  const fetchEvents = useCallback(async (start: string, end: string) => {
    if (!connected && !hasToken()) return;

    const request = ++eventsRequestRef.current;
    setLoading(true);
    try {
      let cals = calendarsRef.current;
      if (cals.length === 0) {
        cals = (await fetchCalendars()) || [];
      }
      if (cals.length === 0) return;

      // One request per calendar, all at once rather than one after another.
      const perCalendar = await Promise.all(cals.map(async (cal) => {
        try {
          const params = new URLSearchParams({ start, end });
          const result = await haFetch(`/api/calendars/${cal.id}?${params}`) as HaCalendarEvent[];

          return (result || []).map((ev, index): CalendarEvent => {
            const startStr = typeof ev.start === 'string' ? ev.start : (ev.start.dateTime || ev.start.date);
            const endStr = typeof ev.end === 'string' ? ev.end : (ev.end.dateTime || ev.end.date);
            const allDay = typeof ev.start === 'string'
              ? ev.start.length === 10
              : !!ev.start.date && !ev.start.dateTime;

            // Every occurrence of a repeating event carries the series' uid;
            // recurrence_id says which occurrence it is. Both go into the id,
            // so each occurrence is its own event here (React keys, reminders,
            // the event opened), and edits can target just one occurrence.
            // Some integrations return no uid at all: those get a made-up id
            // and can't be edited or deleted (hasStableId: false).
            const uid = ev.uid || undefined;
            const recurrenceId = ev.recurrence_id || undefined;
            const rrule = ev.rrule || undefined;
            return {
              id: uid ? (recurrenceId ? `${uid}::${recurrenceId}` : uid) : `${cal.id}-${index}`,
              uid,
              recurrenceId,
              rrule,
              ...parseRrule(rrule, startStr),
              title: ev.summary,
              start: startStr,
              end: endStr,
              allDay,
              description: ev.description || undefined,
              location: ev.location || undefined,
              calendarId: cal.id,
              calendarName: cal.name,
              color: cal.color,
              hasStableId: !!uid,
            };
          });
        } catch (err) {
          console.error(`Failed to fetch events for ${cal.name}:`, err);
          return [];
        }
      }));

      // A newer request (the week changed again meanwhile) owns the result.
      if (request !== eventsRequestRef.current) return;
      const allEvents = perCalendar.flat();
      allEvents.sort((a, b) => a.start.localeCompare(b.start));
      setEvents(allEvents);
    } finally {
      if (request === eventsRequestRef.current) setLoading(false);
    }
  }, [connected, fetchCalendars]);

  /**
   * Create a new calendar event. HA requires the calendar/event/create WS
   * command (not calendar.create_event REST service) to support recurring
   * events (rrule) — the service silently ignores/rejects rrule. When a live
   * HomeAssistantClient is available (standalone mode, direct browser WS
   * connection), this calls its createEvent method directly. Otherwise
   * (add-on/proxy mode, no browser-side token) it routes through the add-on
   * server's /beacon-action/calendar-event bridge, which opens the WS
   * connection server-side using SUPERVISOR_TOKEN.
   *
   * Many calendar providers don't support event creation at all
   * (CalendarEntityFeature.CREATE_EVENT unset) — HA reports that as error
   * code "not_supported", which is normalized here into
   * CalendarNotSupportedError so callers can detect it and show a clear
   * message instead of a raw error.
   */
  const createEvent = useCallback(async (calendarId: string, event: EventPayload) => {
    try {
      const client = getClient?.();
      if (client?.isConnected) {
        await client.createEvent(calendarId, event);
      } else {
        await callBeaconAction('/beacon-action/calendar-event', {
          op: 'create',
          entity_id: calendarId,
          event: toWsEventPayload(event),
        });
      }
    } catch (err) {
      if (isNotSupported(err)) throw new CalendarNotSupportedError('create');
      throw err;
    }
  }, [getClient]);

  /**
   * Update an existing event. HA moved this off the `calendar.update_event`
   * REST service to a WS-only command in current core (see
   * homeassistant/components/calendar/__init__.py) — POSTing to
   * /api/services/calendar/update_event now 400s because the service no
   * longer exists. When a live HomeAssistantClient is available
   * (standalone mode, direct browser WS connection), this calls its
   * updateEvent method directly. Otherwise (add-on/proxy mode, no
   * browser-side token) it routes through the add-on server's
   * /beacon-action/calendar-event bridge, which opens the WS connection
   * server-side using SUPERVISOR_TOKEN.
   *
   * Many calendar providers don't support event updates at all
   * (CalendarEntityFeature.UPDATE_EVENT unset) — HA reports that as error
   * code "not_supported", which is normalized here into
   * CalendarNotSupportedError so callers can detect it and offer a
   * delete+recreate fallback instead of showing a raw error.
   */
  const updateEvent = useCallback(async (
    calendarId: string,
    uid: string,
    event: EventPayload,
    target?: OccurrenceTarget,
  ) => {
    try {
      const client = getClient?.();
      if (client?.isConnected) {
        await client.updateEvent(calendarId, uid, event, target);
      } else {
        await callBeaconAction('/beacon-action/calendar-event', {
          op: 'update',
          entity_id: calendarId,
          uid,
          ...toWsTarget(target),
          event: toWsEventPayload(event),
        });
      }
    } catch (err) {
      if (isNotSupported(err)) throw new CalendarNotSupportedError('update');
      throw err;
    }
  }, [getClient]);

  /**
   * Delete an event. Same WS-only migration and not-supported handling as
   * updateEvent above — see that doc comment for the full explanation.
   */
  const deleteEvent = useCallback(async (calendarId: string, uid: string, target?: OccurrenceTarget) => {
    try {
      const client = getClient?.();
      if (client?.isConnected) {
        await client.deleteEvent(calendarId, uid, target);
      } else {
        await callBeaconAction('/beacon-action/calendar-event', {
          op: 'delete',
          entity_id: calendarId,
          uid,
          ...toWsTarget(target),
        });
      }
    } catch (err) {
      if (isNotSupported(err)) throw new CalendarNotSupportedError('delete');
      throw err;
    }
  }, [getClient]);

  return {
    calendars,
    events,
    loading,
    fetchCalendars,
    fetchEvents,
    createEvent,
    updateEvent,
    deleteEvent,
  };
}
