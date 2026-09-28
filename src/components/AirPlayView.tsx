import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Airplay, ArrowLeft, Music, Volume2 } from 'lucide-react';
import {
  airPlayCoverUrl,
  airPlayStreamUrl,
  createMediaAssembler,
  parseAirPlayStatus,
  type AirPlayStatus,
} from '../api/airplay';
import { canPlayAirPlayVideo, createAirPlayVideo, type AirPlayVideoPlayer } from '../utils/airplay-video';
import { createAirPlayAudio, suspendSharedAudio, type AirPlayAudioPlayer } from '../utils/airplay-audio';
import { requestFullBleed } from '../utils/ha-kiosk';
import '../styles/airplay.css';

/**
 * The AirPlay screen: shows what a phone, tablet or Mac sends to the
 * add-on's AirPlay receiver: a mirrored screen, or the cover and title of
 * what's playing, with its sound. Like the photo frame, it covers the
 * whole display; a tap brings up the back button.
 *
 * While shown (and the page visible) it takes the add-on's stream over a
 * WebSocket: the status as text, and the picture and sound as binary
 * messages (airplay-relay.cjs), which airplay-video/airplay-audio play.
 */

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;
const CONTROLS_MS = 5000;

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

interface AirPlayViewProps {
  status: AirPlayStatus | null;
  /** The status the stream sends, which comes sooner than App's checks. */
  onStatus: (status: AirPlayStatus) => void;
  onBack: () => void;
}

export function AirPlayView({ status, onStatus, onBack }: AirPlayViewProps) {
  // Draw under the iPhone notch / home bar inside the HA app too.
  useEffect(() => requestFullBleed(), []);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<AirPlayAudioPlayer | null>(null);
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);
  const [canPlay] = useState(canPlayAirPlayVideo);
  const [problem, setProblem] = useState<string | null>(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const visible = usePageVisible();

  useEffect(() => {
    if (!visible) return;
    const video = videoRef.current;
    let stopped = false;
    let socket: WebSocket | null = null;
    let videoPlayer: AirPlayVideoPlayer | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let wait = FIRST_RETRY_MS;
    const audio = createAirPlayAudio({ onBlockedChange: setSoundBlocked });
    audioRef.current = audio;

    /** Drops this connection (and its picture) and, unless stopped, makes a new one. */
    const reconnect = () => {
      const ws = socket;
      socket = null;
      ws?.close();
      videoPlayer?.close();
      videoPlayer = null;
      if (stopped) return;
      retry = setTimeout(connect, wait);
      wait = Math.min(wait * 2, MAX_RETRY_MS);
    };

    function connect() {
      const ws = new WebSocket(airPlayStreamUrl());
      ws.binaryType = 'arraybuffer';
      socket = ws;
      // A fresh picture for each connection: the add-on starts it from a keyframe.
      const player = video && canPlay
        ? createAirPlayVideo(video, {
          onFatal: (reason) => {
            setProblem(reason);
            if (socket === ws) reconnect();
          },
        })
        : null;
      videoPlayer = player;
      const assemble = createMediaAssembler((media) => {
        if (media.kind === 'video') player?.push(media);
        else audio.push(media.data);
      });
      ws.onopen = () => {
        wait = FIRST_RETRY_MS;
      };
      ws.onmessage = (event: MessageEvent) => {
        if (socket !== ws) return;
        if (typeof event.data !== 'string') {
          assemble(event.data as ArrayBuffer);
          return;
        }
        let next: AirPlayStatus | null = null;
        try {
          next = parseAirPlayStatus(JSON.parse(event.data));
        } catch { /* not a status */ }
        if (next) onStatusRef.current(next);
      };
      ws.onclose = () => {
        if (socket === ws) reconnect();
      };
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      reconnect();
      audio.close();
      audioRef.current = null;
      suspendSharedAudio();
      setSoundBlocked(false);
    };
  }, [visible, canPlay]);

  const [controls, setControls] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hideTimerRef.current), []);

  const handleTap = useCallback(() => {
    // Any tap lets the browser play the sound.
    void audioRef.current?.unlock();
    clearTimeout(hideTimerRef.current);
    if (controls) {
      setControls(false);
    } else {
      setControls(true);
      hideTimerRef.current = setTimeout(() => setControls(false), CONTROLS_MS);
    }
  }, [controls]);

  const mirroring = !!status?.enabled && status.state === 'mirroring';
  const playing = !!status?.enabled && (status.state === 'audio' || (status.state === 'connected' && !!status.metadata));
  const showBack = controls || !(mirroring || playing);

  let content: ReactNode;
  if (!status) {
    content = <Message title="AirPlay" lines={['Connecting…']} />;
  } else if (!status.enabled) {
    content = <Message title="AirPlay is off" lines={["This add-on doesn't have an AirPlay receiver turned on."]} />;
  } else if (!status.available) {
    content = (
      <Message
        title="AirPlay isn't running"
        lines={[
          status.error,
          'The add-on starts its receiver when it starts; its Log tab says more.',
        ]}
      />
    );
  } else if (mirroring) {
    content = canPlay
      ? problem && <div className="airplay-problem" role="status">{problem}</div>
      : (
        <Message
          title="This browser can't show a mirrored screen"
          lines={['Sound still plays here. On an iPhone or iPad, the screen needs iOS 17.1 or later.']}
        />
      );
  } else if (playing) {
    content = <NowPlaying status={status} />;
  } else if (status.state === 'connected') {
    content = <Message title={`Connected to “${status.name}”`} lines={['Nothing is being sent yet.']} />;
  } else {
    content = <HowToSend status={status} />;
  }

  // Rendered at the top level of the page, like the photo frame: inside the
  // app's main area, its animated wrapper confines the fixed layer's stacking.
  return createPortal(
    <div className="airplay-view" onClick={handleTap}>
      <video
        ref={videoRef}
        className={`airplay-video${mirroring && canPlay ? ' airplay-video--shown' : ''}`}
        muted
        playsInline
        autoPlay
        onPlaying={() => setProblem(null)}
      />
      {content}
      {soundBlocked && (
        <button
          type="button"
          className="airplay-sound"
          onClick={(e) => {
            e.stopPropagation();
            void audioRef.current?.unlock();
          }}
        >
          <Volume2 size={20} />
          Tap for sound
        </button>
      )}
      {showBack && (
        <button
          type="button"
          className="airplay-back"
          onClick={(e) => {
            e.stopPropagation();
            onBack();
          }}
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={24} />
        </button>
      )}
    </div>,
    document.body,
  );
}

