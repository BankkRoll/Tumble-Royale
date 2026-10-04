/**
 * Daily login streak card: the streak so far, a Claim button while today is
 * open, the 7-day ladder (day 7 is the big one) and when the streak breaks or
 * the next claim opens. Online accounts only; the API decides everything, the
 * card only emits `claimLoginStreak`.
 */
import { useEffect, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Button } from '../../components/controls.tsx';
import { GrantChip, grantText } from '../../components/GrantChip.tsx';
import { formatRemaining, useNow, useReducedMotion } from '../../components/hooks.ts';
import { Icon } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { useUI } from '../../store/uiStore.ts';
import type { LoginStreakData } from '../../store/types.ts';
import { confettiSets } from '../../theme/tokens.ts';
import { fireConfetti } from '../../transitions/Confetti.tsx';

/**
 * The status line under the title.
 *
 * @param s - Streak state.
 * @param now - Epoch ms.
 */
export function streakStatus(s: LoginStreakData, now: number): string {
  if (s.claimedToday) return `Next reward in ${formatRemaining(s.nextClaimAt - now)}`;
  if (s.breaksAt !== null) return `Claim within ${formatRemaining(s.breaksAt - now)} to keep your streak`;
  return 'Claim once a day. Miss a day and the streak starts over.';
}

/** The daily login card; renders nothing until the account has loaded it. */
export function LoginStreakCard(): JSX.Element | null {
  const s = useUI((st) => st.loginStreak);
  const now = useNow(1000);
  const reduce = useReducedMotion();
  const [pending, setPending] = useState(false);
  // A fresh state from the server (claimed, refused or a new day) ends the wait.
  useEffect(() => setPending(false), [s]);
  if (!s) return null;
  const title = s.streak > 0 ? `${s.streak}-day streak` : 'Start a streak';
  return (
    <section className="tr-panel tr-streak" data-testid="login-streak" aria-label="Daily login reward">
      <div className="tr-streak-head">
        <span className={`tr-streak-flame${s.streak > 0 ? ' is-lit' : ''}`} aria-hidden>
          <Icon name="fire" size="2.2em" />
        </span>
        <div className="tr-col tr-grow" style={{ gap: '0.15em', minWidth: 0 }}>
          <span className="tr-label">Daily login</span>
          <b className="tr-title tr-h3">{title}</b>
          <small className="tr-muted" data-testid="streak-status">
            {streakStatus(s, now)}
            {s.best > 1 && ` · Best ${s.best}`}
          </small>
        </div>
        {s.canClaim ? (
          <Button
            size="sm"
            variant="mint"
            cue={null}
            className="tr-streak-claim"
            data-testid="streak-claim"
            disabled={pending}
            aria-label={`Claim day ${s.next.day}: ${s.next.rewards.map(grantText).join(', ')}`}
            onClick={(e) => {
              if (pending) return;
              setPending(true);
              playCue('ui.claim');
              if (!reduce) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                fireConfetti({
                  x: (r.left + r.width / 2) / window.innerWidth,
                  y: r.top / window.innerHeight,
                  count: s.next.day === 7 ? 120 : 50,
                  spread: 45,
                  speed: 700,
                  colors: confettiSets.candy,
                });
              }
              uiEvents.emit('claimLoginStreak');
            }}
          >
            Claim day {s.next.day}
          </Button>
        ) : (
          <span className="tr-ch-stamp">
            <Icon name="check" size="1em" /> Claimed
          </span>
        )}
      </div>
      <ol className="tr-streak-ladder" aria-label="This week's rewards">
        {s.ladder.map((d) => (
          <li
            key={d.day}
            className={`tr-streak-day is-${d.state}${d.day === s.ladder.length ? ' is-big' : ''}`}
            aria-label={`Day ${d.day}, ${d.state === 'claimed' ? 'claimed' : d.state === 'today' ? 'ready today' : 'upcoming'}: ${d.rewards.map(grantText).join(', ')}`}
          >
            <span className="tr-streak-day-n">
              {d.state === 'claimed' ? <Icon name="check" size="0.9em" /> : null}Day {d.day}
            </span>
            <span className="tr-streak-day-rewards">
              {d.rewards.map((g, i) => (
                <GrantChip key={i} grant={g} compact />
              ))}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
