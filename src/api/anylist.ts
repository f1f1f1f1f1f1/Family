import { GroceryItem, GroceryList } from '../types/grocery';
import { callHaService, fetchAllStates } from './ha-rest';
import { getTodoItems } from './ha-services';

type TodoItemRef = { uid?: string | null; summary: string };

/**
 * How HA's todo services (update_item, remove_item) find an item: by uid,
 * since two items can share a title and HA would change the first one with
 * it. An item added moments ago and not reloaded yet has only a temporary
 * id here ("temp-…"), so that one goes by title.
 */
export function todoItemRef(item: TodoItemRef): string {
  return item.uid && !item.uid.startsWith('temp-') ? item.uid : item.summary;
}

/**
 * AnyList / Todo integration via Home Assistant's REST API.
 *
 * Discovers all todo.* entities (AnyList, Shopping List, etc.) and provides
 * a unified interface for listing, adding, checking, and unchecking items.
 */
export class AnyListClient {
  /**
   * Discover available todo entities by fetching all states and filtering
   * to entities that are actually available (not unavailable/unknown).
   *
   * Uses the shared, briefly cached copy of all states (fetchAllStates),
   * so a list created or removed in Google Tasks still shows up within
   * seconds without a page reload.
   */
  private async discoverEntities(): Promise<string[]> {
    try {
      const states = await fetchAllStates();

      return states
        .filter(s => s.entity_id.startsWith('todo.') && s.state !== 'unavailable')
        .map(s => s.entity_id);
    } catch {
      return [];
    }
  }

  async getLists(): Promise<GroceryList[]> {
    const entityIds = await this.discoverEntities();
    if (entityIds.length === 0) return [];

    try {
      const states = await fetchAllStates(); // same shared copy discoverEntities used

      return entityIds.map(entityId => {
        const entity = states.find(s => s.entity_id === entityId);
        const friendlyName = (entity?.attributes?.friendly_name as string)
          ?? entityId.replace('todo.', '').replace(/_/g, ' ');

        return {
          id: entityId,
          name: friendlyName,
          items: [],
        };
      });
    } catch (err) {
      console.warn('Beacon: Failed to fetch todo lists', err);
      return [];
    }
  }

  async getItems(listId: string): Promise<GroceryItem[]> {
    const entityIds = await this.discoverEntities();
    if (!entityIds.includes(listId)) return [];

    try {
      const items = await getTodoItems(listId);
      return (items ?? []).map(item => ({
        id: item.uid,
        name: item.summary,
        checked: item.status === 'completed',
      }));
    } catch (err) {
      console.warn(`Beacon: Failed to fetch items for ${listId}`, err);
      return [];
    }
  }

  // add/check/uncheck throw when HA doesn't take the change, so the screens
  // can undo what they showed (they used to show it as done regardless).

  async addItem(listId: string, name: string): Promise<void> {
    await callHaService('todo', 'add_item', {
      entity_id: listId,
      item: name,
    });
  }

  async checkItem(listId: string, item: TodoItemRef): Promise<void> {
    await callHaService('todo', 'update_item', {
      entity_id: listId,
      item: todoItemRef(item),
      status: 'completed',
    });
  }

  async uncheckItem(listId: string, item: TodoItemRef): Promise<void> {
    await callHaService('todo', 'update_item', {
      entity_id: listId,
      item: todoItemRef(item),
      status: 'needs_action',
    });
  }

  /** No-op now that entity discovery isn't cached — kept for API compatibility. */
  resetEntities(): void {}
}
