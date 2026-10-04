/**
 * Limited-time events: the Play tab tile (live event with "Ends in", or an
 * upcoming teaser with "Starts in") and the event screen inside the
 * Challenges tab (header art, points track with tier reward previews, event
 * challenges with claim buttons).
 *
 * Every claim is an intent for the game to send to the API; nothing here
 * decides what is earned. Offline (or signed out) the bundled events still
 * show so players know what is on, with a note that progress needs online
 * play. While operators have switched events off (`events.enabled`) the
 * screen says so and the tile disappears; during maintenance claims wait.
 */
import { useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Bar } from '../../components/bits.tsx';
import { Button, Segmented } from '../../components/controls.tsx';
import { GrantChip } from '../../components/GrantChip.tsx';
import { formatNumber, formatRemaining, useNow } from '../../components/hooks.ts';
import { Icon, challengeIcon, type IconName } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { featureOn } from '../../store/liveOps.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { EventsData, LiveEventView } from '../../store/types.ts';

const EVENT_ICONS: readonly IconName[] = ['star', 'gift', 'fire', 'calendar', 'crown', 'party', 'swirl'];

function eventIcon(icon: string): IconName {
  return (EVENT_ICONS as readonly string[]).includes(icon) ? (icon as IconName) : 'star';
}

/**
 * The countdown line for an event.
 *
 * @param e - The event.
 * @param now - Device clock (ms).
 * @example
 * eventCountdown({ phase: 'live', endsAt: now + 90_000, ... }, now); // 'Ends in 1:30'
 */
export function eventCountdown(e: Pick<LiveEventView, 'phase' | 'startsAt' | 'endsAt'>, now: number): string {
  if (e.phase === 'upcoming') return `Starts in ${formatRemaining(e.startsAt - now)}`;
  if (e.phase === 'live') return `Ends in ${formatRemaining(e.endsAt - now)}`;
  return 'Ended';
}

/**
 * The event to spotlight: the live one, else the next upcoming one, else the
 * most recently ended one.
 *
 * @param list - Events, earliest first.
 */
export function featuredEvent(list: readonly LiveEventView[]): LiveEventView | null {
  return (
    list.find((e) => e.phase === 'live') ??
    list.find((e) => e.phase === 'upcoming') ??
    [...list].reverse().find((e) => e.phase === 'ended') ??
    null
  );
}

/**
 * Rewards waiting to be claimed in an event (tiers plus challenges).
 *
 * @param e - The event.
 */
export function claimableCount(e: LiveEventView): number {
  return (
    e.tiers.filter((t) => t.state === 'claimable').length +
    e.challenges.filter((c) => !c.claimed && c.progress >= c.goal).length
  );
}

/** Points needed for the next tier, or null when the track is complete. */
function nextTier(e: LiveEventView): { tier: number; points: number } | null {
  const t = e.tiers.find((x) => e.points < x.points);
  return t ? { tier: t.tier, points: t.points } : null;
}

function useEventsOn(): boolean {
  const flags = useUI((s) => s.liveOps.flags);
  const data = useUI((s) => s.events);
  return featureOn(flags, 'events.enabled') && data?.enabled !== false;
}

/** Play tab tile; renders nothing without a live or upcoming event, or while events are off. */
export function EventCard(): JSX.Element | null {
  const data = useUI((s) => s.events);
  const on = useEventsOn();
  const now = useNow(1000);
  const e = data ? featuredEvent(data.list) : null;
  if (!data || !on || !e || e.phase === 'ended') return null;
  const next = nextTier(e);
  const ready = data.online ? claimableCount(e) : 0;
  return (
    <button
      type="button"
      className={`tr-info-card tr-event-card is-${e.phase} tr-enter-left`}
      style={{ ['--art-a' as string]: e.art[0], ['--art-b' as string]: e.art[1] }}
      data-nav=""
      data-testid="event-card"
      onClick={() => {
        playCue('ui.click');
        ui.getState().openEvents();
      }}
    >
      <span className="tr-info-card-head">
        <Icon name={eventIcon(e.icon)} />
        <span className="tr-label tr-grow">{e.phase === 'live' ? 'Live event' : 'Coming soon'}</span>
        <span className="tr-info-chip" data-testid="event-countdown">
          <Icon name="clock" size="0.9em" /> {eventCountdown(e, now)}
        </span>
      </span>
      <b className="tr-title tr-h3 tr-ellipsis">{e.name}</b>
      {e.phase === 'live' ? (
        <>
          <Bar
            value={next ? e.points / next.points : 1}
            color="var(--lemon)"
            label={`${e.name} points to the next tier`}
          />
          <small className="tr-muted">
            {next
              ? `${formatNumber(e.points)} / ${formatNumber(next.points)} points to tier ${next.tier}`
              : 'Every tier unlocked!'}
          </small>
        </>
      ) : (
        <small className="tr-muted tr-ellipsis">{e.description}</small>
      )}
      {ready > 0 && (
        <span className="tr-info-cta is-hot">
          <Icon name="gift" size="1.1em" /> {ready} event reward{ready === 1 ? '' : 's'} to claim
        </span>
      )}
    </button>
  );
}

