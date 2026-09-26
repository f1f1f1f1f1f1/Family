import { useEffect, useState, type RefObject } from 'react';
import { coverCrop, readExifOrientation } from '../utils/cover-photo';

const ORIENTATION_NAMES: Record<number, string> = {
  1: '1 (upright)', 2: '2 (mirrored)', 3: '3 (rotated 180°)', 4: '4 (mirrored, 180°)',
  5: '5 (mirrored, 90°)', 6: '6 (rotated 90°)', 7: '7 (mirrored, 270°)', 8: '8 (rotated 270°)',
};

/**
 * On-screen readout of everything that decides where a photo lands:
 * Family's own viewport, the HA page and iframe around it, the device
 * screen, and the photo. Used to diagnose devices where the full-screen
 * photo doesn't line up with the visible screen.
 */

interface Props {
  frameRef: RefObject<HTMLDivElement | null>;
  photoUrl?: string;
  testPattern: boolean;
  onToggleTestPattern: () => void;
  onClose: () => void;
}

const size = (w?: number, h?: number) =>
  w === undefined || h === undefined ? '—' : `${Math.round(w)} × ${Math.round(h)}`;

function rectText(r?: DOMRect | null): string {
  if (!r) return '—';
  return `${size(r.width, r.height)} at top ${Math.round(r.top)}, left ${Math.round(r.left)}`;
}

function measure(frame: HTMLDivElement | null, photo?: { w: number; h: number }, orientation?: string): [string, string][] {
  const image = frame?.querySelector<HTMLCanvasElement>('.photo-frame-image') ?? null;
  let crop = '—';
  if (image && photo) {
    const c = coverCrop(photo.w, photo.h, image.width, image.height);
    crop = `photo ${Math.round(c.sx)},${Math.round(c.sy)} → ${Math.round(c.sw)} × ${Math.round(c.sh)} on ${image.width} × ${image.height} canvas`;
  }
  const vv = window.visualViewport;
  const rootStyle = getComputedStyle(document.documentElement);
  const safe = ['top', 'right', 'bottom', 'left']
    .map((s) => rootStyle.getPropertyValue(`--ha-safe-${s}`).trim() || '0')
    .join(' / ');

  // The HA page is same-origin (ingress), so it can be inspected directly.
  let parentViewport: string;
  let parentVisual = '—';
  let iframeRect = '—';
  let iframePadding = '—';
  try {
    if (window.parent !== window) {
      parentViewport = size(window.parent.innerWidth, window.parent.innerHeight);
      const pvv = window.parent.visualViewport;
      if (pvv) parentVisual = `${size(pvv.width, pvv.height)} offset ${Math.round(pvv.offsetTop)}, ${Math.round(pvv.offsetLeft)}`;
      const el = window.frameElement as HTMLElement | null;
      if (el) {
        iframeRect = rectText(el.getBoundingClientRect());
        const cs = window.parent.getComputedStyle(el);
        iframePadding = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' / ');
      }
    } else {
      parentViewport = 'not in an HA frame';
    }
  } catch {
    parentViewport = 'not accessible';
  }

  return [
    ['Version', __APP_VERSION__],
    ['Family viewport', size(window.innerWidth, window.innerHeight)],
    ['Family visual viewport', vv ? `${size(vv.width, vv.height)} offset ${Math.round(vv.offsetTop)}, ${Math.round(vv.offsetLeft)}` : '—'],
    ['Photo area', rectText(frame?.getBoundingClientRect())],
    ['Photo layer', rectText(image?.getBoundingClientRect())],
    ['Photo crop', crop],
    ['Photo rotation (EXIF)', orientation ?? 'checking…'],
    ['Page scroll', `${Math.round(window.scrollX)}, ${Math.round(window.scrollY)} (body ${document.body.scrollTop}, root ${document.documentElement.scrollTop})`],
    ['Photo', photo ? size(photo.w, photo.h) : 'loading…'],
    ['HA page viewport', parentViewport],
    ['HA visual viewport', parentVisual],
    ['Family frame in HA', iframeRect],
    ['Frame padding (t/r/b/l)', iframePadding],
    ['Safe area from HA (t/r/b/l)', safe],
    ['Screen', `${size(screen.width, screen.height)} (available ${size(screen.availWidth, screen.availHeight)})`],
    ['Pixel ratio', String(window.devicePixelRatio)],
    ['Browser', navigator.userAgent],
  ];
}

export function PhotoDiagnostics({ frameRef, photoUrl, testPattern, onToggleTestPattern, onClose }: Props) {
  const [photo, setPhoto] = useState<{ w: number; h: number }>();
  const [rows, setRows] = useState<[string, string][]>([]);
  const [orientation, setOrientation] = useState<string>();

  useEffect(() => {
    setOrientation(undefined);
    if (!photoUrl) return;
    let cancelled = false;
    fetch(photoUrl, { headers: { Range: 'bytes=0-131071' } })
      .then((res) => res.arrayBuffer())
      .then((buf) => {
        if (cancelled) return;
        const o = readExifOrientation(buf);
        setOrientation(o === null ? 'none (not set)' : ORIENTATION_NAMES[o] ?? String(o));
      })
      .catch(() => { if (!cancelled) setOrientation('could not read'); });
    return () => { cancelled = true; };
  }, [photoUrl]);

  useEffect(() => {
    setPhoto(undefined);
    if (!photoUrl) return;
    const img = new Image();
    img.onload = () => setPhoto({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = photoUrl;
  }, [photoUrl]);

  useEffect(() => {
    const update = () => setRows(measure(frameRef.current, photo, orientation));
    update();
    const t = setInterval(update, 1000);
    window.addEventListener('resize', update);
    return () => {
      clearInterval(t);
      window.removeEventListener('resize', update);
    };
  }, [frameRef, photo, orientation]);

  return (
    <>
      {/* Crosshair at the exact centre of the screen */}
      <div className="photo-diagnostics-crosshair" aria-hidden="true" />
      <div className="photo-diagnostics" onClick={(e) => e.stopPropagation()}>
      <div className="photo-diagnostics-header">
        <strong>Photo diagnostics</strong>
        <button type="button" onClick={onClose} aria-label="Close diagnostics">✕</button>
      </div>
      <button type="button" className="photo-diagnostics-pattern" onClick={onToggleTestPattern}>
        {testPattern ? 'Show photo' : 'Show test pattern'}
      </button>
      {/* Collapsed while the test pattern shows, so the screen centre stays visible */}
      {!testPattern && (
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      </div>
    </>
  );
}
