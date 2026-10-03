/**
 * An `<img>` that swaps to a fallback (e.g. a sticker icon) when the image is
 * missing or fails to load, so cards never show a broken-image glyph.
 */
import { useState, type JSX, type ReactNode } from 'react';

/** Props for {@link SafeImg}. */
export interface SafeImgProps {
  src: string | undefined;
  alt?: string;
  className?: string;
  /** Shown when there's no src or it fails. */
  fallback: ReactNode;
}

/** Image with a graceful fallback. */
export function SafeImg({ src, alt = '', className, fallback }: SafeImgProps): JSX.Element {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <span className="tr-img-fallback">{fallback}</span>;
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(src)}
    />
  );
}
