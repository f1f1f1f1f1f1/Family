/** Keywords that identify a to-do list as grocery/shopping (vs tasks) by its name. */
const GROCERY_KEYWORDS = [
  'grocer', 'shopping', 'costco', 'walmart', 'target', 'store',
  'pantry', 'fridge', 'freezer', 'inventory', 'meal',
];

/** Fallback classification used when no grocery lists are configured in Settings. */
export function isGroceryListName(name: string): boolean {
  const lower = name.toLowerCase();
  return GROCERY_KEYWORDS.some((kw) => lower.includes(kw));
}
