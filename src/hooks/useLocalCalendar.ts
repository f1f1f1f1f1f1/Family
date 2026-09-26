import { useCallback } from 'react';
import { CalendarEvent, CalendarInfo } from '../types';
import { useStoredData } from './useStoredData';

/**
 * Built-in local calendar synced via beacon-store.
 * Server is source of truth in add-on mode; localStorage is offline cache.
 */

const EVENTS_KEY = 'beacon-local-events';
const LOCAL_CAL_ID = 'beacon-local';
const LOCAL_CAL_NAME = 'Family';

export const LOCAL_CALENDAR: CalendarInfo = {
  id: LOCAL_CAL_ID,
  name: LOCAL_CAL_NAME,
  color: '#6366f1', // indigo accent
};

/** Events saved before the rename still carry the old calendar name. */
function withLocalCalName(events: CalendarEvent[]): CalendarEvent[] {
  return events.map((e) => (e.calendarName === LOCAL_CAL_NAME ? e : { ...e, calendarName: LOCAL_CAL_NAME }));
}

const NO_EVENTS: CalendarEvent[] = [];

export function useLocalCalendar() {
  const [events, setEvents, refresh] = useStoredData<CalendarEvent[]>(EVENTS_KEY, NO_EVENTS, withLocalCalName);

  const getEventsInRange = useCallback((start: string, end: string): CalendarEvent[] => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    return events.filter(ev => {
      const evStart = new Date(ev.start);
      const evEnd = new Date(ev.end);
      return evStart < endDate && evEnd > startDate;
    });
  }, [events]);

  const createEvent = useCallback((event: {
    summary: string;
    start_date_time?: string;
    end_date_time?: string;
    start_date?: string;
    end_date?: string;
    description?: string;
  }) => {
    const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const allDay = !!event.start_date;
    const start = allDay ? event.start_date : event.start_date_time;
    const end = allDay ? event.end_date : event.end_date_time;
    if (!start || !end) return null; // invalid event data

    const newEvent: CalendarEvent = {
      id,
      calendarId: LOCAL_CAL_ID,
      calendarName: LOCAL_CAL_NAME,
      title: event.summary,
      start,
      end,
      allDay,
      description: event.description,
      color: LOCAL_CALENDAR.color,
    };
    setEvents(prev => [...prev, newEvent]);
    return newEvent;
  }, [setEvents]);

  const updateEvent = useCallback((uid: string, patch: {
    summary?: string;
    start_date_time?: string;
    end_date_time?: string;
    start_date?: string;
    end_date?: string;
    description?: string;
  }) => {
    setEvents(prev => prev.map(ev => {
      if (ev.id !== uid) return ev;
      const updated = { ...ev };
      if (patch.summary !== undefined) updated.title = patch.summary;
      if (patch.start_date_time) { updated.start = patch.start_date_time; updated.allDay = false; }
      if (patch.end_date_time) { updated.end = patch.end_date_time; updated.allDay = false; }
      if (patch.start_date) { updated.start = patch.start_date; updated.allDay = true; }
      if (patch.end_date) { updated.end = patch.end_date; updated.allDay = true; }
      if (patch.description !== undefined) updated.description = patch.description;
      return updated;
    }));
  }, [setEvents]);

  const deleteEvent = useCallback((uid: string) => {
    setEvents(prev => prev.filter(ev => ev.id !== uid));
  }, [setEvents]);

  return {
    calendar: LOCAL_CALENDAR,
    events,
    getEventsInRange,
    createEvent,
    updateEvent,
    deleteEvent,
    refresh,
  };
}
