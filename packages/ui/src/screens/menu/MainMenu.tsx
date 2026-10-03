/**
 * Main menu shell: top bar (level, tabs, wallet, social, settings), the active
 * tab panel, and the bottom play bar / matchmaking card.
 * docs/design/SCREENS.md §4 and §6.
 */
import { useRef, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { playCue } from '../../audio-cues.ts';
import { Bar, CurrencyPill, TipCarousel } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { formatClock, formatRemaining, useNow } from '../../components/hooks.ts';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import { MENU_TABS, type MenuTab } from '../../store/types.ts';
import { ChallengesTab } from './ChallengesTab.tsx';
import { LeaderboardsTab } from './LeaderboardsTab.tsx';
import { LockerTab } from './LockerTab.tsx';
import { NewsTab } from './NewsTab.tsx';
import { PassTab } from './PassTab.tsx';
import { PlayTab } from './PlayTab.tsx';
import { ProfileTab } from './ProfileTab.tsx';
import { StoreTab } from './StoreTab.tsx';

const TAB_META: Record<MenuTab, { label: string; icon: string }> = {
  play: { label: 'Play', icon: '🎮' },
  locker: { label: 'Locker', icon: '👕' },
  store: { label: 'Store', icon: '🛍️' },
  pass: { label: 'Pass', icon: '⭐' },
  challenges: { label: 'Challenges', icon: '🎯' },
  profile: { label: 'Profile', icon: '🙂' },
  leaderboards: { label: 'Ranks', icon: '🏆' },
  news: { label: 'News', icon: '📰' },
};

/** Tips shown while queueing. */
export const MATCHMAKING_TIPS: readonly string[] = [
  'Dive mid-jump to cover more ground!',
  'Grab a ledge and press Jump to climb up.',
  'Spinning platforms carry you — ride them, don’t fight them.',
  'Magenta and orange mean danger. Mint means safe.',
  'Feeling stuck? A well-timed dive gets you up most ramps.',
  'Bumping into other Tumblers is legal. And hilarious.',
];

function LevelBadge(): JSX.Element | null {
  const p = useUI(
    useShallow((s) =>
      s.profile ? { level: s.profile.level, xp: s.profile.xp, next: s.profile.xpToNext } : null,
    ),
  );
  if (!p) return null;
  return (
    <div className="tr-level tr-interactive" title={`${p.xp} / ${p.next} XP`}>
      <span className="tr-level-badge">
        <small>LV</small>
        {p.level}
      </span>
      <Bar value={p.xp / Math.max(1, p.next)} label="XP to next level" className="tr-level-bar" />
    </div>
  );
}

function TabStrip(): JSX.Element {
  const tab = useUI((s) => s.menuTab);
  const disabled = useUI((s) => s.screen === 'matchmaking');
  return (
    <nav className="tr-tabs tr-interactive" role="tablist" aria-label="Menu" data-nav-tabs="">
      <span className="tr-tabs-hint" aria-hidden>
        Q
      </span>
      {MENU_TABS.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={t === tab}
          disabled={disabled && t !== tab}
          className={`tr-tab${t === tab ? ' is-active' : ''}`}
          data-nav=""
          onClick={() => {
            if (t === tab) return;
            playCue('ui.tab');
            ui.getState().setMenuTab(t);
          }}
        >
          <span className="tr-tab-icon" aria-hidden>
            {TAB_META[t].icon}
          </span>
          <span className="tr-tab-label">{TAB_META[t].label}</span>
        </button>
      ))}
      <span className="tr-tabs-hint" aria-hidden>
        E
      </span>
    </nav>
  );
}

