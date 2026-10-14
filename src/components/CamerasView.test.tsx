import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CamerasView } from './CamerasView';
import { fetchAllStates } from '../api/ha-rest';
import { fetchCameraSnapshot, getCameraStreamUrl } from '../api/cameras';

vi.mock('../api/ha-rest', () => ({ fetchAllStates: vi.fn() }));
vi.mock('../api/cameras', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/cameras')>(),
  fetchCameraSnapshot: vi.fn(),
  getCameraStreamUrl: vi.fn(),
}));
vi.mock('../utils/hls-player', () => ({ playHls: vi.fn(async () => () => {}) }));

beforeEach(() => {
  vi.mocked(fetchAllStates).mockResolvedValue([
    { entity_id: 'camera.porch', state: 'idle', attributes: { friendly_name: 'Porch', supported_features: 2 } },
    { entity_id: 'camera.garage', state: 'unavailable', attributes: { friendly_name: 'Garage' } },
  ]);
  vi.mocked(fetchCameraSnapshot).mockReset().mockResolvedValue(new Blob(['jpeg']));
  vi.mocked(getCameraStreamUrl).mockReset().mockResolvedValue('/beacon-hls/ab12/master_playlist.m3u8');
  URL.createObjectURL = vi.fn(() => 'blob:picture');
  URL.revokeObjectURL = vi.fn();
});

describe('CamerasView', () => {
  it('shows each chosen camera, named, in order', async () => {
    render(<CamerasView cameras={['camera.porch', 'camera.garage']} />);
    const tiles = await screen.findAllByRole('button', { name: /full screen/ });
    expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual(['Show Porch full screen', 'Show Garage full screen']);
    expect(screen.getByText('· unavailable', { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(fetchCameraSnapshot).toHaveBeenCalledWith('camera.porch', expect.any(AbortSignal)));
  });

  it('shows a camera full screen, live, when tapped', async () => {
    render(<CamerasView cameras={['camera.porch']} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show Porch full screen' }));
    expect(screen.getByRole('dialog', { name: 'Porch, full screen' })).toBeInTheDocument();
    await waitFor(() => expect(getCameraStreamUrl).toHaveBeenCalledWith('camera.porch', undefined));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says so when a chosen camera is no longer in Home Assistant', async () => {
    render(<CamerasView cameras={['camera.gone']} />);
    expect(await screen.findByText("camera.gone isn't in Home Assistant")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show gone full screen' })).toBeDisabled();
    expect(fetchCameraSnapshot).not.toHaveBeenCalled();
  });

  it('explains where to choose cameras when none are', () => {
    render(<CamerasView cameras={[]} />);
    expect(screen.getByText(/Pick up to four in Settings → Integrations → Cameras/)).toBeInTheDocument();
  });
});
