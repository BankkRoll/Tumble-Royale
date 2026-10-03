/**
 * Candy-sticker SVG icon set used by the menus instead of emoji: tab icons,
 * challenge-type illustrations, mode tiles and small UI glyphs. Every icon is
 * a 24×24 drawing with the ink outline, so they sit on any panel colour.
 */
import type { JSX } from 'react';

/** Icon ids. */
export type IconName =
  | 'play'
  | 'locker'
  | 'store'
  | 'pass'
  | 'challenges'
  | 'profile'
  | 'ranks'
  | 'news'
  | 'bell'
  | 'friends'
  | 'gear'
  | 'globe'
  | 'bot'
  | 'key'
  | 'crown'
  | 'flag'
  | 'swirl'
  | 'team'
  | 'target'
  | 'brain'
  | 'jump'
  | 'dive'
  | 'grab'
  | 'bounce'
  | 'checkpoint'
  | 'emote'
  | 'ticket'
  | 'medal'
  | 'star'
  | 'swap'
  | 'lock'
  | 'check'
  | 'clock'
  | 'gift'
  | 'party'
  | 'plus'
  | 'chevron-left'
  | 'chevron-right'
  | 'close'
  | 'refresh'
  | 'fire'
  | 'stopwatch'
  | 'calendar'
  | 'hourglass'
  | 'home'
  | 'camera'
  | 'copy'
  | 'monitor'
  | 'gamepad'
  | 'speaker'
  | 'eye'
  | 'dice'
  | 'access'
  | 'megaphone';

const INK = 'currentColor';
const S = {
  stroke: INK,
  strokeWidth: 1.8,
  strokeLinejoin: 'round' as const,
  strokeLinecap: 'round' as const,
};

