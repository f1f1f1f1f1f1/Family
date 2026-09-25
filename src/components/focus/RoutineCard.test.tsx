import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoutineCard } from './RoutineCard';
import type { Routine } from '../../types/family';

const routine: Routine = {
  id: 'r1',
  name: 'Morning routine',
  member_id: 'kai',
  time_of_day: 'morning',
  tasks: [{ id: 't1', name: 'Brush teeth', order: 0 }],
};

describe('RoutineCard', () => {
  it('explains when a previewed routine can be ticked off', () => {
    render(<RoutineCard routine={routine} label="Tomorrow morning" interactive={false} isTaskCompleted={() => false} onToggleTask={() => {}} />);
    expect(screen.getByText('You can tick these off tomorrow morning.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete Brush teeth' })).toBeDisabled();
  });

  it('shows no note for the current routine', () => {
    render(<RoutineCard routine={routine} label="" interactive isTaskCompleted={() => false} onToggleTask={() => {}} />);
    expect(screen.queryByText(/You can tick these off/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete Brush teeth' })).toBeEnabled();
  });
});
