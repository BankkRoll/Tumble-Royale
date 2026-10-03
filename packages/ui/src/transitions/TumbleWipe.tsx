/**
 * The signature "Tumble Wipe": candy gumdrop blobs swallow the screen from the
 * bottom-left, a Tumbler cartwheels across, the screen swaps while covered
 * (the game swaps its 3D scene on `transitionCovered`), then the blobs fly off
 * to the top-right revealing the next screen.
 */
import { useEffect, useRef, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { ui, useUI } from '../store/uiStore.ts';

const BLOBS = ['#ff4f9a', '#ffd23f', '#3ee6b4', '#8a5cff', '#5aa9ff', '#ff8a3d', '#fff7ea'] as const;
const COVER_MS = 520;
const REVEAL_MS = 560;
const STAGGER_MS = 45;

/** Total cover time (ms) for callers that want to sync with it. */
export const WIPE_COVER_TOTAL_MS = COVER_MS + STAGGER_MS * (BLOBS.length - 1);
/** Total reveal time (ms). */
export const WIPE_REVEAL_TOTAL_MS = REVEAL_MS + STAGGER_MS * (BLOBS.length - 1);

/** Mounted once by `App`; driven by `ui.wipe`. */
export function TumbleWipe(): JSX.Element | null {
  const phase = useUI((s) => s.wipe.phase);
  const seq = useUI((s) => s.wipe.seq);
  const colors = useUI((s) => s.profile?.colors);
  const blobRefs = useRef<(HTMLDivElement | null)[]>([]);
  const runnerRef = useRef<HTMLDivElement>(null);
  const anims = useRef<Animation[]>([]);

  useEffect(() => {
    const blobs = blobRefs.current.filter((b): b is HTMLDivElement => b !== null);
    if (blobs.length === 0) return;
    for (const a of anims.current) a.cancel();
    anims.current = [];

    if (phase === 'covering') {
      playCue('ui.whoosh');
      blobs.forEach((b, i) => {
        const rot = 25 + i * 6;
        anims.current.push(
          b.animate(
            [
              { transform: 'translate(-50%, 50%) scale(0) rotate(0deg)' },
              { transform: `translate(-50%, 50%) scale(1) rotate(${rot}deg)` },
            ],
            {
              duration: COVER_MS,
              delay: i * STAGGER_MS,
              easing: 'cubic-bezier(.34,1.3,.64,1)',
              fill: 'both',
            },
          ),
        );
      });
      const runner = runnerRef.current;
      if (runner) {
        anims.current.push(
          runner.animate(
            [
              { transform: 'translate(-20vw, 10vh) rotate(0deg)', opacity: 1 },
              { transform: 'translate(55vw, -18vh) rotate(380deg)', opacity: 1, offset: 0.55 },
              { transform: 'translate(120vw, 6vh) rotate(720deg)', opacity: 1 },
            ],
            { duration: 820, delay: 120, easing: 'cubic-bezier(.3,.1,.4,1)', fill: 'both' },
          ),
        );
      }
      const last = anims.current[blobs.length - 1];
      last?.finished.then(
        () => ui.getState()._wipeCovered(),
        () => {},
      );
      // NOTE: background tabs can stall WAAPI; never leave the player stuck behind candy.
      const safety = window.setTimeout(() => ui.getState()._wipeCovered(), WIPE_COVER_TOTAL_MS + 400);
      return () => window.clearTimeout(safety);
    } else if (phase === 'covered') {
      for (const b of blobs) b.style.transform = 'translate(-50%, 50%) scale(1) rotate(30deg)';
    } else if (phase === 'revealing') {
      playCue('ui.whoosh');
      const n = blobs.length;
      blobs.forEach((b, i) => {
        const order = n - 1 - i;
        anims.current.push(
          b.animate(
            [
              { transform: 'translate(-50%, 50%) scale(1) rotate(30deg)' },
              { transform: 'translate(calc(-50% + 160vmax), calc(50% - 160vmax)) scale(0.35) rotate(60deg)' },
            ],
            {
              duration: REVEAL_MS,
              delay: order * STAGGER_MS,
              easing: 'cubic-bezier(.55,0,.75,.2)',
              fill: 'both',
            },
          ),
        );
      });
      Promise.all(anims.current.map((a) => a.finished)).then(
        () => ui.getState()._wipeDone(),
        () => {},
      );
      const safety = window.setTimeout(() => ui.getState()._wipeDone(), WIPE_REVEAL_TOTAL_MS + 400);
      return () => window.clearTimeout(safety);
    }
  }, [phase, seq]);

  if (phase === 'idle') return null;
  return (
    <div className="tr-wipe" aria-hidden>
      {BLOBS.map((c, i) => (
        <div
          key={c}
          ref={(el) => {
            blobRefs.current[i] = el;
          }}
          className="tr-wipe-blob"
          style={{ background: c, zIndex: i }}
        />
      ))}
      {phase === 'covering' && (
        <div ref={runnerRef} className="tr-wipe-runner">
          <TumblerAvatar
            colors={colors ?? { primary: '#ff4f9a', secondary: '#ffffff', pattern: 'dots' }}
            expression="cheer"
            size="7em"
            blink={false}
            noShadow
          />
        </div>
      )}
      {phase === 'covered' && (
        <div className="tr-wipe-hold">
          <span className="tr-gumball-spinner" />
          <span className="tr-title tr-h3">Hang tight…</span>
        </div>
      )}
    </div>
  );
}
