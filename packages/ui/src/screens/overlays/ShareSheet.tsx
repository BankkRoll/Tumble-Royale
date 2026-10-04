/**
 * Share sheet for the finished show.
 *
 * Responsibilities:
 * - `ShareButton`: the rewards screen entry, shown when the show offers a
 *   card (a win or a notable finish) or recorded rounds to clip;
 * - `ShareLayer`: the modal sheet. Card tab: social or story format and the
 *   "show my name" toggle (off by default in Streamer Mode). Clip tab: pick a
 *   recorded round and a 5–15 s window with a trimmer that works with keys,
 *   pad and touch. Then rendering (progress + cancel), the result preview
 *   (Share / Save / Copy) or an error, and an explanation where the browser
 *   cannot make clips at all;
 * - focus: the sheet traps pad/keyboard navigation (`data-nav-scope`), moves
 *   focus to each state's main action and returns it to the Share button on
 *   close; progress and outcomes are announced through a live region.
 *
 * The game renders and delivers; the sheet only emits `shareCard`,
 * `shareClip`, `shareCancel`, `shareDeliver` and `shareClose`.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Bar } from '../../components/bits.tsx';
import { Button, Segmented, Toggle } from '../../components/controls.tsx';
import { useReducedMotion } from '../../components/hooks.ts';
import { Icon } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { featureOn } from '../../store/liveOps.ts';
import {
  shareUI,
  useShare,
  type ShareCardFormat,
  type ShareClipRound,
  type ShareOffer,
  type ShareResult,
} from '../../store/share.ts';
import { useUI } from '../../store/uiStore.ts';
import { formatReplayTime } from '../Replay.tsx';

/** Clip lengths the trimmer offers (s). */
export const CLIP_LENGTHS: readonly number[] = [5, 10, 15];
/** Trimmer nudge (s). */
const NUDGE = 1;

/**
 * Whether the show has anything to share.
 *
 * @param offer - The game's offer.
 * @param replaysOn - `replays.enabled`.
 */
export function shareAvailable(offer: ShareOffer | null, replaysOn: boolean): boolean {
  if (!offer) return false;
  return offer.card || (replaysOn && offer.clips.length > 0 && offer.clipSupport !== 'none');
}

/** Rewards screen entry point; renders nothing when there is nothing to share. */
export function ShareButton(): JSX.Element | null {
  const offer = useShare((s) => s.offer);
  const replaysOn = useUI((s) => featureOn(s.liveOps.flags, 'replays.enabled'));
  if (!shareAvailable(offer, replaysOn)) return null;
  return (
    <Button
      variant="secondary"
      size="lg"
      data-testid="share-open"
      data-share-return=""
      aria-haspopup="dialog"
      onClick={() => shareUI.getState().openSheet()}
    >
      <Icon name="share" size="1.1em" /> Share
    </Button>
  );
}

