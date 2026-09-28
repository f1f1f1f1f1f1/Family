/**
 * Just enough fragmented MP4 to play an H.264 stream with Media Source
 * Extensions: the AirPlay screen gets each video frame as an Annex B
 * access unit (see src/api/airplay.ts) and appends it as a fragment.
 * One video track; no B-frames (a mirrored screen has none), so
 * presentation times are decode times.
 */

export const TIMESCALE = 90_000;
const TRACK_ID = 1;

export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;
const NAL_AUD = 9;

/** The NAL units of an Annex B access unit (between 00 00 01 / 00 00 00 01 start codes). */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let start = -1;
  const take = (end: number) => {
    while (end > start && data[end - 1] === 0) end--;
    if (end > start) nals.push(data.subarray(start, end));
  };
  for (let i = 0; i + 2 < data.length;) {
    if (data[i + 2] > 1) {
      i += 3;
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) take(i);
      i += 3;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start >= 0) take(data.length);
  return nals;
}

/** A NAL unit without its emulation prevention bytes (00 00 03 → 00 00). */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let length = 0;
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[length++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, length);
}

class BitReader {
  private bit = 0;

  constructor(private readonly bytes: Uint8Array) {}

  u(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.bit >> 3];
      if (byte === undefined) throw new RangeError('SPS ends early');
      value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit += 1;
    }
    return value;
  }

  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      if (++zeros > 31) throw new RangeError('Bad Exp-Golomb code');
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }

  se(): number {
    const value = this.ue();
    return value % 2 ? (value + 1) / 2 : -value / 2;
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

const hex = (value: number) => value.toString(16).padStart(2, '0');

/** The picture size and MSE codec string of an SPS NAL unit, or null if it isn't one. */
export function parseSps(nal: Uint8Array): { width: number; height: number; codec: string } | null {
  if ((nal[0] & 0x1f) !== NAL_SPS) return null;
  const rbsp = unescapeRbsp(nal);
  try {
    const bits = new BitReader(rbsp.subarray(1));
    const profile = bits.u(8);
    const constraints = bits.u(8);
    const level = bits.u(8);
    bits.ue(); // seq_parameter_set_id
    let chromaFormat = 1;
    let separateColourPlanes = false;
    if (HIGH_PROFILES.has(profile)) {
      chromaFormat = bits.ue();
      if (chromaFormat === 3) separateColourPlanes = bits.u(1) === 1;
      bits.ue(); // bit_depth_luma_minus8
      bits.ue(); // bit_depth_chroma_minus8
      bits.u(1); // qpprime_y_zero_transform_bypass_flag
      if (bits.u(1)) {
        for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
          if (!bits.u(1)) continue;
          let last = 8;
          let next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + bits.se() + 256) % 256;
            if (next !== 0) last = next;
          }
        }
      }
    }
    bits.ue(); // log2_max_frame_num_minus4
    const pocType = bits.ue();
    if (pocType === 0) {
      bits.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      bits.u(1); // delta_pic_order_always_zero_flag
      bits.se(); // offset_for_non_ref_pic
      bits.se(); // offset_for_top_to_bottom_field
      const cycle = bits.ue();
      for (let i = 0; i < cycle; i++) bits.se();
    }
    bits.ue(); // max_num_ref_frames
    bits.u(1); // gaps_in_frame_num_value_allowed_flag
    const widthMbs = bits.ue() + 1;
    const heightMapUnits = bits.ue() + 1;
    const frameMbsOnly = bits.u(1);
    if (!frameMbsOnly) bits.u(1); // mb_adaptive_frame_field_flag
    bits.u(1); // direct_8x8_inference_flag
    let crop = [0, 0, 0, 0];
    if (bits.u(1)) crop = [bits.ue(), bits.ue(), bits.ue(), bits.ue()];

    const monochrome = chromaFormat === 0 || separateColourPlanes;
    const cropX = monochrome || chromaFormat === 3 ? 1 : 2;
    const cropY = (monochrome || chromaFormat !== 1 ? 1 : 2) * (2 - frameMbsOnly);
    const width = widthMbs * 16 - (crop[0] + crop[1]) * cropX;
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (crop[2] + crop[3]) * cropY;
    if (width <= 0 || height <= 0) return null;
    return { width, height, codec: `avc1.${hex(profile)}${hex(constraints)}${hex(level)}` };
  } catch {
    return null;
  }
}

