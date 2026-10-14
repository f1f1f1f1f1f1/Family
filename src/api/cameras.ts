/**
 * Home Assistant cameras: the list to pick from, snapshots, and live
 * streams.
 *
 * Snapshots come from HA's /api/camera_proxy/<camera>, through the Family
 * server like every other HA read. HA's MJPEG stream can't come that way:
 * the Supervisor holds each answer until it ends, and that one never does.
 * Live video is HA's HLS stream instead, made of short files, which the
 * server passes on at /beacon-hls/ (see server.js, proxyHls).
 */
import type { HomeAssistantClient } from './homeassistant';
import { callBeaconAction, fetchAllStates, haFetchBlob, haResourceUrl, type HaStateObject } from './ha-rest';
import { isAddOn } from '../utils/ha-env';

/** HA's CameraEntityFeature.STREAM: the camera has a live stream. */
const SUPPORT_STREAM = 2;

export interface CameraInfo {
  entityId: string;
  name: string;
  available: boolean;
  /** Whether HA can play it live (it has a stream source). */
  canStream: boolean;
}

export function cameraInfo(state: HaStateObject): CameraInfo {
  const features = Number(state.attributes?.supported_features) || 0;
  return {
    entityId: state.entity_id,
    name: (state.attributes?.friendly_name as string | undefined) || state.entity_id.replace(/^camera\./, '').replace(/_/g, ' '),
    available: state.state !== 'unavailable',
    canStream: (features & SUPPORT_STREAM) !== 0,
  };
}

/** Every camera in HA (that the Family server doesn't hide), by name. */
export async function listCameras(): Promise<CameraInfo[]> {
  const states = await fetchAllStates();
  return states
    .filter((state) => state.entity_id.startsWith('camera.'))
    .map(cameraInfo)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The camera's picture right now. */
export function fetchCameraSnapshot(entityId: string, signal?: AbortSignal): Promise<Blob> {
  return haFetchBlob(`/api/camera_proxy/${entityId}`, signal);
}

/**
 * Starts the camera's live stream in HA and returns the address of its
 * HLS playlist. Rejects when the camera can't stream.
 */
export async function getCameraStreamUrl(entityId: string, client?: HomeAssistantClient | null): Promise<string> {
  if (isAddOn()) {
    const { url } = await callBeaconAction('/beacon-action/camera-stream', { entity_id: entityId }) as { url: string };
    return haResourceUrl(`/${url}`);
  }
  if (!client?.isConnected) throw new Error('Not connected to Home Assistant');
  return haResourceUrl(await client.getCameraStreamPath(entityId));
}
