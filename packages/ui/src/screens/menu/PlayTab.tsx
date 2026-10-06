/**
 * Play tab. Two clusters around the 3D lobby Tumbler:
 *
 * - left: info cards only (Season Pass progress → Pass, today's challenges →
 *   Challenges, the latest news post → News reader);
 * - bottom-left: the lobby emote and lobby games buttons; top-centre over
 *   the 3D platform: the running lobby game's score HUD;
 * - bottom-right: everything that starts a game, in one card — how to play
 *   (Play Online / Vs Bots / Private), the playlist, the party, Join with code,
 *   Practice Island and the big PLAY button. While queueing the same card
 *   becomes the matchmaking status. docs/design/SCREENS.md §6.
 *
 * In a party only the online queue is the leader's: a member's PLAY is Ready
 * up online, but Vs Bots and Practice Island stay theirs to start (the game
 * confirms that they will play solo).
 */
import { useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { playCue } from '../../audio-cues.ts';
import { Bar, TipCarousel } from '../../components/bits.tsx';
import { ItemPreview } from '../../components/ItemPreview.tsx';
import { Button } from '../../components/controls.tsx';
import { formatClock, formatRemaining, useNow } from '../../components/hooks.ts';
import { SafeImg } from '../../components/SafeImg.tsx';
import { Icon, challengeIcon, type IconName } from '../../components/icons/index.tsx';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { uiEvents } from '../../store/events.ts';
import { social } from '../../store/social.ts';
import { STATUS_PAGE_URL } from '../../store/liveOps.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type {
  OnlineStatus,
  PartyMember,
  PassReward,
  PlayMode,
  Playlist,
  SeasonPassData,
} from '../../store/types.ts';
import { LobbyEmotes } from './LobbyEmotes.tsx';
import { EventCard } from './EventsView.tsx';
import { LobbyGameHudSlot, LobbyGamesButton } from './LobbyGames.tsx';
import { openNewsPost } from './NewsTab.tsx';
import { openJoinCode, openPrivateShow } from '../overlays/PrivateShow.tsx';

/** Tips shown while queueing. */
export const MATCHMAKING_TIPS: readonly string[] = [
  'Dive mid-jump to cover more ground!',
  'Grab a ledge and press Jump to climb up.',
  'Spinning platforms carry you — ride them, don’t fight them.',
  'Magenta and orange mean danger. Mint means safe.',
  'Feeling stuck? A well-timed dive gets you up most ramps.',
  'Bumping into other Tumblers is legal. And hilarious.',
];

// -----------------------------------------------------------------------------
// Info cards (left)
// -----------------------------------------------------------------------------

/** The next tier with a cosmetic the player can actually get (free track unless premium). */
export function nextMarquee(pass: SeasonPassData): { tier: number; reward: PassReward } | null {
  for (const t of pass.tiers) {
    if (t.tier <= pass.currentTier) continue;
    const r =
      pass.premium && t.premium?.item
        ? t.premium
        : t.free?.item
          ? t.free
          : t.premium?.item
            ? t.premium
            : null;
    if (r?.item) return { tier: t.tier, reward: r };
  }
  return null;
}

/** Claimable pass rewards (cleared tiers, unclaimed, track unlocked). */
export function claimablePass(pass: SeasonPassData | null): number {
  if (!pass) return 0;
  let n = 0;
  for (const t of pass.tiers) {
    if (t.tier > pass.currentTier) break;
    if (t.free && !t.free.claimed) n++;
    if (pass.premium && t.premium && !t.premium.claimed) n++;
  }
  return n;
}

