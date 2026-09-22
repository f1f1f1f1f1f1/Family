import { Photo } from '../types/photos';
import { getConfig } from '../config';
import { haFetch, hasToken, getHaBaseUrl } from './ha-rest';

const { photo_directory: PHOTOS_PATH } = getConfig();

/**
 * Shuffles an array in place using Fisher-Yates.
 */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Converts a plain filesystem-style path (e.g. "/media/beacon/photos", as
 * configured via the `photo_directory` add-on option) into the
 * `media-source://` content id HA's browse_media/resolve_media APIs
 * actually expect. Leaves already-qualified media-source ids untouched.
 */
function toMediaContentId(path: string): string {
  if (!path) return 'media-source://media_source/local';
  if (path.startsWith('media-source://')) return path;

  const trimmed = path.replace(/^\/+|\/+$/g, ''); // strip leading/trailing slashes
  const withoutMediaPrefix = trimmed.replace(/^media\/?/, ''); // "media/beacon/photos" -> "beacon/photos"

  return withoutMediaPrefix
    ? `media-source://media_source/local/${withoutMediaPrefix}`
    : 'media-source://media_source/local';
}

/**
 * Resolves a browsable media_content_id to a playable/signed URL suitable
 * for an <img src>. browse_media only returns metadata — the actual
 * (possibly auth-signed) URL comes from resolve_media.
 */
async function resolveImageUrl(mediaContentId: string): Promise<string | null> {
  try {
    const resolved = await haFetch(
      `/api/media_source/resolve_media?media_content_id=${encodeURIComponent(mediaContentId)}`,
    ) as { url?: string } | null;

    if (!resolved?.url) return null;

    // resolve_media normally returns a relative, signed path
    // (e.g. "/api/media_source/local/...?authSig=..."); absolute URLs are
    // passed through as-is.
    return /^https?:\/\//.test(resolved.url)
      ? resolved.url
      : `${getHaBaseUrl()}${resolved.url}`;
  } catch {
    return null;
  }
}

/**
 * Browses a media_content_id and resolves every image child to a
 * displayable URL.
 */
async function fetchPhotosFrom(
  mediaContentId: string,
  source: 'ha_media' | 'local',
): Promise<Photo[]> {
  if (!hasToken()) return [];

  try {
    const data = await haFetch(
      `/api/media_source/browse_media?media_content_id=${encodeURIComponent(mediaContentId)}`,
    ) as {
      children?: Array<{
        media_content_id: string;
        title: string;
        media_content_type: string;
      }>;
    };

    const children = data?.children || [];
    const imageChildren = children.filter((item) => item.media_content_type?.startsWith('image'));

    const resolved = await Promise.all(
      imageChildren.map(async (item) => ({
        url: await resolveImageUrl(item.media_content_id),
        caption: item.title as string | undefined,
        source,
      })),
    );

    const photos: Photo[] = [];
    for (const item of resolved) {
      if (item.url) photos.push({ url: item.url, caption: item.caption, source: item.source });
    }
    return photos;
  } catch {
    console.warn(`Beacon: Failed to fetch photos from ${mediaContentId}`);
    return [];
  }
}

/**
 * Fetches photos from HA media browser API (root of local media).
 */
function fetchHAMediaPhotos(): Promise<Photo[]> {
  return fetchPhotosFrom('media-source://media_source/local', 'ha_media');
}

/**
 * Fetches photos from the configured local photo directory.
 */
function fetchLocalPhotos(): Promise<Photo[]> {
  return fetchPhotosFrom(toMediaContentId(PHOTOS_PATH), 'local');
}

/**
 * Gets all photos from configured sources, shuffled.
 */
export async function getPhotos(sources: Array<'local' | 'google_photos' | 'ha_media'> = ['ha_media', 'local']): Promise<Photo[]> {
  const fetchers: Promise<Photo[]>[] = [];

  if (sources.includes('ha_media')) {
    fetchers.push(fetchHAMediaPhotos());
  }
  if (sources.includes('local')) {
    fetchers.push(fetchLocalPhotos());
  }
  // google_photos would require OAuth — not implemented yet

  const results = await Promise.all(fetchers);
  const allPhotos = results.flat();

  return shuffle(allPhotos);
}
