import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { DashboardCardContext } from '../../types/dashboard-cards';
import type { CalendarEvent } from '../../types';
import type { FamilyMember } from '../../types/family';
import { FamilyCalendarCard } from './FamilyCalendarCard';

const member = (id: string): FamilyMember => ({
  id,
  name: id,
  avatar: '🙂',
  color: '#3366ff',
  role: 'parent',
  calendar_entity: `calendar.${id}`,
});

const event = (id: string): CalendarEvent => ({
  id,
  title: id,
  start: '2026-09-26T09:00:00',
  end: '2026-09-26T10:00:00',
  allDay: false,
  calendarId: 'calendar.shared',
  calendarName: 'Shared',
  color: '#999999',
});

const context = (members: FamilyMember[], other: CalendarEvent[]) =>
  ({
    members,
    other,
    byMember: new Map(),
    todayEvents: [],
    selectedMemberFilter: null,
    toggleMemberFilter: () => {},
    isViewingToday: true,
  }) as unknown as DashboardCardContext;

function renderGrid(config: Record<string, unknown>, members: FamilyMember[], other: CalendarEvent[]) {
  const { container } = render(<FamilyCalendarCard config={config} context={context(members, other)} />);
  const grid = container.querySelector<HTMLElement>('.dash-family-grid')!;
  return {
    columnCount: grid.style.getPropertyValue('--member-count'),
    renderedColumns: grid.querySelectorAll('.dash-member-col').length,
  };
}

describe('FamilyCalendarCard column count', () => {
  const members = ['a', 'b', 'c', 'd'].map(member);

  it('gives the Other column a grid column of its own instead of wrapping it onto a second row', () => {
    expect(renderGrid({}, members, [event('school-pickup')])).toEqual({ columnCount: '5', renderedColumns: 5 });
  });

  it('counts only members when nothing lands in Other', () => {
    expect(renderGrid({}, members, [])).toEqual({ columnCount: '4', renderedColumns: 4 });
  });

  it('counts only members when the Other column is turned off', () => {
    expect(renderGrid({ show_other: false }, members, [event('school-pickup')])).toEqual({
      columnCount: '4',
      renderedColumns: 4,
    });
  });
});
