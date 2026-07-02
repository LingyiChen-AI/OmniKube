import type { CSSProperties } from 'react';

interface Props {
  /** Glyph size relative to its container box (or a px number). */
  size?: number | string;
  style?: CSSProperties;
}

/**
 * OmniKube logo glyph — a monogram of the name, not the Kubernetes wheel:
 *   • the outer ring is the "O" of **Omni** (one console encompassing everything),
 *     with a single orbit marker hinting at multi-cluster reach;
 *   • the isometric cube is **Kube** (a container/box — the K8s nod, minus the helm).
 * Rendered white so it sits on the sky-gradient `.ok-brand-mark` box (and favicon).
 * Geometry is on a 32×32 grid centred at (16,16).
 */
export default function BrandMark({ size = '64%', style }: Props) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none" style={style} aria-hidden="true">
      {/* Omni ring (the "O") + a single orbit marker */}
      <circle cx="16" cy="16" r="11" stroke="#fff" strokeWidth="1.4" opacity="0.5" />
      <circle cx="16" cy="5" r="1.7" fill="#fff" />

      {/* Kube — isometric cube, three shaded faces */}
      <path d="M16 8.5 L22 11.5 L16 14.5 L10 11.5 Z" fill="#fff" fillOpacity="0.32" />
      <path d="M22 11.5 L22 17.5 L16 20.5 L16 14.5 Z" fill="#fff" fillOpacity="0.16" />
      <path d="M10 11.5 L10 17.5 L16 20.5 L16 14.5 Z" fill="#fff" fillOpacity="0.06" />

      {/* cube edges */}
      <path
        d="M16 8.5 L22 11.5 L22 17.5 L16 20.5 L10 17.5 L10 11.5 Z"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M16 14.5 L22 11.5 M16 14.5 L10 11.5 M16 14.5 L16 20.5"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
