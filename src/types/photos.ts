export type PhotoSource = 'local' | 'google_photos' | 'ha_media';

export interface Photo {
  url: string;
  caption?: string;
  date?: string;
  source: PhotoSource;
}

/** A photo found in the media folders, before its URL has been resolved. */
export interface PhotoEntry {
  /** HA media_content_id (media-source://…), resolved to a URL on demand. */
  id: string;
  caption?: string;
  source: PhotoSource;
}

export type PhotoTransition = 'fade' | 'slide';

export interface PhotoConfig {
  sources: PhotoSource[];
  interval_seconds: number;
  transition: PhotoTransition;
  show_clock: boolean;
  show_weather: boolean;
}