function TopBar(): JSX.Element {
  const wallet = useUI(
    useShallow((s) => ({ gumballs: s.profile?.gumballs ?? 0, gems: s.profile?.gems ?? 0 })),
  );
  const unread = useUI((s) => s.notifications.filter((n) => !n.read).length);
  const online = useUI((s) => s.friends.filter((f) => f.presence !== 'offline').length);
  const overlay = useUI((s) => s.overlay);
  const toggle = (o: 'friends' | 'notifications' | 'settings'): void =>
    ui.getState().setOverlay(overlay === o ? 'none' : o);
  return (
    <header className="tr-topbar">
      <LevelBadge />
      <TabStrip />
      <div className="tr-topbar-right tr-interactive">
        <CurrencyPill
          currency="gumballs"
          amount={wallet.gumballs}
          onAdd={() => ui.getState().setMenuTab('store')}
        />
        <CurrencyPill currency="gems" amount={wallet.gems} onAdd={() => ui.getState().setMenuTab('store')} />
        <Button
          variant="secondary"
          className="tr-btn--icon"
          aria-label={`Notifications (${unread} new)`}
          icon={<span>🔔</span>}
          onClick={() => toggle('notifications')}
        >
          {unread > 0 ? <span className="tr-badge-dot">{unread}</span> : null}
        </Button>
        <Button
          variant="secondary"
          className="tr-btn--icon"
          aria-label={`Friends (${online} online)`}
          icon={<span>👥</span>}
          onClick={() => toggle('friends')}
        >
          {online > 0 ? <span className="tr-badge-dot tr-badge-dot--mint">{online}</span> : null}
        </Button>
        <Button
          variant="secondary"
          aria-label="Settings"
          icon={<span>⚙️</span>}
          onClick={() => toggle('settings')}
        />
      </div>
    </header>
  );
}

function PartySlots(): JSX.Element {
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
            ready: false,
            isLeader: true,
            isSelf: true,
          },
        ]
      : []);
  const max = party?.maxSize ?? 4;
  return (
    <div className="tr-party tr-interactive" aria-label="Party">
      {Array.from({ length: max }, (_, i) => {
        const m = members[i];
        if (!m) {
          return (
            <button
              key={i}
              type="button"
              className="tr-party-slot is-empty"
              data-nav=""
              aria-label="Invite a friend"
              onClick={() => ui.getState().setOverlay('friends')}
            >
              +
            </button>
          );
        }
        return (
          <div
            key={m.id}
            className={`tr-party-slot${m.ready ? ' is-ready' : ''}${m.isSelf ? ' is-self' : ''}`}
            title={m.name}
          >
            <TumblerAvatar colors={m.colors} size="2.6em" blink={false} noShadow />
            {m.isLeader && <span className="tr-party-crown">👑</span>}
            {m.ready && <span className="tr-party-tick">✓</span>}
          </div>
        );
      })}
    </div>
  );
}

function PlaylistPicker({ disabled }: { disabled: boolean }): JSX.Element | null {
  const playlists = useUI((s) => s.playlists);
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
    <div
      className="tr-playlist tr-interactive"
      style={{ ['--art-a' as string]: p.art[0], ['--art-b' as string]: p.art[1] }}
    >
      <button
        type="button"
        className="tr-playlist-arrow"
        data-nav=""
        disabled={disabled}
        aria-label="Previous playlist"
        onClick={() => cycle(-1)}
      >
        ◀
      </button>
      <div key={p.id} className="tr-playlist-card tr-enter-pop">
        <span className="tr-playlist-icon" aria-hidden>
          {p.icon}
        </span>
        <div className="tr-col" style={{ gap: '0.1em', minWidth: 0 }}>
          <b className="tr-playlist-name tr-ellipsis">{p.name}</b>
          <span className="tr-small">
            {p.players} players{p.teamSize > 1 ? ` · ${p.teamSize === 2 ? 'Duos' : 'Squads'}` : ''}
            {p.ranked ? ' · Ranked' : ''}
          </span>
        </div>
        {p.endsAt && (
          <span className="tr-chip tr-chip--pink tr-playlist-ends">
            Ends in {formatRemaining(p.endsAt - now)}
          </span>
        )}
      </div>
      <button
        type="button"
        className="tr-playlist-arrow"
        data-nav=""
        disabled={disabled}
        aria-label="Next playlist"
        onClick={() => cycle(1)}
      >
        ▶
      </button>
    </div>
  );
}

