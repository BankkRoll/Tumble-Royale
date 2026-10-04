/**
 * What the held Tumble Wipe shows while a round (or the tutorial island)
 * loads underneath it: round type and name, the objective, a slim progress
 * bar, a rotating tip and, online, who the round is still waiting for.
 *
 * PERF: the round build owns the main thread while this is up, so nothing
 * here animates through React. The bar is a scaled fill with a CSS
 * transition (the session throttles progress to ≤ 4 Hz and the transition
 * interpolates in between), tips cross-fade with WAAPI opacity, and each
 * part subscribes only to the store fields it draws, so a progress tick
 * re-renders the bar alone.
 */
import { useEffect, useRef, type JSX } from 'react';
import { TypeBadge } from '../components/bits.tsx';
import { useDisplayName } from '../components/hooks.ts';
import { Icon } from '../components/icons/index.tsx';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { useUI } from '../store/uiStore.ts';

/** Players shown by name while waiting (the protocol caps the roster at 8 too). */
export const MAX_WAITING_SHOWN = 8;
/** How long each loading tip stays up (ms). */
const LOADING_TIP_MS = 4000;

/**
 * Cycles tips with compositor-only opacity animations (WAAPI), so the
 * carousel keeps moving while the main thread builds a round and React never
 * re-renders for it.
 */
function CompositorTips({ tips, intervalMs }: { tips: readonly string[]; intervalMs: number }): JSX.Element {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const key = tips.join('\n');
  useEffect(() => {
    const n = tips.length;
    if (n < 2) return;
    const cycle = n * intervalMs;
    const share = 1 / n;
    const fade = Math.min(0.25, 350 / cycle);
    const anims: Animation[] = [];
    refs.current.forEach((el, i) => {
      if (!el || typeof el.animate !== 'function') return;
      anims.push(
        el.animate(
          [
            { opacity: 0, offset: 0 },
            { opacity: 1, offset: fade },
            { opacity: 1, offset: share - fade },
            { opacity: 0, offset: share },
            { opacity: 0, offset: 1 },
          ],
          { duration: cycle, delay: i * intervalMs, iterations: Infinity, fill: 'backwards' },
        ),
      );
    });
    return () => {
      for (const a of anims) a.cancel();
    };
    // Keyed on the text: a new array holding the same tips must not restart the cycle.
  }, [key, intervalMs]);
  return (
    <div className="tr-loading-tips" aria-live="off">
      {tips.map((tip, i) => (
        <div
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="tr-loading-tip"
          style={{ opacity: tips.length < 2 || i === 0 ? 1 : 0 }}
        >
          <Icon name="star" size="1em" />
          <span>{tip}</span>
        </div>
      ))}
    </div>
  );
}

/** This machine's build progress; an indeterminate shimmer when the load reports none (tutorial). */
function LoadingBar(): JSX.Element | null {
  const known = useUI((s) => s.roundLoading !== null);
  const ready = useUI((s) => s.roundLoading?.ready ?? false);
  const progress = useUI((s) => Math.max(0, Math.min(1, s.roundLoading?.progress ?? 0)));
  if (!known)
    return (
      <div className="tr-loadcover-bar is-indeterminate" role="progressbar" aria-label="Loading">
        <i />
      </div>
    );
  const value = ready ? 1 : progress;
  return (
    <div
      className="tr-loadcover-bar"
      role="progressbar"
      aria-label="Loading the round"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
    >
      <i style={{ transform: `scaleX(${value})` }} />
    </div>
  );
}

/** Online, once this machine is ready: who the round still waits for, then "Everyone's in!". */
function LoadingWaiting(): JSX.Element | null {
  const ready = useUI((s) => s.roundLoading?.ready ?? false);
  return ready ? <WaitingRoster /> : null;
}

function WaitingRoster(): JSX.Element | null {
  const load = useUI((s) => s.roundLoading);
  const displayName = useDisplayName();
  if (!load) return null;
  if (load.everyoneIn)
    return (
      <div className="tr-loadcover-status is-go" aria-live="polite">
        Everyone&apos;s in!
      </div>
    );
  const waiting = load.waiting;
  const outstanding = Math.max(0, load.total - load.loaded);
  // The roster names at most 8; beyond that the count comes from loaded/total.
  const count = waiting.length < MAX_WAITING_SHOWN ? waiting.length : Math.max(waiting.length, outstanding);
  if (count === 0) return null;
  return (
    <div className="tr-loadcover-wait">
      <div className="tr-loadcover-status" aria-live="polite">
        Waiting for {count} player{count === 1 ? '' : 's'}…
      </div>
      {waiting.length > 0 && (
        <ul className="tr-loadcover-players" aria-label="Still loading">
          {waiting.slice(0, MAX_WAITING_SHOWN).map((p) => (
            <li key={p.id}>
              <TumblerAvatar colors={p.colors} expression="sleepy" size="1.5em" blink={false} noShadow />
              <span>{displayName(p)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The loading overlay. Rendered by the Tumble Wipe while it holds over a
 * `roundLoading` screen, and by that screen itself when Reduce Motion turns
 * the wipe into a fade.
 *
 * @param props.leaving - Fades out while the wipe reveals the round.
 * @returns The overlay, or null before the round is known.
 */
export function LoadingOverlay({ leaving = false }: { leaving?: boolean }): JSX.Element | null {
  const info = useUI((s) => s.roundIntro);
  if (!info) return null;
  return (
    <div className={`tr-loadcover${leaving ? ' is-leaving' : ''}`}>
      <div className="tr-loadcover-card">
        <TypeBadge type={info.type} />
        <h2 className="tr-title tr-loadcover-name">{info.name}</h2>
        {info.objective && <div className="tr-loadcover-objective">{info.objective}</div>}
        <LoadingBar />
        <LoadingWaiting />
      </div>
      {info.tips.length > 0 && <CompositorTips tips={info.tips} intervalMs={LOADING_TIP_MS} />}
    </div>
  );
}

/**
 * The `roundLoading` screen: a still candy-stripe backdrop matching the held
 * wipe. Normally the wipe covers it and draws the overlay itself; when Reduce
 * Motion turns the wipe into a fade (the wipe stays idle) this screen shows
 * the overlay instead.
 *
 * @returns The screen.
 */
export function LoadingCoverScreen(): JSX.Element {
  const wipeIdle = useUI((s) => s.wipe.phase === 'idle');
  return <div className="tr-screen tr-loadcover-screen">{wipeIdle && <LoadingOverlay />}</div>;
}
