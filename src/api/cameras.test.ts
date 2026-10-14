import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cameraInfo, fetchCameraSnapshot, getCameraStreamUrl, listCameras } from './cameras';
import { callBeaconAction, fetchAllStates, haFetchBlob } from './ha-rest';
import type { HomeAssistantClient } from './homeassistant';

const env = vi.hoisted(() => ({ addOn: true }));
vi.mock('../utils/ha-env', () => ({ isAddOn: () => env.addOn }));
vi.mock('./ha-rest', () => ({
  callBeaconAction: vi.fn(),
  fetchAllStates: vi.fn(),
  haFetchBlob: vi.fn(),
  haResourceUrl: (path: string) => `/api/hassio_ingress/abc${path}`,
}));

beforeEach(() => {
  env.addOn = true;
  vi.mocked(callBeaconAction).mockReset();
});

describe('cameraInfo', () => {
  it('names a camera, and says whether it can stream and is there', () => {
    expect(cameraInfo({ entity_id: 'camera.front_door', state: 'idle', attributes: { friendly_name: 'Front Door', supported_features: 3 } }))
      .toEqual({ entityId: 'camera.front_door', name: 'Front Door', available: true, canStream: true });
    expect(cameraInfo({ entity_id: 'camera.back_yard', state: 'unavailable', attributes: { supported_features: 1 } }))
      .toEqual({ entityId: 'camera.back_yard', name: 'back yard', available: false, canStream: false });
  });
});

describe('listCameras', () => {
  it('lists the cameras in HA by name, and nothing else', async () => {
    vi.mocked(fetchAllStates).mockResolvedValue([
      { entity_id: 'camera.porch', state: 'idle', attributes: { friendly_name: 'Porch' } },
      { entity_id: 'light.porch', state: 'on', attributes: { friendly_name: 'Porch light' } },
      { entity_id: 'camera.garage', state: 'idle', attributes: { friendly_name: 'Garage' } },
    ]);
    expect((await listCameras()).map((camera) => camera.name)).toEqual(['Garage', 'Porch']);
  });
});

describe('fetchCameraSnapshot', () => {
  it("asks HA's camera proxy for the picture", async () => {
    const blob = new Blob(['jpeg']);
    vi.mocked(haFetchBlob).mockResolvedValue(blob);
    expect(await fetchCameraSnapshot('camera.porch')).toBe(blob);
    expect(haFetchBlob).toHaveBeenCalledWith('/api/camera_proxy/camera.porch', undefined);
  });
});

describe('getCameraStreamUrl', () => {
  it('starts the stream through the Family server, and plays it from there', async () => {
    vi.mocked(callBeaconAction).mockResolvedValue({ url: 'beacon-hls/ab12/master_playlist.m3u8' });
    expect(await getCameraStreamUrl('camera.porch')).toBe('/api/hassio_ingress/abc/beacon-hls/ab12/master_playlist.m3u8');
    expect(callBeaconAction).toHaveBeenCalledWith('/beacon-action/camera-stream', { entity_id: 'camera.porch' });
  });

  it('asks HA directly in the app without the server', async () => {
    env.addOn = false;
    const client = { isConnected: true, getCameraStreamPath: vi.fn(async () => '/api/hls/ab12/master_playlist.m3u8') };
    expect(await getCameraStreamUrl('camera.porch', client as unknown as HomeAssistantClient))
      .toBe('/api/hassio_ingress/abc/api/hls/ab12/master_playlist.m3u8');
    expect(client.getCameraStreamPath).toHaveBeenCalledWith('camera.porch');
  });

  it("fails when it can't reach HA", async () => {
    env.addOn = false;
    await expect(getCameraStreamUrl('camera.porch', null)).rejects.toThrow('Not connected');
  });
});
