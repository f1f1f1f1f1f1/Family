import { describe, expect, it } from 'vitest';
import {
  TIMESCALE,
  avccSample,
  initSegment,
  mediaSegment,
  parseSps,
  splitAnnexB,
  unescapeRbsp,
} from './fmp4';
import { IDR, PPS, P_SLICE, sps } from '../test/h264';

interface Box {
  type: string;
  size: number;
  start: number;
  body: Uint8Array;
  children: Box[];
}

/** Box types whose body is boxes, with how many bytes come before them. */
const CONTAINERS: Record<string, number> = {
  moov: 0, trak: 0, mdia: 0, minf: 0, dinf: 0, stbl: 0, mvex: 0, moof: 0, traf: 0,
  stsd: 8, dref: 8, avc1: 78,
};

function parseBoxes(data: Uint8Array, start = 0, end = data.length): Box[] {
  const boxes: Box[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = start;
  while (offset < end) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    expect(size, `${type} size`).toBeGreaterThanOrEqual(8);
    expect(offset + size, `${type} fits its parent`).toBeLessThanOrEqual(end);
    const body = data.subarray(offset + 8, offset + size);
    const skip = CONTAINERS[type];
    const children = skip === undefined ? [] : parseBoxes(data, offset + 8 + skip, offset + size);
    boxes.push({ type, size, start: offset, body, children });
    offset += size;
  }
  expect(offset).toBe(end);
  return boxes;
}

function find(boxes: Box[], path: string): Box {
  const [first, ...rest] = path.split('/');
  const box = boxes.find((item) => item.type === first);
  if (!box) throw new Error(`no ${first} box`);
  return rest.length ? find(box.children, rest.join('/')) : box;
}

const u32 = (body: Uint8Array, offset: number) =>
  new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(offset);

describe('splitAnnexB', () => {
  it('finds the NAL units between start codes of either length', () => {
    const data = new Uint8Array([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5]);
    expect(splitAnnexB(data)).toEqual([
      new Uint8Array([0x67, 1, 2]),
      new Uint8Array([0x68, 3]),
      new Uint8Array([0x65, 4, 5]),
    ]);
  });

  it('keeps zero bytes inside a NAL unit, and drops trailing ones', () => {
    const data = new Uint8Array([0, 0, 1, 0x41, 0, 0, 3, 0, 7, 0, 0, 0, 0, 1, 0x41, 9]);
    expect(splitAnnexB(data)).toEqual([
      new Uint8Array([0x41, 0, 0, 3, 0, 7]),
      new Uint8Array([0x41, 9]),
    ]);
  });

  it('finds nothing without a start code', () => {
    expect(splitAnnexB(new Uint8Array([1, 2, 3]))).toEqual([]);
    expect(splitAnnexB(new Uint8Array([]))).toEqual([]);
  });
});

describe('unescapeRbsp', () => {
  it('removes emulation prevention bytes', () => {
    expect(unescapeRbsp(new Uint8Array([1, 0, 0, 3, 1, 0, 0, 3, 0, 0, 3]))).toEqual(new Uint8Array([1, 0, 0, 1, 0, 0, 0, 0]));
    expect(unescapeRbsp(new Uint8Array([0, 3, 0, 0, 4]))).toEqual(new Uint8Array([0, 3, 0, 0, 4]));
  });
});

describe('parseSps', () => {
  it('reads the size and codec of a baseline stream', () => {
    expect(parseSps(sps({ profile: 66, constraints: 0xc0, level: 31, widthMbs: 80, heightMapUnits: 45 })))
      .toEqual({ width: 1280, height: 720, codec: 'avc1.42c01f' });
  });

  it('takes the cropping off a high profile stream', () => {
    expect(parseSps(sps({ profile: 100, level: 40, widthMbs: 120, heightMapUnits: 68, crop: [0, 0, 0, 4] })))
      .toEqual({ width: 1920, height: 1080, codec: 'avc1.640028' });
  });

  it('reads a portrait screen with a scaling matrix', () => {
    expect(parseSps(sps({
      profile: 100, level: 42, widthMbs: 74, heightMapUnits: 150, crop: [0, 1, 0, 0], scalingMatrix: true,
    }))).toEqual({ width: 1182, height: 2400, codec: 'avc1.64002a' });
  });

  it('reads interlaced and picture order count type 1 streams', () => {
    expect(parseSps(sps({ profile: 77, level: 30, widthMbs: 45, heightMapUnits: 18, frameMbsOnly: false, pocType: 1 })))
      .toEqual({ width: 720, height: 576, codec: 'avc1.4d001e' });
  });

  it('reads a 4:4:4 stream', () => {
    expect(parseSps(sps({ profile: 244, level: 40, widthMbs: 40, heightMapUnits: 30, chromaFormat: 3, crop: [1, 1, 1, 1] })))
      .toEqual({ width: 638, height: 478, codec: 'avc1.f40028' });
  });

  it('undoes emulation prevention before reading', () => {
    // A zero profile and constraint flags then level 1 is 00 00 01, which an encoder escapes.
    const nal = sps({ profile: 0, level: 1, widthMbs: 20, heightMapUnits: 15 });
    expect([...nal.subarray(1, 5)]).toEqual([0, 0, 3, 1]);
    expect(parseSps(nal)).toEqual({ width: 320, height: 240, codec: 'avc1.000001' });
  });

  it('refuses what is not an SPS', () => {
    expect(parseSps(PPS)).toBeNull();
    expect(parseSps(new Uint8Array([0x67, 100]))).toBeNull();
  });
});