function paths(name: IconName): JSX.Element {
  switch (name) {
    case 'play':
      return <path d="M7 4.5v15l12.5-7.5z" fill="#ff4f9a" {...S} />;
    case 'locker':
      return (
        <>
          <path d="M8 4.5 12 7l4-2.5 4.5 3-2 4-2-1V20h-9v-9.5l-2 1-2-4z" fill="#5aa9ff" {...S} />
          <path d="M10 4.8c.5 1.4 1.2 2.2 2 2.2s1.5-.8 2-2.2" fill="none" {...S} />
        </>
      );
    case 'store':
      return (
        <>
          <path d="M5 8.5h14l-1.2 11.5H6.2z" fill="#ffd23f" {...S} />
          <path d="M9 10V7a3 3 0 0 1 6 0v3" fill="none" {...S} />
        </>
      );
    case 'pass':
    case 'star':
      return (
        <path
          d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z"
          fill="#ffd23f"
          {...S}
        />
      );
    case 'challenges':
    case 'target':
      return (
        <>
          <circle cx="12" cy="12" r="8.5" fill="#ff4f9a" {...S} />
          <circle cx="12" cy="12" r="5" fill="#fff" {...S} />
          <circle cx="12" cy="12" r="1.8" fill="#ff4f9a" {...S} />
        </>
      );
    case 'profile':
      return (
        <>
          <path d="M6 20c0-6 1.5-14 6-14s6 8 6 14z" fill="#3ee6b4" {...S} />
          <ellipse cx="12" cy="11.5" rx="3.3" ry="2.6" fill="#fff7ea" {...S} />
          <circle cx="10.8" cy="11.4" r=".7" fill={INK} />
          <circle cx="13.2" cy="11.4" r=".7" fill={INK} />
        </>
      );
    case 'ranks':
      return (
        <>
          <path d="M7 4h10v4a5 5 0 0 1-10 0z" fill="#ffb021" {...S} />
          <path d="M7 6H4.5a3 3 0 0 0 3 4M17 6h2.5a3 3 0 0 1-3 4" fill="none" {...S} />
          <path d="M10 13.5h4l.5 3.5h-5zM8 20h8v-3H8z" fill="#ffd23f" {...S} />
        </>
      );
    case 'news':
      return (
        <>
          <rect x="4" y="5" width="16" height="14" rx="2.5" fill="#fff" {...S} />
          <rect x="7" y="8" width="5" height="4" rx="1" fill="#5aa9ff" {...S} />
          <path d="M14.5 8.5H17M14.5 11.5H17M7 15h10" fill="none" {...S} />
        </>
      );
    case 'bell':
      return (
        <>
          <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" fill="#ffd23f" {...S} />
          <path d="M10 20.5a2 2 0 0 0 4 0" fill="none" {...S} />
        </>
      );
    case 'friends':
    case 'party':
      return (
        <>
          <path d="M3.5 19c0-4 1-9.5 4.5-9.5s4.5 5.5 4.5 9.5z" fill="#5aa9ff" {...S} />
          <path d="M11.5 19c0-4.5 1.2-11 5-11s5 6.5 5 11z" fill="#ff4f9a" {...S} />
          <circle cx="16.5" cy="12.5" r="1.6" fill="#fff7ea" {...S} />
          <circle cx="8" cy="13.5" r="1.4" fill="#fff7ea" {...S} />
        </>
      );
    case 'gear':
      return (
        <>
          <path
            d="M12 3.5l1.6 2.2 2.6-.7.6 2.7 2.6 1-1 2.5 1.6 2.2-2.2 1.6.3 2.7-2.7.1-1.2 2.4-2.6-1.2-2.6 1.2-1.2-2.4-2.7-.1.3-2.7L3.6 12.8l1.6-2.2-1-2.5 2.6-1 .6-2.7 2.6.7z"
            fill="#c7b8ff"
            {...S}
          />
          <circle cx="12" cy="12" r="3" fill="#fff" {...S} />
        </>
      );
    case 'globe':
      return (
        <>
          <circle cx="12" cy="12" r="8.5" fill="#5aa9ff" {...S} />
          <path
            d="M5.5 9.5c2.5 1 3 2.5 5 2 2-.4 1-3 3-3.6M9 20c.5-2.5 2-3 3.5-3.5 1.6-.6 1-2.6 3-3 1.5-.3 3 .3 4 1.3"
            fill="none"
            stroke="#3ee6b4"
            strokeWidth={2.2}
            strokeLinecap="round"
          />
          <circle cx="12" cy="12" r="8.5" fill="none" {...S} />
        </>
      );
    case 'bot':
      return (
        <>
          <rect x="5" y="8" width="14" height="11" rx="4" fill="#c7b8ff" {...S} />
          <path d="M12 8V5" fill="none" {...S} />
          <circle cx="12" cy="4.3" r="1.4" fill="#ff4f9a" {...S} />
          <circle cx="9.3" cy="13" r="1.6" fill="#fff" {...S} />
          <circle cx="14.7" cy="13" r="1.6" fill="#fff" {...S} />
          <path d="M10 16.5h4" fill="none" {...S} />
        </>
      );
    case 'key':
      return (
        <>
          <circle cx="8" cy="12" r="4.5" fill="#ffd23f" {...S} />
          <circle cx="8" cy="12" r="1.5" fill="#fff" {...S} />
          <path d="M12.5 12H20l0 3M17 12v2.5" fill="none" {...S} />
        </>
      );
    case 'crown':
      return <path d="M4 17.5 3 7.5l5 4 4-6 4 6 5-4-1 10z" fill="#ffd23f" {...S} />;
    case 'flag':
      return (
        <>
          <path d="M6 21V4" fill="none" {...S} />
          <path d="M6 4.5h12l-2.5 4 2.5 4H6z" fill="#ff8a3d" {...S} />
          <path d="M9 4.5v8M12 4.5v8" stroke="#fff" strokeWidth={1.4} />
          <path d="M6 4.5h12l-2.5 4 2.5 4H6z" fill="none" {...S} />
        </>
      );
    case 'swirl':
    case 'hourglass':
      return (
        <>
          <path d="M6.5 3.5h11M6.5 20.5h11" fill="none" {...S} />
          <path
            d="M7.5 3.5c0 5 4.5 6 4.5 8.5S7.5 15.5 7.5 20.5h9c0-5-4.5-6-4.5-8.5s4.5-3.5 4.5-8.5z"
            fill="#8a5cff"
            {...S}
          />
          <path d="M9.5 18.5h5c-.5-2-2.5-3-2.5-3s-2 1-2.5 3z" fill="#ffd23f" />
        </>
      );
    case 'team':
      return (
        <>
          <path d="M3 18c0-4 1.3-9 4-9s4 5 4 9z" fill="#5aa9ff" {...S} />
          <path d="M13 18c0-4 1.3-9 4-9s4 5 4 9z" fill="#5aa9ff" {...S} />
          <path d="M8 18c0-5 1.6-11 4-11s4 6 4 11z" fill="#3ee6b4" {...S} />
        </>
      );
    case 'brain':
      return (
        <>
          <path
            d="M12 5.5c-1.5-2-5-1.5-5.2 1.2-2.6.3-3.2 3.5-1.6 5-1.5 2 .2 5 2.6 4.6.4 2.4 3.4 3 4.2 1.2.8 1.8 3.8 1.2 4.2-1.2 2.4.4 4.1-2.6 2.6-4.6 1.6-1.5 1-4.7-1.6-5C17 4 13.5 3.5 12 5.5z"
            fill="#3ec7c7"
            {...S}
          />
          <path d="M12 5.5V18" fill="none" {...S} />
        </>
      );
    case 'jump':
      return (
        <>
          <path d="M8 15c0-4 1.6-9 4-9s4 5 4 9z" fill="#ff8a3d" {...S} />
          <path d="M6 20.5h12M9 18l-1.5 1.5M15 18l1.5 1.5" fill="none" {...S} />
          <path d="M12 2.5v1.5M7.5 4l1 1M16.5 4l-1 1" fill="none" {...S} />
        </>
      );
    case 'dive':
      return (
        <>
          <path d="M4 15.5c3-5.5 9-8 15.5-7.5-1.5 4.5-7.5 9-15.5 7.5z" fill="#5aa9ff" {...S} />
          <path d="M3 19.5h4M9 19.5h3" fill="none" {...S} />
        </>
      );
    case 'grab':
      return (
        <path
          d="M7 12V7.5a1.5 1.5 0 0 1 3 0V11V6a1.5 1.5 0 0 1 3 0v5V7a1.5 1.5 0 0 1 3 0v5.5V10a1.5 1.5 0 0 1 3 0v4.5c0 3.5-2.5 6-6 6h-1c-2.4 0-3.8-1-5-3l-2.4-3.8a1.5 1.5 0 0 1 2.4-1.7z"
          fill="#ffd6f2"
          {...S}
        />
      );
    case 'bounce':
      return (
        <>
          <ellipse cx="12" cy="17" rx="8" ry="3" fill="#8a5cff" {...S} />
          <circle cx="12" cy="8" r="3.5" fill="#ff4f9a" {...S} />
          <path d="M8 12.5l-1 1.5M16 12.5l1 1.5" fill="none" {...S} />
        </>
      );
    case 'checkpoint':
      return (
        <>
          <path d="M12 21v-8" fill="none" {...S} />
          <path
            d="M12 3c-3.3 0-6 2.5-6 5.6 0 3.6 6 9.4 6 9.4s6-5.8 6-9.4C18 5.5 15.3 3 12 3z"
            fill="#3ee6b4"
            {...S}
          />
          <circle cx="12" cy="8.5" r="2.2" fill="#fff" {...S} />
        </>
      );
    case 'emote':
      return (
        <>
          <circle cx="12" cy="12" r="8.5" fill="#ffd23f" {...S} />
          <path d="M8 13.5c1 2 2.4 3 4 3s3-1 4-3z" fill="#ff4f9a" {...S} />
          <path d="M8.5 9.5l1.2-1.2 1.2 1.2M13.1 9.5l1.2-1.2 1.2 1.2" fill="none" {...S} />
        </>
      );
    case 'ticket':
      return <path d="M3.5 7.5h17v3a1.8 1.8 0 0 0 0 3v3h-17v-3a1.8 1.8 0 0 0 0-3z" fill="#ff4f9a" {...S} />;
    case 'medal':
      return (
        <>
          <path d="M8 3.5h3l1 5-3 1zM16 3.5h-3l-1 5 3 1z" fill="#5aa9ff" {...S} />
          <circle cx="12" cy="15" r="5.5" fill="#ffd23f" {...S} />
          <path d="m12 12.3.9 1.8 2 .3-1.4 1.4.3 2-1.8-.9-1.8.9.3-2-1.4-1.4 2-.3z" fill="#fff" />
        </>
      );
    case 'swap':
    case 'refresh':
      return (
        <>
          <path d="M5 10a7 7 0 0 1 12.5-3.5M19 14a7 7 0 0 1-12.5 3.5" fill="none" {...S} strokeWidth={2.2} />
          <path d="M18.5 3.5v3.5H15M5.5 20.5V17H9" fill="none" {...S} strokeWidth={2.2} />
        </>
      );
    case 'lock':
      return (
        <>
          <rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5" fill="#c7b8ff" {...S} />
          <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" {...S} />
        </>
      );
    case 'check':
      return <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" {...S} strokeWidth={3} />;
    case 'clock':
    case 'stopwatch':
      return (
        <>
          <circle cx="12" cy="13" r="7.5" fill="#fff" {...S} />
          <path d="M12 9v4l2.5 2M10 3h4" fill="none" {...S} />
        </>
      );
    case 'calendar':
      return (
        <>
          <rect x="4" y="5.5" width="16" height="14" rx="2.5" fill="#fff" {...S} />
          <path d="M4 9.5h16" fill="none" {...S} />
          <path d="M8 3.5v3.5M16 3.5v3.5" fill="none" {...S} />
          <rect x="7.5" y="12" width="3" height="3" rx=".6" fill="#ff4f9a" />
        </>
      );
    case 'gift':
      return (
        <>
          <rect x="4" y="9" width="16" height="11" rx="2" fill="#ff4f9a" {...S} />
          <rect x="3" y="7" width="18" height="4" rx="1.4" fill="#ff8ac0" {...S} />
          <path d="M12 7v13" stroke="#ffd23f" strokeWidth={2.4} />
          <path d="M12 7c-1.5-3-5-3.5-5-1.5S10 7 12 7c2 0 5-1 5-1.5S13.5 4 12 7z" fill="#ffd23f" {...S} />
        </>
      );
    case 'fire':
      return (
        <path
          d="M12 21c-4 0-6.5-2.6-6.5-6 0-4 3.5-5.5 3.5-9.5 3 1.5 4 4 4 5.5 1-1 1.5-2 1.5-3.5 2.5 2 4 4.6 4 7.5 0 3.4-2.5 6-6.5 6z"
          fill="#ff8a3d"
          {...S}
        />
      );
    case 'plus':
      return <path d="M12 5v14M5 12h14" fill="none" {...S} strokeWidth={3} />;
    case 'chevron-left':
      return <path d="m15 5-7 7 7 7" fill="none" {...S} strokeWidth={3} />;
    case 'chevron-right':
      return <path d="m9 5 7 7-7 7" fill="none" {...S} strokeWidth={3} />;
    case 'home':
      return (
        <>
          <path d="M4 11.5 12 4l8 7.5V20h-5.5v-5h-5v5H4z" fill="#ffd23f" {...S} />
        </>
      );
    case 'camera':
      return (
        <>
          <path d="M4 8.5h3.5L9 6h6l1.5 2.5H20V19H4z" fill="#5aa9ff" {...S} />
          <circle cx="12" cy="13.5" r="3.3" fill="#fff" {...S} />
        </>
      );
    case 'copy':
      return (
        <>
          <rect x="8" y="8" width="11" height="12" rx="2" fill="#fff" {...S} />
          <path d="M5 15.5V6a2 2 0 0 1 2-2h8" fill="none" {...S} />
        </>
      );
    case 'monitor':
      return (
        <>
          <rect x="3.5" y="5" width="17" height="11" rx="2" fill="#5aa9ff" {...S} />
          <path d="M9 20h6M12 16v4" fill="none" {...S} />
        </>
      );
    case 'gamepad':
      return (
        <>
          <path
            d="M7 8h10c2.8 0 4 4 4 7.5 0 2.3-2 2.8-3.3 1.4L15.5 15h-7l-2.2 1.9C5 18.3 3 17.8 3 15.5 3 12 4.2 8 7 8z"
            fill="#c7b8ff"
            {...S}
          />
          <path d="M8 10.5v3M6.5 12h3" fill="none" {...S} />
          <circle cx="15.5" cy="11" r=".9" fill={INK} />
          <circle cx="17" cy="13" r=".9" fill={INK} />
        </>
      );
    case 'speaker':
      return (
        <>
          <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="#3ee6b4" {...S} />
          <path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" {...S} />
        </>
      );
    case 'eye':
      return (
        <>
          <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="#fff" {...S} />
          <circle cx="12" cy="12" r="3.2" fill="#5aa9ff" {...S} />
        </>
      );
    case 'dice':
      return (
        <>
          <rect x="4" y="4" width="16" height="16" rx="3.5" fill="#fff" {...S} />
          <circle cx="8.5" cy="8.5" r="1.3" fill="#ff4f9a" />
          <circle cx="12" cy="12" r="1.3" fill="#ff4f9a" />
          <circle cx="15.5" cy="15.5" r="1.3" fill="#ff4f9a" />
        </>
      );
    case 'access':
      return (
        <>
          <circle cx="12" cy="12" r="8.5" fill="#5aa9ff" {...S} />
          <circle cx="12" cy="7.6" r="1.4" fill="#fff" />
          <path
            d="M7.5 10.2 12 11l4.5-.8M12 11v3l-2 3.5M12 14l2 3.5"
            fill="none"
            stroke="#fff"
            strokeWidth={1.8}
            strokeLinecap="round"
          />
        </>
      );
    case 'megaphone':
      return (
        <>
          <path d="M4 10v4h3l9 4.5v-13L7 10z" fill="#ff8a3d" {...S} />
          <path d="M7 14l1.5 5h2.5L10 15" fill="#fff" {...S} />
        </>
      );
    case 'close':
      return <path d="M6 6l12 12M18 6 6 18" fill="none" {...S} strokeWidth={3} />;
  }
}

