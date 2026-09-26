/**
 * A stand-in for server.js's /beacon-action/media-source bridge, recording
 * every browse and resolve, so tests can check how often HA is asked.
 * Use as the ha-rest mock:
 *   vi.mock('../api/ha-rest', async () => (await import('../test/fake-media-source')).haRestMock);
 */

export const MEDIA_ROOT = 'media-source://media_source/local';
/** The default photo_directory, /media/beacon/photos. */
export const PHOTO_FOLDER = 'media-source://media_source/local/beacon/photos';

export const media = {
  folders: new Map<string, string[]>(),
  browses: [] as string[],
  resolves: [] as string[],
  failBrowse: false,
  signature: 0,
};

export function resetMedia(): void {
  media.folders.clear();
  media.browses.length = 0;
  media.resolves.length = 0;
  media.failBrowse = false;
  media.signature = 0;
}

/** Puts `count` photos in the photo folder; returns their ids. */
export function addPhotos(count: number, folder = PHOTO_FOLDER): string[] {
  const ids = Array.from({ length: count }, (_, i) => `${folder}/photo-${i + 1}.jpg`);
  media.folders.set(folder, [...(media.folders.get(folder) ?? []), ...ids]);
  return ids;
}

export const haRestMock = {
  hasToken: () => true,
  callBeaconAction: async (_path: string, body: { op: string; media_content_id: string }) => {
    const id = body.media_content_id;
    if (body.op === 'browse') {
      media.browses.push(id);
      if (media.failBrowse) throw new Error('Home Assistant WebSocket command timed out');
      const children = (media.folders.get(id) ?? []).map((child) => ({
        media_content_id: child,
        title: child.split('/').pop(),
        media_content_type: 'image/jpeg',
      }));
      return { ok: true, result: { children } };
    }
    media.resolves.push(id);
    const path = id.replace(MEDIA_ROOT, '/media/local');
    return { ok: true, result: { url: `${path}?authSig=sig-${++media.signature}` } };
  },
};
