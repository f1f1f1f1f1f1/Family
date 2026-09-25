import { useEffect, useState, type RefObject } from 'react';

/**
 * On-screen readout of everything that decides where a photo lands:
 * Family's own viewport, the HA page and iframe around it, the device
 * screen, and the photo. Used to diagnose devices where the full-screen
 * photo doesn't line up with the visible screen.
 */

interface Props {
  frameRef: RefObject<HTMLDivElement | null>;
  photoUrl?: string;
  onClose: () => void;
}

const size = (w?: number, h?: number) =>
  w === undefined || h === undefined ? '—' : `${Math.round(w)} × ${Math.round(h)}`;

function rectText(r?: DOMRect | null): string {
  if (!r) return '—';
  return `${size(r.width, r.height)} at top ${Math.round(r.top)}, left ${Math.round(r.left)}`;
}

function measure(frame: HTMLDivElement | null, photo?: { w: number; h: number }): [string, string][] {
  const vv = window.visualViewport;
  const rootStyle = getComputedStyle(document.documentElement);
  const safe = ['top', 'right', 'bottom', 'left']
    .map((s) => rootStyle.getPropertyValue(`--ha-safe-${s}`).trim() || '0')
    .join(' / ');

  // The HA page is same-origin (ingress), so it can be inspected directly.
  let parentViewport = '—';
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

export function PhotoDiagnostics({ frameRef, photoUrl, onClose }: Props) {
  const [photo, setPhoto] = useState<{ w: number; h: number }>();
  const [rows, setRows] = useState<[string, string][]>([]);

  useEffect(() => {
    setPhoto(undefined);
    if (!photoUrl) return;
    const img = new Image();
    img.onload = () => setPhoto({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = photoUrl;
  }, [photoUrl]);

  useEffect(() => {
    const update = () => setRows(measure(frameRef.current, photo));
    update();
    const t = setInterval(update, 1000);
    window.addEventListener('resize', update);
    return () => {
      clearInterval(t);
      window.removeEventListener('resize', update);
    };
  }, [frameRef, photo]);

  return (
    <div className="photo-diagnostics" onClick={(e) => e.stopPropagation()}>
      <div className="photo-diagnostics-header">
        <strong>Photo diagnostics</strong>
        <button type="button" onClick={onClose} aria-label="Close diagnostics">✕</button>
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
