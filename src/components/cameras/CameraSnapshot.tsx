import { useEffect, useRef, useState } from 'react';
import { fetchCameraSnapshot } from '../../api/cameras';
import { isDisplayAsleep } from '../../utils/display-sleep';

interface CameraSnapshotProps {
  entityId: string;
  name: string;
  /** How long after one picture arrives to ask for the next */
  intervalMs: number;
  /** Stop asking for pictures (the last one stays) */
  paused?: boolean;
}

/**
 * A camera's picture, fetched again every `intervalMs` (one request at a
 * time, and none while the page is hidden or the screen saver is on).
 * Each new picture replaces the last once it has loaded, so it doesn't
 * flicker.
 */
export function CameraSnapshot({ entityId, name, intervalMs, paused = false }: CameraSnapshotProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Object URLs: the newest picture, and the one the <img> shows
  const latest = useRef<string | null>(null);
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (paused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const load = async () => {
      if (!document.hidden && !isDisplayAsleep()) {
        try {
          const blob = await fetchCameraSnapshot(entityId, controller.signal);
          if (stopped) return;
          // One that arrived but never got shown isn't needed any more.
          if (latest.current && latest.current !== shown.current) URL.revokeObjectURL(latest.current);
          latest.current = URL.createObjectURL(blob);
          setSrc(latest.current);
          setFailed(false);
        } catch {
          if (stopped) return;
          setFailed(true);
        }
      }
      if (!stopped) timer = setTimeout(load, intervalMs);
    };
    void load();

    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [entityId, intervalMs, paused]);

  useEffect(() => () => {
    for (const url of new Set([latest.current, shown.current])) {
      if (url) URL.revokeObjectURL(url);
    }
  }, []);

  const handleLoad = () => {
    if (shown.current && shown.current !== src) URL.revokeObjectURL(shown.current);
    shown.current = src;
  };

  return (
    <div className="camera-snapshot">
      {src && <img className="camera-snapshot-img" src={src} alt={name} onLoad={handleLoad} />}
      {failed && !src && <div className="camera-snapshot-status">Can't show this camera right now</div>}
      {failed && src && <div className="camera-snapshot-stale">Not updating</div>}
      {!failed && !src && <div className="camera-snapshot-status">Loading…</div>}
    </div>
  );
}
