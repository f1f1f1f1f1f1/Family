import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PhotoFrame } from './PhotoFrame';

/** Whether the (stood-in) slideshow is moving on to the next photo. */
const slideshow = vi.hoisted(() => ({ isActive: true }));

vi.mock('../hooks/usePhotos', async () => {
  const { useState } = await import('react');
  return {
    usePhotos: () => {
      const [isActive, setActive] = useState(true);
      slideshow.isActive = isActive;
      return {
        currentPhoto: { id: 'a', url: 'a.jpg', caption: 'a.jpg' },
        upcomingPhoto: { id: 'b', url: 'b.jpg', caption: 'b.jpg' },
        nextPhoto: () => {},
        previousPhoto: () => {},
        isActive,
        setActive,
        reportLoadError: () => {},
        photoCount: 2,
      };
    },
  };
});
vi.mock('./CoverPhoto', () => ({ CoverPhoto: () => null }));

const frame = () => document.querySelector<HTMLElement>('.photo-frame')!;

describe('PhotoFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The slideshow holds while the controls are up. Showing them used to
  // stop it for good: it stayed on that photo after they'd gone.
  it('goes on with the slideshow once the controls are gone', () => {
    render(<PhotoFrame />);
    expect(slideshow.isActive).toBe(true);

    fireEvent.click(frame());
    expect(slideshow.isActive).toBe(false);
    fireEvent.click(frame()); // tapped away
    expect(slideshow.isActive).toBe(true);

    fireEvent.click(frame());
    expect(slideshow.isActive).toBe(false);
    act(() => { vi.advanceTimersByTime(5000); }); // gone by themselves
    expect(document.querySelector('.photo-frame-controls--visible')).toBeNull();
    expect(slideshow.isActive).toBe(true);
  });

  it('stays paused after the pause button until resumed', () => {
    render(<PhotoFrame />);
    fireEvent.click(frame());
    fireEvent.click(screen.getByLabelText('Pause slideshow'));
    fireEvent.click(frame());
    expect(slideshow.isActive).toBe(false);

    fireEvent.click(frame());
    fireEvent.click(screen.getByLabelText('Resume slideshow'));
    fireEvent.click(frame());
    expect(slideshow.isActive).toBe(true);
  });

  it('holds on one photo while diagnostics are open', () => {
    render(<PhotoFrame />);
    fireEvent.click(frame());
    fireEvent.click(screen.getByLabelText('Photo diagnostics'));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(slideshow.isActive).toBe(false);
  });
});
