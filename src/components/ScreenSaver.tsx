import { useState, useEffect, useRef, useCallback } from 'react';
import { format } from 'date-fns';
import { usePhotos } from '../hooks/usePhotos';
import { requestFullBleed } from '../utils/ha-kiosk';

const POSITION_INTERVAL = 30_000; // move clock every 30s

type Phase = 'awake' | 'dim' | 'screensaver';

interface ScreenSaverProps {
  enabled?: boolean;
  dimTimeoutMin?: number;
  screenSaverTimeoutMin?: number;
  showPhotos?: boolean;
  photoIntervalSeconds?: number;
}

export function ScreenSaver({
  enabled = true,
  dimTimeoutMin = 5,
  screenSaverTimeoutMin = 10,
  showPhotos = false,
  photoIntervalSeconds = 30,
}: ScreenSaverProps) {
  const [phase, setPhase] = useState<Phase>('awake');

  // A photo screensaver fills the whole screen, under the iPhone notch too.
  const fullBleed = enabled && showPhotos && phase === 'screensaver';
  useEffect(() => (fullBleed ? requestFullBleed() : undefined), [fullBleed]);
  const [now, setNow] = useState(new Date());
  const [position, setPosition] = useState({ x: 50, y: 50 });
  const lastActivityRef = useRef(Date.now());

  const dimAfterMs = dimTimeoutMin * 60 * 1000;
  const screenSaverAfterMs = screenSaverTimeoutMin * 60 * 1000;

  // Photos load on mount regardless of phase (so the first photo is ready
  // the moment the screensaver activates, no blank flash), but only
  // actively cycle while the screensaver is actually showing.
  const { currentPhoto, isActive: photosActive, setActive: setPhotosActive } = usePhotos(
    ['ha_media', 'local'],
    photoIntervalSeconds,
  );

  useEffect(() => {
    if (!showPhotos) return;
    const shouldCycle = phase === 'screensaver';
    if (shouldCycle !== photosActive) setPhotosActive(shouldCycle);
  }, [showPhotos, phase, photosActive, setPhotosActive]);

  const wake = useCallback(() => {
    lastActivityRef.current = Date.now();
    setPhase('awake');
  }, []);

  // Listen for user interaction globally
  useEffect(() => {
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, wake, { passive: true }));
    return () => {
      events.forEach((e) => window.removeEventListener(e, wake));
    };
  }, [wake]);

  // Idle timer — check every 10 seconds
  useEffect(() => {
    if (!enabled) {
      setPhase('awake');
      return;
    }

    const check = () => {
      const idle = Date.now() - lastActivityRef.current;
      if (idle >= screenSaverAfterMs) {
        setPhase('screensaver');
      } else if (idle >= dimAfterMs) {
        setPhase('dim');
      }
    };

    const interval = setInterval(check, 10_000);
    return () => clearInterval(interval);
  }, [enabled, dimAfterMs, screenSaverAfterMs]);

  // Clock tick for screensaver
  useEffect(() => {
    if (phase !== 'screensaver') return;
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, [phase]);

  // Move screensaver clock position periodically to prevent burn-in
  useEffect(() => {
    if (phase !== 'screensaver') return;

    const move = () => {
      setPosition({
        x: 15 + Math.random() * 70, // 15%–85%
        y: 15 + Math.random() * 70,
      });
    };

    move(); // initial position
    const interval = setInterval(move, POSITION_INTERVAL);
    return () => clearInterval(interval);
  }, [phase]);

  if (!enabled || phase === 'awake') return null;

  if (phase === 'dim') {
    return <div className="screensaver-dim" onClick={wake} />;
  }

  return (
    <div className="screensaver-overlay" onClick={wake}>
      {showPhotos && currentPhoto && (
        <>
          <div
            key={currentPhoto.url}
            className="screensaver-photo"
            style={{ backgroundImage: `url(${currentPhoto.url})` }}
          />
          <div className="screensaver-photo-scrim" />
        </>
      )}
      <div
        className="screensaver-clock"
        style={{ left: `${position.x}%`, top: `${position.y}%` }}
      >
        <div className="screensaver-time">{format(now, 'h:mm')}</div>
        <div className="screensaver-date">{format(now, 'EEEE, MMMM d')}</div>
      </div>
    </div>
  );
}
