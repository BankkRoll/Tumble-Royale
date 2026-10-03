/**
 * Ranks: the ranked tier ladder (Bronze → Crown League, divisions I–III,
 * your position and placement state) beside the leaderboards. Online boards
 * come from the API (`/leaderboards/:type`, global / regional / friends);
 * offline the client fills a Hall of Fame from this device's real show
 * history (you + the Tumblers you actually faced) — never invented rows.
 * Your row is highlighted and pinned when off-screen; any row opens that
 * player's profile card. docs/design/SCREENS.md §5.6.
 */
import { useEffect, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { formatNumber } from '../../components/hooks.ts';
import { Icon } from '../../components/icons/index.tsx';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { uiEvents } from '../../store/events.ts';
import { useUI } from '../../store/uiStore.ts';
import type { LeaderboardId, LeaderboardRow, LeaderboardScope, RankInfo } from '../../store/types.ts';
import { RANK_TIERS, RankGem } from './ProfileTab.tsx';

const BOARDS: { id: LeaderboardId; label: string; unit: string }[] = [
  { id: 'crowns', label: 'Crowns · Season', unit: 'Crowns' },
  { id: 'crowns_all_time', label: 'Crowns · All time', unit: 'Crowns' },
  { id: 'ranked', label: 'Ranked', unit: 'RP' },
  { id: 'win_streak', label: 'Win streak', unit: 'wins' },
  { id: 'weekly', label: 'This week', unit: 'Crowns' },
];

const SCOPES: { id: LeaderboardScope; label: string }[] = [
  { id: 'global', label: 'Global' },
  { id: 'regional', label: 'Region' },
  { id: 'friends', label: 'Friends' },
];

function Row({ row, unit, pinned }: { row: LeaderboardRow; unit: string; pinned?: boolean }): JSX.Element {
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const name = streamer && !row.isSelf && !row.isBot ? `Tumbler ${row.rank}` : row.name;
  return (
    <button
      type="button"
      className={`tr-lb-row${row.isSelf ? ' is-self' : ''}${pinned ? ' is-pinned' : ''}${row.rank <= 3 ? ` is-top${row.rank}` : ''}`}
      data-nav=""
      data-testid={row.isSelf ? 'lb-self' : undefined}
      onClick={() => {
        playCue('ui.click');
        uiEvents.emit('inspectPlayer', { playerId: row.playerId, name: row.name });
      }}
    >
      <span className="tr-lb-rank">
        {row.rank <= 3 ? <Icon name="crown" size="1.2em" /> : null}#{row.rank}
      </span>
      <TumblerAvatar colors={row.colors} size="2.2em" blink={false} noShadow />
      <span className="tr-col tr-grow" style={{ gap: 0, minWidth: 0, alignItems: 'flex-start' }}>
        <b className="tr-ellipsis" style={{ maxWidth: '100%' }}>
          {name}
          {row.isSelf && <small className="tr-you-chip">You</small>}
          {row.isBot && <small className="tr-bot-chip">Bot</small>}
        </b>
        {row.detail && <small className="tr-muted tr-ellipsis">{row.detail}</small>}
      </span>
      <b className="tr-lb-value">
        {formatNumber(row.value)} <small className="tr-muted">{unit}</small>
      </b>
    </button>
  );
}

function Podium({ rows, unit }: { rows: LeaderboardRow[]; unit: string }): JSX.Element | null {
  const top = rows.slice(0, 3);
  if (top.length < 3) return null;
  const order = [top[1]!, top[0]!, top[2]!];
  return (
    <div className="tr-podium">
      {order.map((r) => (
        <button
          key={r.playerId}
          type="button"
          data-nav=""
          aria-label={`#${r.rank} ${r.name}, ${r.value} ${unit}`}
          className={`tr-podium-step is-${r.rank}${r.isSelf ? ' is-self' : ''}`}
          onClick={() => uiEvents.emit('inspectPlayer', { playerId: r.playerId, name: r.name })}
        >
          <TumblerAvatar
            colors={r.colors}
            size={r.rank === 1 ? '4em' : '3.2em'}
            expression={r.rank === 1 ? 'cheer' : 'happy'}
          />
          <b className="tr-ellipsis">{r.name}</b>
          <small>
            {formatNumber(r.value)} {unit}
          </small>
          <span className="tr-podium-block">{r.rank}</span>
        </button>
      ))}
    </div>
  );
}

function Ladder({ rank }: { rank: RankInfo | undefined }): JSX.Element {
  const idx = rank ? RANK_TIERS.findIndex((t) => t.tier === rank.tier) : -1;
  return (
    <div className="tr-panel tr-ladder" data-testid="rank-ladder">
      <div className="tr-panel-head">
        <h2 className="tr-title tr-h3 tr-grow">Ranked ladder</h2>
      </div>
      {rank?.placementsLeft ? (
        <p className="tr-small tr-ladder-note">
          <b>Placement shows:</b> {rank.placementsLeft} left. Your starting tier is set after 5 Ranked shows.
        </p>
      ) : !rank ? (
        <p className="tr-small tr-ladder-note">
          Play Ranked online to get placed. 5 placement shows set your starting tier.
        </p>
      ) : null}
      <ol className="tr-ladder-list">
        {[...RANK_TIERS].reverse().map((t, ri) => {
          const i = RANK_TIERS.length - 1 - ri;
          const here = i === idx;
          return (
            <li
              key={t.tier}
              className={`tr-ladder-tier${here ? ' is-here' : ''}${i < idx ? ' is-passed' : ''}`}
              style={{ ['--rank' as string]: t.color }}
            >
              <RankGem
                tier={t.tier}
                division={here && rank ? rank.division : undefined}
                size="2.1em"
                dim={!here && i > idx}
              />
              <span className="tr-col tr-grow" style={{ gap: '0.15em', minWidth: 0 }}>
                <b>{t.label}</b>
                {t.tier !== 'crown' && (
                  <span className="tr-ladder-divs" aria-label="Divisions">
                    {[3, 2, 1].map((d) => (
                      <i
                        key={d}
                        className={
                          here && rank && rank.division === d
                            ? 'is-on'
                            : here && rank && d > rank.division
                              ? 'is-done'
                              : i < idx
                                ? 'is-done'
                                : ''
                        }
                      >
                        {['I', 'II', 'III'][d - 1]}
                      </i>
                    ))}
                  </span>
                )}
                {here && rank && !rank.placementsLeft && (
                  <small>
                    {formatNumber(rank.rp)} RP · {formatNumber(rank.rpToNext)} to promote
                  </small>
                )}
              </span>
              {here && <span className="tr-you-chip">You</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Leaderboards tab. */
export function LeaderboardsTab(): JSX.Element {
  const [board, setBoard] = useState<LeaderboardId>('crowns');
  const [scope, setScope] = useState<LeaderboardScope>('global');
  const rows = useUI((s) => s.leaderboards[board]);
  const info = useUI((s) => s.leaderboardInfo[board]);
  const rank = useUI((s) => s.profile?.rank);
  useEffect(() => {
    uiEvents.emit('leaderboardQuery', { board, scope });
  }, [board, scope]);
  const meta = BOARDS.find((b) => b.id === board) ?? BOARDS[0]!;
  const local = info?.source === 'local';
  const top = rows?.slice(0, 50) ?? [];
  const self = rows?.find((r) => r.isSelf);
  const selfVisible = self ? top.includes(self) : false;
  return (
    <div className="tr-ranks">
      <Ladder rank={rank} />
      <div className="tr-panel tr-leaderboards">
        <div className="tr-lb-head">
          <h2 className="tr-title tr-h3 tr-grow">{local ? 'Hall of Fame' : 'Leaderboards'}</h2>
          {!local && (
            <div className="tr-seg" role="group" aria-label="Scope">
              {SCOPES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={s.id === scope}
                  data-nav=""
                  onClick={() => setScope(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="tr-lb-boards" role="tablist" aria-label="Board">
          {BOARDS.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={b.id === board}
              className={`tr-lb-board${b.id === board ? ' is-on' : ''}`}
              data-nav=""
              onClick={() => {
                playCue('ui.tab');
                setBoard(b.id);
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
        {local && (
          <p className="tr-lb-note tr-small">
            <Icon name="bot" size="1.2em" /> Offline Hall of Fame — ranked from the shows you've played on
            this device: you and the Tumblers you actually faced.
          </p>
        )}
        {!rows ? (
          <div className="tr-empty">
            <span className="tr-gumball-spinner" />
            <p>Counting crowns…</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="tr-empty">
            <Icon name="ranks" size="3em" />
            <p>
              {board === 'ranked' && local
                ? 'Ranked boards need the online servers.'
                : local
                  ? 'Play a show to start your Hall of Fame.'
                  : 'Nobody here yet — be the first!'}
            </p>
          </div>
        ) : (
          <>
            <Podium rows={rows} unit={meta.unit} />
            <div className="tr-lb-list tr-scroll" key={`${board}:${scope}`} data-testid="lb-list">
              {top.slice(rows.length >= 3 ? 3 : 0).map((r) => (
                <Row key={r.playerId} row={r} unit={meta.unit} />
              ))}
            </div>
            {self && !selfVisible && <Row row={self} unit={meta.unit} pinned />}
            {local && rows.length < 3 && (
              <p className="tr-small tr-muted tr-lb-note">
                Every show you play adds the Tumblers you meet here — win Crowns to climb.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
