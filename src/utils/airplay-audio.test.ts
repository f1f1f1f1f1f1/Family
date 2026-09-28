import { describe, expect, it, vi } from 'vitest';
import { CHUNK_FRAMES, SAMPLE_RATE, createAirPlayAudio, pcmToChannels, scheduleChunk } from './airplay-audio';

class FakeContext extends EventTarget {
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = {};
  allowResume = true;
  sources: {
    buffer: { duration: number; channels: Float32Array[] } | null;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }[] = [];

  resume = vi.fn(async () => {
    if (!this.allowResume) return;
    this.state = 'running';
    this.dispatchEvent(new Event('statechange'));
  });

  createBuffer(channels: number, length: number, rate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / rate, length, channels: data, getChannelData: (i: number) => data[i] };
  }

  createBufferSource() {
    const source = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    this.sources.push(source);
    return source;
  }
}

/** PCM as the add-on sends it: 16-bit big-endian, left then right. */
function pcm(frames: [number, number][]): Uint8Array {
  const data = new Uint8Array(frames.length * 4);
  const view = new DataView(data.buffer);
  frames.forEach(([left, right], i) => {
    view.setInt16(i * 4, left);
    view.setInt16(i * 4 + 2, right);
  });
  return data;
}

const silence = (frames: number) => new Uint8Array(frames * 4);

function player(context = new FakeContext()) {
  const onBlockedChange = vi.fn();
  const audio = createAirPlayAudio({ context: () => context as unknown as AudioContext, onBlockedChange });
  return { audio, context, onBlockedChange };
}

describe('pcmToChannels', () => {
  it('turns 16-bit big-endian stereo into two channels of floats', () => {
    const [left, right] = pcmToChannels(pcm([[32767, -32768], [1, -1]]));
    expect(Array.from(left)).toEqual([32767 / 32768, 1 / 32768]);
    expect(Array.from(right)).toEqual([-1, -1 / 32768]);
  });

  it('ignores a trailing partial frame', () => {
    const [left, right] = pcmToChannels(new Uint8Array([0, 1, 0, 2, 0, 3]));
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
  });
});

describe('scheduleChunk', () => {
  it('starts a little ahead, then plays each chunk after the last', () => {
    expect(scheduleChunk(0, 0, 0.1)).toEqual({ start: 0.12, next: expect.closeTo(0.22) });
    expect(scheduleChunk(0.22, 0.1, 0.1)).toEqual({ start: 0.22, next: expect.closeTo(0.32) });
  });

  it('starts ahead again after running dry', () => {
    expect(scheduleChunk(0.1, 0.095, 0.1)).toEqual({ start: expect.closeTo(0.215), next: expect.closeTo(0.315) });
  });

  it('drops sound that would play too late', () => {
    expect(scheduleChunk(0.9, 0.1, 0.1)).toBeNull();
  });
});

describe('createAirPlayAudio', () => {
  it('plays the sound in chunks, one after another', () => {
    const { audio, context } = player();
    audio.push(silence(CHUNK_FRAMES / 2));
    expect(context.sources).toHaveLength(0);
    audio.push(silence(CHUNK_FRAMES / 2 + 10));
    expect(context.sources).toHaveLength(1);
    audio.push(silence(CHUNK_FRAMES));
    expect(context.sources).toHaveLength(2);

    const [first, second] = context.sources;
    expect(first.connect).toHaveBeenCalledWith(context.destination);
    expect(first.buffer!.duration).toBeCloseTo(CHUNK_FRAMES / SAMPLE_RATE);
    expect(first.start).toHaveBeenCalledWith(0.12);
    expect(second.start.mock.calls[0][0]).toBeCloseTo(0.12 + CHUNK_FRAMES / SAMPLE_RATE);
  });

  it('keeps the samples in order across chunks', () => {
    const { audio, context } = player();
    const frames: [number, number][] = Array.from({ length: CHUNK_FRAMES + 3 }, (_, i) => [i, -i]);
    audio.push(pcm(frames.slice(0, 5)));
    audio.push(pcm(frames.slice(5)));
    const [left, right] = context.sources[0].buffer!.channels;
    expect(left[4] * 32768).toBeCloseTo(4);
    expect(left[CHUNK_FRAMES - 1] * 32768).toBeCloseTo(CHUNK_FRAMES - 1);
    expect(right[7] * 32768).toBeCloseTo(-7);
  });

  it('waits for a tap when the browser holds the sound back', async () => {
    const context = new FakeContext();
    context.state = 'suspended';
    context.allowResume = false;
    const { audio, onBlockedChange } = player(context);
    audio.push(silence(CHUNK_FRAMES));
    await Promise.resolve();
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(onBlockedChange).toHaveBeenLastCalledWith(true);
    expect(audio.blocked).toBe(true);
    audio.push(silence(CHUNK_FRAMES));
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(context.sources.filter((source) => source.buffer)).toHaveLength(0);

    context.allowResume = true;
    await audio.unlock();
    expect(onBlockedChange).toHaveBeenLastCalledWith(false);
    expect(audio.blocked).toBe(false);
    audio.push(silence(CHUNK_FRAMES));
    expect(context.sources.filter((source) => source.buffer && source.buffer.duration > 0.01)).toHaveLength(1);
  });

  it('stops what it scheduled when closed', () => {
    const { audio, context } = player();
    audio.push(silence(CHUNK_FRAMES * 2));
    audio.close();
    for (const source of context.sources) expect(source.stop).toHaveBeenCalled();
    audio.push(silence(CHUNK_FRAMES));
    expect(context.sources).toHaveLength(2);
  });

  it('does nothing without Web Audio', () => {
    const audio = createAirPlayAudio({ context: () => null });
    expect(() => audio.push(silence(CHUNK_FRAMES))).not.toThrow();
    expect(audio.blocked).toBe(false);
  });
});
