import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnyListClient, todoItemRef } from './anylist';
import { callHaService } from './ha-rest';

vi.mock('./ha-rest', () => ({ callHaService: vi.fn(), fetchAllStates: vi.fn(async () => []) }));

describe('todoItemRef', () => {
  // HA's update_item takes a uid or a title; by title it changes the first
  // item with it, which may not be the one tapped.
  it('names an item by its uid', () => {
    expect(todoItemRef({ uid: 'a1', summary: 'Take out trash' })).toBe('a1');
  });

  it('names an item by title when it has no real uid yet', () => {
    expect(todoItemRef({ uid: 'temp-1727400000000', summary: 'Bread' })).toBe('Bread');
    expect(todoItemRef({ uid: null, summary: 'Bread' })).toBe('Bread');
  });
});

describe('AnyListClient', () => {
  beforeEach(() => {
    vi.mocked(callHaService).mockReset();
  });

  it('ticks the item with that uid', async () => {
    await new AnyListClient().checkItem('todo.chores', { uid: 'a2', summary: 'Take out trash' });
    expect(callHaService).toHaveBeenCalledWith('todo', 'update_item', { entity_id: 'todo.chores', item: 'a2', status: 'completed' });
  });

  // Failures were logged and swallowed, so a screen showed the tick anyway.
  it('lets a failed change through to the screen', async () => {
    vi.mocked(callHaService).mockRejectedValue(new Error('Service call 500'));
    const client = new AnyListClient();
    await expect(client.checkItem('todo.chores', { uid: 'a2', summary: 'x' })).rejects.toThrow('Service call 500');
    await expect(client.addItem('todo.chores', 'Bread')).rejects.toThrow('Service call 500');
  });
});
