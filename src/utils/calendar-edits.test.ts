import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../types';
import type { EventFormData } from '../components/EventModal';
import { formToPayload, movedPayload, occurrenceTarget } from './calendar-edits';

const occurrence: CalendarEvent = {
  id: 'series-1::20260926T160000',
  uid: 'series-1',
  recurrenceId: '20260926T160000',
  rrule: 'FREQ=WEEKLY',
  recurrence: 'weekly',
  title: 'Soccer',
  start: '2026-09-26T16:00:00',
  end: '2026-09-26T17:30:00',
  allDay: false,
  location: 'Main field',
  description: 'Bring water',
  calendarId: 'calendar.family',
  calendarName: 'Family',
  color: '#22c55e',
};

const form = (overrides: Partial<EventFormData> = {}): EventFormData => ({
  summary: 'Soccer',
  description: 'Bring water',
  calendarId: 'calendar.family',
  startDate: '2026-09-26',
  startTime: '17:00',
  endDate: '2026-09-26',
  endTime: '18:30',
  allDay: false,
  recurrence: 'weekly',
  recurrenceEnd: '',
  rrule: 'FREQ=WEEKLY',
  scope: 'this',
  ...overrides,
});

describe('occurrenceTarget', () => {
  it('targets one occurrence, or it and those after it', () => {
    expect(occurrenceTarget(occurrence, 'this')).toEqual({ recurrenceId: '20260926T160000' });
    expect(occurrenceTarget(occurrence, 'following')).toEqual({ recurrenceId: '20260926T160000', recurrenceRange: 'THISANDFUTURE' });
  });

  it('targets the whole event when it is not an occurrence', () => {
    expect(occurrenceTarget({ ...occurrence, recurrenceId: undefined }, 'this')).toBeUndefined();
  });
});

describe('formToPayload', () => {
  // HA replaces the whole event on update; the form has no location field,
  // so saving used to drop the event's location.
  it("keeps the event's location", () => {
    expect(formToPayload(form(), occurrence).location).toBe('Main field');
  });

  it('sends no repeat rule when one occurrence changes on its own', () => {
    expect(formToPayload(form({ scope: 'this' }), occurrence).rrule).toBeUndefined();
  });

  it('sends the repeat rule for this and following occurrences', () => {
    expect(formToPayload(form({ scope: 'following', recurrence: 'daily' }), occurrence).rrule).toBe('FREQ=DAILY');
  });

  it('keeps a rule the form cannot show', () => {
    const payload = formToPayload(form({ scope: 'following', recurrence: 'custom', rrule: 'FREQ=WEEKLY;INTERVAL=2' }), occurrence);
    expect(payload.rrule).toBe('FREQ=WEEKLY;INTERVAL=2');
  });

  it('sends the repeat rule for a new event', () => {
    expect(formToPayload(form({ recurrence: 'monthly', recurrenceEnd: '2026-12-31', allDay: true }), null)).toMatchObject({
      start_date: '2026-09-26',
      end_date: '2026-09-27',
      rrule: 'FREQ=MONTHLY;UNTIL=20261231',
    });
  });
});

describe('movedPayload', () => {
  // HA requires the title on every update; the drag sent only the times.
  it('sends the whole event at its new time', () => {
    expect(movedPayload(occurrence, '2026-09-27', 9)).toEqual({
      summary: 'Soccer',
      start_date_time: '2026-09-27T09:00:00',
      end_date_time: '2026-09-27T10:30:00',
      description: 'Bring water',
      location: 'Main field',
    });
  });

  it('moves all-day events by whole days', () => {
    const allDay = { ...occurrence, allDay: true, start: '2026-09-25', end: '2026-09-28', recurrenceId: undefined, rrule: undefined };
    expect(movedPayload(allDay, '2026-10-01', 0)).toMatchObject({ start_date: '2026-10-01', end_date: '2026-10-04' });
  });

  it('keeps the rule of a repeating event that is not an occurrence', () => {
    expect(movedPayload({ ...occurrence, recurrenceId: undefined }, '2026-09-27', 9).rrule).toBe('FREQ=WEEKLY');
  });
});