function close(): void {
  playCue('ui.back');
  uiEvents.emit('shareClose');
  shareUI.getState().closeSheet();
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function CardOptions({ offer }: { offer: ShareOffer }): JSX.Element {
  const streamer = useUI((s) => s.settings.gameplay.streamerMode);
  const [format, setFormat] = useState<ShareCardFormat>('social');
  const [includeName, setIncludeName] = useState(!streamer);
  return (
    <div className="tr-col tr-share-options" data-testid="share-card-options">
      <span className="tr-label">Format</span>
      <Segmented
        label="Card format"
        value={format}
        options={[
          { value: 'social', label: 'Post (1200×630)' },
          { value: 'story', label: 'Story (1080×1920)' },
        ]}
        onChange={setFormat}
      />
      <div className="tr-row tr-share-toggle">
        <span className="tr-grow">
          Show my name <b className="tr-ellipsis">{offer.playerName}</b>
          {streamer && <span className="tr-small tr-muted"> · Streamer Mode is on</span>}
        </span>
        <Toggle checked={includeName} onChange={setIncludeName} label="Show my name on the card" />
      </div>
      <p className="tr-small tr-muted">
        Other players' names never appear. The image is made on this device and is not uploaded.
      </p>
      <Button
        variant="go"
        size="lg"
        autoFocusNav
        data-testid="share-make-card"
        onClick={() => uiEvents.emit('shareCard', { format, includeName })}
      >
        <Icon name="camera" size="1.1em" /> Make card
      </Button>
    </div>
  );
}

function outcomeLabel(c: ShareClipRound): string {
  return c.outcome === 'qualified' ? 'Qualified' : c.outcome === 'eliminated' ? 'Out' : 'Watched';
}

/**
 * The clip window picker: round chips, length presets and a start trimmer.
 */
function ClipOptions({ offer }: { offer: ShareOffer }): JSX.Element {
  const first =
    offer.clips.find((c) => c.key === offer.defaultClipKey) ?? offer.clips[offer.clips.length - 1];
  const [key, setKey] = useState(first?.key ?? '');
  const round = offer.clips.find((c) => c.key === key) ?? first;
  const [length, setLength] = useState(first?.defaultLength ?? 10);
  const [start, setStart] = useState(first?.defaultStart ?? 0);
  if (!round) return <p className="tr-muted">No rounds were recorded in this show.</p>;
  const len = Math.min(length, round.duration);
  const maxStart = Math.max(0, round.duration - len);
  const s = Math.min(Math.max(0, start), maxStart);
  const pct = (t: number): string => `${round.duration > 0 ? (t / round.duration) * 100 : 0}%`;
  const pick = (c: ShareClipRound): void => {
    playCue('ui.toggle');
    setKey(c.key);
    setLength(c.defaultLength);
    setStart(c.defaultStart);
  };
  return (
    <div className="tr-col tr-share-options" data-testid="share-clip-options">
      <span className="tr-label" id="share-round-label">
        Round
      </span>
      <div className="tr-row tr-wrap" role="radiogroup" aria-labelledby="share-round-label">
        {offer.clips.map((c) => (
          <button
            key={c.key}
            type="button"
            role="radio"
            aria-checked={c.key === round.key}
            data-nav=""
            className={`tr-chip tr-share-round is-${c.outcome}${c.key === round.key ? ' is-on' : ''}`}
            title={`${c.name} · ${outcomeLabel(c)}`}
            onClick={() => pick(c)}
          >
            {c.isFinal ? 'Final' : `R${c.roundIndex + 1}`} · {c.name}
          </button>
        ))}
      </div>
      <span className="tr-label">Length</span>
      <Segmented
        label="Clip length"
        value={CLIP_LENGTHS.includes(length) ? length : 10}
        options={CLIP_LENGTHS.map((v) => ({ value: v, label: `${v} s` }))}
        onChange={setLength}
      />
      <span className="tr-label">Start</span>
      <div className="tr-share-trim" aria-hidden>
        <span className="tr-share-trim-window" style={{ left: pct(s), width: pct(len) }} />
      </div>
      <div className="tr-row tr-share-trim-row">
        <Button
          variant="secondary"
          size="sm"
          aria-label="Start 1 second earlier"
          onClick={() => setStart(s - NUDGE)}
        >
          <Icon name="chevron-left" size="0.9em" /> 1s
        </Button>
        <input
          type="range"
          className="tr-slider tr-grow"
          data-nav=""
          min={0}
          max={Math.max(0.1, maxStart)}
          step={0.1}
          value={s}
          aria-label="Clip start"
          aria-valuetext={`${formatReplayTime(s)} to ${formatReplayTime(s + len)}`}
          onChange={(e) => setStart(Number(e.currentTarget.value))}
        />
        <Button
          variant="secondary"
          size="sm"
          aria-label="Start 1 second later"
          onClick={() => setStart(s + NUDGE)}
        >
          1s <Icon name="chevron-right" size="0.9em" />
        </Button>
      </div>
      <p className="tr-small" data-testid="share-clip-window">
        {formatReplayTime(s)} – {formatReplayTime(s + len)} of {formatReplayTime(round.duration)} ·{' '}
        {offer.clipQuality} · 30 fps · no sound
      </p>
      <Button
        variant="go"
        size="lg"
        autoFocusNav
        data-testid="share-make-clip"
        onClick={() => uiEvents.emit('shareClip', { key: round.key, start: s, length: len })}
      >
        <Icon name="film" size="1.1em" /> Make clip
      </Button>
    </div>
  );
}

function ClipUnavailable({ offer, replaysOn }: { offer: ShareOffer; replaysOn: boolean }): JSX.Element {
  let body: string;
  if (!replaysOn) body = 'Replays are switched off right now, so there is nothing to clip.';
  else if (offer.clipSupport === 'checking') body = 'Checking what this browser can record…';
  else if (offer.clipSupport === 'none')
    body =
      "This browser can't record video clips. A share card still works, or try a recent Chrome, Edge, Firefox or Safari.";
  else body = 'No rounds were recorded in this show.';
  return (
    <div className="tr-empty" role="status" data-testid="share-clip-unsupported">
      <Icon name="film" size="2.4em" />
      <p>{body}</p>
    </div>
  );
}

function Preview({ r }: { r: ShareResult }): JSX.Element {
  const reduced = useReducedMotion();
  const tall = r.height > r.width;
  if (r.kind === 'card')
    return (
      <img
        className={`tr-share-preview${tall ? ' is-tall' : ''}`}
        src={r.url}
        width={r.width}
        height={r.height}
        alt={`Your share card, ${r.width} by ${r.height}`}
        data-testid="share-preview-card"
      />
    );
  return (
    <video
      className={`tr-share-preview${tall ? ' is-tall' : ''}`}
      src={r.url}
      width={r.width}
      height={r.height}
      controls
      muted
      loop
      playsInline
      autoPlay={!reduced}
      aria-label={`Your clip, ${Math.round(r.duration ?? 0)} seconds, no sound`}
      data-testid="share-preview-clip"
    />
  );
}

function ResultActions({ r }: { r: ShareResult }): JSX.Element {
  return (
    <div className="tr-row tr-wrap tr-share-actions">
      {r.canShare && (
        <Button
          variant="go"
          size="lg"
          autoFocusNav
          data-testid="share-deliver-share"
          onClick={() => uiEvents.emit('shareDeliver', { action: 'share' })}
        >
          <Icon name="share" size="1.1em" /> Share
        </Button>
      )}
      {r.canDownload && (
        <Button
          variant={r.canShare ? 'secondary' : 'go'}
          size="lg"
          autoFocusNav={!r.canShare}
          data-testid="share-deliver-download"
          onClick={() => uiEvents.emit('shareDeliver', { action: 'download' })}
        >
          <Icon name="download" size="1.1em" /> Save
        </Button>
      )}
      {r.canCopy && (
        <Button
          variant="secondary"
          size="lg"
          autoFocusNav={!r.canShare && !r.canDownload}
          data-testid="share-deliver-copy"
          onClick={() => uiEvents.emit('shareDeliver', { action: 'copy' })}
        >
          <Icon name="copy" size="1.1em" /> Copy
        </Button>
      )}
      <Button
        variant="secondary"
        size="lg"
        onClick={() => shareUI.getState().patchSheet({ status: 'idle', result: null, notice: null })}
      >
        <Icon name="refresh" size="1em" /> Make another
      </Button>
    </div>
  );
}

/** The share sheet (renders nothing while closed). */
export function ShareLayer(): JSX.Element | null {
  const sheet = useShare((s) => s.sheet);
  const offer = useShare((s) => s.offer);
  const replaysOn = useUI((s) => featureOn(s.liveOps.flags, 'replays.enabled'));
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const clipsUsable = !!offer && replaysOn && offer.clips.length > 0 && offer.clipSupport !== 'none';
  const tabs = useMemo(
    () =>
      [
        offer?.card ? { id: 'card' as const, label: 'Card' } : null,
        offer && replaysOn && offer.clips.length > 0 ? { id: 'clip' as const, label: 'Clip' } : null,
      ].filter((t): t is { id: 'card' | 'clip'; label: string } => t !== null),
    [offer, replaysOn],
  );

  useEffect(() => {
    if (!sheet.open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const back = opener.current?.isConnected
        ? opener.current
        : document.querySelector<HTMLElement>('[data-share-return]');
      back?.focus({ preventScroll: true });
    };
  }, [sheet.open]);

  useEffect(() => {
    if (!sheet.open) return;
    const el = ref.current?.querySelector<HTMLElement>('[data-autofocus]');
    el?.focus({ preventScroll: true });
  }, [sheet.open, sheet.status, sheet.tab, offer?.clipSupport]);

  if (!sheet.open || !offer) return null;
  const busy = sheet.status === 'rendering';
  const tab = tabs.some((t) => t.id === sheet.tab) ? sheet.tab : (tabs[0]?.id ?? 'card');
  const status =
    sheet.status === 'rendering'
      ? sheet.task === 'clip'
        ? `Rendering clip… ${Math.round(sheet.progress * 100)}%`
        : 'Making your card…'
      : sheet.status === 'ready'
        ? (sheet.notice ?? `${sheet.result?.kind === 'clip' ? 'Clip' : 'Card'} ready`)
        : sheet.status === 'error'
          ? (sheet.error ?? 'Something went wrong')
          : '';

  return (
    <div
      ref={ref}
      className="tr-dialog-wrap tr-interactive"
      data-nav-scope="12"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-title"
      data-testid="share-sheet"
      data-status={sheet.status}
    >
      <div className="tr-dim" onClick={busy ? undefined : close} />
      <div className="tr-panel tr-share tr-enter-pop">
        <div className="tr-row tr-share-head">
          <h2 className="tr-title tr-h2 tr-grow" id="share-title">
            Share · {offer.headline}
          </h2>
          {!busy && (
            <button
              type="button"
              className="tr-close"
              data-nav=""
              data-nav-back=""
              aria-label="Close"
              onClick={close}
            >
              <Icon name="close" size="1em" />
            </button>
          )}
        </div>

        {sheet.status === 'idle' && tabs.length > 1 && (
          <div className="tr-row tr-share-tabs" role="tablist" aria-label="What to share" data-nav-tabs="">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                data-nav=""
                className={`tr-chip tr-share-tab${tab === t.id ? ' is-on' : ''}`}
                onClick={() => {
                  playCue('ui.tab');
                  shareUI.getState().patchSheet({ tab: t.id });
                }}
              >
                <Icon name={t.id === 'card' ? 'camera' : 'film'} size="1em" /> {t.label}
              </button>
            ))}
          </div>
        )}

        <p className="tr-sr-only" role="status" aria-live="polite" data-testid="share-status">
          {status}
        </p>

        {sheet.status === 'idle' &&
          (tab === 'card' ? (
            <CardOptions offer={offer} />
          ) : clipsUsable && offer.clipSupport !== 'checking' ? (
            <ClipOptions offer={offer} />
          ) : (
            <ClipUnavailable offer={offer} replaysOn={replaysOn} />
          ))}

        {busy && (
          <div className="tr-col tr-share-busy" data-testid="share-progress">
            <span className="tr-gumball-spinner" aria-hidden />
            <p aria-hidden>{status}</p>
            {sheet.task === 'clip' && <Bar value={sheet.progress} large label="Clip progress" />}
            <Button
              variant="secondary"
              size="lg"
              autoFocusNav
              data-nav-back=""
              data-testid="share-cancel"
              cue="ui.back"
              onClick={() => uiEvents.emit('shareCancel')}
            >
              <Icon name="close" size="0.9em" /> Cancel
            </Button>
          </div>
        )}

        {sheet.status === 'ready' && sheet.result && (
          <div className="tr-col tr-share-ready" data-testid="share-ready">
            <Preview r={sheet.result} />
            <p className="tr-small tr-muted">
              {sheet.result.fileName} · {sizeLabel(sheet.result.bytes)}
            </p>
            {sheet.notice && (
              <p className="tr-small tr-share-notice" aria-hidden>
                {sheet.notice}
              </p>
            )}
            <ResultActions r={sheet.result} />
          </div>
        )}

        {sheet.status === 'error' && (
          <div className="tr-col tr-share-error" data-testid="share-error">
            <p>{sheet.error ?? 'Something went wrong.'}</p>
            <Button
              variant="go"
              size="lg"
              autoFocusNav
              onClick={() => shareUI.getState().patchSheet({ status: 'idle', error: null })}
            >
              <Icon name="refresh" size="1em" /> Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
