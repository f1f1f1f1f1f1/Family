import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { CoverPhoto, loadPhoto, preloadPhoto, clearLoadedPhotos, readExifOrientation } from './CoverPhoto';

/*
 * jsdom doesn't download or decode images, so fetch, Image and blob URLs
 * are stood in for: `downloads` records every photo fetched from HA, and
 * `imageSources` every URL an <img> was pointed at.
 */

let downloads: string[];
let imageSources: string[];
let blobs: Blob[];
let responses: Map<string, () => { ok: boolean; status: number; bytes?: ArrayBuffer }>;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  decoding = '';
  naturalWidth = 400;
  naturalHeight = 300;
  set src(url: string) {
    imageSources.push(url);
    queueMicrotask(() => this.onload?.());
  }
}

/** A minimal JPEG; with an EXIF orientation tag when given one. */
function jpeg(orientation?: number): ArrayBuffer {
  if (orientation === undefined) return new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer;
  const tiff = new DataView(new ArrayBuffer(26));
  tiff.setUint16(0, 0x4d4d);
  tiff.setUint16(2, 42);
  tiff.setUint32(4, 8);
  tiff.setUint16(8, 1);
  tiff.setUint16(10, 0x0112);
  tiff.setUint16(12, 3);
  tiff.setUint32(14, 1);
  tiff.setUint16(18, orientation);
  const app1Length = 2 + 6 + tiff.byteLength;
  const out = new Uint8Array(4 + app1Length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xffd8);
  view.setUint16(2, 0xffe1);
  view.setUint16(4, app1Length);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  out.set(new Uint8Array(tiff.buffer), 12);
  return out.buffer;
}

function servePhoto(url: string, bytes: ArrayBuffer = jpeg()) {
  responses.set(url, () => ({ ok: true, status: 200, bytes }));
}

beforeEach(() => {
  downloads = [];
  imageSources = [];
  blobs = [];
  responses = new Map();
  clearLoadedPhotos();
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    downloads.push(url);
    const res = responses.get(url)?.() ?? { ok: false, status: 404 };
    return {
      ok: res.ok,
      status: res.status,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => res.bytes ?? new ArrayBuffer(0),
    };
  }));
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return `blob:photo-${blobs.length}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadPhoto', () => {
  it('downloads an upright photo once and draws it from those bytes', async () => {
    servePhoto('https://ha.local/a.jpg');
    const loaded = await loadPhoto('https://ha.local/a.jpg');
    expect(loaded.orientation).toBe(1);
    expect(downloads).toEqual(['https://ha.local/a.jpg']);
    expect(imageSources).toEqual(['blob:photo-1']); // never the network URL again
  });

  it('downloads a sideways iPhone photo once, rotating it itself', async () => {
    const bytes = jpeg(6);
    servePhoto('https://ha.local/iphone.jpg', bytes);
    const loaded = await loadPhoto('https://ha.local/iphone.jpg');
    expect(loaded.orientation).toBe(6); // rotated when drawn
    expect(readExifOrientation(bytes)).toBe(1); // the browser is told "as stored"
    expect(blobs[0].type).toBe('image/jpeg');
    expect(downloads).toHaveLength(1);
    expect(imageSources).toEqual(['blob:photo-1']);
  });

  it("doesn't download a preloaded photo again when it's shown", async () => {
    servePhoto('https://ha.local/next.jpg');
    preloadPhoto('https://ha.local/next.jpg');
    await loadPhoto('https://ha.local/next.jpg');
    await loadPhoto('https://ha.local/next.jpg');
    expect(downloads).toEqual(['https://ha.local/next.jpg']);
  });

  it('fails an expired photo without downloading it a second time, and tries it afresh next time', async () => {
    responses.set('https://ha.local/old.jpg', () => ({ ok: false, status: 401 }));
    await expect(loadPhoto('https://ha.local/old.jpg')).rejects.toThrow(/401/);
    expect(downloads).toHaveLength(1);
    expect(imageSources).toEqual([]);

    servePhoto('https://ha.local/old.jpg');
    await loadPhoto('https://ha.local/old.jpg');
    expect(downloads).toHaveLength(2);
  });

  it('keeps only the last few photos', async () => {
    const urls = ['a', 'b', 'c', 'd', 'e'].map((n) => `https://ha.local/${n}.jpg`);
    for (const url of urls) {
      servePhoto(url);
      await loadPhoto(url);
    }
    await loadPhoto(urls[4]);
    expect(downloads).toHaveLength(5);
    await loadPhoto(urls[0]);
    expect(downloads).toHaveLength(6);
  });
});

describe('CoverPhoto', () => {
  it('preloads the next photo once the current one is loaded, and shows it without downloading it again', async () => {
    servePhoto('https://ha.local/1.jpg');
    servePhoto('https://ha.local/2.jpg');
    servePhoto('https://ha.local/3.jpg');
    const { rerender } = render(
      <CoverPhoto src="https://ha.local/1.jpg" preloadSrc="https://ha.local/2.jpg" label="Photo" />,
    );
    await waitFor(() => expect(downloads).toEqual(['https://ha.local/1.jpg', 'https://ha.local/2.jpg']));

    rerender(<CoverPhoto src="https://ha.local/2.jpg" preloadSrc="https://ha.local/3.jpg" label="Photo" />);
    await waitFor(() => expect(downloads).toHaveLength(3));
    expect(downloads).toEqual(['https://ha.local/1.jpg', 'https://ha.local/2.jpg', 'https://ha.local/3.jpg']);
  });

  it('reports a photo that fails to load', async () => {
    const onError = vi.fn();
    render(<CoverPhoto src="https://ha.local/missing.jpg" label="Photo" onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith('https://ha.local/missing.jpg'));
  });
});
