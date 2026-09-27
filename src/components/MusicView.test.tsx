import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MusicView } from './MusicView';
import type { MediaPlayer } from '../types/music';

const livingRoom: MediaPlayer = {
  entity_id: 'media_player.living_room',
  friendly_name: 'Living Room',
  state: 'playing',
  media_title: 'Golden Hour',
  media_artist: 'The Sunset Parade',
  media_album_name: 'Afterglow',
  media_duration: 245,
  media_position: 62,
  media_position_updated_at: '2026-09-27T10:00:00Z',
  volume_level: 0.4,
};
const kitchen: MediaPlayer = {
  entity_id: 'media_player.kitchen',
  friendly_name: 'Kitchen',
  state: 'paused',
  media_title: 'Midnight Signals',
  media_artist: 'Harbor Lights',
  media_duration: 198,
  media_position: 95,
  media_position_updated_at: '2026-09-27T09:58:00Z',
  volume_level: 0.3,
};

const handlers = () => ({
  onSelectPlayer: vi.fn(),
  onPlay: vi.fn(),
  onPause: vi.fn(),
  onNext: vi.fn(),
  onPrevious: vi.fn(),
  onSetVolume: vi.fn(),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T10:00:30Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MusicView', () => {
  it('shows the track and how far it has got', () => {
    render(<MusicView players={[livingRoom]} selectedPlayerId={null} {...handlers()} />);

    expect(screen.getByRole('heading', { name: 'Golden Hour' })).toBeInTheDocument();
    expect(screen.getByText('The Sunset Parade — Afterglow')).toBeInTheDocument();
    // 62 s when measured, 30 s ago
    expect(screen.getByText('1:32')).toBeInTheDocument();
    expect(screen.getByText('-2:33')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  // The playing speaker always won, so another couldn't be seen or controlled.
  it('shows the speaker picked, even while another one plays', () => {
    const on = handlers();
    render(<MusicView players={[kitchen, livingRoom]} selectedPlayerId={null} {...on} />);

    fireEvent.click(screen.getByRole('button', { name: 'Speaker: Living Room, change speaker' }));
    fireEvent.click(screen.getByRole('button', { name: /^Kitchen/ }));

    expect(on.onSelectPlayer).toHaveBeenCalledWith('media_player.kitchen');
    expect(screen.getByRole('heading', { name: 'Midnight Signals' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Speakers' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(on.onPlay).toHaveBeenCalledWith('media_player.kitchen');
  });

  // Every move of the slider used to be a Home Assistant service call.
  it('sets the volume at most every quarter second while dragging, ending where it was left', () => {
    const on = handlers();
    render(<MusicView players={[livingRoom]} selectedPlayerId={null} {...on} />);
    const slider = screen.getByRole('slider', { name: 'Volume' });

    fireEvent.change(slider, { target: { value: '0.5' } });
    fireEvent.change(slider, { target: { value: '0.6' } });
    fireEvent.change(slider, { target: { value: '0.7' } });
    expect(on.onSetVolume).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(250); });
    expect(on.onSetVolume).toHaveBeenCalledTimes(2);
    expect(on.onSetVolume).toHaveBeenLastCalledWith(0.7, 'media_player.living_room');
  });

  // Pausing used to switch the screen to whichever other speaker was playing.
  it('stays on the speaker showing when it is paused', () => {
    const on = handlers();
    const { rerender } = render(<MusicView players={[livingRoom, kitchen]} selectedPlayerId={null} {...on} />);
    expect(screen.getByRole('heading', { name: 'Golden Hour' })).toBeInTheDocument();

    const pausedLivingRoom = { ...livingRoom, state: 'paused' as const };
    const playingKitchen = { ...kitchen, state: 'playing' as const };
    rerender(<MusicView players={[playingKitchen, pausedLivingRoom]} selectedPlayerId={null} {...on} />);

    expect(screen.getByRole('heading', { name: 'Golden Hour' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('says when there are no speakers', () => {
    render(<MusicView players={[]} selectedPlayerId={null} {...handlers()} />);
    expect(screen.getByRole('heading', { name: 'No speakers' })).toBeInTheDocument();
  });
});
