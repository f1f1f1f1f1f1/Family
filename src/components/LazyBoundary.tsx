import { Component, Suspense, type ReactNode } from 'react';

/** Shown while a screen's code downloads. Fades in only if that takes a moment, so quick loads don't flash. */
export function LoadingFallback() {
  return (
    <div className="lazy-fallback" role="status">
      Loading…
    </div>
  );
}

interface LazyBoundaryProps {
  children: ReactNode;
  /** Shown while the code downloads (default: a small "Loading…"). */
  fallback?: ReactNode;
}

interface LazyBoundaryState {
  failed: boolean;
}

/**
 * Suspense plus an error boundary for screens loaded with lazyNamed(), so a
 * screen that can't load (or crashes) shows a Reload button in its place
 * instead of blanking the whole app.
 */
export class LazyBoundary extends Component<LazyBoundaryProps, LazyBoundaryState> {
  state: LazyBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazyBoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="lazy-error" role="alert">
          <p>This screen couldn't load.</p>
          <button type="button" className="settings-btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    // A default (not ??) so that fallback={null} means "show nothing".
    const { fallback = <LoadingFallback />, children } = this.props;
    return <Suspense fallback={fallback}>{children}</Suspense>;
  }
}
