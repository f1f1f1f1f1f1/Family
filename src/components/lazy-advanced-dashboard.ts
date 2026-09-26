import { lazyNamed } from '../utils/lazy-screen';

// Only needed when Advanced Dashboard is switched on; brings GridStack along.
// Render it inside a <LazyBoundary>.
export const AdvancedDashboard = lazyNamed(() => import('./AdvancedDashboard'), 'AdvancedDashboard');
