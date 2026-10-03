/**
 * The signature "Tumble Wipe": skewed candy-stripe bands with gumdrop caps
 * pour up from the bottom in a springy cascade while a Tumbler cartwheels
 * across. The screen swaps while covered (the game swaps its 3D scene on
 * `transitionCovered`), then the bands keep rising off the top to reveal the
 * next screen, so the whole thing reads as one continuous sweep.
 *
 * PERF: every band is roughly one sixth of the viewport and only its
 * `transform` animates, so the browser rasterises each layer once and runs the
 * motion on the compositor. That keeps it smooth while the main thread is busy
 * building the next round's scene.
 */
import { useEffect, useRef, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { ui, useUI } from '../store/uiStore.ts';

const BANDS = ['#ff4f9a', '#ffd23f', '#3ee6b4', '#8a5cff', '#5aa9ff', '#ff8a3d'] as const;
const COVER_MS = 430;
const REVEAL_MS = 470;
const STAGGER_MS = 42;
const COVER_EASE = 'cubic-bezier(.3,1.35,.6,1)';
const REVEAL_EASE = 'cubic-bezier(.5,0,.75,.3)';

/** Total cover time (ms) for callers that want to sync with it. */
export const WIPE_COVER_TOTAL_MS = COVER_MS + STAGGER_MS * (BANDS.length - 1);
/** Total reveal time (ms). */
export const WIPE_REVEAL_TOTAL_MS = REVEAL_MS + STAGGER_MS * (BANDS.length - 1);

const BELOW = 'translate3d(0, 112%, 0)';
const COVERED = 'translate3d(0, 0, 0)';
const ABOVE = 'translate3d(0, -112%, 0)';

/**
 * Runs `fn` after two animation frames, so a newly swapped screen has painted
 * before motion starts; starting during the frame that mounts it drops frames.
 */
function afterPaint(fn: () => void): () => void {
  let id = requestAnimationFrame(() => {
    id = requestAnimationFrame(fn);
  });
  return () => cancelAnimationFrame(id);
}

/** Mounted once by `App`; driven by `ui.wipe`. */
export function TumbleWipe(): JSX.Element | null {
  const phase = useUI((s) => s.wipe.phase);
  const seq = useUI((s) => s.wipe.seq);
  const colors = useUI((s) => s.profile?.colors);
  const bandRefs = useRef<(HTMLDivElement | null)[]>([]);
  const runnerRef = useRef<HTMLDivElement>(null);
  const anims = useRef<Animation[]>([]);

  useEffect(() => {
    const bands = bandRefs.current.filter((b): b is HTMLDivElement => b !== null);
    if (bands.length === 0) return;
    for (const a of anims.current) a.cancel();
    anims.current = [];

    if (phase === 'covering') {
      for (const b of bands) b.style.transform = BELOW;
      let safety = 0;
      const cancelStart = afterPaint(() => {
        playCue('ui.whoosh');
        bands.forEach((b, i) => {
          anims.current.push(
            b.animate([{ transform: BELOW }, { transform: COVERED }], {
              duration: COVER_MS,
              delay: i * STAGGER_MS,
              easing: COVER_EASE,
              fill: 'forwards',
            }),
          );
        });
        const runner = runnerRef.current;
        if (runner) {
          anims.current.push(
            runner.animate(
              [
                { transform: 'translate3d(-25vw, 12vh, 0) rotate(0deg)' },
                { transform: 'translate3d(50vw, -14vh, 0) rotate(380deg)', offset: 0.55 },
                { transform: 'translate3d(125vw, 6vh, 0) rotate(720deg)' },
              ],
              { duration: 760, delay: 60, easing: 'cubic-bezier(.3,.1,.4,1)', fill: 'forwards' },
            ),
          );
        }
        anims.current[bands.length - 1]?.finished.then(
          () => ui.getState()._wipeCovered(),
          () => {},
        );
        // NOTE: background tabs can stall WAAPI; never leave the player stuck behind candy.
        safety = window.setTimeout(() => ui.getState()._wipeCovered(), WIPE_COVER_TOTAL_MS + 400);
      });
      return () => {
        cancelStart();
        window.clearTimeout(safety);
      };
    }

    if (phase === 'covered') {
      for (const b of bands) b.style.transform = COVERED;
      return;
    }

    if (phase === 'revealing') {
      for (const b of bands) b.style.transform = COVERED;
      let safety = 0;
      const cancelStart = afterPaint(() => {
        playCue('ui.whoosh');
        bands.forEach((b, i) => {
          anims.current.push(
            b.animate([{ transform: COVERED }, { transform: ABOVE }], {
              duration: REVEAL_MS,
              delay: i * STAGGER_MS,
              easing: REVEAL_EASE,
              fill: 'forwards',
            }),
          );
        });
        Promise.all(anims.current.map((a) => a.finished)).then(
          () => ui.getState()._wipeDone(),
          () => {},
        );
        safety = window.setTimeout(() => ui.getState()._wipeDone(), WIPE_REVEAL_TOTAL_MS + 400);
      });
      return () => {
        cancelStart();
        window.clearTimeout(safety);
      };
    }
  }, [phase, seq]);

  if (phase === 'idle') return null;
  return (
    <div className="tr-wipe" aria-hidden>
      <div className="tr-wipe-bands">
        {BANDS.map((c, i) => (
          <div
            key={c}
            ref={(el) => {
              bandRefs.current[i] = el;
            }}
            className="tr-wipe-band"
            style={{ background: c }}
          />
        ))}
      </div>
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
          <div className="tr-wipe-hold-card">
            <span className="tr-gumball-spinner" />
            <span className="tr-title tr-h3">Hang tight…</span>
          </div>
        </div>
      )}
    </div>
  );
}
