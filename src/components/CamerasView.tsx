import { useEffect, useState } from 'react';
import { Cctv } from 'lucide-react';
import type { HomeAssistantClient } from '../api/homeassistant';
import { cameraInfo, type CameraInfo } from '../api/cameras';
import { fetchAllStates } from '../api/ha-rest';
import { CameraSnapshot } from './cameras/CameraSnapshot';
import { CameraLive } from './cameras/CameraLive';
import '../styles/cameras.css';

interface CamerasViewProps {
  /** The cameras chosen in Settings, in order (see chosenCameras) */
  cameras: string[];
  getClient?: () => HomeAssistantClient | null;
}

/** How long after one snapshot arrives to ask for the next */
const SNAPSHOT_INTERVAL_MS = 2000;

/**
 * Up to four Home Assistant cameras as pictures refreshed every couple of
 * seconds; tapping one shows it full screen, live.
 */
export function CamerasView({ cameras, getClient }: CamerasViewProps) {
  const [info, setInfo] = useState<Record<string, CameraInfo> | null>(null);
  const [liveId, setLiveId] = useState<string | null>(null);
  const camerasKey = cameras.join(',');

  useEffect(() => {
    let cancelled = false;
    const wanted = camerasKey.split(',');
    fetchAllStates()
      .then((states) => {
        if (cancelled) return;
        setInfo(Object.fromEntries(states
          .filter((state) => wanted.includes(state.entity_id))
          .map((state) => [state.entity_id, cameraInfo(state)])));
      })
      .catch(() => {
        if (!cancelled) setInfo({});
      });
    return () => { cancelled = true; };
  }, [camerasKey]);

  if (cameras.length === 0) {
    return (
      <div className="cameras-view cameras-view--empty">
        <Cctv size={40} strokeWidth={1.5} aria-hidden="true" />
        <p>No cameras chosen yet. Pick up to four in Settings → Integrations → Cameras.</p>
      </div>
    );
  }

  // Until the states arrive, a camera is taken to stream; CameraLive falls
  // back to pictures if it can't.
  const describe = (id: string): CameraInfo =>
    info?.[id] ?? { entityId: id, name: id.replace(/^camera\./, '').replace(/_/g, ' '), available: true, canStream: true };
  const live = liveId ? describe(liveId) : null;

  return (
    <div className="cameras-view">
      <div className={`cameras-grid cameras-grid--${Math.min(cameras.length, 4)}`}>
        {cameras.map((id) => {
          const camera = describe(id);
          const missing = info !== null && !info[id];
          return (
            <button
              key={id}
              type="button"
              className="cameras-tile"
              onClick={() => setLiveId(id)}
              aria-label={`Show ${camera.name} full screen`}
              disabled={missing}
            >
              {info === null || missing ? (
                <div className="camera-snapshot">
                  <div className="camera-snapshot-status">
                    {missing ? `${id} isn't in Home Assistant` : 'Loading…'}
                  </div>
                </div>
              ) : (
                <CameraSnapshot
                  entityId={id}
                  name={camera.name}
                  intervalMs={SNAPSHOT_INTERVAL_MS}
                  paused={liveId !== null}
                />
              )}
              <span className="cameras-tile-name">
                {camera.name}
                {!camera.available && <span className="cameras-tile-state"> · unavailable</span>}
              </span>
            </button>
          );
        })}
      </div>
      {live && <CameraLive camera={live} getClient={getClient} onClose={() => setLiveId(null)} />}
    </div>
  );
}
