import { Photo } from '../types/photos';
import { getConfig } from '../config';
import { hasToken, callBeaconAction } from './ha-rest';
import { isAddOn } from '../utils/ha-env';

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
 *
 * media_source/resolve_media has no REST endpoint in HA core — it's
 * WebSocket-only (see homeassistant/components/media_source/__init__.py,
 * websocket_resolve_media). In add-on mode we bridge through server.js's
 * /beacon-action/media-source, which opens a short-lived authenticated WS
 * connection. Standalone mode isn't wired up yet (would need access to the
 * shared HomeAssistantClient WS connection) and returns null.
 */
async function resolveImageUrl(mediaContentId: string): Promise<string | null> {
  if (!isAddOn()) return null;

  try {
    const resolved = await callBeaconAction('/beacon-action/media-source', {
      op: 'resolve',
      media_content_id: mediaContentId,
    }) as { result?: { url?: string } };

    const url = resolved?.result?.url;
    if (!url) return null;

    // resolve_media returns a relative, signed path
    // (e.g. "/media/local/...?authSig=..."). This must NOT be routed
    // through server.js's Supervisor-token proxy (http://supervisor/core/*)
    // — that internal proxy blocks /media/* regardless of auth headers
    // (Supervisor restricts which Core paths it forwards for add-on
    // tokens). Instead, since the ingress iframe is same-origin as HA's
    // own web server, fetch it directly from the top-level origin — the
    // authSig query param is a self-contained signature that HA's own
    // server accepts with no further auth, exactly like its own frontend
    // does for media thumbnails.
    if (/^https?:\/\//.test(url)) return url;
    try {
      const topOrigin = window.parent !== window ? window.parent.location.origin : window.location.origin;
      return `${topOrigin}${url}`;
    } catch {
      // Cross-origin parent (shouldn't happen for same-host ingress, but
      // fall back to same-window origin rather than throwing).
      return `${window.location.origin}${url}`;
    }
  } catch {
    return null;
  }
}

/**
 * Browses a media_content_id and resolves every image child to a
 * displayable URL.
 *
 * media_source/browse_media has no REST endpoint either — same WS-only
 * situation as resolve_media above.
 */
async function fetchPhotosFrom(
  mediaContentId: string,
  source: 'ha_media' | 'local',
): Promise<Photo[]> {
  if (!hasToken()) return [];
  if (!isAddOn()) return []; // standalone WS media browsing not yet implemented

  try {
    const browsed = await callBeaconAction('/beacon-action/media-source', {
      op: 'browse',
      media_content_id: mediaContentId,
    }) as {
      result?: {
        children?: Array<{
          media_content_id: string;
          title: string;
          media_content_type: string;
        }>;
      };
    };

    const children = browsed?.result?.children || [];
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
