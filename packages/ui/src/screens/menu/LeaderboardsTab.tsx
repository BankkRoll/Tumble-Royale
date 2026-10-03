/**
 * Leaderboards with tabs and your row pinned. docs/design/SCREENS.md §5.6.
 */
import { useEffect, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Panel } from '../../components/bits.tsx';
import { formatNumber } from '../../components/hooks.ts';
import { TumblerAvatar } from '../../components/TumblerAvatar.tsx';
import { uiEvents } from '../../store/events.ts';
import { useUI } from '../../store/uiStore.ts';
import type { LeaderboardId, LeaderboardRow } from '../../store/types.ts';

const BOARDS: { id: LeaderboardId; label: string; unit: string }[] = [
  { id: 'crowns', label: 'Crowns', unit: 'crowns' },
  { id: 'ranked', label: 'Ranked', unit: 'RP' },
  { id: 'weekly', label: 'This week', unit: 'wins' },
  { id: 'friends', label: 'Friends', unit: 'crowns' },
];

function Row({ row, unit, pinned }: { row: LeaderboardRow; unit: string; pinned?: boolean }): JSX.Element {
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const medal = row.rank <= 3 ? ['🥇', '🥈', '🥉'][row.rank - 1] : null;
  return (
    <div
      className={`tr-lb-row${row.isSelf ? ' is-self' : ''}${pinned ? ' is-pinned' : ''}${medal ? ` is-top${row.rank}` : ''}`}
    >
      <span className="tr-lb-rank">{medal ?? `#${row.rank}`}</span>
      <TumblerAvatar colors={row.colors} size="2.2em" blink={false} noShadow />
      <span className="tr-grow tr-ellipsis">
        {streamer && !row.isSelf ? `Tumbler ${row.rank}` : row.name}
      </span>
      <b className="tr-lb-value">
        {formatNumber(row.value)} <small className="tr-muted">{unit}</small>
      </b>
    </div>
  );
}

/** Leaderboards tab. */
export function LeaderboardsTab(): JSX.Element {
  const [board, setBoard] = useState<LeaderboardId>('crowns');
  const rows = useUI((s) => s.leaderboards[board]);
  useEffect(() => {
    uiEvents.emit('leaderboardQuery', { board });
  }, [board]);
  const meta = BOARDS.find((b) => b.id === board) ?? BOARDS[0]!;
  const top = rows?.slice(0, 50) ?? [];
  const self = rows?.find((r) => r.isSelf);
  const selfVisible = self ? top.includes(self) : false;
  return (
    <Panel tilt={-0.4} className="tr-leaderboards">
      <div className="tr-panel-head">
        <h2 className="tr-title tr-h3 tr-grow">Leaderboards</h2>
        <div className="tr-seg" role="tablist" data-nav-tabs="">
          {BOARDS.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={b.id === board}
              aria-pressed={b.id === board}
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
      </div>
      {!rows ? (
        <div className="tr-empty">
          <span className="tr-gumball-spinner" />
          <p>Counting crowns…</p>
        </div>
      ) : (
        <>
          <div className="tr-lb-list tr-scroll" key={board}>
            {top.map((r) => (
              <Row key={r.playerId} row={r} unit={meta.unit} />
            ))}
          </div>
          {self && !selfVisible && <Row row={self} unit={meta.unit} pinned />}
        </>
      )}
    </Panel>
  );
}
