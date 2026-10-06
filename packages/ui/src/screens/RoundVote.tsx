/**
 * Between-rounds round vote (SCREENS.md §9.11a): the next round's ballot over
 * the results wall, live counts and countdown, the local pick highlighted,
 * then the winner reveal before the Tumble Wipe.
 *
 * Responsibilities:
 * - one card per candidate (thumbnail swatch, type badge, name, objective,
 *   live count), voted with a click/tap, Enter/A on the focused card, or the
 *   number keys 1–4;
 * - a polite screen-reader status that announces the ballot and its winner
 *   (never every tally tick);
 * - read-only for players who cannot vote (knocked out, spectators), who
 *   still watch the counts but never get their focus trapped by the card.
 */
import { memo, useEffect, useMemo, useState, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { TypeBadge } from '../components/bits.tsx';
import { Icon, type IconName } from '../components/icons/index.tsx';
import { uiEvents } from '../store/events.ts';
import { keyboardBusy } from '../store/inputOwnership.ts';
import { useUI } from '../store/uiStore.ts';
import type { RoundType, RoundVoteState } from '../store/types.ts';
import { roundTypeStyle } from '../theme/tokens.ts';

const TYPE_ICON: Record<RoundType, IconName> = {
  race: 'flag',
  survival: 'hourglass',
  team: 'team',
  hunt: 'target',
  logic: 'brain',
  final: 'crown',
};

/**
 * Whole seconds until `at` (epoch ms), ticking every 250 ms.
 *
 * @param at - Deadline, or null to stop ticking.
 * @returns Seconds left, or null when `at` is null.
 */
function useSecondsLeft(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * What a screen reader hears: the ballot when it opens, the winner when it
 * closes.
 *
 * @param vote - The ballot.
 * @returns One sentence.
 * @example
 * voteAnnouncement(vote); // "Vote for the next round: Tile Panic, Egg Heist or Tail Chase."
 */
export function voteAnnouncement(vote: RoundVoteState): string {
  if (vote.result) {
    const won = vote.options[vote.result.winner];
    if (!won) return '';
    const how = vote.result.reason === 'tie' ? ' (tie broken at random)' : '';
    return `Next round: ${won.name}${how}.`;
  }
  const names = vote.options.map((o) => o.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : (names[0] ?? '');
  return `${vote.isFinal ? 'Vote for the final' : 'Vote for the next round'}: ${list}.`;
}

/**
 * The line under the cards: how many voted, or why the winner won.
 *
 * @param vote - The ballot.
 * @returns Footer copy.
 */
export function voteFooter(vote: RoundVoteState): string {
  if (vote.result?.reason === 'tie') return 'A tie! The show picked one of the leaders at random.';
  if (vote.result?.reason === 'noVotes') return 'Nobody voted, so the show picked.';
  if (vote.result) return 'Most votes wins.';
  const tally = `${vote.voted} of ${vote.eligible} voted`;
  if (!vote.canVote) return `${tally} · only players still in the show can vote`;
  return vote.botsDiscounted ? `${tally} · bot votes count for less than yours` : tally;
}

/** The vote card over the results wall (nothing outside a ballot). */
export function RoundVoteLayer(): JSX.Element | null {
  const vote = useUI((s) => s.roundVote);
  const onResults = useUI((s) => s.screen === 'roundResults');
  if (!vote || !onResults) return null;
  return <RoundVoteCard vote={vote} />;
}

/** The ballot card. */
export const RoundVoteCard = memo(function RoundVoteCard({ vote }: { vote: RoundVoteState }): JSX.Element {
  const closed = vote.result !== null;
  const secs = useSecondsLeft(closed ? null : vote.closesAt);
  const total = vote.counts.reduce((a, b) => a + b, 0);
  const winner = vote.result?.winner ?? -1;
  const interactive = vote.canVote && !closed;
  const announcement = useMemo(() => voteAnnouncement(vote), [vote.result, vote.options, vote.isFinal]);

  useEffect(() => {
    if (closed) playCue('ui.stamp');
  }, [closed]);

  useEffect(() => {
    if (!interactive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || keyboardBusy(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const n = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1];
      if (!n) return;
      const option = Number(n) - 1;
      if (option >= vote.options.length) return;
      e.preventDefault();
      playCue('ui.confirm');
      uiEvents.emit('castVote', { roundIndex: vote.roundIndex, option });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interactive, vote.roundIndex, vote.options.length]);

  const title = closed ? 'Next up!' : vote.isFinal ? 'Vote for the final' : 'Vote for the next round';
  return (
    <section
      className={`tr-vote tr-interactive${closed ? ' is-closed' : ''}${vote.canVote ? '' : ' is-readonly'}`}
      // Only a player who can vote gets focus pulled to the ballot; everyone else keeps the results' controls.
      data-nav-scope={interactive ? '7' : undefined}
      aria-label={title}
      data-testid="round-vote"
    >
      <header className="tr-vote-head">
        <span className="tr-title tr-h3">{title}</span>
        {!closed && secs !== null && (
          <span className="tr-chip tr-chip--ink tr-vote-timer" aria-hidden data-testid="round-vote-timer">
            <Icon name="clock" size="0.9em" /> {secs}s
          </span>
        )}
      </header>
      <div className="tr-vote-cards" role="group" aria-label="Rounds">
        {vote.options.map((o, i) => {
          const count = vote.counts[i] ?? 0;
          const mine = vote.myVote === i;
          const won = i === winner;
          const share = total > 0 ? Math.round((count / total) * 100) : 0;
          const label = [
            `${o.name}, ${roundTypeStyle[o.type].label.toLowerCase()} round.`,
            /[.!?]$/.test(o.objective) ? o.objective : `${o.objective}.`,
            `${count} ${count === 1 ? 'vote' : 'votes'}.`,
            mine ? 'Your pick.' : '',
            won ? 'Winner.' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={o.roundId}
              type="button"
              className={`tr-vote-card${mine ? ' is-mine' : ''}${won ? ' is-winner' : ''}${closed && !won ? ' is-out' : ''}`}
              style={{
                ['--vote-a' as string]: o.colors[0],
                ['--vote-b' as string]: o.colors[1],
                ['--type' as string]: roundTypeStyle[o.type].color,
              }}
              data-nav=""
              data-autofocus={interactive && i === 0 ? '' : undefined}
              disabled={!interactive}
              aria-pressed={vote.canVote ? mine : undefined}
              aria-label={label}
              data-testid={`round-vote-option-${i}`}
              onClick={() => {
                playCue('ui.confirm');
                uiEvents.emit('castVote', { roundIndex: vote.roundIndex, option: i });
              }}
            >
              <span className="tr-vote-thumb" aria-hidden>
                <Icon name={TYPE_ICON[o.type]} size="1.8em" />
                {interactive && <span className="tr-vote-key">{i + 1}</span>}
              </span>
              <TypeBadge type={o.type} className="tr-vote-badge" />
              <span className="tr-vote-name tr-ellipsis">{o.name}</span>
              <span className="tr-vote-goal">{o.objective}</span>
              <span className="tr-vote-bar" aria-hidden>
                <span style={{ width: `${share}%` }} />
              </span>
              <span className="tr-vote-count" aria-hidden>
                {count} {count === 1 ? 'vote' : 'votes'}
              </span>
              {mine && (
                <span className="tr-vote-mine" aria-hidden>
                  <Icon name="check" size="0.85em" /> Your pick
                </span>
              )}
              {won && (
                <span className="tr-vote-won" aria-hidden>
                  <Icon name="crown" size="0.85em" /> Winner
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="tr-small tr-vote-foot" data-testid="round-vote-foot">
        {voteFooter(vote)}
      </p>
      <p className="tr-sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
});
