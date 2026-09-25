import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { DashboardCardContext } from '../../types/dashboard-cards';

const getTodoItems = vi.hoisted(() => vi.fn());
vi.mock('../../api/ha-services', () => ({ getTodoItems }));
vi.mock('../../api/anylist', () => ({ AnyListClient: class {} }));

import { ShoppingCard } from './ShoppingCard';

const context = (defaultShoppingList: string) => ({ defaultShoppingList }) as DashboardCardContext;

beforeEach(() => {
  getTodoItems.mockReset();
  getTodoItems.mockResolvedValue([{ uid: '1', summary: 'Milk', status: 'needs_action' }]);
});

describe('ShoppingCard', () => {
  it('uses the shopping list from Settings when the card has none of its own', async () => {
    render(<ShoppingCard config={{ shoppingEntity: '' }} context={context('todo.shopping')} />);
    await waitFor(() => expect(screen.getByText('Milk')).toBeInTheDocument());
    expect(getTodoItems).toHaveBeenCalledWith('todo.shopping');
  });

  it("prefers the card's own list over the one in Settings", async () => {
    render(<ShoppingCard config={{ shoppingEntity: 'todo.costco' }} context={context('todo.shopping')} />);
    await waitFor(() => expect(getTodoItems).toHaveBeenCalledWith('todo.costco'));
    expect(getTodoItems).not.toHaveBeenCalledWith('todo.shopping');
  });

  it('shows just the list by default, without an add field', async () => {
    render(<ShoppingCard config={{ shoppingEntity: 'todo.shopping' }} context={context('')} />);
    await waitFor(() => expect(screen.getByText('Milk')).toBeInTheDocument());
    expect(screen.queryByPlaceholderText('Add item...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check Milk' })).toBeInTheDocument();
  });

  it('shows the add field when turned on for the card', async () => {
    render(<ShoppingCard config={{ shoppingEntity: 'todo.shopping', showAddField: true }} context={context('')} />);
    await waitFor(() => expect(screen.getByText('Milk')).toBeInTheDocument());
    expect(screen.getByPlaceholderText('Add item...')).toBeInTheDocument();
  });

  it('explains how to pick a list when neither is set', () => {
    render(<ShoppingCard config={{ shoppingEntity: '' }} context={context('')} />);
    expect(screen.getByText(/Edit this card to pick one/)).toBeInTheDocument();
    expect(getTodoItems).not.toHaveBeenCalled();
  });
});