/** Props for {@link Icon}. */
export interface IconProps {
  name: IconName;
  /** CSS size (default `1.4em`). */
  size?: string;
  className?: string;
  /** Accessible label; decorative (aria-hidden) when omitted. */
  title?: string;
}

/**
 * One sticker icon.
 *
 * @example <Icon name="crown" size="2em" />
 */
export function Icon({ name, size = '1em', className, title }: IconProps): JSX.Element {
  return (
    <svg
      className={`tr-icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {paths(name)}
    </svg>
  );
}

/** Illustrated icon for a challenge metric (falls back to the target). */
export function challengeIcon(metric: string | undefined): IconName {
  switch (metric) {
    case 'showsPlayed':
      return 'ticket';
    case 'roundsPlayed':
    case 'roundsQualified':
      return 'medal';
    case 'racesQualified':
      return 'flag';
    case 'survivalsQualified':
      return 'hourglass';
    case 'teamRoundsWon':
      return 'team';
    case 'huntRoundsQualified':
      return 'target';
    case 'logicRoundsQualified':
      return 'brain';
    case 'finalsReached':
    case 'crowns':
      return 'crown';
    case 'jumps':
      return 'jump';
    case 'dives':
      return 'dive';
    case 'grabs':
      return 'grab';
    case 'checkpoints':
      return 'checkpoint';
    case 'bounces':
      return 'bounce';
    case 'topTenFinishes':
      return 'star';
    case 'emotes':
      return 'emote';
    default:
      return 'target';
  }
}
