import { describe, it, expect } from 'vitest';
import { coverCrop } from './CoverPhoto';
import { readExifOrientation } from './PhotoDiagnostics';

describe('coverCrop', () => {
  it('crops a portrait photo on a landscape screen equally top and bottom', () => {
    // Echo Show 8: 962×601 screen, 1448×1930 photo
    const c = coverCrop(1448, 1930, 962, 601);
    expect(c.sx).toBe(0);
    expect(c.sw).toBe(1448);
    expect(c.sh).toBeCloseTo(904.6, 0);
    expect(c.sy).toBeCloseTo((1930 - c.sh) / 2, 5); // same amount off the top as the bottom
  });

  it('crops a landscape photo on a portrait screen equally left and right', () => {
    const c = coverCrop(1600, 900, 390, 844);
    expect(c.sy).toBe(0);
    expect(c.sh).toBe(900);
    expect(c.sx).toBeCloseTo((1600 - c.sw) / 2, 5);
  });

  it('keeps the photo proportions (no stretching)', () => {
    const c = coverCrop(1448, 1930, 962, 601);
    expect(c.sw / c.sh).toBeCloseTo(962 / 601, 5);
  });
});

function jpegWithOrientation(orientation: number, littleEndian = false): ArrayBuffer {
  const tiff = new DataView(new ArrayBuffer(26));
  tiff.setUint16(0, littleEndian ? 0x4949 : 0x4d4d);
  tiff.setUint16(2, 42, littleEndian);
  tiff.setUint32(4, 8, littleEndian);
  tiff.setUint16(8, 1, littleEndian); // one IFD entry
  tiff.setUint16(10, 0x0112, littleEndian);
  tiff.setUint16(12, 3, littleEndian);
  tiff.setUint32(14, 1, littleEndian);
  tiff.setUint16(18, orientation, littleEndian);
  const app1Length = 2 + 6 + tiff.byteLength;
  const out = new Uint8Array(2 + 2 + app1Length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xffd8);
  view.setUint16(2, 0xffe1);
  view.setUint16(4, app1Length);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6); // "Exif\0\0"
  out.set(new Uint8Array(tiff.buffer), 12);
  return out.buffer;
}

describe('readExifOrientation', () => {
  it('reads the orientation tag (big- and little-endian)', () => {
    expect(readExifOrientation(jpegWithOrientation(6))).toBe(6);
    expect(readExifOrientation(jpegWithOrientation(3, true))).toBe(3);
  });

  it('returns null for files without EXIF or that are not JPEGs', () => {
    expect(readExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer)).toBeNull();
    expect(readExifOrientation(new TextEncoder().encode('<svg></svg>').buffer)).toBeNull();
  });
});
