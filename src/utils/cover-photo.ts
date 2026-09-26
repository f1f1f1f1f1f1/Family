/**
 * Pure helpers behind CoverPhoto: the centre crop, and reading a JPEG's EXIF
 * orientation tag. Kept out of the component file so React Fast Refresh can
 * hot-reload the component on its own.
 */

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
