/**
 * News cards (season, events, patch notes), alternately tilted.
 */
import type { JSX } from 'react';
import { Panel } from '../../components/bits.tsx';
import { useUI } from '../../store/uiStore.ts';

/** News tab. */
export function NewsTab(): JSX.Element {
  const news = useUI((s) => s.news);
  return (
    <div className="tr-news tr-scroll">
      {news.length === 0 && <Panel>No news is good news!</Panel>}
      {news.map((n, i) => (
        <Panel
          key={n.id}
          tilt={i % 2 === 0 ? -1.5 : 1.5}
          delay={i * 70}
          className="tr-news-card"
          style={{ ['--art-a' as string]: n.art[0], ['--art-b' as string]: n.art[1] }}
        >
          <div className="tr-news-art" aria-hidden>
            {n.icon}
          </div>
          <span className="tr-chip tr-chip--pink">{n.tag}</span>
          <h3 className="tr-title tr-h3">{n.title}</h3>
          <p>{n.body}</p>
        </Panel>
      ))}
    </div>
  );
}
