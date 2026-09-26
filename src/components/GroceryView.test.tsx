import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { GroceryView } from './GroceryView';
import { getTodoItems } from '../api/ha-services';

vi.mock('../api/ha-rest', () => ({
  hasToken: () => true,
  callHaService: vi.fn(),
  fetchAllStates: vi.fn(async () => [
    { entity_id: 'todo.chores', state: '1', attributes: { friendly_name: 'Chores' } },
  ]),
}));

vi.mock('../api/ha-services', () => ({
  getTodoItems: vi.fn(async () => [{ uid: 'c1', summary: 'Take out trash', status: 'needs_action' }]),
}));

vi.mock('../hooks/useLocalTasks', () => ({
  useLocalTasks: () => ({
    lists: [
      { id: 'beacon-todo', name: 'To-Do' },
      { id: 'beacon-shopping', name: 'Shopping List' },
    ],
    getTasksForList: () => [],
    addTask: vi.fn(),
    toggleTask: vi.fn(),
    removeTask: vi.fn(),
  }),
}));

describe('GroceryView', () => {
  beforeEach(() => {
    vi.mocked(getTodoItems).mockClear();
  });

  // The Shopping list is Family's own; it only exists on the Shopping
  // screen. A view that moved on to To-Do with it still selected used to
  // ask Home Assistant for its items, which HA answers with a 500.
  it('never asks Home Assistant for a list the screen does not offer', async () => {
    const { rerender } = render(<GroceryView mode="grocery" />);
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('beacon-shopping'));

    rerender(<GroceryView mode="tasks" />);
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('beacon-todo'));

    expect(getTodoItems).not.toHaveBeenCalledWith('beacon-shopping');
  });

  it('loads the items of a selected Home Assistant list', async () => {
    render(<GroceryView mode="tasks" defaultListId="todo.chores" hideLocalList />);
    expect(await screen.findByText('Take out trash')).toBeInTheDocument();
    expect(getTodoItems).toHaveBeenCalledWith('todo.chores');
  });
});
