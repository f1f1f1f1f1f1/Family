import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSettings, chosenCameras } from './useSettings';
import { resetStoredData } from './useStoredData';

describe('useSettings cameras', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStoredData();
  });

  it('has four empty camera slots to begin with', () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.cameraEntities).toEqual(['', '', '', '']);
  });

  it('keeps four slots of camera ids, emptying anything else', () => {
    localStorage.setItem('beacon-settings', JSON.stringify({
      cameraEntities: ['camera.front', 'light.porch', 7, 'camera.back', 'camera.extra'],
    }));
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.cameraEntities).toEqual(['camera.front', '', '', 'camera.back']);
  });

  // Two changes made from the same copy (here, before the screen caught up
  // with the first) each change only their own slot.
  it('applies only the slots a change picked', () => {
    const { result } = renderHook(() => useSettings());
    act(() => {
      result.current.updateSettings({ cameraEntities: ['camera.front', '', '', ''] });
      result.current.updateSettings({ cameraEntities: ['', 'camera.back', '', ''] });
    });
    expect(result.current.settings.cameraEntities).toEqual(['camera.front', 'camera.back', '', '']);
  });

  it('lists the chosen cameras in slot order, each once', () => {
    expect(chosenCameras({ cameraEntities: ['', 'camera.back', 'camera.front', 'camera.back'] }))
      .toEqual(['camera.back', 'camera.front']);
  });
});
