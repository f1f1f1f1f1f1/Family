/**
 * Downloads photos for CoverPhoto, once each. The image is built from the
 * fetched bytes whether or not it needs rotating: a sideways iPhone photo
 * gets its EXIF orientation tag rewritten to 1 ("as stored") in our copy,
 * and CoverPhoto applies the rotation itself (see CoverPhoto.tsx for why).
 * The last few loaded photos are kept, so a preloaded photo shows without
 * being downloaded again.
 */

import { findExifOrientation } from './cover-photo';

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

