import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CameraLive } from './CameraLive';
import { fetchCameraSnapshot, getCameraStreamUrl, type CameraInfo } from '../../api/cameras';
import { playHls } from '../../utils/hls-player';

vi.mock('../../api/cameras', () => ({ getCameraStreamUrl: vi.fn(), fetchCameraSnapshot: vi.fn() }));
vi.mock('../../utils/hls-player', () => ({ playHls: vi.fn() }));

const porch: CameraInfo = { entityId: 'camera.porch', name: 'Porch', available: true, canStream: true };
const stop = vi.fn();

beforeEach(() => {
  stop.mockReset();
  vi.mocked(getCameraStreamUrl).mockReset().mockResolvedValue('/beacon-hls/ab12/master_playlist.m3u8');
  vi.mocked(playHls).mockReset().mockResolvedValue(stop);
  vi.mocked(fetchCameraSnapshot).mockReset().mockResolvedValue(new Blob(['jpeg']));
  URL.createObjectURL = vi.fn(() => 'blob:picture');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CameraLive', () => {
  it('plays the camera live, and stops when closed', async () => {
    const { unmount } = render(<CameraLive camera={porch} onClose={() => {}} />);
    await waitFor(() => expect(playHls).toHaveBeenCalled());
    const video = screen.getByLabelText('Porch live video');
    expect(playHls).toHaveBeenCalledWith(video, '/beacon-hls/ab12/master_playlist.m3u8', expect.any(Function));
    expect(getCameraStreamUrl).toHaveBeenCalledWith('camera.porch', undefined);
    // Its picture shows until the video starts
    expect(screen.getByText('Starting live video…')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Porch' })).toBeInTheDocument();

    fireEvent.playing(video);
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.queryByText('Starting live video…')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Porch' })).not.toBeInTheDocument();

    unmount();
    expect(stop).toHaveBeenCalled();
  });

  it('shows pictures instead when the stream stops playing', async () => {
    render(<CameraLive camera={porch} onClose={() => {}} />);
    await waitFor(() => expect(playHls).toHaveBeenCalled());
    const onFatal = vi.mocked(playHls).mock.calls[0][2];

    onFatal('manifestLoadError');
    expect(await screen.findByText("Live video couldn't start, so this picture refreshes every second.")).toBeInTheDocument();
    expect(stop).toHaveBeenCalled();
    expect(screen.queryByLabelText('Porch live video')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchCameraSnapshot).toHaveBeenCalledWith('camera.porch', expect.any(AbortSignal)));
  });

  // A stream whose video never plays left it starting for good.
  it("gives up on live video that hasn't started after 30 seconds", async () => {
    vi.useFakeTimers();
    render(<CameraLive camera={porch} onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(playHls).toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(screen.getByText('Starting live video…')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText("Live video couldn't start, so this picture refreshes every second.")).toBeInTheDocument();
    expect(stop).toHaveBeenCalled();
  });

  it("shows pictures instead when HA can't start the stream", async () => {
    vi.mocked(getCameraStreamUrl).mockRejectedValue(new Error('camera.porch does not support play stream service'));
    render(<CameraLive camera={porch} onClose={() => {}} />);
    expect(await screen.findByText("Live video couldn't start, so this picture refreshes every second.")).toBeInTheDocument();
    expect(playHls).not.toHaveBeenCalled();
  });

  it("doesn't try to stream a camera that has no stream", async () => {
    render(<CameraLive camera={{ ...porch, canStream: false }} onClose={() => {}} />);
    expect(screen.getByText('This camera has no live video in Home Assistant, so this picture refreshes every second.')).toBeInTheDocument();
    await waitFor(() => expect(fetchCameraSnapshot).toHaveBeenCalled());
    expect(getCameraStreamUrl).not.toHaveBeenCalled();
  });

  it('closes with its button or Escape', async () => {
    const onClose = vi.fn();
    render(<CameraLive camera={porch} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(playHls).toHaveBeenCalled());
  });
});
