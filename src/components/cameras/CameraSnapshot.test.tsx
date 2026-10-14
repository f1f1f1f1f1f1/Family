import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CameraSnapshot } from './CameraSnapshot';
import { fetchCameraSnapshot } from '../../api/cameras';
import { setDisplayAsleep } from '../../utils/display-sleep';

vi.mock('../../api/cameras', () => ({ fetchCameraSnapshot: vi.fn() }));

let urls = 0;
const revoked: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  urls = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn(() => `blob:picture-${++urls}`);
  URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
  vi.mocked(fetchCameraSnapshot).mockReset().mockResolvedValue(new Blob(['jpeg']));
});

afterEach(() => {
  setDisplayAsleep(false);
  vi.useRealTimers();
});

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('CameraSnapshot', () => {
  it("shows the camera's picture, and a new one after the interval", async () => {
    render(<CameraSnapshot entityId="camera.porch" name="Porch" intervalMs={2000} />);
    await settle();
    const img = screen.getByRole('img', { name: 'Porch' });
    expect(img).toHaveAttribute('src', 'blob:picture-1');
    expect(fetchCameraSnapshot).toHaveBeenCalledWith('camera.porch', expect.any(AbortSignal));
    fireEvent.load(img);

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fetchCameraSnapshot).toHaveBeenCalledTimes(2);
    expect(img).toHaveAttribute('src', 'blob:picture-2');

    // The last picture stays until the new one has loaded, then is let go
    expect(revoked).toEqual([]);
    fireEvent.load(img);
    expect(revoked).toEqual(['blob:picture-1']);
  });

  it('asks for one picture at a time', async () => {
    let arrive!: (blob: Blob) => void;
    vi.mocked(fetchCameraSnapshot).mockReturnValueOnce(new Promise((resolve) => { arrive = resolve; }));
    render(<CameraSnapshot entityId="camera.porch" name="Porch" intervalMs={2000} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchCameraSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => { arrive(new Blob(['jpeg'])); await vi.advanceTimersByTimeAsync(2000); });
    expect(fetchCameraSnapshot).toHaveBeenCalledTimes(2);
  });

  it('asks for none while paused or under the screen saver', async () => {
    const { rerender } = render(<CameraSnapshot entityId="camera.porch" name="Porch" intervalMs={2000} paused />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchCameraSnapshot).not.toHaveBeenCalled();

    setDisplayAsleep(true);
    rerender(<CameraSnapshot entityId="camera.porch" name="Porch" intervalMs={2000} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchCameraSnapshot).not.toHaveBeenCalled();

    setDisplayAsleep(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fetchCameraSnapshot).toHaveBeenCalledTimes(1);
  });

  it("says so when the camera can't be shown, and when its picture stops updating", async () => {
    vi.mocked(fetchCameraSnapshot).mockRejectedValueOnce(new Error('HA API 500'));
    render(<CameraSnapshot entityId="camera.porch" name="Porch" intervalMs={2000} />);
    await settle();
    expect(screen.getByText("Can't show this camera right now")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole('img', { name: 'Porch' })).toBeInTheDocument();

    vi.mocked(fetchCameraSnapshot).mockRejectedValueOnce(new Error('HA API 500'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole('img', { name: 'Porch' })).toBeInTheDocument();
    expect(screen.getByText('Not updating')).toBeInTheDocument();
  });

  it('lets its pictures go when it closes', async () => {
    const { unmount } = render(<CameraSnapshot entityId="camera.porch" name="Porch" intervalMs={2000} />);
    await settle();
    unmount();
    expect(revoked).toEqual(['blob:picture-1']);
  });
});