function SeasonCard(): JSX.Element | null {
  const pass = useUI((s) => s.pass);
  const now = useNow(60_000);
  if (!pass) return null;
  const next = nextMarquee(pass);
  const claim = claimablePass(pass);
  return (
    <button
      type="button"
      className="tr-info-card tr-season-card tr-enter-left"
      data-nav=""
      data-testid="season-card"
      onClick={() => {
        playCue('ui.click');
        ui.getState().setMenuTab('pass');
      }}
    >
      <span className="tr-info-card-head">
        <Icon name="pass" />
        <span className="tr-label tr-grow">Season {pass.seasonNumber} · Pass</span>
        <span className="tr-info-chip">{formatRemaining(pass.endsAt - now)} left</span>
      </span>
      <span className="tr-season-row">
        <span className="tr-season-tier">
          <small>Tier</small>
          <b>{pass.currentTier}</b>
        </span>
        <span className="tr-col tr-grow" style={{ gap: '0.35em', minWidth: 0 }}>
          <b className="tr-season-name tr-ellipsis">{pass.seasonName.replace(/^Season \d+:\s*/, '')}</b>
          <Bar value={pass.tierProgress} color="var(--lemon)" label="Progress to next tier" />
        </span>
        {next?.reward.item && (
          <span
            className={`tr-season-next tr-rar-frame tr-rar-frame--${next.reward.item.rarity}`}
            title={`Tier ${next.tier}: ${next.reward.item.name}`}
          >
            <ItemPreview item={next.reward.item} className="tr-season-next-art" />
            <small>T{next.tier}</small>
          </span>
        )}
      </span>
      {claim > 0 ? (
        <span className="tr-info-cta is-hot">
          <Icon name="gift" size="1.1em" /> {claim} reward{claim === 1 ? '' : 's'} to claim
        </span>
      ) : next?.reward.item ? (
        <span className="tr-info-cta">
          Next: <b>{next.reward.item.name}</b> at tier {next.tier}
        </span>
      ) : null}
    </button>
  );
}

function ChallengesCard(): JSX.Element | null {
  const challenges = useUI((s) => s.challenges);
  const daily = challenges?.list.filter((c) => c.cadence === 'daily') ?? [];
  if (daily.length === 0) return null;
  const ready = challenges?.list.filter((c) => !c.claimed && c.progress >= c.goal).length ?? 0;
  return (
    <button
      type="button"
      className="tr-info-card tr-mini-challenges tr-enter-left"
      style={{ animationDelay: '60ms' }}
      data-nav=""
      data-testid="challenges-card"
      onClick={() => {
        playCue('ui.click');
        ui.getState().setMenuTab('challenges');
      }}
    >
      <span className="tr-info-card-head">
        <Icon name="challenges" />
        <span className="tr-label tr-grow">Today's challenges</span>
        <span className="tr-info-chip">
          All <Icon name="chevron-right" size="0.8em" />
        </span>
      </span>
      {daily.slice(0, 3).map((c) => {
        const done = c.progress >= c.goal;
        return (
          <span
            key={c.id}
            className={`tr-mini-challenge${done && !c.claimed ? ' is-ready' : ''}${c.claimed ? ' is-claimed' : ''}`}
          >
            <Icon name={challengeIcon(c.metric)} size="1.5em" />
            <span className="tr-grow tr-ellipsis">{c.title}</span>
            <span className="tr-small tr-nowrap">
              {c.claimed ? 'Claimed' : done ? 'Claim!' : `${Math.min(c.progress, c.goal)}/${c.goal}`}
            </span>
            <Bar value={c.progress / c.goal} color={done ? 'var(--mint)' : 'var(--lemon)'} />
          </span>
        );
      })}
      {ready > 0 && (
        <span className="tr-info-cta is-hot">
          <Icon name="gift" size="1.1em" /> {ready} ready to claim
        </span>
      )}
    </button>
  );
}

function NewsCard(): JSX.Element | null {
  const news = useUI((s) => s.news.find((n) => n.featured) ?? s.news[0]);
  if (!news) return null;
  return (
    <button
      type="button"
      className="tr-info-card tr-news-teaser tr-enter-left"
      style={{
        animationDelay: '120ms',
        ['--art-a' as string]: news.art[0],
        ['--art-b' as string]: news.art[1],
      }}
      data-nav=""
      data-testid="news-card"
      onClick={() => {
        playCue('ui.click');
        openNewsPost(news.id);
        ui.getState().setMenuTab('news');
      }}
    >
      <span className="tr-news-teaser-art">
        <SafeImg src={news.image} fallback={<Icon name="news" size="2.2em" />} />
      </span>
      <span className="tr-col" style={{ gap: '0.15em', minWidth: 0, alignItems: 'flex-start' }}>
        <span className="tr-row" style={{ gap: '0.4em' }}>
          <span className="tr-news-tag">{news.tag}</span>
          {news.unread && <span className="tr-new-dot">NEW</span>}
        </span>
        <b className="tr-clamp-2">{news.title}</b>
      </span>
    </button>
  );
}

