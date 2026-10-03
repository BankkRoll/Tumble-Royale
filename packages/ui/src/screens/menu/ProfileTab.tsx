/**
 * Profile: the player card (banner, nameplate-styled name#tag, level/XP,
 * Crowns + Crown Shards, rank badge, editable banner/nameplate), the 3D
 * lobby Tumbler in the middle, and real stats from the player's show history
 * (win rate, qualify rate, favourite round, best race times, gameplay
 * totals), the showcase (rarest owned cosmetics) and the last 20 shows with
 * expandable per-round results. `ProfileOverlay` shows the same card for
 * another player (ranks, results). docs/design/SCREENS.md §5.5.
 */
import { useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Bar, BotTag, TypeBadge } from '../../components/bits.tsx';
import { ItemPreview, Nameplate, bannerStyle } from '../../components/ItemPreview.tsx';
import { confirmSignOut } from '../../components/account.ts';
import { RenameField } from '../overlays/AccountSheet.tsx';
import { Button } from '../../components/controls.tsx';
import { formatNumber, ordinal, useDisplayName } from '../../components/hooks.ts';
import { Icon, type IconName } from '../../components/icons/index.tsx';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import { PlayerActionRow } from '../overlays/PlayerActions.tsx';
import type { PlayerRef } from '../../store/social.ts';
import type {
  MatchHistoryEntry,
  MetOfflineInfo,
  ProfileData,
  RankInfo,
  RankTier,
} from '../../store/types.ts';
import { rarityLabels } from '../../theme/tokens.ts';
import { OpenReplayButton } from '../Replay.tsx';

/** Ranked ladder tiers, lowest first, with display colours. */
export const RANK_TIERS: { tier: RankTier; label: string; color: string; dark: string }[] = [
  { tier: 'bronze', label: 'Bronze', color: '#e0975a', dark: '#8a4f22' },
  { tier: 'silver', label: 'Silver', color: '#d3dcea', dark: '#6d7a92' },
  { tier: 'gold', label: 'Gold', color: '#ffd23f', dark: '#b07a00' },
  { tier: 'platinum', label: 'Platinum', color: '#7fe7e0', dark: '#1f8f88' },
  { tier: 'diamond', label: 'Diamond', color: '#8cc6ff', dark: '#2f62c0' },
  { tier: 'champion', label: 'Champion', color: '#ff7ad9', dark: '#a1207f' },
  { tier: 'crown', label: 'Crown League', color: '#ffb021', dark: '#7a3d00' },
];

const ROMAN = ['I', 'II', 'III'];

/** A ranked tier gem (SVG), optionally with its division numeral. */
export function RankGem({
  tier,
  division,
  size = '3em',
  dim,
}: {
  tier: RankTier;
  division?: number;
  size?: string;
  dim?: boolean;
}): JSX.Element {
  const t = RANK_TIERS.find((x) => x.tier === tier) ?? RANK_TIERS[0]!;
  return (
    <svg
      className={`tr-rank-gem${dim ? ' is-dim' : ''}`}
      viewBox="0 0 40 44"
      width={size}
      height={size}
      aria-hidden
    >
      <path
        d="M20 2 37 11v20L20 42 3 31V11z"
        fill={t.color}
        stroke="#2b1a5e"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path d="M20 7 32 13.5v14L20 37 8 27.5v-14z" fill="#fff" opacity=".35" />
      {tier === 'crown' ? (
        <path
          d="M11 27 9.5 16l5.5 4.5 5-7 5 7 5.5-4.5L29 27z"
          fill="#fff"
          stroke="#2b1a5e"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      ) : (
        division !== undefined && (
          <text
            x="20"
            y="27.5"
            textAnchor="middle"
            fontFamily="var(--font-display)"
            fontSize="13"
            fill={t.dark}
          >
            {ROMAN[division - 1] ?? ''}
          </text>
        )
      )}
    </svg>
  );
}

