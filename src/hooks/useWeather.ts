import { useState, useEffect, useCallback } from 'react';
import { HomeAssistantClient } from '../api/homeassistant';
import { WeatherData } from '../types';
import { getConfig } from '../config';
import { hasToken } from '../api/ha-rest';
import { findWeatherEntity } from '../api/ha-services';

const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

export function useWeather(getClient: () => HomeAssistantClient | null) {
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchWeather = useCallback(async () => {
    const client = getClient();
    const configEntity = getConfig().weather_entity;

    // Try WebSocket client first
    if (client?.isConnected) {
      try {
        const data = await client.getWeather(configEntity);
        setWeather(data);
        setError(null);
        return;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch weather');
      }
    }

    // Fall back to REST API (proxy mode)
    if (hasToken()) {
      try {
        const entity = await findWeatherEntity();
        if (entity) {
          const attrs = entity.attributes;
          setWeather({
            temperature: (attrs.temperature as number) ?? 0,
            temperatureUnit: (attrs.temperature_unit as string) ?? '°F',
            condition: entity.state,
            humidity: attrs.humidity as number | undefined,
            windSpeed: attrs.wind_speed as number | undefined,
            forecast: [], // forecast requires a separate service call
          });
          setError(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch weather');
      }
    }
  }, [getClient]);

  useEffect(() => {
    fetchWeather();
    const interval = setInterval(fetchWeather, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchWeather]);

  return { weather, error, refresh: fetchWeather };
}
