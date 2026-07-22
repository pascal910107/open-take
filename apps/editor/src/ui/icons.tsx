// Lucide-style stroke icons, inline (no dependency). 24×24 viewBox, sized via
// the `size` prop. Icons over text walls — the v4 design rule.
import type { JSX } from "react";

type P = { size?: number; strokeWidth?: number };

function I(path: JSX.Element, { size = 16, strokeWidth = 1.8 }: P = {}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {path}
    </svg>
  );
}

export const IcZoom = (p: P = {}) =>
  I(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3M8 11h6M11 8v6" />
    </>,
    p,
  );
export const IcBg = (p: P = {}) =>
  I(
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-4.5-4.5L6 21" />
    </>,
    p,
  );
export const IcFrame = (p: P = {}) =>
  I(<path d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2" />, p);
export const IcCursor = (p: P = {}) => I(<path d="m4 4 7.1 16.9L13.6 14l6.9-2.5z" />, p);
export const IcMotion = (p: P = {}) => I(<path d="M2 12h3l3-8 4 16 3-8h3M20 12h2" />, p);
export const IcClip = (p: P = {}) =>
  I(
    <>
      <rect x="2" y="6" width="20" height="12" rx="3" />
      <path d="M7 6v12M17 6v12" />
    </>,
    p,
  );
export const IcAgent = (p: P = {}) =>
  I(
    <>
      <path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4M19.1 19.1l-1.4-1.4" />
      <circle cx="12" cy="12" r="4" />
    </>,
    p,
  );
export const IcUndo = (p: P = {}) => I(<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v1" />, p);
export const IcRedo = (p: P = {}) => I(<path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0-6 6v1" />, p);
export const IcCompare = (p: P = {}) =>
  I(
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M12 4v16" />
    </>,
    p,
  );
export const IcExport = (p: P = {}) =>
  I(<path d="M12 15V3M7 8l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />, p);
export const IcPlay = ({ size = 16 }: P = {}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path d="M7 4.5v15l13-7.5z" fill="currentColor" />
  </svg>
);
export const IcPause = ({ size = 16 }: P = {}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="6" y="4" width="4.5" height="16" rx="1.2" fill="currentColor" />
    <rect x="13.5" y="4" width="4.5" height="16" rx="1.2" fill="currentColor" />
  </svg>
);
export const IcPrev = ({ size = 15 }: P = {}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path d="M17 19V5h-2v14zM15 12 6 6v12z" fill="currentColor" />
  </svg>
);
export const IcNext = ({ size = 15 }: P = {}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path d="M7 5v14h2V5zM9 12l9 6V6z" fill="currentColor" />
  </svg>
);
export const IcTarget = (p: P = {}) =>
  I(
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </>,
    p,
  );
export const IcCalm = (p: P = {}) => I(<path d="M3 14c3-6 6-6 9 0s6 6 9 0" />, { size: 18, ...p });
export const IcNatural = (p: P = {}) =>
  I(<path d="M3 16c2-8 5-8 7 0s5 8 7 0 2-6 4-4" />, { size: 18, ...p });
export const IcFast = ({ size = 18 }: P = {}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path d="M3 12h8l-2-5 8 8h-8l2 5z" fill="currentColor" />
  </svg>
);
export const IcGradient = ({ size = 18 }: P = {}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <defs>
      <linearGradient id="icg" x1="0" y1="0" x2="1" y2="1">
        <stop stopColor="#8d86ff" />
        <stop offset="1" stopColor="#2a2450" />
      </linearGradient>
    </defs>
    <rect x="3" y="3" width="18" height="18" rx="4" fill="url(#icg)" />
  </svg>
);
export const IcSolid = ({ size = 18 }: P = {}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="4" y="4" width="16" height="16" rx="4" fill="currentColor" opacity=".82" />
  </svg>
);
