/**
 * Profile card: banner, name#tag, level, rank emblem, stat tiles, showcase,
 * and the match-history entry point. docs/design/SCREENS.md §5.5.
 */
import type { JSX } from 'react';
import { Bar, Panel } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { formatNumber } from '../../components/hooks.ts';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { RankInfo, RankTier } from '../../store/types.ts';

const RANK_STYLE: Record<RankTier, { label: string; color: string; icon: string }> = {
  bronze: { label: 'Bronze', color: '#d08a4a', icon: '🥉' },
  silver: { label: 'Silver', color: '#c4d0e0', icon: '🥈' },
  gold: { label: 'Gold', color: '#ffd23f', icon: '🥇' },
  platinum: { label: 'Platinum', color: '#7fe7e0', icon: '💠' },
  diamond: { label: 'Diamond', color: '#7fb8ff', icon: '💎' },
  champion: { label: 'Champion', color: '#ff7ad9', icon: '🏆' },
  crown: { label: 'Crown League', color: '#ffb021', icon: '👑' },
};

/** Ranked emblem with RP bar. */
export function RankEmblem({ rank, compact }: { rank: RankInfo; compact?: boolean }): JSX.Element {
  const s = RANK_STYLE[rank.tier];
  const div = rank.tier === 'crown' ? '' : ` ${['I', 'II', 'III'][rank.division - 1] ?? ''}`;
  return (
    <div className={`tr-rank${compact ? ' is-compact' : ''}`} style={{ ['--rank' as string]: s.color }}>
      <span className="tr-rank-gem" aria-hidden>
        {s.icon}
      </span>
      <div className="tr-col" style={{ gap: '0.2em', minWidth: 0 }}>
        <b>
          {s.label}
          {div}
        </b>
        {rank.placementsLeft ? (
          <span className="tr-small">{rank.placementsLeft} placement shows left</span>
        ) : (
          <>
            <Bar value={rank.rp / Math.max(1, rank.rpToNext)} color={s.color} />
            <span className="tr-small">
              {rank.rp} / {rank.rpToNext} RP
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** Profile tab. */
export function ProfileTab(): JSX.Element {
  const p = useUI((s) => s.profile);
  if (!p) return <Panel className="tr-profile">Sign in to see your profile.</Panel>;
  const tiles: [string, string, number][] = [
    ['👑', 'Crowns', p.crowns],
    ['🎪', 'Shows', p.stats.shows],
    ['🏁', 'Finals', p.stats.finals],
    ['✅', 'Rounds qualified', p.stats.roundsQualified],
    ['📈', 'Win rate', p.stats.shows ? Math.round((p.crowns / p.stats.shows) * 100) : 0],
    ['🔥', 'Best streak', p.stats.bestStreak],
  ];
  return (
    <div className="tr-profile">
      <Panel tilt={-0.8} className="tr-profile-card">
        <div className="tr-profile-banner" aria-hidden />
        <div className="tr-profile-avatar">
          <TumblerAvatar colors={p.colors} hat={p.hat} expression="grin" size="7em" />
        </div>
        <div className="tr-col" style={{ gap: '0.2em', alignItems: 'center' }}>
          <h2 className="tr-title tr-h2">{p.name}</h2>
          <span className="tr-chip tr-chip--ink">
            #{p.tag} · Level {p.level}
          </span>
          {p.isGuest && (
            <span className="tr-chip tr-chip--pink">Guest — link an account to keep progress</span>
          )}
        </div>
        {p.rank && <RankEmblem rank={p.rank} />}
        <div className="tr-row tr-wrap" style={{ justifyContent: 'center' }}>
          <Button
            variant="sky"
            onClick={() => {
              uiEvents.emit('requestMatchHistory');
              ui.getState().setScreen('matchHistory');
            }}
          >
            📜 Match history
          </Button>
        </div>
      </Panel>
      <Panel tilt={0.6} delay={80} className="tr-profile-stats">
        <div className="tr-stat-grid">
          {tiles.map(([icon, label, value], i) => (
            <div key={label} className="tr-stat" style={{ animationDelay: `${i * 50}ms` }}>
              <span className="tr-stat-icon" aria-hidden>
                {icon}
              </span>
              <b className="tr-stat-value">
                {formatNumber(value)}
                {label === 'Win rate' ? '%' : ''}
              </b>
              <span className="tr-small">{label}</span>
            </div>
          ))}
        </div>
        {p.stats.favouriteRound && (
          <p className="tr-small">
            Favourite round: <b>{p.stats.favouriteRound}</b>
          </p>
        )}
        {p.showcase && p.showcase.length > 0 && (
          <div className="tr-col" style={{ gap: '0.4em' }}>
            <span className="tr-label">Showcase</span>
            <div className="tr-row">
              {p.showcase.map((it) => (
                <span
                  key={it.id}
                  className={`tr-showcase tr-showcase--${it.rarity}`}
                  title={it.name}
                  style={{ ['--art-a' as string]: it.art[0], ['--art-b' as string]: it.art[1] }}
                >
                  {it.icon}
                </span>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
