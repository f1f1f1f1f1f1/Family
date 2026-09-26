import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { lazyNamed } from './lazy-screen';
import { LazyBoundary } from '../components/LazyBoundary';

function Hello({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

describe('lazyNamed + LazyBoundary', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('renders the named export once its file has loaded', async () => {
    const Lazy = lazyNamed(() => Promise.resolve({ Hello }), 'Hello');
    render(
      <LazyBoundary>
        <Lazy name="Family" />
      </LazyBoundary>,
    );
    expect(await screen.findByText('Hello Family')).toBeInTheDocument();
  });

  it('shows "Loading…" while downloading, or nothing with fallback={null}', () => {
    const Pending = lazyNamed<'Hello', { Hello: typeof Hello }>(() => new Promise(() => {}), 'Hello');
    const { unmount } = render(
      <LazyBoundary>
        <Pending name="x" />
      </LazyBoundary>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    unmount();

    render(
      <LazyBoundary fallback={null}>
        <Pending name="x" />
      </LazyBoundary>,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('downloads only once when preloaded before rendering', async () => {
    const load = vi.fn(() => Promise.resolve({ Hello }));
    const Lazy = lazyNamed(load, 'Hello');
    Lazy.preload();
    render(
      <LazyBoundary>
        <Lazy name="again" />
      </LazyBoundary>,
    );
    expect(await screen.findByText('Hello again')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shows a Reload button in place of a screen that cannot load', async () => {
    // A reload was just tried, so the error is shown instead of reloading again.
    sessionStorage.setItem('beacon-lazy-reload-at', String(Date.now()));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Lazy = lazyNamed<'Hello', { Hello: typeof Hello }>(
      () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
      'Hello',
    );
    render(
      <div>
        <p>Sidebar</p>
        <LazyBoundary>
          <Lazy name="Family" />
        </LazyBoundary>
      </div>,
    );
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByText("This screen couldn't load.")).toBeInTheDocument();
    // The rest of the app keeps rendering.
    expect(screen.getByText('Sidebar')).toBeInTheDocument();
  });
});
