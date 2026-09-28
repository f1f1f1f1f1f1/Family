/** Builds H.264 NAL units for tests (see src/utils/fmp4.ts). */

/** Writes the fields of an SPS, bit by bit. */
class BitWriter {
  private bits: number[] = [];

  u(count: number, value: number) {
    for (let i = count - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }

  ue(value: number) {
    const coded = value + 1;
    const length = Math.floor(Math.log2(coded));
    this.u(length, 0);
    return this.u(length + 1, coded);
  }

  se(value: number) {
    return this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  /** The RBSP: the bits, a stop bit, zeros to the byte. */
  rbsp(): number[] {
    const bits = [...this.bits, 1];
    while (bits.length % 8) bits.push(0);
    const bytes: number[] = [];
    for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    return bytes;
  }
}

/** Adds emulation prevention bytes, as an encoder does. */
function escape(rbsp: number[]): number[] {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out;
}

export interface SpsFields {
  profile: number;
  constraints?: number;
  level: number;
  widthMbs: number;
  heightMapUnits: number;
  frameMbsOnly?: boolean;
  /** Left, right, top, bottom, in crop units. */
  crop?: [number, number, number, number];
  chromaFormat?: number;
  scalingMatrix?: boolean;
  pocType?: number;
}

export function sps({
  profile, constraints = 0, level, widthMbs, heightMapUnits,
  frameMbsOnly = true, crop, chromaFormat = 1, scalingMatrix = false, pocType = 0,
}: SpsFields): Uint8Array {
  const w = new BitWriter().u(8, profile).u(8, constraints).u(8, level).ue(0);
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    w.ue(chromaFormat);
    if (chromaFormat === 3) w.u(1, 0);
    w.ue(0).ue(0).u(1, 0).u(1, scalingMatrix ? 1 : 0);
    if (scalingMatrix) {
      // The first list present with some deltas, the rest absent.
      w.u(1, 1);
      for (let j = 0; j < 16; j++) w.se(j === 0 ? 8 : 1);
      for (let i = 1; i < (chromaFormat !== 3 ? 8 : 12); i++) w.u(1, 0);
    }
  }
  w.ue(0).ue(pocType);
  if (pocType === 0) w.ue(2);
  if (pocType === 1) w.u(1, 0).se(-1).se(2).ue(2).se(3).se(-4);
  w.ue(1).u(1, 0).ue(widthMbs - 1).ue(heightMapUnits - 1).u(1, frameMbsOnly ? 1 : 0);
  if (!frameMbsOnly) w.u(1, 0);
  w.u(1, 1).u(1, crop ? 1 : 0);
  if (crop) crop.forEach((value) => w.ue(value));
  w.u(1, 0); // no VUI
  return new Uint8Array([0x67, ...escape(w.rbsp())]);
}

export const PPS = new Uint8Array([0x68, 0xee, 0x3c, 0x80]);
export const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x21]);
export const P_SLICE = new Uint8Array([0x41, 0x9a, 0x02]);

/** NAL units as an Annex B access unit, as the relay sends them. */
export function annexB(...nals: Uint8Array[]): Uint8Array {
  return new Uint8Array(nals.flatMap((nal) => [0, 0, 0, 1, ...nal]));
}
