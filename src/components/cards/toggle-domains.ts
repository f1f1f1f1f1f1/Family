/**
 * Domains the HA Toggle card can switch. The add-on server only lets
 * `<domain>.toggle` through for these, so keep in sync with TOGGLE_DOMAINS
 * in server-guards.cjs.
 */
export const TOGGLE_DOMAINS = ['light', 'switch', 'input_boolean', 'fan'];

export function canToggle(entityId: string): boolean {
  return TOGGLE_DOMAINS.includes(entityId.split('.')[0]);
}
