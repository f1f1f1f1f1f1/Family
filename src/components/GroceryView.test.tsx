import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { GroceryView } from './GroceryView';
import { getTodoItems, type HaTodoItem } from '../api/ha-services';
import { callHaService, fetchAllStates } from '../api/ha-rest';

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

const local = vi.hoisted(() => ({
  tasks: [] as { id: string; summary: string; status: 'needs_action' | 'completed'; listId: string; createdAt: string }[],
  removeTask: vi.fn(),
}));

vi.mock('../hooks/useLocalTasks', () => ({
  useLocalTasks: () => ({
    lists: [
      { id: 'beacon-todo', name: 'To-Do' },
      { id: 'beacon-shopping', name: 'Shopping List' },
    ],
    getTasksForList: (listId: string) => local.tasks.filter((task) => task.listId === listId),
    addTask: vi.fn(),
    toggleTask: vi.fn(),
    removeTask: local.removeTask,
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

describe('GroceryView, switching lists', () => {
  const listsBefore = vi.mocked(fetchAllStates).getMockImplementation();
  const itemsBefore = vi.mocked(getTodoItems).getMockImplementation();
  afterEach(() => {
    vi.mocked(fetchAllStates).mockImplementation(listsBefore!);
    vi.mocked(getTodoItems).mockImplementation(itemsBefore!);
  });

  // A slow load for the list left behind used to land after the new
  // list's, showing its items under the new list's name.
  it("never shows a list's items under another list", async () => {
    vi.mocked(fetchAllStates).mockImplementation(async () => [
      { entity_id: 'todo.chores', state: '1', attributes: { friendly_name: 'Chores' } },
      { entity_id: 'todo.errands', state: '1', attributes: { friendly_name: 'Errands' } },
    ]);
    let finishChores!: (items: HaTodoItem[]) => void;
    vi.mocked(getTodoItems).mockImplementation((id) => (id === 'todo.chores'
      ? new Promise((resolve) => { finishChores = resolve; })
      : Promise.resolve([{ uid: 'e1', summary: 'Post office', status: 'needs_action' }])));

    render(<GroceryView mode="tasks" defaultListId="todo.chores" hideLocalList />);
    await waitFor(() => expect(getTodoItems).toHaveBeenCalledWith('todo.chores'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'todo.errands' } });
    expect(await screen.findByText('Post office')).toBeInTheDocument();

    await act(async () => finishChores([{ uid: 'c1', summary: 'Take out trash', status: 'needs_action' }]));

    expect(screen.queryByText('Take out trash')).not.toBeInTheDocument();
    expect(screen.getByText('Post office')).toBeInTheDocument();
  });
});

describe('GroceryView, deleting', () => {
  const itemsBefore = vi.mocked(getTodoItems).getMockImplementation();
  afterEach(() => {
    vi.mocked(getTodoItems).mockImplementation(itemsBefore!);
    vi.mocked(callHaService).mockReset();
    local.tasks = [];
    local.removeTask.mockClear();
  });

  // Only Family's own lists had a delete button, so a done task on a Home
  // Assistant list (Google Tasks, say) could never be removed.
  it('deletes a completed item from a Home Assistant list on a second tap', async () => {
    let items: HaTodoItem[] = [
      { uid: 'c1', summary: 'Take out trash', status: 'needs_action' },
      { uid: 'c2', summary: 'Book dentist', status: 'completed' },
    ];
    vi.mocked(getTodoItems).mockImplementation(async () => items);
    vi.mocked(callHaService).mockImplementation(async (_domain, service, data) => {
      if (service === 'remove_item') items = items.filter((item) => item.uid !== data?.item);
      return [];
    });
    render(<GroceryView mode="tasks" defaultListId="todo.chores" hideLocalList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Book dentist' }));
    expect(callHaService).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to delete Book dentist' }));

    await waitFor(() => expect(screen.queryByText('Book dentist')).not.toBeInTheDocument());
    expect(callHaService).toHaveBeenCalledWith(
      'todo', 'remove_item', { entity_id: 'todo.chores', item: 'c2' }, false, 'deleted on the Tasks screen',
    );
    expect(screen.getByText('Take out trash')).toBeInTheDocument();
  });

  it('deletes an open item too', async () => {
    vi.mocked(callHaService).mockResolvedValue([]);
    render(<GroceryView mode="grocery" defaultListId="todo.chores" hideLocalList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Take out trash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to delete Take out trash' }));

    await waitFor(() => expect(callHaService).toHaveBeenCalledWith(
      'todo', 'remove_item', { entity_id: 'todo.chores', item: 'c1' }, false, 'deleted on the Lists screen',
    ));
  });

  it("puts an item back, and says so, when Home Assistant won't delete it", async () => {
    vi.mocked(getTodoItems).mockImplementation(async () => [{ uid: 'c2', summary: 'Book dentist', status: 'completed' }]);
    vi.mocked(callHaService).mockRejectedValue(new Error('Service call 400: Bad Request'));
    render(<GroceryView mode="tasks" defaultListId="todo.chores" hideLocalList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Book dentist' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to delete Book dentist' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/delete “Book dentist”/);
    expect(screen.getByText('Book dentist')).toBeInTheDocument();
  });

  // One tap used to delete from Family's own lists.
  it("asks before deleting from one of Family's own lists", async () => {
    local.tasks = [{ id: 'l1', summary: 'Milk', status: 'completed', listId: 'beacon-todo', createdAt: '' }];
    render(<GroceryView mode="tasks" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Milk' }));
    expect(local.removeTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to delete Milk' }));
    expect(local.removeTask).toHaveBeenCalledWith('l1');
  });
});
