export interface GroceryItem {
  id: string;
  name: string;
  checked: boolean;
  category?: string;
  quantity?: string;
  added_by?: string;
}

export interface GroceryList {
  id: string;
  name: string;
  items: GroceryItem[];
}
