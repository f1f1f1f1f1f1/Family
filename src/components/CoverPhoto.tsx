import { useEffect, useRef, useState } from 'react';
import { coverCrop, findExifOrientation } from '../utils/cover-photo';

/**
 * Draws a photo to fill its box without distortion, cropped around the
 * exact centre of the photo, handling EXIF orientation itself.
 *
 * iPhone JPEGs are stored sideways with an EXIF orientation tag. On the
 * Echo Show's Android WebView those photos came out off-centre whether
 * drawn with CSS `cover` or canvas drawImage() — even with a correct
 * centre crop computed from the photo's rotated size — while images
 * without the tag centred correctly. So the browser is never left to
 * apply the orientation: the file is fetched, its orientation tag is
 * rewritten to 1 ("as stored") in our copy, the raw pixels are loaded,
 * and the rotation and centre crop are both done here.
 */

interface Props {
  src?: string;
  label: string;
  className?: string;
}

interface LoadedPhoto {
  image: HTMLImageElement;
  /** EXIF orientation still to be applied (1 = none). */
  orientation: number;
  revoke?: () => void;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function loadPhoto(src: string): Promise<LoadedPhoto> {
  try {
    const bytes = await (await fetch(src)).arrayBuffer();
    const found = findExifOrientation(bytes);
    if (found && found.value >= 2 && found.value <= 8) {
      const copy = bytes.slice(0);
      new DataView(copy).setUint16(found.offset, 1, found.little);
      const url = URL.createObjectURL(new Blob([copy], { type: 'image/jpeg' }));
      const image = await loadImage(url);
      return { image, orientation: found.value, revoke: () => URL.revokeObjectURL(url) };
    }
  } catch {
    /* fall back to letting the browser load it directly */
  }
  return { image: await loadImage(src), orientation: 1 };
}

/** The photo drawn upright on a canvas of its upright size. */
function uprightCanvas({ image, orientation }: LoadedPhoto): HTMLCanvasElement | HTMLImageElement {
  if (orientation === 1) return image;
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const swap = orientation >= 5;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return image;
  // Standard EXIF orientation transforms (stored pixels -> upright).
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
  }
  ctx.drawImage(image, 0, 0);
  return canvas;
}

export function CoverPhoto({ src, label, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [upright, setUpright] = useState<HTMLCanvasElement | HTMLImageElement | null>(null);

  useEffect(() => {
    setUpright(null);
    if (!src) return;
    let cancelled = false;
    let revoke: (() => void) | undefined;
    loadPhoto(src)
      .then((loaded) => {
        revoke = loaded.revoke;
        if (!cancelled) setUpright(uprightCanvas(loaded));
      })
      .catch(() => { /* image failed to load: leave blank */ });
    return () => {
      cancelled = true;
      revoke?.();
    };
  }, [src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !upright) return;
    const w = upright instanceof HTMLImageElement ? upright.naturalWidth : upright.width;
    const h = upright instanceof HTMLImageElement ? upright.naturalHeight : upright.height;

    const draw = () => {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height || !w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingQuality = 'high';
      const { sx, sy, sw, sh } = coverCrop(w, h, canvas.width, canvas.height);
      ctx.drawImage(upright, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    };

    draw();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null;
    observer?.observe(canvas);
    window.addEventListener('resize', draw);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', draw);
    };
  }, [upright]);

  return <canvas ref={canvasRef} className={className} role="img" aria-label={label} />;
}
