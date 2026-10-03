/**
 * Line icons for the tutorial overlay (checklist, objective card, rewards).
 * Simple inline SVG so the overlay never depends on emoji fonts.
 */
import type { JSX } from 'react';

/** Icon names the tutorial uses. */
export type TutorialIconName =
  | 'move'
  | 'jump'
  | 'dive'
  | 'grab'
  | 'climb'
  | 'bounce'
  | 'tiles'
  | 'checkpoint'
  | 'race'
  | 'done'
  | 'nameplate'
  | 'crown';

const PATHS: Record<TutorialIconName, JSX.Element> = {
  move: (
    <>
      <path d="M4 12h12" />
      <path d="M12 6l6 6-6 6" />
    </>
  ),
  jump: (
    <>
      <path d="M4 18c3-9 9-12 16-12" />
      <path d="M15 4l5 2-2 5" />
      <path d="M3 21h6" />
    </>
  ),
  dive: (
    <>
      <path d="M3 16c4-7 9-9 18-8" />
      <path d="M17 5l4 3-3 4" />
      <path d="M5 21h14" strokeDasharray="2 3" />
    </>
  ),
  grab: (
    <>
      <path d="M7 12V7a1.5 1.5 0 013 0v4" />
      <path d="M10 10V5.5a1.5 1.5 0 013 0V10" />
      <path d="M13 10V7a1.5 1.5 0 013 0v6c0 4-2.5 7-6 7s-5-2-6-4l-1.5-3a1.5 1.5 0 012.6-1.5L7 14" />
    </>
  ),
  climb: (
    <>
      <path d="M4 21V9h8V3h8" />
      <path d="M9 9l3-3" />
      <circle cx="16" cy="9.5" r="1.6" />
    </>
  ),
  bounce: (
    <>
      <ellipse cx="12" cy="18" rx="7" ry="2.5" />
      <path d="M12 14V4" />
      <path d="M8.5 7.5L12 4l3.5 3.5" />
    </>
  ),
  tiles: (
    <>
      <rect x="3" y="4" width="7" height="7" rx="1.2" />
      <rect x="14" y="4" width="7" height="7" rx="1.2" />
      <rect x="3" y="14" width="7" height="6" rx="1.2" />
      <path d="M15 15l2 3 2-3" />
    </>
  ),
  checkpoint: (
    <>
      <path d="M6 21V3" />
      <path d="M6 4h11l-2.5 4L17 12H6" />
    </>
  ),
  race: (
    <>
      <path d="M5 21V3" />
      <path d="M5 4h14v9H5" />
      <path d="M9 4v9M13 4v9M17 4v9M5 8.5h14" strokeWidth="1.4" />
    </>
  ),
  done: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  nameplate: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="5" />
      <path d="M8 12h8" />
    </>
  ),
  crown: <path d="M4 18l-1-10 5 4 4-6 4 6 5-4-1 10z" />,
};

/**
 * One tutorial icon, sized to the surrounding text (`1em`).
 *
 * @example
 * <TutorialIcon name="jump" />
 */
export function TutorialIcon({ name, className }: { name: TutorialIconName; className?: string }): JSX.Element {
  return (
    <svg
      className={`tt-icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}
