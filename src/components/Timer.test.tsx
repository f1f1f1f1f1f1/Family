import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Timer } from './Timer';

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

function startTimer(name: string, preset: string) {
  fireEvent.change(screen.getByPlaceholderText('Timer name (optional)'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: preset }));
  fireEvent.click(screen.getByTitle('Start timer'));
}

beforeEach(() => {
  // performance.now() too: the countdowns are measured with it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Timer on other screens', () => {
  // App keeps the Timer screen mounted but hidden once it's been opened.
  // Leaving the screen used to end every timer, so they never rang.
  it('keeps counting while hidden, then says which timer is up', () => {
    const { rerender } = render(<Timer shown />);
    startTimer('Pasta', '1m');
    rerender(<Timer shown={false} />);

    advance(59_000);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    advance(2_000);
    expect(screen.getByRole('alert')).toHaveTextContent('Pasta is done');
  });

  it('stops the alarm from the notice', () => {
    const { rerender } = render(<Timer shown />);
    startTimer('Pasta', '1m');
    rerender(<Timer shown={false} />);
    advance(61_000);

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens the Timer screen from the notice', () => {
    const onShow = vi.fn();
    const { rerender } = render(<Timer shown onShow={onShow} />);
    startTimer('Pasta', '1m');
    rerender(<Timer shown={false} onShow={onShow} />);
    advance(61_000);

    fireEvent.click(screen.getByRole('button', { name: 'Show' }));

    expect(onShow).toHaveBeenCalled();
  });

  it('shows no notice on the Timer screen itself, where the timer has its own button', () => {
    render(<Timer shown />);
    startTimer('Pasta', '1m');
    advance(61_000);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTitle('Dismiss alarm')).toBeInTheDocument();
  });

  it('keeps the stopwatch running while hidden', () => {
    const { rerender } = render(<Timer shown />);
    fireEvent.click(screen.getByRole('button', { name: 'Stopwatch' }));
    fireEvent.click(screen.getByTitle('Start'));

    rerender(<Timer shown={false} />);
    advance(5_000);
    rerender(<Timer shown />);

    expect(screen.getByText('00:05')).toBeInTheDocument();
  });
});

describe('Timer after a reload', () => {
  // Timers only lived in the page, so reloading it (an add-on update does)
  // lost them, and they never rang.
  it('keeps counting a running timer', () => {
    const { unmount } = render(<Timer shown />);
    startTimer('Pasta', '1m');
    advance(20_000);
    unmount();

    advance(5_000);
    render(<Timer shown />);

    expect(screen.getByText('Pasta')).toBeInTheDocument();
    expect(screen.getByText('00:35')).toBeInTheDocument();
  });

  it('rings for a timer that ran out meanwhile', () => {
    const { unmount } = render(<Timer shown />);
    startTimer('Pasta', '1m');
    unmount();

    advance(120_000);
    render(<Timer shown={false} />);
    advance(250);

    expect(screen.getByRole('alert')).toHaveTextContent('Pasta is done');
  });

  it('keeps a paused timer paused', () => {
    const { unmount } = render(<Timer shown />);
    startTimer('Pasta', '1m');
    advance(10_000);
    fireEvent.click(screen.getByTitle('Pause'));
    unmount();

    advance(120_000);
    render(<Timer shown />);
    advance(1_000);

    expect(screen.getByText('00:50')).toBeInTheDocument();
    expect(screen.getByTitle('Resume')).toBeInTheDocument();
  });

  it('forgets a removed timer', () => {
    const { unmount } = render(<Timer shown />);
    startTimer('Pasta', '1m');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Pasta' }));
    unmount();

    render(<Timer shown />);

    expect(screen.queryByText('Pasta')).not.toBeInTheDocument();
  });

  // The stopwatch wasn't kept at all, so a reload set it back to zero.
  it('keeps the stopwatch running, with its laps', () => {
    const { unmount } = render(<Timer shown />);
    fireEvent.click(screen.getByRole('button', { name: 'Stopwatch' }));
    fireEvent.click(screen.getByTitle('Start'));
    advance(3_000);
    fireEvent.click(screen.getByTitle('Lap'));
    advance(2_000);
    unmount();

    advance(5_000);
    render(<Timer shown />);
    fireEvent.click(screen.getByRole('button', { name: 'Stopwatch' }));

    expect(screen.getByText('00:10')).toBeInTheDocument();
    expect(screen.getByText('Lap 1')).toBeInTheDocument();
    expect(screen.getByTitle('Pause')).toBeInTheDocument();
  });

  it('keeps a paused stopwatch paused', () => {
    const { unmount } = render(<Timer shown />);
    fireEvent.click(screen.getByRole('button', { name: 'Stopwatch' }));
    fireEvent.click(screen.getByTitle('Start'));
    advance(4_000);
    fireEvent.click(screen.getByTitle('Pause'));
    unmount();

    advance(60_000);
    render(<Timer shown />);
    fireEvent.click(screen.getByRole('button', { name: 'Stopwatch' }));
    advance(1_000);

    expect(screen.getByText('00:04')).toBeInTheDocument();
    expect(screen.getByTitle('Start')).toBeInTheDocument();
  });

  // Without laps too: reset sets a new, empty laps array, which saves it as reset.
  it('forgets a stopwatch that was reset', () => {
    const { unmount } = render(<Timer shown />);
    fireEvent.click(screen.getByRole('button', { name: 'Stopwatch' }));
    fireEvent.click(screen.getByTitle('Start'));
    advance(2_000);
    fireEvent.click(screen.getByTitle('Pause'));
    fireEvent.click(screen.getByTitle('Reset'));
    unmount();

    render(<Timer shown />);
    fireEvent.click(screen.getByRole('button', { name: 'Stopwatch' }));

    expect(screen.getByText('00:00')).toBeInTheDocument();
    expect(localStorage.getItem('beacon-stopwatch')).toBeNull();
  });
});
