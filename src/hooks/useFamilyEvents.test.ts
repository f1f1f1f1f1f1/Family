import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFamilyEvents } from './useFamilyEvents';
import type { CalendarEvent } from '../types';
import type { FamilyMember } from '../types/family';

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'ev',
    title: 'Event',
    start: '2026-09-26T09:00:00',
    end: '2026-09-26T10:00:00',
    allDay: false,
    calendarId: 'calendar.family',
    calendarName: 'Family',
    color: '#22c55e',
    ...overrides,
  };
}

const members = [
  { id: 'mia', name: 'Mia', calendar_entity: 'calendar.school' },
] as FamilyMember[];

describe('useFamilyEvents', () => {
  // The dashboard used to show an event only on the day it starts, so a
  // week-long holiday vanished after its first day.
  it('includes events that started on an earlier day and are still going', () => {
    const events = [
      event({ id: 'holiday', allDay: true, start: '2026-09-24', end: '2026-10-01', calendarId: 'calendar.school' }),
      event({ id: 'movie', start: '2026-09-25T22:00:00', end: '2026-09-26T00:30:00' }),
      event({ id: 'dentist', start: '2026-09-26T09:00:00', end: '2026-09-26T10:00:00' }),
      event({ id: 'finished', allDay: true, start: '2026-09-24', end: '2026-09-26' }),
    ];
    const { result } = renderHook(() => useFamilyEvents(events, members, new Date(2026, 8, 26)));

    expect(result.current.byMember.get('mia')!.map((e) => e.id)).toEqual(['holiday']);
    expect(result.current.other.map((e) => e.id)).toEqual(['movie', 'dentist']);
  });
});
