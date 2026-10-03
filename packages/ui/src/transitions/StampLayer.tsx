/**
 * Stamp Slam layer: giant sticker words (QUALIFIED!, ELIMINATED, GO!, …) that
 * slam onto the screen with an impact shake, hold, then pop away. Stamps are
 * queued in the store and shown one at a time.
 */
import { useEffect, useMemo, useRef, type JSX } from 'react';
import { playCue, type UICueName } from '../audio-cues.ts';
import { ui, useUI } from '../store/uiStore.ts';
import type { StampEntry, StampKind } from '../store/types.ts';
import { prefersReducedMotion, screenShake } from '../theme/motion.ts';
import { confettiSets } from '../theme/tokens.ts';
import { fireConfetti } from './Confetti.tsx';

interface StampStyle {
  text: string;
  /** CSS colour class modifier. */
  tone: 'mint' | 'pink' | 'cream' | 'lemon' | 'grape' | 'tangerine';
  holdMs: number;
  tilt: number;
  cue: UICueName;
}

const STAMPS: Record<StampKind, StampStyle> = {
  qualified: { text: 'QUALIFIED!', tone: 'mint', holdMs: 1500, tilt: -4, cue: 'ui.stamp.qualified' },
  eliminated: { text: 'ELIMINATED', tone: 'pink', holdMs: 1900, tilt: -9, cue: 'ui.stamp.eliminated' },
  roundOver: { text: 'ROUND OVER!', tone: 'cream', holdMs: 1300, tilt: -3, cue: 'ui.stamp.roundOver' },
  timeUp: { text: "TIME'S UP!", tone: 'tangerine', holdMs: 1300, tilt: 3, cue: 'ui.stamp.timeUp' },
  go: { text: 'GO!', tone: 'lemon', holdMs: 450, tilt: -6, cue: 'ui.countdown.go' },
  overtime: { text: 'OVERTIME!', tone: 'tangerine', holdMs: 1000, tilt: 4, cue: 'ui.stamp.overtime' },
  final: { text: 'FINAL ROUND!', tone: 'lemon', holdMs: 1500, tilt: -4, cue: 'ui.stamp.final' },
  victory: { text: 'VICTORY!', tone: 'lemon', holdMs: 1800, tilt: -5, cue: 'ui.stamp.victory' },
  teamWin: { text: 'TEAM WINS!', tone: 'mint', holdMs: 1400, tilt: -4, cue: 'ui.stamp.teamWin' },
  teamLose: { text: 'TEAM OUT!', tone: 'grape', holdMs: 1400, tilt: 4, cue: 'ui.stamp.teamLose' },
};

/** Consolation lines under ELIMINATED. */
export const CONSOLATION_LINES: readonly string[] = [
  'Gravity: 1 · You: 0',
  'That was a strategic nap.',
  'Tumbled with style.',
  'The floor was very welcoming.',
  'Physics sends its regards.',
  'You were robbed. Probably.',
  'Next show is yours. Probably.',
];

function Stamp({ stamp }: { stamp: StampEntry }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const style = STAMPS[stamp.kind];
  const text = stamp.text ?? style.text;
  const sub = useMemo(
    () =>
      stamp.sub ??
      (stamp.kind === 'eliminated'
        ? CONSOLATION_LINES[Math.floor(Math.random() * CONSOLATION_LINES.length)]
        : undefined),
    [stamp],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = prefersReducedMotion();
    const tilt = style.tilt;
    let impactTimer = 0;
    const slam = reduce
      ? el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill: 'both' })
      : el.animate(
          [
            { transform: `scale(2.6) rotate(${tilt - 10}deg)`, opacity: 0 },
            { transform: `scale(0.92) rotate(${tilt}deg)`, opacity: 1, offset: 0.55 },
            { transform: `scale(1.04) rotate(${tilt}deg)`, opacity: 1, offset: 0.8 },
            { transform: `scale(1) rotate(${tilt}deg)`, opacity: 1 },
          ],
          { duration: 360, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'both' },
        );
    impactTimer = window.setTimeout(
      () => {
        playCue('ui.stamp');
        playCue(style.cue);
        const root = el.closest('.tr-stage');
        if (root) screenShake(root, stamp.kind === 'eliminated' ? 9 : 6);
        if (stamp.kind === 'qualified' || stamp.kind === 'teamWin')
          fireConfetti({
            x: 0.5,
            y: 0.45,
            ring: true,
            count: 110,
            speed: 900,
            colors: confettiSets.qualified,
          });
        if (stamp.kind === 'go')
          fireConfetti({
            x: 0.5,
            y: 0.5,
            ring: true,
            count: 80,
            speed: 1100,
            colors: confettiSets.candy,
            silent: true,
          });
        if (stamp.kind === 'victory')
          fireConfetti({ x: 0.5, y: 0.6, count: 200, colors: confettiSets.victory });
      },
      reduce ? 0 : 200,
    );

    const total = 360 + style.holdMs;
    const exitTimer = window.setTimeout(() => {
      const out = reduce
        ? el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' })
        : el.animate(
            [
              { transform: `scale(1) rotate(${tilt}deg)`, opacity: 1 },
              { transform: `scale(1.08) rotate(${tilt}deg)`, opacity: 1, offset: 0.3 },
              { transform: `scale(0) rotate(${tilt + 12}deg)`, opacity: 0 },
            ],
            { duration: 260, easing: 'cubic-bezier(.36,0,.66,-.56)', fill: 'forwards' },
          );
      out.finished.then(
        () => ui.getState().dismissStamp(stamp.id),
        () => ui.getState().dismissStamp(stamp.id),
      );
    }, total);

    return () => {
      slam.cancel();
      window.clearTimeout(impactTimer);
      window.clearTimeout(exitTimer);
    };
  }, [stamp, style]);

  return (
    <div className="tr-stamp-wrap">
      <div ref={ref} className={`tr-stamp tr-stamp--${style.tone} tr-stamp--${stamp.kind}`}>
        <div className="tr-stamp-text" aria-live="assertive">
          {text.split('').map((ch, i) => (
            <span key={i} className={stamp.kind === 'eliminated' && i === 2 ? 'tr-stamp-fall' : undefined}>
              {ch === ' ' ? ' ' : ch}
            </span>
          ))}
        </div>
        {sub && <div className="tr-stamp-sub">{sub}</div>}
        <div className="tr-stamp-ring" aria-hidden />
      </div>
    </div>
  );
}

/** Shows the head of the stamp queue. */
export function StampLayer(): JSX.Element | null {
  const head = useUI((s) => s.stamps[0]);
  if (!head) return null;
  return (
    <div className="tr-stamps" aria-hidden={false}>
      <Stamp key={head.id} stamp={head} />
    </div>
  );
}