function Notice({
  testId,
  icon,
  children,
}: {
  testId: string;
  icon: IconName;
  children: string;
}): JSX.Element {
  return (
    <p className="tr-event-notice" role="note" data-testid={testId}>
      <Icon name={icon} size="1.1em" />
      <span>{children}</span>
    </p>
  );
}

function TierTrack({ e, canClaim }: { e: LiveEventView; canClaim: boolean }): JSX.Element {
  return (
    <ol className="tr-event-track" aria-label={`${e.name} points track`}>
      {e.tiers.map((t) => (
        <li
          key={t.tier}
          className={`tr-event-tier is-${t.state}`}
          data-testid={`event-tier-${t.tier}`}
          data-state={t.state}
        >
          <span className="tr-event-tier-head">
            <b>Tier {t.tier}</b>
            <small className="tr-muted">{formatNumber(t.points)} pts</small>
          </span>
          <span className="tr-event-tier-rewards">
            {t.rewards.map((g, i) => (
              <GrantChip key={i} grant={g} />
            ))}
          </span>
          {t.state === 'claimed' ? (
            <span className="tr-ch-stamp">
              <Icon name="check" size="1em" /> Claimed
            </span>
          ) : t.state === 'claimable' && canClaim ? (
            <Button
              size="sm"
              variant="mint"
              data-testid="event-tier-claim"
              onClick={() => uiEvents.emit('claimEventTier', { eventId: e.id, tier: t.tier })}
            >
              Claim
            </Button>
          ) : (
            <Icon name="lock" size="1em" />
          )}
        </li>
      ))}
    </ol>
  );
}