// -----------------------------------------------------------------------------
// Start cluster (right)
// -----------------------------------------------------------------------------

const MODES: { id: PlayMode | 'custom'; label: string; sub: string; icon: IconName }[] = [
  { id: 'online', label: 'Play Online', sub: 'Real players + bot fill', icon: 'globe' },
  { id: 'offline', label: 'Vs Bots', sub: 'Offline · all bots', icon: 'bot' },
  { id: 'custom', label: 'Private', sub: 'Your rounds · bots or friends', icon: 'key' },
];

/** The mode a Play press will use: online only when it's reachable. */
export function effectiveMode(mode: PlayMode, online: boolean): PlayMode {
  return mode === 'online' && online ? 'online' : 'offline';
}

/**
 * Play Online tile subtitle: only numbers the servers actually report
 * ("N online · M in queue"), else the honest "Real players + bot fill".
 *
 * @param status - Online reachability and counts.
 * @returns Subtitle copy.
 */
export function onlineTileSub(status: OnlineStatus): string {
  if (status.state === 'checking') return 'Checking servers…';
  if (status.noNetwork) return "You're offline";
  if (status.state !== 'online') return 'Servers offline';
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const parts: string[] = [];
  if (status.playersOnline !== undefined) parts.push(`${fmt(status.playersOnline)} online`);
  if (status.inQueue !== undefined) parts.push(`${fmt(status.inQueue)} in queue`);
  return parts.length > 0 ? parts.join(' · ') : 'Real players + bot fill';
}