function Message({ title, lines }: { title: string; lines: (string | null)[] }) {
  return (
    <div className="airplay-message">
      <Airplay size={56} strokeWidth={1.5} className="airplay-message-icon" />
      <h1>{title}</h1>
      {lines.filter(Boolean).map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}

function HowToSend({ status }: { status: AirPlayStatus }) {
  const name = `“${status.name}”`;
  return (
    <div className="airplay-message">
      <Airplay size={56} strokeWidth={1.5} className="airplay-message-icon" />
      <h1>AirPlay to {name}</h1>
      <p>To show a screen: on an iPhone or iPad, open Control Center, tap Screen Mirroring and choose {name}. On a Mac, it&apos;s in Control Center too.</p>
      <p>To play music or video: tap AirPlay in the app and choose {name}.</p>
      {status.passwordRequired && (
        <p className="airplay-hint">It asks for the AirPlay password set in the add-on&apos;s options.</p>
      )}
      {status.error && <p className="airplay-error">{status.error}</p>}
    </div>
  );
}

function NowPlaying({ status }: { status: AirPlayStatus }) {
  const cover = status.coverVersion > 0 ? airPlayCoverUrl(status.coverVersion) : null;
  const { title, artist, album } = status.metadata ?? { title: null, artist: null, album: null };
  return (
    <div className="airplay-playing">
      {cover && <div className="airplay-backdrop" style={{ backgroundImage: `url("${cover}")` }} />}
      {cover
        ? <img className="airplay-cover" src={cover} alt="" />
        : <div className="airplay-cover airplay-cover--none"><Music size={72} strokeWidth={1.5} /></div>}
      <div className="airplay-track">
        <div className="airplay-track-title">{title || `Playing on “${status.name}”`}</div>
        {artist && <div className="airplay-track-artist">{artist}</div>}
        {album && <div className="airplay-track-album">{album}</div>}
      </div>
    </div>
  );
}