/** An access unit's NAL units as an MP4 sample (4-byte lengths), without parameter sets or delimiters. */
export function avccSample(nals: Uint8Array[]): Uint8Array {
  const kept = nals.filter((nal) => {
    const type = nal[0] & 0x1f;
    return type !== NAL_SPS && type !== NAL_PPS && type !== NAL_AUD;
  });
  const out = new Uint8Array(kept.reduce((total, nal) => total + 4 + nal.length, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const nal of kept) {
    view.setUint32(offset, nal.length);
    out.set(nal, offset + 4);
    offset += 4 + nal.length;
  }
  return out;
}

type Part = Uint8Array | number[];

function concat(parts: Part[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function box(type: string, ...parts: Part[]): Uint8Array {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

const u16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const u32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u64 = (value: number) => [...u32(Math.floor(value / 2 ** 32)), ...u32(value % 2 ** 32)];
const zeros = (count: number) => new Array<number>(count).fill(0);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const MATRIX = [...u32(0x00010000), ...zeros(12), ...u32(0x00010000), ...zeros(12), ...u32(0x40000000)];

export interface VideoConfig {
  sps: Uint8Array;
  pps: Uint8Array;
  width: number;
  height: number;
}

/** The initialization segment (ftyp + moov) for a stream with these parameter sets. */
export function initSegment({ sps, pps, width, height }: VideoConfig): Uint8Array {
  const [, profile, compatibility, level] = unescapeRbsp(sps);
  const avcC = box('avcC',
    [1, profile, compatibility, level, 0xff, 0xe0 | 1, ...u16(sps.length)], sps,
    [1, ...u16(pps.length)], pps);
  const avc1 = box('avc1',
    zeros(6), u16(1), zeros(16), u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), zeros(4), u16(1), zeros(32), u16(0x18), u16(0xffff),
    avcC);
  const stbl = box('stbl',
    box('stsd', zeros(4), u32(1), avc1),
    box('stts', zeros(8)),
    box('stsc', zeros(8)),
    box('stsz', zeros(12)),
    box('stco', zeros(8)));
  const minf = box('minf',
    box('vmhd', [0, 0, 0, 1], zeros(8)),
    box('dinf', box('dref', zeros(4), u32(1), box('url ', [0, 0, 0, 1]))),
    stbl);
  const mdia = box('mdia',
    box('mdhd', zeros(12), u32(TIMESCALE), zeros(4), u16(0x55c4), zeros(2)),
    box('hdlr', zeros(8), ascii('vide'), zeros(12), ascii('VideoHandler'), [0]),
    minf);
  const tkhd = box('tkhd',
    [0, 0, 0, 7], zeros(8), u32(TRACK_ID), zeros(4), zeros(4), zeros(8),
    zeros(4), zeros(4), MATRIX, u32(width * 65536), u32(height * 65536));
  const mvhd = box('mvhd',
    zeros(12), u32(TIMESCALE), zeros(4), u32(0x00010000), u16(0x0100), zeros(10),
    MATRIX, zeros(24), u32(0xffffffff));
  const trex = box('trex', zeros(4), u32(TRACK_ID), u32(1), zeros(8), u32(0x00010001));
  return concat([
    box('ftyp', ascii('isom'), u32(1), ascii('isom'), ascii('avc1')),
    box('moov', mvhd, box('trak', tkhd, mdia), box('mvex', trex)),
  ]);
}

export interface Mp4Sample {
  /** The access unit as avccSample() gives it. */
  data: Uint8Array;
  /** In TIMESCALE units. */
  duration: number;
  keyframe: boolean;
}

/** A media segment (moof + mdat) of samples that start at baseDecodeTime (in TIMESCALE units). */
export function mediaSegment(sequence: number, baseDecodeTime: number, samples: Mp4Sample[]): Uint8Array {
  const trunBytes = 8 + 12 + 16 * samples.length;
  const moofBytes = 8 + 16 + 8 + 16 + 20 + trunBytes;
  const trun = box('trun',
    [0, 0, 0x0f, 0x01], u32(samples.length), u32(moofBytes + 8),
    ...samples.map((sample) => [
      ...u32(sample.duration),
      ...u32(sample.data.length),
      // Keyframes depend on nothing; other frames depend on others and aren't sync samples.
      ...(sample.keyframe ? [0x02, 0, 0, 0] : [0x01, 0x01, 0, 0]),
      ...u32(0),
    ]));
  const moof = box('moof',
    box('mfhd', zeros(4), u32(sequence)),
    box('traf',
      box('tfhd', zeros(4), u32(TRACK_ID)),
      box('tfdt', [1, 0, 0, 0], u64(baseDecodeTime)),
      trun));
  return concat([moof, box('mdat', ...samples.map((sample) => sample.data))]);
}
