/**
 * Pure SVG Tumbler portrait: gumdrop body in the player's colours and
 * pattern, face plate with expressions, optional hat. Used by the player wall,
 * results grid, party slots, profile and anywhere a 3D render isn't available.
 */
import { memo, useId, type JSX } from 'react';
import type { AvatarHat, FaceExpression, TumblerColors } from '../store/types.ts';
import { shade } from '../theme/tokens.ts';

/** Props for `TumblerAvatar`. */
export interface TumblerAvatarProps {
  colors: TumblerColors;
  expression?: FaceExpression;
  hat?: AvatarHat;
  /** CSS size (width); height follows the 100:120 aspect. Default `4em`. */
  size?: string;
  /** Blink loop (disable for big grids where it's distracting). */
  blink?: boolean;
  className?: string;
  /** Hide the ground shadow (e.g. while falling). */
  noShadow?: boolean;
  title?: string;
}

const BODY = 'M50 9 C77 9 88 40 88 70 C88 98 72 110 50 110 C28 110 12 98 12 70 C12 40 23 9 50 9 Z';
const INK = '#2b1a5e';

function PatternDef({ id, colors }: { id: string; colors: TumblerColors }): JSX.Element | null {
  const c = colors.secondary;
  switch (colors.pattern) {
    case 'stripes':
      return (
        <pattern id={id} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
          <rect width="6" height="14" fill={c} />
        </pattern>
      );
    case 'dots':
      return (
        <pattern id={id} width="16" height="16" patternUnits="userSpaceOnUse">
          <circle cx="5" cy="5" r="3.4" fill={c} />
          <circle cx="13" cy="13" r="3.4" fill={c} />
        </pattern>
      );
    case 'checker':
      return (
        <pattern id={id} width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(12)">
          <rect width="9" height="9" fill={c} />
          <rect x="9" y="9" width="9" height="9" fill={c} />
        </pattern>
      );
    case 'zigzag':
      return (
        <pattern id={id} width="16" height="12" patternUnits="userSpaceOnUse">
          <path
            d="M0 8 L4 3 L8 8 L12 3 L16 8"
            stroke={c}
            strokeWidth="3"
            fill="none"
            strokeLinejoin="round"
          />
        </pattern>
      );
    case 'stars':
      return (
        <pattern id={id} width="22" height="22" patternUnits="userSpaceOnUse">
          <path
            d="M6 1 L7.6 4.6 L11.5 5 L8.6 7.6 L9.4 11.4 L6 9.4 L2.6 11.4 L3.4 7.6 L0.5 5 L4.4 4.6 Z"
            fill={c}
          />
          <path
            d="M17 12 L18.2 14.6 L21 15 L19 17 L19.5 19.8 L17 18.4 L14.5 19.8 L15 17 L13 15 L15.8 14.6 Z"
            fill={c}
          />
        </pattern>
      );
    case 'camo':
      return (
        <pattern id={id} width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M4 6 C12 0 20 8 16 14 C12 20 2 16 4 6 Z" fill={c} />
          <path d="M24 22 C34 18 40 28 32 34 C24 38 18 28 24 22 Z" fill={c} />
          <path d="M28 2 C34 2 36 8 32 10 C26 12 24 4 28 2 Z" fill={shade(c, -0.2)} />
          <path d="M6 28 C12 26 14 34 10 36 C4 38 2 30 6 28 Z" fill={shade(c, -0.2)} />
        </pattern>
      );
    case 'galaxy':
      return (
        <pattern id={id} width="30" height="30" patternUnits="userSpaceOnUse">
          <circle cx="4" cy="6" r="1.2" fill="#fff" />
          <circle cx="20" cy="4" r="0.8" fill="#fff" />
          <circle cx="14" cy="18" r="1.6" fill={c} />
          <circle cx="26" cy="24" r="1" fill="#fff" />
          <circle cx="6" cy="26" r="0.7" fill="#fff" />
        </pattern>
      );
    default:
      return null;
  }
}

