import { useEffect, useRef, useState } from 'react';

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
 *
 * Each photo is downloaded once: the image is built from the fetched bytes
 * whether or not it needed rotating, and the last few loaded photos are
 * kept, so `preloadSrc` (the next photo) is ready when it's shown.
 */

interface Props {
  src?: string;
  /** Loaded in the background once `src` is showing, e.g. the next photo. */
  preloadSrc?: string;
  label: string;
  className?: string;
  /** Called with `src` when it couldn't be loaded. */
  onError?: (src: string) => void;
}

/** Source rectangle of an image (w × h) that fills a box (bw × bh), centred. */
export function coverCrop(w: number, h: number, bw: number, bh: number) {
  const scale = Math.max(bw / w, bh / h);
  const sw = bw / scale;
  const sh = bh / scale;
  return { sx: (w - sw) / 2, sy: (h - sh) / 2, sw, sh };
}

/**
 * Byte offset of the EXIF Orientation value (a 16-bit field) in a JPEG, and
 * its value. Null when the file isn't a JPEG or has no orientation tag.
 */
export function findExifOrientation(bytes: ArrayBuffer): { value: number; offset: number; little: boolean } | null {
  const view = new DataView(bytes);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    const length = view.getUint16(offset + 2);
    if (marker === 0xffe1 && offset + 10 <= view.byteLength && view.getUint32(offset + 4) === 0x45786966) {
      const tiff = offset + 10;
      if (tiff + 8 > view.byteLength) return null;
      const little = view.getUint16(tiff) === 0x4949;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      if (ifd + 2 > view.byteLength) return null;
      const entries = view.getUint16(ifd, little);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 10 > view.byteLength) return null;
        if (view.getUint16(entry, little) === 0x0112) {
          return { value: view.getUint16(entry + 8, little), offset: entry + 8, little };
        }
      }
      return null;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null;
    offset += 2 + length;
  }
  return null;
}

/** EXIF Orientation tag (1–8) of a JPEG, or null if absent/not a JPEG. */
export function readExifOrientation(bytes: ArrayBuffer): number | null {
  return findExifOrientation(bytes)?.value ?? null;
}

export interface LoadedPhoto {
  image: HTMLImageElement;
  /** EXIF orientation still to be applied (1 = none). */
  orientation: number;
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

async function fetchPhoto(src: string): Promise<LoadedPhoto> {
  let res: Response;
  try {
    res = await fetch(src);
  } catch {
    // Can't be fetched (e.g. another site without CORS): let the browser
    // load it directly.
    return { image: await loadImage(src), orientation: 1 };
  }
  if (!res.ok) throw new Error(`Photo failed to load (HTTP ${res.status})`);

  const bytes = await res.arrayBuffer();
  let type = res.headers.get('Content-Type') || '';
  let orientation = 1;
  const found = findExifOrientation(bytes);
  if (found && found.value >= 2 && found.value <= 8) {
    new DataView(bytes).setUint16(found.offset, 1, found.little);
    orientation = found.value;
    type = 'image/jpeg';
  }

  const url = URL.createObjectURL(new Blob([bytes], { type }));
  try {
    return { image: await loadImage(url), orientation };
  } catch {
    /* fall back to letting the browser load it directly */
  } finally {
    // A loaded image keeps its pixels; the blob URL isn't needed after.
    URL.revokeObjectURL(url);
  }
  return { image: await loadImage(src), orientation: 1 };
}

const MAX_KEPT_PHOTOS = 4; // current + next, for both slideshows
const keptPhotos = new Map<string, Promise<LoadedPhoto>>();

/**
 * Downloads a photo (once) and loads it ready to draw. The most recently
 * used photos are kept, so asking again — e.g. showing a preloaded photo —
 * doesn't download it again. Failed loads aren't kept.
 */
export function loadPhoto(src: string): Promise<LoadedPhoto> {
  const kept = keptPhotos.get(src);
  if (kept) {
    // Re-insert so the least recently used photo is first to go.
    keptPhotos.delete(src);
    keptPhotos.set(src, kept);
    return kept;
  }
  const loading = fetchPhoto(src);
  keptPhotos.set(src, loading);
  loading.catch(() => {
    if (keptPhotos.get(src) === loading) keptPhotos.delete(src);
  });
  while (keptPhotos.size > MAX_KEPT_PHOTOS) {
    keptPhotos.delete(keptPhotos.keys().next().value as string);
  }
  return loading;
}

/** Starts loading a photo in the background so it shows instantly later. */
export function preloadPhoto(src: string): void {
  loadPhoto(src).catch(() => { /* reported if and when it's shown */ });
}

/** Forget all kept photos (for tests). */
export function clearLoadedPhotos(): void {
  keptPhotos.clear();
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

export function CoverPhoto({ src, preloadSrc, label, className, onError }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [upright, setUpright] = useState<HTMLCanvasElement | HTMLImageElement | null>(null);
  const [settledSrc, setSettledSrc] = useState<string>();
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; });

  useEffect(() => {
    setUpright(null);
    if (!src) return;
    let cancelled = false;
    loadPhoto(src)
      .then((loaded) => {
        if (!cancelled) setUpright(uprightCanvas(loaded));
      })
      .catch(() => {
        if (!cancelled) onErrorRef.current?.(src);
      })
      .finally(() => {
        if (!cancelled) setSettledSrc(src);
      });
    return () => { cancelled = true; };
  }, [src]);

  // Preload once this photo is done, so it isn't slowed down by the next.
  useEffect(() => {
    if (preloadSrc && src && settledSrc === src) preloadPhoto(preloadSrc);
  }, [preloadSrc, src, settledSrc]);

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
