/**
 * Main menu shell: top bar (level → Profile, text-only tabs with Q/E cycling,
 * named wallet pills with their popovers, Install app where the device can
 * install it, bell, friends, settings) and the
 * active tab panel. Tabs cross-fade (~200 ms slide/fade, the old panel fades
 * out under the new one) so switching never flashes or wipes.
 * docs/design/SCREENS.md §4 and §6.
 */
import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { playCue } from '../../audio-cues.ts';
import { Bar, CurrencyPill } from '../../components/bits.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { useNow } from '../../components/hooks.ts';
import { maintenanceHeadline } from '../../store/liveOps.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import { MENU_TABS, type MenuTab } from '../../store/types.ts';
import { ChallengesTab } from './ChallengesTab.tsx';
import { CurrencyPanel } from './CurrencyPanel.tsx';
import { claimableCount } from './EventsView.tsx';
import { LeaderboardsTab } from './LeaderboardsTab.tsx';
import { LockerTab } from './LockerTab.tsx';
import { NewsTab } from './NewsTab.tsx';
import { PassTab } from './PassTab.tsx';
import { claimablePass, PlayTab } from './PlayTab.tsx';
import { ProfileTab, ProfileOverlay } from './ProfileTab.tsx';
import { GiftSheet } from './Gifting.tsx';
import { StoreTab } from './StoreTab.tsx';
import { canInstall, requestInstall } from '../overlays/InstallApp.tsx';

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

/** Badge counts per tab (claimables, unread news, unopened gifts). */
function useTabBadges(): Partial<Record<MenuTab, number>> {
  return useUI(
    useShallow((s) => ({
      pass: claimablePass(s.pass),
      challenges:
        (s.challenges?.list.filter((c) => !c.claimed && c.progress >= c.goal).length ?? 0) +
        (s.events?.online ? s.events.list.map(claimableCount).reduce((a, b) => a + b, 0) : 0),
      news: s.news.filter((n) => n.unread).length,
      profile: s.gifts?.unopened ?? 0,
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
  const online = useUI((s) => s.friends.filter((f) => !f.recent && f.presence !== 'offline').length);
  const overlay = useUI((s) => s.overlay);
  const panel = useUI((s) => s.currencyPanel);
  const installable = useUI((s) => canInstall(s.pwa.install));
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
        {installable && (
          <IconButton label="Install app" icon="download" onClick={requestInstall} testId="btn-install" />
        )}
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

/**
 * Announces scheduled maintenance ("Maintenance in 10 min") and explains a
 * running one. Online play is blocked by the game meanwhile; Vs Bots still
 * works, which the banner says so nobody thinks the whole game is down.
 */
export function MaintenanceBanner(): JSX.Element | null {
  const notice = useUI((s) => s.liveOps.maintenance);
  const now = useNow(notice?.phase === 'scheduled' ? 1000 : 30_000);
  if (!notice) return null;
  const active = notice.phase === 'active';
  return (
    <div
      className={`tr-maintenance${active ? ' is-active' : ''}`}
      role="status"
      aria-live="polite"
      data-testid="maintenance-banner"
    >
      <Icon name="clock" size="1.1em" />
      <span className="tr-col" style={{ gap: '0.1em', minWidth: 0 }}>
        <b>{maintenanceHeadline(notice, now)}</b>
        <small className="tr-ellipsis">
          {active ? `${notice.message} Vs Bots still works offline.` : notice.message}
        </small>
      </span>
    </div>
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

/** Attributes that make an element reachable by menu navigation or tests. */
const LIVE_ATTRS = [
  'data-nav',
  'data-autofocus',
  'data-nav-back',
  'data-nav-scope',
  'data-nav-tabs',
  'data-testid',
];

/**
 * Turns a copy of the outgoing tab into a dead picture for its fade-out: no
 * navigation targets, no test ids, hidden from assistive tech and inert.
 * The live tab unmounts at once, so its effects (dressing-room events, key
 * listeners) never outlive the switch.
 *
 * @param ghost - A deep clone of the outgoing panel (detached).
 * @param tab - The outgoing tab.
 * @param dir - Direction of travel.
 * @returns The same element, ready to insert.
 */
export function inertTabGhost(ghost: Element, tab: MenuTab, dir: 'left' | 'right'): Element {
  for (const el of [ghost, ...Array.from(ghost.querySelectorAll('*'))])
    for (const a of LIVE_ATTRS) el.removeAttribute(a);
  ghost.removeAttribute('role');
  ghost.setAttribute('class', `tr-tab-panel tr-tab-panel--${tab} is-leaving to-${dir}`);
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('inert', '');
  return ghost;
}

function TabPanel({ matchmaking }: { matchmaking: boolean }): JSX.Element {
  const tab = useUI((s) => s.menuTab);
  const reduce = useUI((s) => s.settings.accessibility.reduceMotion);
  const prev = useRef<MenuTab>(tab);
  const enterDir = useRef<'left' | 'right'>('right');
  const panel = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const ghost = useRef<Element | null>(null);
  if (prev.current !== tab) {
    const from = prev.current;
    const dir = MENU_TABS.indexOf(tab) >= MENU_TABS.indexOf(from) ? 'right' : 'left';
    enterDir.current = dir;
    prev.current = tab;
    // NOTE: read during render on purpose: until this render commits, the DOM still shows the old tab.
    const old = panel.current;
    ghost.current = !reduce && old ? inertTabGhost(old.cloneNode(true) as Element, from, dir) : null;
  }
  useLayoutEffect(() => {
    const g = ghost.current;
    ghost.current = null;
    if (!g || !stack.current) return;
    stack.current.prepend(g);
    const id = window.setTimeout(() => g.remove(), LEAVE_MS);
    return () => {
      window.clearTimeout(id);
      g.remove();
    };
  }, [tab]);
  return (
    <div ref={stack} className="tr-tab-stack">
      <div
        ref={panel}
        key={tab}
        className={`tr-tab-panel tr-tab-panel--${tab} tr-tab-from-${enterDir.current}`}
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
      <MaintenanceBanner />
      <TabPanel matchmaking={matchmaking} />
      <CurrencyPanel />
      <ProfileOverlay />
      <GiftSheet />
    </div>
  );
}
