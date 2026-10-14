import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findWeatherEntity, refreshTodoList, resetTodoRefreshes } from './ha-services';
import { callHaService, haFetch } from './ha-rest';

vi.mock('./ha-rest', () => ({
  haFetch: vi.fn(async (path: string) => ({ entity_id: path.split('/').pop(), state: 'sunny', attributes: {} })),
  fetchAllStates: vi.fn(async () => []),
  callHaService: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(haFetch).mockClear();
});

describe('findWeatherEntity', () => {
  // Settings' Weather Entity used to be ignored for the add-on option.
  it('uses the weather entity chosen in Settings', async () => {
    localStorage.setItem('beacon-settings', JSON.stringify({ weatherEntity: 'weather.garden' }));

    expect((await findWeatherEntity())?.entity_id).toBe('weather.garden');
    expect(haFetch).toHaveBeenCalledWith('/api/states/weather.garden');
  });

  it('uses the add-on option when Settings has none', async () => {
    expect((await findWeatherEntity())?.entity_id).toBe('weather.home');
  });
});

describe('refreshTodoList', () => {
  beforeEach(() => {
    resetTodoRefreshes();
    vi.mocked(callHaService).mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has HA fetch the list from Google Tasks', async () => {
    expect(await refreshTodoList('todo.kai')).toBe(true);
    expect(callHaService).toHaveBeenCalledWith('homeassistant', 'update_entity', { entity_id: 'todo.kai' });
  });

  // Every screen showing a list refreshes it; Google is asked once for them all.
  it('asks about once a minute per list', async () => {
    await refreshTodoList('todo.kai');
    expect(await refreshTodoList('todo.kai')).toBe(false);
    expect(await refreshTodoList('todo.shopping')).toBe(true);
    expect(callHaService).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(50_000);
    expect(await refreshTodoList('todo.kai')).toBe(true);
    expect(callHaService).toHaveBeenCalledTimes(3);
  });

  it("says there's nothing new to read when HA couldn't refresh it", async () => {
    vi.mocked(callHaService).mockRejectedValue(new Error('Service call 500'));
    expect(await refreshTodoList('todo.kai')).toBe(false);
  });
});
