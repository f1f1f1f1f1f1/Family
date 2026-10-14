/**
 * Plays an HLS stream (a camera's live video) in a <video>: with hls.js
 * where the browser has Media Source Extensions, which is nearly
 * everywhere, else natively (older iOS). hls.js is fetched only now, so
 * it isn't part of the app's startup download.
 *
 * Calls `onFatal` once the stream can't be played. Resolves to the
 * cleanup, which stops the stream.
 */
export async function playHls(
  video: HTMLVideoElement,
  url: string,
  onFatal: (reason: string) => void,
): Promise<() => void> {
  const { default: Hls } = await import('hls.js');

  if (Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: true,
      backBufferLength: 10,
      // HA answers the first playlist only once the camera has sent a
      // whole segment, which can take several seconds.
      manifestLoadingTimeOut: 30_000,
      manifestLoadingMaxRetry: 2,
      levelLoadingTimeOut: 30_000,
      fragLoadingTimeOut: 30_000,
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) onFatal(data.details);
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    return () => hls.destroy();
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    const onError = () => onFatal('video error');
    video.addEventListener('error', onError);
    video.src = url;
    return () => {
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      video.load();
    };
  }

  onFatal('This browser can\'t play live video');
  return () => {};
}