describe('avccSample', () => {
  it('prefixes each NAL unit with its length and leaves out parameter sets and delimiters', () => {
    const spsNal = sps({ profile: 66, level: 31, widthMbs: 80, heightMapUnits: 45 });
    const sample = avccSample([new Uint8Array([0x09, 0xf0]), spsNal, PPS, new Uint8Array([0x06, 5, 1, 0x80]), IDR]);
    expect([...sample]).toEqual([0, 0, 0, 4, 0x06, 5, 1, 0x80, 0, 0, 0, 5, ...IDR]);
  });
});

describe('initSegment', () => {
  const spsNal = sps({ profile: 100, level: 40, widthMbs: 120, heightMapUnits: 68, crop: [0, 0, 0, 4] });
  const segment = initSegment({ sps: spsNal, pps: PPS, width: 1920, height: 1080 });
  const boxes = parseBoxes(segment);

  it('is a ftyp and a moov for one video track', () => {
    expect(boxes.map((box) => box.type)).toEqual(['ftyp', 'moov']);
    expect(find(boxes, 'moov').children.map((box) => box.type)).toEqual(['mvhd', 'trak', 'mvex']);
    expect(String.fromCharCode(...find(boxes, 'ftyp').body.subarray(0, 4))).toBe('isom');
    expect(String.fromCharCode(...find(boxes, 'moov/trak/mdia/hdlr').body.subarray(8, 12))).toBe('vide');
    expect(u32(find(boxes, 'moov/trak/mdia/mdhd').body, 12)).toBe(TIMESCALE);
    expect(u32(find(boxes, 'moov/mvex/trex').body, 4)).toBe(1);
  });

  it('gives the picture size', () => {
    const tkhd = find(boxes, 'moov/trak/tkhd').body;
    expect(u32(tkhd, 76) / 65536).toBe(1920);
    expect(u32(tkhd, 80) / 65536).toBe(1080);
    const avc1 = find(boxes, 'moov/trak/mdia/minf/stbl/stsd/avc1').body;
    const view = new DataView(avc1.buffer, avc1.byteOffset);
    expect(view.getUint16(24)).toBe(1920);
    expect(view.getUint16(26)).toBe(1080);
  });

  it('carries the parameter sets in the avcC', () => {
    const avcC = find(boxes, 'moov/trak/mdia/minf/stbl/stsd/avc1/avcC').body;
    expect([...avcC.subarray(0, 6)]).toEqual([1, 100, 0, 40, 0xff, 0xe1]);
    const spsLength = (avcC[6] << 8) | avcC[7];
    expect(avcC.subarray(8, 8 + spsLength)).toEqual(spsNal);
    const at = 8 + spsLength;
    expect(avcC[at]).toBe(1);
    expect((avcC[at + 1] << 8) | avcC[at + 2]).toBe(PPS.length);
    expect(avcC.subarray(at + 3)).toEqual(PPS);
  });
});

describe('mediaSegment', () => {
  const key = avccSample([IDR]);
  const delta = avccSample([P_SLICE]);
  const segment = mediaSegment(7, 2 ** 32 + 5, [
    { data: key, duration: 1500, keyframe: true },
    { data: delta, duration: 3000, keyframe: false },
  ]);
  const boxes = parseBoxes(segment);

  it('is a moof and an mdat of the samples', () => {
    expect(boxes.map((box) => box.type)).toEqual(['moof', 'mdat']);
    expect(find(boxes, 'moof').children.map((box) => box.type)).toEqual(['mfhd', 'traf']);
    expect(find(boxes, 'moof/traf').children.map((box) => box.type)).toEqual(['tfhd', 'tfdt', 'trun']);
    expect(u32(find(boxes, 'moof/mfhd').body, 4)).toBe(7);
    expect(find(boxes, 'mdat').body).toEqual(new Uint8Array([...key, ...delta]));
  });

  it('gives the decode time as 64 bits', () => {
    const tfdt = find(boxes, 'moof/traf/tfdt').body;
    expect(tfdt[0]).toBe(1);
    expect(u32(tfdt, 4)).toBe(1);
    expect(u32(tfdt, 8)).toBe(5);
  });

  it('describes each sample and points at its data', () => {
    const trun = find(boxes, 'moof/traf/trun').body;
    expect(u32(trun, 4)).toBe(2);
    const mdat = find(boxes, 'mdat');
    expect(u32(trun, 8)).toBe(mdat.start + 8);
    expect([u32(trun, 12), u32(trun, 16), u32(trun, 20), u32(trun, 24)]).toEqual([1500, key.length, 0x02000000, 0]);
    expect([u32(trun, 28), u32(trun, 32), u32(trun, 36), u32(trun, 40)]).toEqual([3000, delta.length, 0x01010000, 0]);
  });
});
