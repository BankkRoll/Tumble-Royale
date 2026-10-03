/**
 * Play tab: selected show info, today's challenges at a glance, a news teaser
 * and the custom-lobby entry point. The 3D lobby stays visible on the right.
 */
import type { JSX } from 'react';
import { Bar, Panel } from '../../components/bits.tsx';
import { Button } from '../../components/controls.tsx';
import { formatRemaining, useNow } from '../../components/hooks.ts';
import { ui, useUI } from '../../store/uiStore.ts';

/** Play tab panel. */
export function PlayTab(): JSX.Element {
  const playlists = useUI((s) => s.playlists);
  const selected = useUI((s) => s.selectedPlaylist);
  const challenges = useUI((s) => s.challenges);
  const news = useUI((s) => s.news[0]);
  const now = useNow(1000);
  const p = playlists.find((x) => x.id === selected) ?? playlists[0];
  const daily = challenges?.list.filter((c) => c.cadence === 'daily').slice(0, 3) ?? [];

  return (
    <div className="tr-play-tab">
      {p && (
        <Panel
          tilt={-1.2}
          className="tr-show-card"
          style={{ ['--art-a' as string]: p.art[0], ['--art-b' as string]: p.art[1] }}
        >
          <div className="tr-show-card-art" aria-hidden>
            {p.icon}
          </div>
          <div className="tr-label">Now showing</div>
          <h2 className="tr-title tr-h2">{p.name}</h2>
          <p>{p.description}</p>
          <div className="tr-row tr-wrap">
            <span className="tr-chip tr-chip--lemon">👥 {p.players}</span>
            {p.teamSize > 1 && (
              <span className="tr-chip tr-chip--grape">{p.teamSize === 2 ? 'Duos' : 'Squads'}</span>
            )}
            {p.ranked && <span className="tr-chip tr-chip--ink">🏅 Ranked</span>}
            {p.endsAt && <span className="tr-chip tr-chip--pink">⏳ {formatRemaining(p.endsAt - now)}</span>}
          </div>
        </Panel>
      )}
      {daily.length > 0 && (
        <Panel tilt={0.8} delay={90} className="tr-mini-challenges">
          <div className="tr-row">
            <span className="tr-label tr-grow">Today's challenges</span>
            <Button size="sm" variant="ghost" onClick={() => ui.getState().setMenuTab('challenges')}>
              All ▸
            </Button>
          </div>
          {daily.map((c) => (
            <div key={c.id} className="tr-mini-challenge">
              <span aria-hidden>{c.icon}</span>
              <span className="tr-grow tr-ellipsis">{c.title}</span>
              <span className="tr-small tr-nowrap">
                {Math.min(c.progress, c.goal)}/{c.goal}
              </span>
              <Bar value={c.progress / c.goal} color="var(--mint)" />
            </div>
          ))}
        </Panel>
      )}
      <div className="tr-row tr-wrap tr-play-actions">
        {news && (
          <Panel
            tilt={-0.6}
            delay={160}
            tight
            className="tr-news-teaser"
            style={{ ['--art-a' as string]: news.art[0], ['--art-b' as string]: news.art[1] }}
          >
            <button
              type="button"
              className="tr-row"
              data-nav=""
              onClick={() => ui.getState().setMenuTab('news')}
              style={{ textAlign: 'left' }}
            >
              <span className="tr-news-teaser-icon" aria-hidden>
                {news.icon}
              </span>
              <span className="tr-col" style={{ gap: 0 }}>
                <span className="tr-chip tr-chip--pink tr-small">{news.tag}</span>
                <b>{news.title}</b>
              </span>
            </button>
          </Panel>
        )}
        <Button variant="sky" onClick={() => ui.getState().setScreen('customLobby')}>
          🔑 Custom show
        </Button>
      </div>
    </div>
  );
}