function Eyes({ expression }: { expression: FaceExpression }): JSX.Element {
  switch (expression) {
    case 'scared':
      return (
        <g>
          <circle cx="40" cy="44" r="6.5" fill="#fff" stroke={INK} strokeWidth="2.5" />
          <circle cx="60" cy="44" r="6.5" fill="#fff" stroke={INK} strokeWidth="2.5" />
          <circle cx="40" cy="45" r="2.4" fill={INK} />
          <circle cx="60" cy="45" r="2.4" fill={INK} />
        </g>
      );
    case 'dizzy':
      return (
        <g fill="none" stroke={INK} strokeWidth="2.6" strokeLinecap="round">
          <path d="M40 44 m-5 0 a5 5 0 1 0 5 -5 a3 3 0 1 0 3 3" />
          <path d="M60 44 m-5 0 a5 5 0 1 0 5 -5 a3 3 0 1 0 3 3" />
        </g>
      );
    case 'cheer':
    case 'grin':
      return (
        <g fill="none" stroke={INK} strokeWidth="3.4" strokeLinecap="round">
          <path d="M35 46 Q40 39 45 46" />
          <path d="M55 46 Q60 39 65 46" />
        </g>
      );
    case 'sad':
      return (
        <g>
          <path d="M34 41 L45 44" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
          <path d="M66 41 L55 44" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
          <ellipse cx="40" cy="47" rx="3.6" ry="4.4" fill={INK} />
          <ellipse cx="60" cy="47" rx="3.6" ry="4.4" fill={INK} />
        </g>
      );
    case 'sleepy':
      return (
        <g fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round">
          <path d="M35 45 Q40 49 45 45" />
          <path d="M55 45 Q60 49 65 45" />
        </g>
      );
    case 'determined':
      return (
        <g>
          <path d="M33 37 L46 41" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <path d="M67 37 L54 41" stroke={INK} strokeWidth="3" strokeLinecap="round" />
          <ellipse cx="40" cy="46" rx="4" ry="5" fill={INK} />
          <ellipse cx="60" cy="46" rx="4" ry="5" fill={INK} />
        </g>
      );
    default:
      return (
        <g className="tr-av-eyes">
          <ellipse cx="40" cy="44" rx="4.4" ry="6" fill={INK} />
          <ellipse cx="60" cy="44" rx="4.4" ry="6" fill={INK} />
          <circle cx="41.6" cy="41.4" r="1.6" fill="#fff" />
          <circle cx="61.6" cy="41.4" r="1.6" fill="#fff" />
        </g>
      );
  }
}

function Mouth({ expression }: { expression: FaceExpression }): JSX.Element {
  switch (expression) {
    case 'scared':
      return <ellipse cx="50" cy="56" rx="3.6" ry="4.4" fill={INK} />;
    case 'dizzy':
      return (
        <path
          d="M42 56 Q46 53 50 56 Q54 59 58 56"
          fill="none"
          stroke={INK}
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      );
    case 'sad':
      return (
        <path d="M43 58 Q50 52 57 58" fill="none" stroke={INK} strokeWidth="2.8" strokeLinecap="round" />
      );
    case 'grin':
    case 'cheer':
      return (
        <path d="M40 52 Q50 64 60 52 Z" fill={INK} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      );
    case 'sleepy':
      return <circle cx="50" cy="56" r="2.2" fill={INK} />;
    case 'determined':
      return <path d="M44 56 L56 55" stroke={INK} strokeWidth="2.8" strokeLinecap="round" />;
    default:
      return (
        <path d="M43 53 Q50 59 57 53" fill="none" stroke={INK} strokeWidth="2.8" strokeLinecap="round" />
      );
  }
}

function Hat({ hat }: { hat: AvatarHat }): JSX.Element | null {
  const stroke = { stroke: INK, strokeWidth: 3, strokeLinejoin: 'round' as const };
  switch (hat) {
    case 'crown':
      return (
        <g transform="translate(0 -4)">
          <path d="M30 18 L34 2 L42 12 L50 -2 L58 12 L66 2 L70 18 Z" fill="#ffd23f" {...stroke} />
          <circle cx="50" cy="8" r="2.6" fill="#ff4f9a" />
          <circle cx="38" cy="12" r="1.8" fill="#3ee6b4" />
          <circle cx="62" cy="12" r="1.8" fill="#3ee6b4" />
        </g>
      );
    case 'cone':
      return (
        <g>
          <path d="M38 14 L50 -12 L62 14 Z" fill="#ff8a3d" {...stroke} />
          <path d="M42 6 L58 6" stroke="#fff" strokeWidth="3" />
          <circle cx="50" cy="-12" r="3.6" fill="#ffd23f" {...stroke} strokeWidth={2} />
        </g>
      );
    case 'cap':
      return (
        <g>
          <path d="M26 20 C26 2 74 2 74 20 Z" fill="#3fa9ff" {...stroke} />
          <path d="M66 18 L88 22 L70 24 Z" fill="#2f7fe0" {...stroke} />
        </g>
      );
    case 'bow':
      return (
        <g transform="translate(62 12)">
          <path d="M0 0 L-12 -8 L-12 8 Z M0 0 L12 -8 L12 8 Z" fill="#ff4f9a" {...stroke} />
          <circle r="3.4" fill="#ff7ad9" {...stroke} strokeWidth={2} />
        </g>
      );
    case 'antenna':
      return (
        <g>
          <path d="M50 10 L50 -6" stroke={INK} strokeWidth="3" />
          <circle cx="50" cy="-8" r="5" fill="#3ee6b4" {...stroke} />
        </g>
      );
    case 'tophat':
      return (
        <g>
          <rect x="34" y="-10" width="32" height="22" rx="3" fill="#3a3550" {...stroke} />
          <rect x="26" y="10" width="48" height="6" rx="3" fill="#3a3550" {...stroke} />
          <rect x="34" y="4" width="32" height="4" fill="#ff4f9a" />
        </g>
      );
    default:
      return null;
  }
}

