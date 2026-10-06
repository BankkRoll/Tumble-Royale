/**
 * News: a featured hero carousel, the post list (with NEW badges) and a full
 * post reader (hero image, headings, lists, tips, inline images). Opening a
 * post emits `newsRead` so the unread badge on the tab and bell clears.
 */
import { useEffect, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Button } from '../../components/controls.tsx';
import { useNow } from '../../components/hooks.ts';
import { SafeImg } from '../../components/SafeImg.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { keyboardBusy, layerAbove } from '../../store/inputOwnership.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { NewsItem } from '../../store/types.ts';

let pendingPost: string | null = null;

/**
 * Asks the News tab to open a post the next time it mounts (Play tab teaser,
 * notifications).
 *
 * @param id - News post id.
 */
export function openNewsPost(id: string): void {
  pendingPost = id;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function Hero({ n }: { n: NewsItem }): JSX.Element {
  return (
    <span
      className="tr-news-hero-art"
      style={{ ['--art-a' as string]: n.art[0], ['--art-b' as string]: n.art[1] }}
    >
      <SafeImg src={n.image} fallback={<Icon name="news" size="4em" />} />
    </span>
  );
}

function Featured({
  posts,
  onOpen,
}: {
  posts: NewsItem[];
  onOpen: (n: NewsItem) => void;
}): JSX.Element | null {
  const [i, setI] = useState(0);
  const now = useNow(6000);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!paused && posts.length > 1) setI((x) => (x + 1) % posts.length);
    // Advance on the shared clock tick.
  }, [now]);
  if (posts.length === 0) return null;
  const n = posts[i % posts.length] as NewsItem;
  return (
    <div
      className="tr-news-featured"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <button
        key={n.id}
        type="button"
        className="tr-news-feature tr-enter-fade"
        data-nav=""
        data-testid="news-featured"
        onClick={() => onOpen(n)}
      >
        <Hero n={n} />
        <span className="tr-news-feature-copy">
          <span className="tr-row" style={{ gap: '0.4em' }}>
            <span className="tr-news-tag">{n.tag}</span>
            {n.unread && <span className="tr-new-dot">NEW</span>}
            <small>{formatDate(n.date)}</small>
          </span>
          <b className="tr-title tr-h2">{n.title}</b>
          <span className="tr-clamp-2">{n.body}</span>
          <span className="tr-news-read">
            Read <Icon name="chevron-right" size="0.9em" />
          </span>
        </span>
      </button>
      {posts.length > 1 && (
        <div className="tr-news-dots" role="tablist" aria-label="Featured posts">
          {posts.map((p, j) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={j === i % posts.length}
              aria-label={p.title}
              data-nav=""
              onClick={() => setI(j)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Reader({ n, onBack }: { n: NewsItem; onBack: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Capture phase: stopping it here would starve the chat field of its own Esc.
      if (e.code !== 'Escape' || keyboardBusy(e) || layerAbove(ui.getState(), 'screen')) return;
      e.preventDefault();
      e.stopPropagation();
      onBack();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onBack]);
  return (
    <article className="tr-panel tr-news-reader tr-enter-fade" data-testid="news-reader">
      <div className="tr-news-reader-bar">
        <Button
          size="sm"
          variant="secondary"
          cue="ui.back"
          data-nav-back=""
          hint="Esc"
          onClick={onBack}
          data-testid="news-back"
        >
          <Icon name="chevron-left" size="0.9em" /> All news
        </Button>
        <span className="tr-news-tag">{n.tag}</span>
        <small className="tr-muted">{formatDate(n.date)}</small>
      </div>
      <div className="tr-news-reader-body">
        <Hero n={n} />
        <h1 className="tr-title tr-h1 tr-news-reader-title">{n.title}</h1>
        <p className="tr-news-lede">{n.body}</p>
        {(n.blocks ?? []).map((b, i) => {
          switch (b.type) {
            case 'heading':
              return (
                <h3 key={i} className="tr-title tr-h3">
                  {b.text}
                </h3>
              );
            case 'paragraph':
              return <p key={i}>{b.text}</p>;
            case 'list':
              return (
                <ul key={i} className="tr-news-list">
                  {b.items.map((it, j) => (
                    <li key={j}>{it}</li>
                  ))}
                </ul>
              );
            case 'tip':
              return (
                <p key={i} className="tr-news-tip">
                  <Icon name="star" size="1.3em" />
                  <span>{b.text}</span>
                </p>
              );
            case 'image':
              return (
                <figure key={i} className="tr-news-figure">
                  <SafeImg src={b.src} alt={b.caption ?? ''} fallback={null} />
                  {b.caption && <figcaption>{b.caption}</figcaption>}
                </figure>
              );
          }
        })}
      </div>
    </article>
  );
}

/** News tab. */
export function NewsTab(): JSX.Element {
  const news = useUI((s) => s.news);
  const [open, setOpen] = useState<string | null>(() => {
    const id = pendingPost;
    pendingPost = null;
    return id;
  });
  const post = news.find((n) => n.id === open) ?? null;
  useEffect(() => {
    if (post?.unread) uiEvents.emit('newsRead', { ids: [post.id] });
  }, [post?.id]);
  const openPost = (n: NewsItem): void => {
    playCue('ui.click');
    setOpen(n.id);
  };
  if (news.length === 0) return <div className="tr-panel tr-empty">No news is good news!</div>;
  if (post) return <Reader n={post} onBack={() => setOpen(null)} />;
  const featured = news.filter((n) => n.featured);
  const rest = news;
  return (
    <div className="tr-news">
      <Featured posts={featured.length > 0 ? featured : news.slice(0, 1)} onOpen={openPost} />
      <div className="tr-panel tr-news-index">
        <div className="tr-panel-head">
          <h2 className="tr-title tr-h3 tr-grow">All posts</h2>
          {news.some((n) => n.unread) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                uiEvents.emit('newsRead', { ids: news.filter((n) => n.unread).map((n) => n.id) })
              }
            >
              Mark all read
            </Button>
          )}
        </div>
        <div className="tr-news-list-grid">
          {rest.map((n, i) => (
            <button
              key={n.id}
              type="button"
              className={`tr-news-row${n.unread ? ' is-unread' : ''}`}
              style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}
              data-nav=""
              data-testid={`news-${n.id}`}
              onClick={() => openPost(n)}
            >
              <span
                className="tr-news-row-art"
                style={{ ['--art-a' as string]: n.art[0], ['--art-b' as string]: n.art[1] }}
              >
                <SafeImg src={n.image} fallback={<Icon name="news" size="1.8em" />} />
              </span>
              <span className="tr-col" style={{ gap: '0.15em', minWidth: 0, alignItems: 'flex-start' }}>
                <span className="tr-row" style={{ gap: '0.4em' }}>
                  <span className="tr-news-tag">{n.tag}</span>
                  {n.unread && <span className="tr-new-dot">NEW</span>}
                  <small className="tr-muted">{formatDate(n.date)}</small>
                </span>
                <b className="tr-news-row-title">{n.title}</b>
                <span className="tr-small tr-muted tr-clamp-2">{n.body}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
