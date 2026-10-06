/**
 * The show's highlights on the rewards screen.
 *
 * Responsibilities:
 * - list the automatic highlights the game found (best first) with a line
 *   on what happened, where, and Watch / Share buttons; Play all runs them
 *   back to back in the replay viewer;
 * - Share opens the share sheet's clip tab on the highlight's window;
 * - an empty state when rounds were recorded but nothing stood out, and
 *   nothing at all while replays are switched off.
 *
 * Names follow Streamer Mode. The UI only emits `highlightPlay` and
 * `highlightShare`; the game plays and renders.
 */
import { type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { Button } from '../components/controls.tsx';
import { Icon, type IconName } from '../components/icons/index.tsx';
import { uiEvents } from '../store/events.ts';
import { HIGHLIGHT_HEADINGS, highlightPlace, highlightTitle } from '../store/highlights.ts';
import { featureOn } from '../store/liveOps.ts';
import { shareUI, useShare } from '../store/share.ts';
import type { HighlightEntry, HighlightKind } from '../store/types.ts';
import { useUI } from '../store/uiStore.ts';

const ICONS: Readonly<Record<HighlightKind, IconName>> = {
  finalWin: 'crown',
  closeFinish: 'flag',
  lastSecondQualify: 'stopwatch',
  bigFall: 'dive',
  chainGrab: 'grab',
  comeback: 'refresh',
  clutchSurvival: 'hourglass',
  decisiveScore: 'target',
};

function share(h: HighlightEntry): void {
  playCue('ui.confirm');
  uiEvents.emit('highlightShare', { id: h.id });
  shareUI.getState().openSheet('clip', { key: h.key, start: h.start, length: h.length });
}

/** The rewards screen's highlight reel (renders nothing while replays are off or nothing was recorded). */
export function HighlightsReel(): JSX.Element | null {
  const items = useUI((s) => s.highlights);
  const recorded = useUI((s) => s.replays.length > 0);
  const replaysOn = useUI((s) => featureOn(s.liveOps.flags, 'replays.enabled'));
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const offer = useShare((s) => s.offer);
  if (!replaysOn || (!recorded && items.length === 0)) return null;
  const canClip = (h: HighlightEntry): boolean =>
    !!offer && offer.clipSupport !== 'none' && offer.clips.some((c) => c.key === h.key);
  return (
    <section className="tr-highlights" aria-labelledby="highlights-title" data-testid="highlights">
      <div className="tr-row tr-highlights-head">
        <span className="tr-label" id="highlights-title">
          <Icon name="star" size="1.1em" /> Highlights
        </span>
        {items.length > 1 && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="highlights-play-all"
            onClick={() => {
              playCue('ui.confirm');
              uiEvents.emit('highlightPlay', { ids: items.map((h) => h.id) });
            }}
          >
            <Icon name="play" size="0.9em" /> Play all
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="tr-small tr-muted tr-highlights-empty" data-testid="highlights-empty">
          No highlights this show. Rewatch any round below.
        </p>
      ) : (
        <ol className="tr-highlights-list">
          {items.map((h) => {
            const title = highlightTitle(h, streamer);
            return (
              <li key={h.id} className={`tr-highlight is-${h.kind}`} data-testid="highlight">
                <Icon name={ICONS[h.kind]} size="1.3em" />
                <span className="tr-col tr-grow tr-highlight-text">
                  <b className="tr-ellipsis">{HIGHLIGHT_HEADINGS[h.kind]}</b>
                  <span className="tr-small tr-ellipsis" title={title}>
                    {title}
                  </span>
                  <span className="tr-small tr-muted tr-ellipsis">{highlightPlace(h)}</span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`Watch: ${title}`}
                  data-testid="highlight-watch"
                  onClick={() => {
                    playCue('ui.confirm');
                    uiEvents.emit('highlightPlay', { ids: [h.id] });
                  }}
                >
                  <Icon name="play" size="0.9em" />
                </Button>
                {canClip(h) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Share a clip: ${title}`}
                    data-share-return=""
                    data-testid="highlight-share"
                    onClick={() => share(h)}
                  >
                    <Icon name="share" size="0.9em" />
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
