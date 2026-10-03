/**
 * Main menu shell: top bar (level → Profile, text-only tabs with Q/E cycling,
 * named wallet pills with their popovers, bell, friends, settings) and the
 * active tab panel. Tabs cross-fade (~200 ms slide/fade, the old panel fades
 * out under the new one) so switching never flashes or wipes.
 * docs/design/SCREENS.md §4 and §6.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { playCue } from '../../audio-cues.ts';
import { Bar, CurrencyPill } from '../../components/bits.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { ui, useUI } from '../../store/uiStore.ts';
import { MENU_TABS, type MenuTab } from '../../store/types.ts';
import { ChallengesTab } from './ChallengesTab.tsx';
import { CurrencyPanel } from './CurrencyPanel.tsx';
import { LeaderboardsTab } from './LeaderboardsTab.tsx';
import { LockerTab } from './LockerTab.tsx';
import { NewsTab } from './NewsTab.tsx';
import { PassTab } from './PassTab.tsx';
import { claimablePass, PlayTab } from './PlayTab.tsx';
import { ProfileTab, ProfileOverlay } from './ProfileTab.tsx';
import { StoreTab } from './StoreTab.tsx';

export { MATCHMAKING_TIPS } from './PlayTab.tsx';

/** Tab labels (text only, by product rule). */
export const TAB_LABELS: Record<MenuTab, string> = {
  play: 'Play',
  locker: 'Locker',
  store: 'Store',
  pass: 'Pass',
  challenges: 'Challenges',
  profile: 'Profile',
  leaderboards: 'Ranks',
  news: 'News',
};

function LevelBadge(): JSX.Element | null {
  const p = useUI(
    useShallow((s) =>
      s.profile ? { level: s.profile.level, xp: s.profile.xp, next: s.profile.xpToNext } : null,
    ),
  );
  if (!p) return null;
  return (
    <button
      type="button"
      className="tr-level tr-interactive"
      data-nav=""
      data-testid="level-badge"
      title={`Level ${p.level} · ${p.xp.toLocaleString('en-US')} / ${p.next.toLocaleString('en-US')} XP — open your profile`}
      aria-label={`Level ${p.level}, ${p.xp} of ${p.next} XP. Open profile`}
      onClick={() => {
        playCue('ui.click');
        ui.getState().setMenuTab('profile');
      }}
    >
      <span className="tr-level-badge">
        <small>LV</small>
        {p.level}
      </span>
      <span className="tr-level-meta">
        <Bar value={p.xp / Math.max(1, p.next)} label="XP to next level" className="tr-level-bar" />
        <small className="tr-level-xp">
          {p.xp.toLocaleString('en-US')} / {p.next.toLocaleString('en-US')} XP
        </small>
      </span>
    </button>
  );
}

/** Badge counts per tab (claimables, unread news). */
function useTabBadges(): Partial<Record<MenuTab, number>> {
  return useUI(
    useShallow((s) => ({
      pass: claimablePass(s.pass),
      challenges: s.challenges?.list.filter((c) => !c.claimed && c.progress >= c.goal).length ?? 0,
      news: s.news.filter((n) => n.unread).length,
    })),
  );
}

function TabStrip(): JSX.Element {
  const tab = useUI((s) => s.menuTab);
  const disabled = useUI((s) => s.screen === 'matchmaking');
  const badges = useTabBadges();
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
          data-tab={t}
          onClick={() => {
            if (t === tab) return;
            playCue('ui.tab');
            ui.getState().setMenuTab(t);
          }}
        >
          {TAB_LABELS[t]}
          {(badges[t] ?? 0) > 0 && <span className="tr-tab-badge" aria-label={`${badges[t]} new`} />}
        </button>
      ))}
      <span className="tr-tabs-hint" aria-hidden>
        E
      </span>
    </nav>
  );
}

function IconButton({
  label,
  icon,
  badge,
  badgeTone,
  onClick,
  testId,
  pressed,
}: {
  label: string;
  icon: Parameters<typeof Icon>[0]['name'];
  badge?: number;
  badgeTone?: 'mint';
  onClick: () => void;
  testId: string;
  pressed?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`tr-round-btn${pressed ? ' is-on' : ''}`}
      data-nav=""
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <Icon name={icon} size="1.5em" />
      {badge !== undefined && badge > 0 && (
        <span className={`tr-badge-dot${badgeTone ? ` tr-badge-dot--${badgeTone}` : ''}`}>{badge}</span>
      )}
    </button>
  );
}

