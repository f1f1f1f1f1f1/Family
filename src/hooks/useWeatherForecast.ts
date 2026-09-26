import { useState, useEffect, useCallback } from 'react';
import { ForecastDay } from '../types';
import { hasToken } from '../api/ha-rest';
import { findWeatherEntity, getWeatherForecast } from '../api/ha-services';
import { refreshWhileAwake } from '../utils/display-sleep';

const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes

/**
 * Fetches a 7-day daily weather forecast from Home Assistant.
 * Auto-discovers the weather entity if none is configured.
 */
export function useWeatherForecast(): ForecastDay[] {
  const [forecast, setForecast] = useState<ForecastDay[]>([]);

  const fetchForecast = useCallback(async () => {
    if (!hasToken()) return;

    try {
      const entity = await findWeatherEntity();
      if (!entity) return;
      const raw = await getWeatherForecast(entity.entity_id, 'daily');

      const days: ForecastDay[] = raw.map((f) => ({
        date: (f.datetime as string).slice(0, 10), // "2026-03-29"
        condition: (f.condition as string) ?? 'sunny',
        tempHigh: (f.temperature as number) ?? 0,
        tempLow: (f.templow as number) ?? 0,
      }));

      setForecast(days);
    } catch {
      // Silently ignore — weather is supplementary
    }
  }, []);

  useEffect(() => {
    fetchForecast();
    return refreshWhileAwake(fetchForecast, REFRESH_INTERVAL);
  }, [fetchForecast]);

  return forecast;
}
