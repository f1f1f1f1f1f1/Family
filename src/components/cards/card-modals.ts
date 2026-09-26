import { lazyNamed } from '../../utils/lazy-screen';

// The dashboard editors' "Add Card" and card-settings dialogs, downloaded the
// first time one is opened. Render them inside a <LazyBoundary>.
export const CardPickerModal = lazyNamed(() => import('./CardPickerModal'), 'CardPickerModal');
export const CardConfigModal = lazyNamed(() => import('./CardConfigModal'), 'CardConfigModal');