function PlayButton(): JSX.Element {
  const { party, ready, selected } = useUI(
    useShallow((s) => ({ party: s.party, ready: s.localReady, selected: s.selectedPlaylist })),
  );
  const self = party?.members.find((m) => m.isSelf);
  const isMember = party && self && !self.isLeader;
  if (isMember) {
    return (
      <Button
        variant={ready ? 'mint' : 'go'}
        size="xl"
        className="tr-play-btn"
        autoFocusNav
        cue="ui.confirm"
        hint="Y"
        onClick={() => {
          ui.getState().setLocalReady(!ready);
          uiEvents.emit('ready', { ready: !ready });
        }}
      >
        {ready ? '✓ Ready!' : 'Ready'}
      </Button>
    );
  }
  return (
    <Button
      variant="go"
      size="xl"
      className="tr-play-btn tr-loop"
      autoFocusNav
      cue="ui.confirm"
      onClick={() => uiEvents.emit('play', { playlistId: selected })}
    >
      Play
    </Button>
  );
}

function MatchmakingCard(): JSX.Element {
  const q = useUI((s) => s.queue);
  const now = useNow(500);
  const elapsed = q.startedAt ? (now - q.startedAt) / 1000 : 0;
  const numRef = useRef<HTMLSpanElement>(null);
  return (
    <div className="tr-mm tr-interactive" data-nav-scope="6">
      <TipCarousel tips={MATCHMAKING_TIPS} now={now} />
      <div className="tr-panel tr-mm-card tr-enter">
        <div className="tr-mm-machine tr-loop" aria-hidden>
          <span />
        </div>
        <div className="tr-col tr-grow" style={{ gap: '0.25em' }}>
          <div className="tr-title tr-h3">{q.status === 'found' ? 'Show found!' : 'Finding Tumblers…'}</div>
          <div className="tr-row tr-wrap tr-small">
            <span className="tr-mm-count">
              <span ref={numRef} key={q.playersFound} className="tr-mm-num">
                {q.playersFound}
              </span>
              <span className="tr-muted"> / {q.playersNeeded}</span>
            </span>
            <span className="tr-chip">⏱ {formatClock(elapsed)}</span>
            <span className="tr-chip">ETA {q.etaSec >= 0 ? `~${formatClock(q.etaSec)}` : '??'}</span>
            <span className="tr-chip tr-chip--ink">🌍 {q.region}</span>
          </div>
          <Bar value={q.playersFound / Math.max(1, q.playersNeeded)} label="Players found" />
        </div>
        <Button
          variant="secondary"
          data-nav-back=""
          data-autofocus=""
          hint="Esc"
          cue="ui.back"
          onClick={() => uiEvents.emit('cancelQueue')}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function TabPanel(): JSX.Element {
  const tab = useUI((s) => s.menuTab);
  const prev = useRef<MenuTab>(tab);
  const dir = MENU_TABS.indexOf(tab) >= MENU_TABS.indexOf(prev.current) ? 'right' : 'left';
  prev.current = tab;
  const body = (() => {
    switch (tab) {
      case 'play':
        return <PlayTab />;
      case 'locker':
        return <LockerTab />;
      case 'store':
        return <StoreTab />;
      case 'pass':
        return <PassTab />;
      case 'challenges':
        return <ChallengesTab />;
      case 'profile':
        return <ProfileTab />;
      case 'leaderboards':
        return <LeaderboardsTab />;
      case 'news':
        return <NewsTab />;
    }
  })();
  return (
    <div key={tab} className={`tr-tab-panel tr-tab-panel--${tab} tr-tab-from-${dir}`}>
      {body}
    </div>
  );
}

/**
 * Main menu screen (also renders the matchmaking state).
 * @param props.matchmaking Show the matchmaking card and dim the menu.
 */
export function MainMenu({ matchmaking = false }: { matchmaking?: boolean }): JSX.Element {
  const tab = useUI((s) => s.menuTab);
  return (
    <div className={`tr-screen tr-menu${matchmaking ? ' is-matchmaking' : ''}`} data-nav-scope="0">
      <TopBar />
      <TabPanel />
      {(tab === 'play' || matchmaking) && (
        <footer className="tr-bottombar">
          <PartySlots />
          {matchmaking ? (
            <MatchmakingCard />
          ) : (
            <div className="tr-bottombar-right">
              <PlaylistPicker disabled={false} />
              <PlayButton />
            </div>
          )}
        </footer>
      )}
    </div>
  );
}
