import { GroceryItem, GroceryList } from '../types/grocery';
import { haFetch, callHaService } from './ha-rest';

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
   * Always fetches fresh rather than caching — a list created (or
   * removed) in Google Tasks after this client was constructed needs to
   * show up without requiring a full page reload to get a new client
   * instance. /api/states is cheap enough that re-fetching each call is
   * fine, especially since getLists() already fetches it again anyway.
   */
  private async discoverEntities(): Promise<string[]> {
    try {
      const states = await haFetch('/api/states') as Array<{
        entity_id: string;
        state: string;
        attributes: Record<string, unknown>;
      }>;

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
      const states = await haFetch('/api/states') as Array<{
        entity_id: string;
        state: string;
        attributes: Record<string, unknown>;
      }>;

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
      // Use todo.get_items with return_response to get actual items
      const result = await callHaService('todo', 'get_items', {
        entity_id: listId,
      }, true) as {
        service_response?: Record<string, { items?: Array<{ uid: string; summary: string; status: string }> }>;
      };

      // Parse the service_response format: { "todo.entity_id": { items: [...] } }
      const entityResponse = result?.service_response?.[listId];
      if (entityResponse?.items) {
        return entityResponse.items.map(item => ({
          id: item.uid,
          name: item.summary,
          checked: item.status === 'completed',
        }));
      }

      return [];
    } catch (err) {
      console.warn(`Beacon: Failed to fetch items for ${listId}`, err);
      return [];
    }
  }

  async addItem(listId: string, name: string): Promise<void> {
    const entityIds = await this.discoverEntities();
    if (!entityIds.includes(listId)) return;

    try {
      await callHaService('todo', 'add_item', {
        entity_id: listId,
        item: name,
      });
    } catch (err) {
      console.warn('Beacon: Failed to add item', err);
    }
  }

  async checkItem(listId: string, itemName: string): Promise<void> {
    try {
      await callHaService('todo', 'update_item', {
        entity_id: listId,
        item: itemName,
        status: 'completed',
      });
    } catch (err) {
      console.warn('Beacon: Failed to check item', err);
    }
  }

  async uncheckItem(listId: string, itemName: string): Promise<void> {
    try {
      await callHaService('todo', 'update_item', {
        entity_id: listId,
        item: itemName,
        status: 'needs_action',
      });
    } catch (err) {
      console.warn('Beacon: Failed to uncheck item', err);
    }
  }

  /** No-op now that entity discovery isn't cached — kept for API compatibility. */
  resetEntities(): void {}
}