function ChallengeList({ e, canClaim }: { e: LiveEventView; canClaim: boolean }): JSX.Element {
  return (
    <div className="tr-event-challenges">
      {e.challenges.map((c) => {
        const done = c.progress >= c.goal;
        const state = c.claimed ? 'claimed' : done ? 'ready' : 'progress';
        return (
          <article
            key={c.id}
            className={`tr-event-challenge is-${state}`}
            data-testid={`event-challenge-${c.id}`}
            data-state={state}
          >
            <Icon name={done ? 'check' : challengeIcon(c.metric)} size="1.6em" />
            <span className="tr-col tr-grow" style={{ gap: '0.25em', minWidth: 0 }}>
              <b className="tr-ellipsis">{c.title}</b>
              <Bar
                value={c.progress / c.goal}
                color={done ? 'var(--mint)' : 'var(--lemon)'}
                label={c.title}
              />
              <small className="tr-muted">
                {formatNumber(Math.min(c.progress, c.goal))} / {formatNumber(c.goal)} · +
                {formatNumber(c.points)} pts
                {c.xp > 0 ? ` · +${formatNumber(c.xp)} XP` : ''}
                {c.eventPlaylistsOnly ? ' · featured shows only' : ''}
              </small>
            </span>
            {state === 'claimed' ? (
              <span className="tr-ch-stamp">
                <Icon name="check" size="1em" /> Claimed
              </span>
            ) : state === 'ready' && canClaim ? (
              <Button
                size="sm"
                variant="mint"
                data-testid="event-challenge-claim"
                onClick={() => uiEvents.emit('claimEventChallenge', { eventId: e.id, challengeId: c.id })}
              >
                Claim
              </Button>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function EventDetail({ e, data, now }: { e: LiveEventView; data: EventsData; now: number }): JSX.Element {
  const maintenance = useUI((s) => s.liveOps.maintenance?.phase === 'active');
  const canClaim = data.online && !maintenance && e.phase !== 'upcoming';
  const next = nextTier(e);
  const featured = e.playlists.join(' and ');
  return (
    <section
      className={`tr-panel tr-event is-${e.phase}`}
      style={{ ['--art-a' as string]: e.art[0], ['--art-b' as string]: e.art[1] }}
      data-testid="event-screen"
      data-phase={e.phase}
    >
      <header className="tr-event-hero">
        <span className="tr-event-hero-icon" aria-hidden>
          <Icon name={eventIcon(e.icon)} size="2.4em" />
        </span>
        <span className="tr-col tr-grow" style={{ gap: '0.3em', minWidth: 0 }}>
          <span className="tr-label">
            {e.phase === 'live' ? 'Live event' : e.phase === 'upcoming' ? 'Coming soon' : 'Event over'}
          </span>
          <h2 className="tr-title tr-h2">{e.name}</h2>
          <p className="tr-event-desc">{e.description}</p>
          {featured && (
            <small>
              {e.multiplier > 1 ? `${e.multiplier}x points in ${featured}` : `Featured: ${featured}`} · every
              show earns at least {formatNumber(e.perShow)} pts
            </small>
          )}
        </span>
        <span className="tr-chip tr-chip--ink" data-testid="event-countdown">
          <Icon name={e.phase === 'ended' ? 'calendar' : 'clock'} size="1em" /> {eventCountdown(e, now)}
        </span>
      </header>

      {!data.online && (
        <Notice testId="event-offline" icon="globe">
          Event progress needs online play. Sign in and play online shows to earn points; Vs Bots shows do not
          count.
        </Notice>
      )}
      {data.online && maintenance && (
        <Notice testId="event-maintenance" icon="clock">
          Online play is down for maintenance. Your event progress is safe; claims open again when it ends.
        </Notice>
      )}
      {e.phase === 'upcoming' && (
        <Notice testId="event-upcoming" icon="calendar">
          {`Starts ${new Date(e.startsAt).toUTCString().slice(0, 22)} UTC. Preview the rewards below.`}
        </Notice>
      )}
      {e.phase === 'ended' && (
        <Notice testId="event-ended" icon="gift">
          This event is over. Anything you earned but did not claim is added to your account automatically.
        </Notice>
      )}

      <div className="tr-event-points">
        <span className="tr-col" style={{ gap: '0.2em' }}>
          <span className="tr-label">Event points</span>
          <b className="tr-title tr-h3" data-testid="event-points">
            {formatNumber(e.points)}
          </b>
        </span>
        <span className="tr-grow">
          <Bar
            value={next ? e.points / next.points : 1}
            color="var(--lemon)"
            large
            label="Points to the next tier"
          />
          <small className="tr-muted">
            {next
              ? `${formatNumber(next.points - e.points)} points to tier ${next.tier}`
              : 'Every tier unlocked!'}
          </small>
        </span>
      </div>

      <h3 className="tr-title tr-h3">Rewards</h3>
      <TierTrack e={e} canClaim={canClaim} />
      <h3 className="tr-title tr-h3">Event challenges</h3>
      <ChallengeList e={e} canClaim={canClaim} />
    </section>
  );
}

/** The event screen (Challenges tab, event view). */
export function EventScreen(): JSX.Element {
  const data = useUI((s) => s.events);
  const on = useEventsOn();
  const now = useNow(1000);
  const [picked, setPicked] = useState<string | null>(null);
  if (!data || data.list.length === 0)
    return (
      <div className="tr-panel tr-empty" data-testid="event-empty">
        No events right now. Check back soon!
      </div>
    );
  if (!on)
    return (
      <div className="tr-panel tr-empty" data-testid="event-disabled">
        Events are paused for a moment. Your progress is safe; check back soon!
      </div>
    );
  const e = data.list.find((x) => x.id === picked) ?? featuredEvent(data.list)!;
  return (
    <div className="tr-events">
      {data.list.length > 1 && (
        <Segmented<string>
          label="Events"
          value={e.id}
          onChange={setPicked}
          options={data.list.map((x) => ({ value: x.id, label: x.name }))}
        />
      )}
      <EventDetail e={e} data={data} now={now} />
    </div>
  );
}