/**
 * SVG Tumbler portrait.
 * @example <TumblerAvatar colors={{ primary: '#ff4f9a', secondary: '#fff', pattern: 'dots' }} expression="grin" />
 */
export const TumblerAvatar = memo(function TumblerAvatar({
  colors,
  expression = 'happy',
  hat = 'none',
  size = '4em',
  blink = true,
  className,
  noShadow,
  title,
}: TumblerAvatarProps): JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradId = `g${uid}`;
  const patId = `p${uid}`;
  const clipId = `c${uid}`;
  const top = colors.pattern === 'gradient' ? colors.secondary : shade(colors.primary, 0.28);
  const bottom = colors.pattern === 'galaxy' ? shade(colors.primary, -0.45) : shade(colors.primary, -0.12);
  const hasPattern = colors.pattern !== 'plain' && colors.pattern !== 'gradient';
  const face = colors.tertiary ?? '#fff7ea';
  const limb = shade(colors.primary, -0.18);

  return (
    <svg
      className={`tr-avatar${blink ? ' tr-avatar--blink' : ''}${className ? ` ${className}` : ''}`}
      viewBox="0 -16 100 136"
      width={size}
      style={{ height: 'auto', overflow: 'visible' }}
      role="img"
      aria-label={title ?? 'Tumbler'}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={top} />
          <stop offset="0.55" stopColor={colors.primary} />
          <stop offset="1" stopColor={bottom} />
        </linearGradient>
        {hasPattern && <PatternDef id={patId} colors={colors} />}
        <clipPath id={clipId}>
          <path d={BODY} />
        </clipPath>
      </defs>
      {!noShadow && <ellipse cx="50" cy="116" rx="28" ry="4.5" fill="rgba(43,26,94,.25)" />}
      <ellipse cx="38" cy="108" rx="10" ry="6.5" fill={limb} stroke={INK} strokeWidth="3.5" />
      <ellipse cx="62" cy="108" rx="10" ry="6.5" fill={limb} stroke={INK} strokeWidth="3.5" />
      <ellipse
        cx="13"
        cy="72"
        rx="7.5"
        ry="10"
        fill={limb}
        stroke={INK}
        strokeWidth="3.5"
        transform="rotate(20 13 72)"
      />
      <ellipse
        cx="87"
        cy="72"
        rx="7.5"
        ry="10"
        fill={limb}
        stroke={INK}
        strokeWidth="3.5"
        transform="rotate(-20 87 72)"
      />
      <path d={BODY} fill={`url(#${gradId})`} />
      {hasPattern && (
        <rect
          x="0"
          y="0"
          width="100"
          height="120"
          fill={`url(#${patId})`}
          clipPath={`url(#${clipId})`}
          opacity="0.9"
        />
      )}
      <path
        d="M22 90 C30 104 70 104 78 90 C74 104 62 110 50 110 C38 110 26 104 22 90 Z"
        fill="rgba(43,26,94,.16)"
      />
      <path d={BODY} fill="none" stroke={INK} strokeWidth="4" />
      <rect x="23" y="29" width="54" height="36" rx="18" fill={face} stroke={INK} strokeWidth="3" />
      <ellipse cx="34" cy="22" rx="9" ry="4.5" fill="rgba(255,255,255,.65)" transform="rotate(-28 34 22)" />
      <Eyes expression={expression} />
      <Mouth expression={expression} />
      {(expression === 'happy' || expression === 'grin' || expression === 'cheer') && (
        <g fill="rgba(255,90,140,.35)">
          <ellipse cx="30" cy="54" rx="4" ry="2.4" />
          <ellipse cx="70" cy="54" rx="4" ry="2.4" />
        </g>
      )}
      <Hat hat={hat} />
    </svg>
  );
});