function ModeTiles(): JSX.Element {
  const mode = useUI((s) => s.playMode);
  const status = useUI((s) => s.onlineStatus);
  const online = status.state === 'online';
  const eff = effectiveMode(mode, online);
  return (
    <div className="tr-mode-tiles" role="radiogroup" aria-label="How to play">
      {MODES.map((m) => {
        const isOnline = m.id === 'online';
        const unavailable = isOnline && !online;
        const selected = m.id === eff;
        const sub = isOnline ? onlineTileSub(status) : m.sub;
        return (
          <button
            key={m.id}
            type="button"
            role={m.id === 'custom' ? undefined : 'radio'}
            aria-checked={m.id === 'custom' ? undefined : selected}
            aria-disabled={unavailable || undefined}
            className={`tr-mode-tile tr-mode-tile--${m.id}${selected ? ' is-on' : ''}${unavailable ? ' is-unavailable' : ''}`}
            data-nav=""
            data-testid={`mode-${m.id}`}
            onClick={() => {
              if (m.id === 'custom') {
                openPrivateShow();
                return;
              }
              if (unavailable) {
                playCue('ui.error');
                uiEvents.emit('retryOnline');
                return;
              }
              playCue('ui.toggle');
              ui.getState().setPlayMode(m.id);
            }}
          >
            <Icon name={m.icon} size="2em" />
            <b>{m.label}</b>
            <small>
              {isOnline && <i className={`tr-status-dot is-${status.state}`} aria-hidden />}
              {sub}
            </small>
            {unavailable && status.state !== 'checking' && (
              <span className="tr-mode-retry">
                <Icon name="refresh" size="0.9em" /> Retry
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * "Servers offline? See the status page." Shown only when the device is
 * online but our servers are not: with no network at all the page would not
 * load either.
 */
export function ServerStatusLink(): JSX.Element | null {
  const status = useUI((s) => s.onlineStatus);
  if (status.state !== 'offline' || status.noNetwork) return null;
  return (
    <p className="tr-status-link" data-testid="server-status-link">
      Can’t reach the servers?{' '}
      <a href={STATUS_PAGE_URL} target="_blank" rel="noopener">
        Check the service status
      </a>
    </p>
  );
}

/** Sticker icon for a playlist (never the emoji placeholder). */
export function playlistIcon(p: Playlist): IconName {
  if (p.ranked) return 'ranks';
  if (p.id.includes('chaos')) return 'fire';
  if (p.teamSize === 4) return 'team';
  if (p.teamSize === 2) return 'friends';
  return 'crown';
}

function PlaylistPicker({ playlists }: { playlists: Playlist[] }): JSX.Element | null {
  const selected = useUI((s) => s.selectedPlaylist);
  const now = useNow(1000);
  const idx = Math.max(
    0,
    playlists.findIndex((p) => p.id === selected),
  );
  const p = playlists[idx];
  if (!p) return null;
  const cycle = (d: number): void => {
    const next = playlists[(idx + d + playlists.length) % playlists.length];
    if (next) {
      playCue('ui.click');
      ui.getState().selectPlaylist(next.id);
    }
  };
  return (
    <div className="tr-playlist" style={{ ['--art-a' as string]: p.art[0], ['--art-b' as string]: p.art[1] }}>
      <button
        type="button"
        className="tr-playlist-arrow"
        data-nav=""
        disabled={playlists.length < 2}
        aria-label="Previous playlist"
        onClick={() => cycle(-1)}
      >
        <Icon name="chevron-left" size="1em" />
      </button>
      <div key={p.id} className="tr-playlist-card tr-enter-pop" data-testid="playlist">
        <span className="tr-playlist-icon" aria-hidden>
          <Icon name={playlistIcon(p)} size="1.7em" />
        </span>
        <span className="tr-col" style={{ gap: '0.05em', minWidth: 0 }}>
          <small className="tr-playlist-kicker">Now showing</small>
          <b className="tr-playlist-name tr-ellipsis">{p.name}</b>
          <span className="tr-small tr-ellipsis">
            {p.players} players · {p.teamSize === 1 ? 'Solo' : p.teamSize === 2 ? 'Duos' : 'Squads'}
            {p.ranked ? ' · Ranked' : ''}
          </span>
        </span>
        {p.comingSoon ? (
          <span className="tr-chip tr-chip--ink tr-playlist-ends" data-testid="playlist-coming-soon">
            {p.startsAt ? `Coming soon · ${formatRemaining(p.startsAt - now)}` : 'Coming soon'}
          </span>
        ) : (
          p.endsAt && (
            <span className="tr-chip tr-chip--pink tr-playlist-ends" data-testid="playlist-ends">
              Ends in {formatRemaining(p.endsAt - now)}
            </span>
          )
        )}
      </div>
      <button
        type="button"
        className="tr-playlist-arrow"
        data-nav=""
        disabled={playlists.length < 2}
        aria-label="Next playlist"
        onClick={() => cycle(1)}
      >
        <Icon name="chevron-right" size="1em" />
      </button>
    </div>
  );
}

function PartyRow(): JSX.Element {
  const party = useUI((s) => s.party);
  const profile = useUI((s) => s.profile);
  const members =
    party?.members ??
    (profile
      ? [
          {
            id: profile.id,
            name: profile.name,
            colors: profile.colors,
            ready: true,
            isLeader: true,
            isSelf: true,
          },
        ]
      : []);
  const max = party?.maxSize ?? 4;
  const notReady = members.filter((m) => !m.ready && !m.isLeader).length;
  const status = partyStatusText(members);
  const leading = members.some((m) => m.isSelf && m.isLeader) && members.length > 1;
  const [armed, setArmed] = useState<string | null>(null);
  return (
    <div className="tr-party" aria-label="Party">
      <div className="tr-party-slots">
        {Array.from({ length: max }, (_, i) => {
          const m = members[i];
          if (!m) {
            return (
              <button
                key={i}
                type="button"
                className="tr-party-slot is-empty"
                data-nav=""
                data-testid="party-invite"
                aria-label="Invite a friend"
                onClick={() => {
                  playCue('ui.click');
                  ui.getState().setOverlay('friends');
                }}
              >
                <Icon name="plus" size="0.9em" />
              </button>
            );
          }
          return (
            <span
              key={m.id}
              className={`tr-party-slot${m.ready ? ' is-ready' : ''}${m.isSelf ? ' is-self' : ''}`}
              title={`${m.name}${m.isLeader ? ' (leader)' : ''}${m.ready ? ' · ready' : ''}`}
            >
              {m.isSelf ? (
                <TumblerAvatar colors={m.colors} size="2.3em" blink={false} noShadow />
              ) : (
                <button
                  type="button"
                  className="tr-party-slot-who"
                  data-nav=""
                  data-testid="party-member"
                  aria-label={`Player card for ${m.name}`}
                  onClick={() =>
                    social.getState().openPlayerMenu({
                      userId: m.id,
                      name: m.name,
                      ...(m.tag ? { tag: m.tag } : {}),
                      key: m.id,
                    })
                  }
                >
                  <TumblerAvatar colors={m.colors} size="2.3em" blink={false} noShadow />
                </button>
              )}
              {m.isLeader && (
                <span className="tr-party-crown">
                  <Icon name="crown" size="1em" />
                </span>
              )}
              {leading && !m.isSelf && (
                <button
                  type="button"
                  className={`tr-party-kick${armed === m.id ? ' is-armed' : ''}`}
                  data-nav=""
                  data-testid="party-kick"
                  aria-label={armed === m.id ? `Confirm: kick ${m.name}` : `Kick ${m.name}`}
                  title={armed === m.id ? 'Click again to kick' : `Kick ${m.name}`}
                  onBlur={() => setArmed((a) => (a === m.id ? null : a))}
                  onClick={() => {
                    // Two presses: a stray click on a tiny badge must not boot a friend.
                    if (armed !== m.id) {
                      playCue('ui.click');
                      setArmed(m.id);
                      return;
                    }
                    playCue('ui.confirm');
                    setArmed(null);
                    uiEvents.emit('kickPartyMember', { memberId: m.id });
                  }}
                >
                  <Icon name="close" size="0.9em" />
                </button>
              )}
            </span>
          );
        })}
      </div>
      <span className="tr-party-status tr-small" data-testid="party-status">
        {status ??
          (members.length <= 1
            ? 'Solo · invite up to 3'
            : notReady > 0
              ? `Waiting for ${notReady} to ready up`
              : `Party of ${members.length} · all ready`)}
      </span>
      <span className="tr-row tr-wrap" style={{ gap: '0.6em' }}>
        <button
          type="button"
          className="tr-link-btn tr-join-code-btn"
          data-nav=""
          data-testid="join-code"
          onClick={openJoinCode}
        >
          <Icon name="key" size="1em" /> Join with code
        </button>
        <button
          type="button"
          className="tr-link-btn"
          data-nav=""
          data-testid="practice-island"
          onClick={() => {
            playCue('ui.click');
            uiEvents.emit('startPractice');
          }}
        >
          <Icon name="bot" size="1em" /> Practice Island
        </button>
      </span>
    </div>
  );
}

/**
 * Who in the party is away playing on their own, for the party line.
 *
 * @returns The line, or null when everyone is in the menu.
 */
export function partyStatusText(members: readonly PartyMember[]): string | null {
  const away = members.filter((m) => m.playingSolo && !m.isSelf);
  if (away.length === 0) return null;
  const leader = away.find((m) => m.isLeader);
  if (leader) return 'Leader is playing solo';
  return away.length === 1 ? `${away[0]!.name} is playing solo` : `${away.length} members are playing solo`;
}

function PlayButton({ mode, playlist }: { mode: PlayMode; playlist: Playlist | undefined }): JSX.Element {
  const { party, ready, selected } = useUI(
    useShallow((s) => ({ party: s.party, ready: s.localReady, selected: s.selectedPlaylist })),
  );
  const self = party?.members.find((m) => m.isSelf);
  const isMember = !!party && !!self && !self.isLeader && party.members.length > 1;
  if (isMember && mode === 'online') {
    return (
      <Button
        variant={ready ? 'mint' : 'go'}
        size="xl"
        className="tr-play-btn"
        autoFocusNav
        cue="ui.confirm"
        data-testid="play"
        onClick={() => {
          ui.getState().setLocalReady(!ready);
          uiEvents.emit('ready', { ready: !ready });
        }}
      >
        <span className="tr-play-label">{ready ? 'Ready!' : 'Ready up'}</span>
        <small className="tr-play-sub">The leader starts the show</small>
      </Button>
    );
  }
  if (playlist?.comingSoon) {
    return (
      <Button variant="go" size="xl" className="tr-play-btn" disabled data-testid="play">
        <span className="tr-play-label">Soon</span>
        <small className="tr-play-sub">{playlist.name} has not opened yet</small>
      </Button>
    );
  }
  return (
    <Button
      variant="go"
      size="xl"
      className="tr-play-btn"
      autoFocusNav
      cue="ui.confirm"
      data-testid="play"
      onClick={() => uiEvents.emit('play', { playlistId: playlist?.id ?? selected, mode })}
    >
      <span className="tr-play-label">Play</span>
      <small className="tr-play-sub">
        {mode === 'online'
          ? `Online · ${playlist?.name ?? 'Main Show'}`
          : isMember
            ? 'Solo vs bots · you stay in the party'
            : `Vs bots · ${playlist?.name ?? 'Main Show'}`}
      </small>
    </Button>
  );
}

function MatchmakingCard(): JSX.Element {
  const q = useUI((s) => s.queue);
  const now = useNow(500);
  const elapsed = q.startedAt ? (now - q.startedAt) / 1000 : 0;
  const numRef = useRef<HTMLSpanElement>(null);
  return (
    <div className="tr-mm" data-nav-scope="6">
      <div className="tr-row" style={{ gap: '0.9em' }}>
        <div className="tr-mm-machine tr-loop" aria-hidden>
          <span />
        </div>
        <div className="tr-col tr-grow" style={{ gap: '0.3em', minWidth: 0 }}>
          <div className="tr-title tr-h3">{q.status === 'found' ? 'Show found!' : 'Finding Tumblers…'}</div>
          <div className="tr-row tr-wrap tr-small" style={{ gap: '0.4em' }}>
            <span className="tr-mm-count">
              <span ref={numRef} key={q.playersFound} className="tr-mm-num">
                {q.playersFound}
              </span>
              <span className="tr-muted"> / {q.playersNeeded}</span>
            </span>
            <span className="tr-chip">
              <Icon name="clock" size="1em" /> {formatClock(elapsed)}
            </span>
            <span className="tr-chip">ETA {q.etaSec >= 0 ? `~${formatClock(q.etaSec)}` : '—'}</span>
            <span className="tr-chip tr-chip--ink">{q.region}</span>
          </div>
        </div>
      </div>
      <Bar value={q.playersFound / Math.max(1, q.playersNeeded)} label="Players found" large />
      <TipCarousel tips={MATCHMAKING_TIPS} now={now} />
      <Button
        variant="secondary"
        block
        data-nav-back=""
        data-autofocus=""
        hint="Esc"
        cue="ui.back"
        data-testid="cancel-queue"
        onClick={() => uiEvents.emit('cancelQueue')}
      >
        Cancel
      </Button>
    </div>
  );
}

/** The start-a-game card (mode, playlist, party, PLAY) or the matchmaking status. */
export function StartCluster({ matchmaking = false }: { matchmaking?: boolean }): JSX.Element {
  const playlists = useUI((s) => s.playlists);
  const selected = useUI((s) => s.selectedPlaylist);
  const mode = useUI((s) => s.playMode);
  const online = useUI((s) => s.onlineStatus.state === 'online');
  const eff = effectiveMode(mode, online);
  // Ranked needs real opponents, so it's only offered online.
  const offered = eff === 'online' ? playlists : playlists.filter((p) => !p.ranked);
  const playlist = offered.find((p) => p.id === selected) ?? offered[0];
  return (
    <section
      className={`tr-panel tr-start tr-interactive${matchmaking ? ' is-queueing' : ''}`}
      aria-label="Start a show"
      data-testid="start-cluster"
    >
      {matchmaking ? (
        <MatchmakingCard />
      ) : (
        <>
          <ModeTiles />
          <ServerStatusLink />
          <PlaylistPicker playlists={offered} />
          <div className="tr-start-foot">
            <PartyRow />
            <PlayButton mode={eff} playlist={playlist} />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Play tab panel.
 *
 * @param props.matchmaking - The start card shows the queue status.
 */
export function PlayTab({ matchmaking = false }: { matchmaking?: boolean }): JSX.Element {
  return (
    <div className="tr-play-tab">
      <aside className="tr-play-info tr-interactive" aria-label="Season, challenges and news">
        <EventCard />
        <SeasonCard />
        <ChallengesCard />
        <NewsCard />
      </aside>
      <LobbyGameHudSlot />
      {!matchmaking && (
        <div className="tr-play-emotes">
          <LobbyEmotes />
          <LobbyGamesButton />
        </div>
      )}
      <StartCluster matchmaking={matchmaking} />
    </div>
  );
}