function TopBar(): JSX.Element {
  const wallet = useUI(
    useShallow((s) => ({ gumballs: s.profile?.gumballs ?? 0, gems: s.profile?.gems ?? 0 })),
  );
  const unread = useUI((s) => s.notifications.filter((n) => !n.read).length);
  const online = useUI((s) => s.friends.filter((f) => f.presence !== 'offline').length);
  const overlay = useUI((s) => s.overlay);
  const panel = useUI((s) => s.currencyPanel);
  const toggle = (o: 'friends' | 'notifications' | 'settings'): void => {
    playCue('ui.click');
    const st = ui.getState();
    st.setCurrencyPanel('none');
    st.setOverlay(overlay === o ? 'none' : o);
  };
  const wallet$ = (c: 'gumballs' | 'gems'): void => {
    playCue('ui.click');
    const st = ui.getState();
    st.setOverlay('none');
    st.setCurrencyPanel(panel === c ? 'none' : c);
  };
  return (
    <header className="tr-topbar">
      <LevelBadge />
      <TabStrip />
      <div className="tr-topbar-right tr-interactive">
        <span
          className="tr-wallet-pill"
          data-testid="wallet-pill-gumballs"
          title="Gumballs — earned by playing"
          aria-label="Gumballs: earned by playing. Open Earn Gumballs"
          onClick={() => wallet$('gumballs')}
        >
          <CurrencyPill currency="gumballs" amount={wallet.gumballs} onAdd={() => wallet$('gumballs')} />
        </span>
        <span
          className="tr-wallet-pill"
          data-testid="wallet-pill-gems"
          title="Gems — premium currency"
          aria-label="Gems: premium currency. Open Gems"
          onClick={() => wallet$('gems')}
        >
          <CurrencyPill currency="gems" amount={wallet.gems} onAdd={() => wallet$('gems')} />
        </span>
        <IconButton
          label={`Notifications (${unread} new)`}
          icon="bell"
          badge={unread}
          onClick={() => toggle('notifications')}
          testId="btn-notifications"
          pressed={overlay === 'notifications'}
        />
        <IconButton
          label={`Friends & party (${online} online)`}
          icon="friends"
          badge={online}
          badgeTone="mint"
          onClick={() => toggle('friends')}
          testId="btn-friends"
          pressed={overlay === 'friends'}
        />
        <IconButton
          label="Settings"
          icon="gear"
          onClick={() => toggle('settings')}
          testId="btn-settings"
          pressed={overlay === 'settings'}
        />
      </div>
    </header>
  );
}

function tabBody(tab: MenuTab, matchmaking: boolean): ReactNode {
  switch (tab) {
    case 'play':
      return <PlayTab matchmaking={matchmaking} />;
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
}

/** Length of the outgoing tab's fade (keep in sync with `.tr-tab-panel.is-leaving`). */
const LEAVE_MS = 200;

function TabPanel({ matchmaking }: { matchmaking: boolean }): JSX.Element {
  const tab = useUI((s) => s.menuTab);
  const reduce = useUI((s) => s.settings.accessibility.reduceMotion);
  const prev = useRef<MenuTab>(tab);
  const [leaving, setLeaving] = useState<{ tab: MenuTab; dir: 'left' | 'right' } | null>(null);
  const dir: 'left' | 'right' = MENU_TABS.indexOf(tab) >= MENU_TABS.indexOf(prev.current) ? 'right' : 'left';
  if (prev.current !== tab) {
    const from = prev.current;
    prev.current = tab;
    if (!reduce) setLeaving({ tab: from, dir });
  }
  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(() => setLeaving(null), LEAVE_MS);
    return () => window.clearTimeout(id);
  }, [leaving]);
  return (
    <div className="tr-tab-stack">
      {leaving && leaving.tab !== tab && (
        <div
          key={leaving.tab}
          className={`tr-tab-panel tr-tab-panel--${leaving.tab} is-leaving to-${leaving.dir}`}
          aria-hidden
          inert
        >
          {tabBody(leaving.tab, false)}
        </div>
      )}
      <div
        key={tab}
        className={`tr-tab-panel tr-tab-panel--${tab} tr-tab-from-${leaving?.dir ?? dir}`}
        role="tabpanel"
        data-testid={`panel-${tab}`}
      >
        {tabBody(tab, matchmaking)}
      </div>
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
    <div
      className={`tr-screen tr-menu tr-menu--${tab}${matchmaking ? ' is-matchmaking' : ''}`}
      data-nav-scope="0"
    >
      <TopBar />
      <TabPanel matchmaking={matchmaking} />
      <CurrencyPanel />
      <ProfileOverlay />
    </div>
  );
}