/** Ranked emblem with RP bar (profile card, rewards). */
export function RankEmblem({ rank, compact }: { rank: RankInfo; compact?: boolean }): JSX.Element {
  const t = RANK_TIERS.find((x) => x.tier === rank.tier) ?? RANK_TIERS[0]!;
  const div = rank.tier === 'crown' ? '' : ` ${ROMAN[rank.division - 1] ?? ''}`;
  return (
    <div className={`tr-rank${compact ? ' is-compact' : ''}`} style={{ ['--rank' as string]: t.color }}>
      <RankGem tier={rank.tier} division={rank.division} size={compact ? '2.2em' : '3em'} />
      <div className="tr-col" style={{ gap: '0.2em', minWidth: 0 }}>
        <b>
          {t.label}
          {div}
        </b>
        {rank.placementsLeft ? (
          <span className="tr-small">{rank.placementsLeft} placement shows left</span>
        ) : (
          <>
            <Bar value={rank.rp / Math.max(1, rank.rp + rank.rpToNext)} color={t.color} />
            <span className="tr-small">
              {formatNumber(rank.rp)} RP · {formatNumber(rank.rpToNext)} to promote
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export { bannerStyle, Nameplate };

function Stat({
  icon,
  label,
  value,
  sub,
}: {
  icon: IconName;
  label: string;
  value: string;
  sub?: string;
}): JSX.Element {
  return (
    <div className="tr-stat">
      <Icon name={icon} size="1.6em" />
      <b className="tr-stat-value">{value}</b>
      <span className="tr-small">{label}</span>
      {sub && <small className="tr-muted">{sub}</small>}
    </div>
  );
}

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round(Math.min(1, n / d) * 100)}%` : '—';
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * The player card. Self cards get Edit buttons (banner, nameplate → Locker).
 *
 * @param props.p - Profile data.
 * @param props.self - The local player's own card.
 */
export function ProfileCard({ p, self }: { p: ProfileData; self: boolean }): JSX.Element {
  const shards = p.crownShards ?? 0;
  const per = p.shardsPerCrown ?? 60;
  return (
    <div className="tr-panel tr-profile-card" data-testid="profile-card">
      <div className="tr-profile-banner" style={bannerStyle(p.banner)}>
        {self && (
          <button
            type="button"
            className="tr-edit-chip"
            data-nav=""
            data-testid="edit-banner"
            onClick={() => ui.getState().openLocker('banner')}
          >
            Edit banner
          </button>
        )}
        {!self && (
          <span className="tr-profile-avatar">
            <TumblerAvatar colors={p.colors} hat={p.hat} expression="grin" size="5.5em" />
          </span>
        )}
      </div>
      <div className="tr-profile-id">
        <span className="tr-level-badge tr-level-badge--card">
          <small>LV</small>
          {p.level}
        </span>
        <div className="tr-col" style={{ gap: '0.35em', minWidth: 0 }}>
          <Nameplate name={p.name} tag={p.tag} plate={p.nameplate} />
          {self && (
            <button
              type="button"
              className="tr-link-btn"
              data-nav=""
              data-testid="edit-nameplate"
              onClick={() => ui.getState().openLocker('nameplate')}
            >
              Change nameplate
            </button>
          )}
        </div>
      </div>
      <div className="tr-col" style={{ gap: '0.25em' }}>
        <Bar value={p.xp / Math.max(1, p.xpToNext)} label="XP to next level" />
        <small className="tr-muted">
          {formatNumber(p.xp)} / {formatNumber(p.xpToNext)} XP to level {p.level + 1}
        </small>
      </div>
      <div className="tr-profile-crowns">
        <span className="tr-crown-count">
          <Icon name="crown" size="2.2em" />
          <span className="tr-col" style={{ gap: 0 }}>
            <b>{formatNumber(p.crowns)}</b>
            <small>Crowns</small>
          </span>
        </span>
        <span className="tr-col tr-grow" style={{ gap: '0.25em' }}>
          <small className="tr-muted">
            Crown Shards {shards % per}/{per}
          </small>
          <Bar value={(shards % per) / per} color="var(--lemon)" label="Crown Shards" />
        </span>
      </div>
      {p.rank ? (
        <RankEmblem rank={p.rank} />
      ) : (
        <div className="tr-rank is-unranked">
          <RankGem tier="bronze" size="2.4em" dim />
          <span className="tr-small">Unranked — play Ranked online to get placed.</span>
        </div>
      )}
      {p.isGuest && self && (
        <span className="tr-chip tr-chip--pink">
          Guest — link an account in Settings to keep progress everywhere
        </span>
      )}
    </div>
  );
}

function Stats({ p }: { p: ProfileData }): JSX.Element {
  const s = p.stats;
  const wins = s.wins ?? p.crowns;
  const played = s.roundsPlayed ?? 0;
  const totals = s.totals;
  return (
    <div className="tr-panel tr-profile-stats" data-testid="profile-stats">
      <div className="tr-panel-head">
        <h2 className="tr-title tr-h3 tr-grow">Stats</h2>
        {s.recentForm && s.recentForm.length > 0 && (
          <span className="tr-form" aria-label="Recent shows, newest first">
            {s.recentForm.slice(0, 10).map((r, i) => (
              <i
                key={i}
                className={`is-${r}`}
                title={r === 'crown' ? 'Crown' : r === 'final' ? 'Reached the final' : 'Eliminated'}
              />
            ))}
          </span>
        )}
      </div>
      <div className="tr-stat-grid">
        <Stat icon="ticket" label="Shows" value={formatNumber(s.shows)} />
        <Stat icon="crown" label="Wins" value={formatNumber(wins)} sub={`${pct(wins, s.shows)} win rate`} />
        <Stat icon="flag" label="Finals" value={formatNumber(s.finals)} sub={pct(s.finals, s.shows)} />
        <Stat
          icon="medal"
          label="Rounds qualified"
          value={formatNumber(s.roundsQualified)}
          sub={played > 0 ? `${pct(s.roundsQualified, played)} of ${formatNumber(played)}` : undefined}
        />
        <Stat icon="fire" label="Best win streak" value={formatNumber(s.bestStreak)} />
        <Stat icon="star" label="Favourite round" value={s.favouriteRound ?? '—'} />
      </div>
      {totals && (totals.jumps || totals.dives || totals.grabs) ? (
        <div className="tr-totals">
          <span>
            <Icon name="jump" size="1.2em" /> <b>{formatNumber(totals.jumps ?? 0)}</b> jumps
          </span>
          <span>
            <Icon name="dive" size="1.2em" /> <b>{formatNumber(totals.dives ?? 0)}</b> dives
          </span>
          <span>
            <Icon name="grab" size="1.2em" /> <b>{formatNumber(totals.grabs ?? 0)}</b> grabs
          </span>
        </div>
      ) : null}
      {s.bestTimes && s.bestTimes.length > 0 && (
        <div className="tr-col" style={{ gap: '0.3em' }}>
          <span className="tr-label">Best race times</span>
          <div className="tr-best-times">
            {s.bestTimes.slice(0, 4).map((b) => (
              <span key={b.round} className="tr-best-time">
                <Icon name="stopwatch" size="1.1em" />
                <span className="tr-grow tr-ellipsis">{b.round}</span>
                <b>{formatTime(b.timeSec)}</b>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Showcase({ p }: { p: ProfileData }): JSX.Element | null {
  const items = p.showcase ?? [];
  return (
    <div className="tr-panel tr-profile-showcase">
      <div className="tr-panel-head">
        <h2 className="tr-title tr-h3 tr-grow">Showcase</h2>
        <small className="tr-muted">Rarest items</small>
      </div>
      {items.length === 0 ? (
        <p className="tr-small tr-muted">
          Unlock cosmetics from the Store, Pass and challenges to show them off here.
        </p>
      ) : (
        <div className="tr-showcase-row">
          {items.slice(0, 3).map((it) => (
            <span
              key={it.id}
              className={`tr-showcase tr-rar-frame tr-rar-frame--${it.rarity}`}
              title={it.name}
              style={{ ['--art-a' as string]: it.art[0], ['--art-b' as string]: it.art[1] }}
            >
              <ItemPreview item={it} className="tr-showcase-art" />
              <b>{it.name}</b>
              <small className={`tr-rarity-text--${it.rarity}`}>{rarityLabels[it.rarity]}</small>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Match history list with expandable per-round results.
 *
 * @param props.entries - Shows, newest first.
 */
export function HistoryList({ entries }: { entries: MatchHistoryEntry[] }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  if (entries.length === 0)
    return <div className="tr-empty tr-small">No shows yet. Go make some history!</div>;
  return (
    <div className="tr-history-list">
      {entries.slice(0, 20).map((m) => {
        const isOpen = open === m.id;
        return (
          <div key={m.id} className={`tr-history-row is-${m.result}${isOpen ? ' is-open' : ''}`}>
            <button
              type="button"
              className="tr-history-sum"
              data-nav=""
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : m.id)}
            >
              <span className={`tr-history-result is-${m.result}`}>
                <Icon
                  name={m.result === 'crown' ? 'crown' : m.result === 'final' ? 'flag' : 'close'}
                  size="1.3em"
                />
              </span>
              <span
                className="tr-col tr-grow"
                style={{ gap: '0.1em', minWidth: 0, alignItems: 'flex-start' }}
              >
                <b className="tr-ellipsis">
                  {m.result === 'crown'
                    ? 'Crowned!'
                    : m.result === 'final'
                      ? 'Reached the final'
                      : `Out in round ${Math.max(1, m.rounds.length)}`}
                  {m.place && m.participants ? (
                    <small className="tr-muted">
                      {' '}
                      · {ordinal(m.place)} of {m.participants}
                    </small>
                  ) : null}
                </b>
                <small className="tr-muted">
                  {m.playlist} ·{' '}
                  {new Date(m.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ·{' '}
                  {m.rounds.length} round{m.rounds.length === 1 ? '' : 's'}
                </small>
              </span>
              <span className="tr-history-pips" aria-hidden>
                {m.rounds.map((r, j) => (
                  <i key={j} className={r.qualified ? 'is-q' : 'is-out'} />
                ))}
              </span>
              <span className="tr-chip tr-chip--lemon tr-nowrap">+{formatNumber(m.xp)} XP</span>
              <Icon
                name={isOpen ? 'chevron-left' : 'chevron-right'}
                size="0.9em"
                className="tr-history-chev"
              />
            </button>
            {isOpen && (
              <ol className="tr-history-rounds tr-enter-fade">
                {m.rounds.map((r, j) => (
                  <li key={j} className={r.qualified ? 'is-q' : 'is-out'}>
                    <span className="tr-history-ri">R{j + 1}</span>
                    <TypeBadge type={r.type} />
                    <b className="tr-grow tr-ellipsis">{r.name}</b>
                    {r.timeSec !== undefined && (
                      <span className="tr-small tr-nowrap">
                        <Icon name="stopwatch" size="1em" /> {formatTime(r.timeSec)}
                      </span>
                    )}
                    {r.place ? (
                      <span className="tr-small tr-nowrap">
                        {ordinal(r.place)}
                        {r.of ? ` / ${r.of}` : ''}
                      </span>
                    ) : null}
                    <span className={`tr-history-q ${r.qualified ? 'is-q' : 'is-out'}`}>
                      {r.qualified ? 'Qualified' : 'Out'}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AccountCard({ p }: { p: ProfileData }): JSX.Element {
  return (
    <div className="tr-panel tr-profile-account">
      <div className="tr-col tr-grow" style={{ gap: '0.15em', minWidth: 0 }}>
        <span className="tr-label">Account</span>
        <RenameField testId="profile-rename" />
        <small className="tr-muted">
          {p.isGuest ? 'Guest · saved on this device only' : 'Signed in · saved to your account'}
        </small>
      </div>
      <Button variant="secondary" size="sm" data-testid="profile-sign-out" onClick={confirmSignOut}>
        Sign out
      </Button>
    </div>
  );
}

/** Shows listed inline on the Profile tab; See all opens the full Match history. */
export const PROFILE_HISTORY_PREVIEW = 5;

/** Opens the full Match history screen, asking the game for fresh entries. */
export function openMatchHistory(): void {
  playCue('ui.click');
  uiEvents.emit('requestMatchHistory');
  ui.getState().setScreen('matchHistory', { transition: 'fade' });
}

/** Profile tab (self). */
export function ProfileTab(): JSX.Element {
  const p = useUI((s) => s.profile);
  const history = useUI((s) => s.matchHistory);
  if (!p) return <div className="tr-panel tr-empty">Create your Tumbler to see your profile.</div>;
  return (
    <div className="tr-profile">
      <div className="tr-profile-left tr-scroll">
        <ProfileCard p={p} self />
        <Showcase p={p} />
        <AccountCard p={p} />
      </div>
      <div className="tr-profile-right tr-scroll">
        <Stats p={p} />
        <div className="tr-panel tr-profile-history">
          <div className="tr-panel-head">
            <h2 className="tr-title tr-h3 tr-grow">Latest shows</h2>
            <OpenReplayButton />
            {history.length > 0 && (
              <Button variant="secondary" size="sm" data-testid="history-see-all" onClick={openMatchHistory}>
                See all
              </Button>
            )}
          </div>
          <HistoryList entries={history.slice(0, PROFILE_HISTORY_PREVIEW)} />
        </div>
      </div>
    </div>
  );
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Local cards (bots, offline players) have no account id, so only mute applies to them. */
function inspectRef(p: ProfileData): PlayerRef {
  return ACCOUNT_ID.test(p.id)
    ? { userId: p.id, name: p.name, tag: p.tag, key: p.id }
    : { name: p.name, key: `name:${p.name}`, isBot: true };
}

/**
 * Card for a Tumbler only met in offline shows: just the shows played
 * together, with no level, XP, rank or lifetime stats (this device can't know them).
 */
export function MetOfflineCard({ p, info }: { p: ProfileData; info: MetOfflineInfo }): JSX.Element {
  const name = useDisplayName();
  return (
    <div className="tr-panel tr-profile-card" data-testid="met-offline-card">
      <div className="tr-profile-banner" style={bannerStyle(p.banner)}>
        <span className="tr-profile-avatar">
          <TumblerAvatar colors={p.colors} hat={p.hat} expression="grin" size="5.5em" />
        </span>
      </div>
      <div className="tr-profile-id">
        <div className="tr-row" style={{ gap: '0.5em', minWidth: 0 }}>
          <b className="tr-title tr-h3 tr-ellipsis">{name({ id: -1, name: p.name, isBot: info.isBot })}</b>
          <BotTag isBot={info.isBot} />
        </div>
      </div>
      <small className="tr-muted">
        {info.isBot ? 'A bot' : 'A Tumbler'} from your offline shows
        {info.lastSeen > 0 && ` · last seen ${new Date(info.lastSeen).toLocaleDateString()}`}
      </small>
      <div className="tr-stat-grid">
        <Stat icon="ticket" label="Shows together" value={formatNumber(info.showsTogether)} />
        <Stat icon="medal" label="Best finish vs you" value={ordinal(info.bestPlace)} />
        <Stat icon="crown" label="Crowns in your shows" value={formatNumber(info.crownsTogether)} />
        {info.aheadOfYou !== undefined && (
          <Stat
            icon="flag"
            label="Finished ahead of you"
            value={`${info.aheadOfYou}/${info.showsTogether}`}
          />
        )}
      </div>
    </div>
  );
}

/** Another player's profile card (opened from Ranks / results via `inspectPlayer`). */
export function ProfileOverlay(): JSX.Element | null {
  const p = useUI((s) => s.inspectedProfile);
  const selfId = useUI((s) => s.profile?.id);
  if (!p) return null;
  const close = (): void => {
    playCue('ui.back');
    ui.getState().setInspectedProfile(null);
  };
  return (
    <div
      className="tr-dialog-wrap tr-interactive"
      data-nav-scope="14"
      role="dialog"
      aria-modal="true"
      aria-label={`${p.name}'s profile`}
    >
      <div className="tr-dim" onClick={close} />
      <div className="tr-inspect tr-enter-pop" data-testid="inspect-profile">
        <div className="tr-inspect-body">
          {p.metOffline ? (
            <MetOfflineCard p={p} info={p.metOffline} />
          ) : (
            <>
              <ProfileCard p={p} self={false} />
              {p.stats.shows > 0 && <Stats p={p} />}
            </>
          )}
        </div>
        {p.id !== selfId && <PlayerActionRow p={inspectRef(p)} compact />}
        <Button
          variant="secondary"
          data-nav-back=""
          data-autofocus=""
          cue="ui.back"
          hint="Esc"
          onClick={close}
        >
          Close
        </Button>
      </div>
    </div>
  );
}
