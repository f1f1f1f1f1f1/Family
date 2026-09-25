import { useEffect, useRef, useState } from 'react';

/**
 * Draws a photo to fill its box without distortion, cropped around the
 * exact centre of the photo — computed here rather than left to CSS.
 *
 * CSS `background-size: cover` / `object-fit: cover` centred iPhone JPEGs
 * wrongly on the Echo Show's Android WebView (the photo landed well below
 * centre) while test images without an EXIF orientation centred fine.
 * canvas drawImage() takes the image's EXIF orientation into account, and
 * naturalWidth/naturalHeight are the rotated size, so the crop maths works
 * on the photo as it should appear.
 */

interface Props {
  src?: string;
  label: string;
  className?: string;
}

/** Source rectangle of an image (w × h) that fills a box (bw × bh), centred. */
export function coverCrop(w: number, h: number, bw: number, bh: number) {
  const scale = Math.max(bw / w, bh / h);
  const sw = bw / scale;
  const sh = bh / scale;
  return { sx: (w - sw) / 2, sy: (h - sh) / 2, sw, sh };
}

export function CoverPhoto({ src, label, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    setImage(null);
    if (!src) return;
    let cancelled = false;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { if (!cancelled) setImage(img); };
    img.src = src;
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;

    const draw = () => {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height || !image.naturalWidth || !image.naturalHeight) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingQuality = 'high';
      const { sx, sy, sw, sh } = coverCrop(image.naturalWidth, image.naturalHeight, canvas.width, canvas.height);
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    };

    draw();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null;
    observer?.observe(canvas);
    window.addEventListener('resize', draw);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', draw);
    };
  }, [image]);

  return <canvas ref={canvasRef} className={className} role="img" aria-label={label} />;
}
