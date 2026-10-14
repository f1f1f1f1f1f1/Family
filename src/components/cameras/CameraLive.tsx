import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { HomeAssistantClient } from '../../api/homeassistant';
import { getCameraStreamUrl, type CameraInfo } from '../../api/cameras';
import { playHls } from '../../utils/hls-player';
import { CameraSnapshot } from './CameraSnapshot';

interface CameraLiveProps {
  camera: CameraInfo;
  getClient?: () => HomeAssistantClient | null;
  onClose: () => void;
}

type Mode = 'starting' | 'live' | 'snapshots';

/**
 * How long live video may take to start. HA answers once the camera has
 * sent a whole segment, which can take several seconds; a stream that
 * never plays (the player keeps waiting on it) gives way to pictures.
 */
const START_TIMEOUT_MS = 30_000;

/**
 * One camera full screen, as live video, showing its picture until the
 * video starts. A camera HA can't stream, or a stream that won't play,
 * shows its picture refreshed every second instead, saying so.
 */
export function CameraLive({ camera, getClient, onClose }: CameraLiveProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<Mode>(camera.canStream ? 'starting' : 'snapshots');
  const stopStream = useRef<(() => void) | null>(null);
  const gaveUp = useRef(false);

  const fallBack = useCallback((reason: unknown) => {
    if (gaveUp.current) return;
    gaveUp.current = true;
    console.warn(`Family: live video for ${camera.entityId} didn't play:`, reason);
    stopStream.current?.();
    stopStream.current = null;
    setMode('snapshots');
  }, [camera.entityId]);

  useEffect(() => {
    if (!camera.canStream) return;
    let stopped = false;
    gaveUp.current = false;

    (async () => {
      try {
        const url = await getCameraStreamUrl(camera.entityId, getClient?.());
        const video = videoRef.current;
        if (stopped || gaveUp.current || !video) return;
        const stop = await playHls(video, url, (reason) => { if (!stopped) fallBack(reason); });
        if (stopped || gaveUp.current) stop();
        else stopStream.current = stop;
      } catch (err) {
        if (!stopped) fallBack(err);
      }
    })();

    return () => {
      stopped = true;
      stopStream.current?.();
      stopStream.current = null;
    };
  }, [camera.entityId, camera.canStream, getClient, fallBack]);

  useEffect(() => {
    if (mode !== 'starting') return;
    const timer = setTimeout(() => fallBack('no picture after 30 seconds'), START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [mode, fallBack]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Rendered at the top level of the page, like AirPlay: inside the app's
  // main area, its animated wrapper confines the fixed layer to that area.
  return createPortal(
    <div className="camera-live" role="dialog" aria-modal="true" aria-label={`${camera.name}, full screen`}>
      <div className="camera-live-header">
        <span className="camera-live-name">{camera.name}</span>
        {mode === 'live' && <span className="camera-live-badge">Live</span>}
        <button type="button" className="camera-live-close" onClick={onClose} aria-label="Close">
          <X size={22} />
        </button>
      </div>
      <div className="camera-live-stage">
        {mode !== 'live' && (
          <CameraSnapshot entityId={camera.entityId} name={camera.name} intervalMs={1000} />
        )}
        {mode !== 'snapshots' && (
          <video
            ref={videoRef}
            className={`camera-live-video${mode === 'starting' ? ' camera-live-video--starting' : ''}`}
            aria-label={`${camera.name} live video`}
            muted
            autoPlay
            playsInline
            onPlaying={() => setMode('live')}
          />
        )}
        {mode === 'starting' && <div className="camera-live-status">Starting live video…</div>}
      </div>
      {mode === 'snapshots' && (
        <p className="camera-live-note">
          {camera.canStream
            ? "Live video couldn't start, so this picture refreshes every second."
            : "This camera has no live video in Home Assistant, so this picture refreshes every second."}
        </p>
      )}
    </div>,
    document.body,
  );
}
