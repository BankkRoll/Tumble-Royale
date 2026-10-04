/**
 * App-level share system: share cards and replay clips for the show just
 * played, made and delivered entirely on this device (no upload).
 *
 * Responsibilities:
 * - when a show ends, keep its result and offer a card (a win or a notable
 *   finish) and clips of the recorded rounds (only while `replays.enabled`
 *   is on, re-checked live) through the share store;
 * - render cards (posed Tumbler + 2D layout → PNG) and clips (offscreen
 *   deterministic replay → WebCodecs / MediaRecorder) on intents from the
 *   sheet, with progress, cancel and errors;
 * - hold at most one result and one object URL, revoked when replaced, when
 *   the sheet closes and when the rewards screen goes away;
 * - deliver through Web Share / download / clipboard and report `share.card`
 *   and `share.clip` analytics.
 */
import type { ToneMappingMode } from '@tumble/render/post';
import type { QualityTier } from '@tumble/render/quality';
import type { CreateTumblerVisual, TumblerLoadout } from '@tumble/render/scenes';
import type { AnalyticsValue } from '@tumble/shared/liveops';
import {
  bindUI,
  shareUI,
  ui,
  type ClipSupport,
  type ShareCardFormat,
  type ShareClipRound,
  type ShareResult,
} from '@tumble/ui';
import type { WebGPURenderer } from 'three/webgpu';
import type { ReplayData } from '../replay/format.ts';
import type { ReplayLibrary } from '../replay/library.ts';
import type { ReplayView } from '../replay/view.ts';
import type { CeremonyPost } from '../views/ceremonies.ts';
import { CARD_BODY_FONT, CARD_DISPLAY_FONT, CARD_SIZES, layoutShareCard } from './cardLayout.ts';
import { drawShareCard } from './cardDraw.ts';
import { renderPose } from './cardPose.ts';
import {
  browserEncoderEnv,
  openClipSink,
  pickClipFormat,
  type ClipEncoderEnv,
  type ClipFormat,
} from './clipEncoder.ts';
import { abortError, renderClip } from './clipRender.ts';
import { clampClipWindow, clipOffer } from './clipWindow.ts';
import {
  cardDataFromFacts,
  cardFileName,
  clipFileName,
  isShareworthy,
  offerHeadline,
  type ShareShowFacts,
} from './shareFacts.ts';
import {
  browserShareEnv,
  deliverFile,
  shareCapabilities,
  type ShareEnv,
  type ShareOutcome,
} from './shareTarget.ts';

/** Clip size per quality tier: 1080p on High/Ultra, 720p otherwise. */
export function clipSize(tier: QualityTier): { width: number; height: number } {
  return tier === 'high' || tier === 'ultra' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
}

const NO_POST: CeremonyPost = { punch: () => {}, flash: () => {}, setFocusVignette: () => {} };
const FONT_WAIT_MS = 1500;
/** Progress pushes per second while a clip renders. */
const PROGRESS_HZ = 8;

/** What the share system needs from the app. */
export interface ShareControllerDeps {
  renderer: WebGPURenderer;
  createTumbler: CreateTumblerVisual;
  /** The local player's look. */
  look: () => TumblerLoadout;
  playerName: () => string;
  /** The show's recordings. */
  library: ReplayLibrary;
  /** Builds a replay view offscreen (`ReplayController.createView`). */
  createReplayView: (data: ReplayData, post: CeremonyPost) => ReplayView;
  tier: () => QualityTier;
  toneMapping: () => ToneMappingMode;
  /** `replays.enabled` right now. */
  replaysEnabled: () => boolean;
  /** Calls back when feature flags change; returns unsubscribe. */
  onFlagsChanged: (fn: () => void) => () => void;
  track: (name: 'share.card' | 'share.clip', props: Record<string, AnalyticsValue>) => void;
  /** Browser surfaces (tests inject fakes). */
  shareEnv?: ShareEnv;
  encoderEnv?: ClipEncoderEnv;
}

interface Held {
  file: File;
  url: string;
  kind: 'card' | 'clip';
  props: Record<string, AnalyticsValue>;
}

function waitFonts(): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return Promise.resolve();
  const load = Promise.all([
    fonts.load(`400 64px ${CARD_DISPLAY_FONT}`),
    fonts.load(`600 32px ${CARD_BODY_FONT}`),
  ]).then(() => undefined);
  return Promise.race([load.catch(() => undefined), new Promise<void>((r) => setTimeout(r, FONT_WAIT_MS))]);
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

const NOTICES: Record<ShareOutcome, string | null> = {
  shared: 'Shared!',
  downloaded: 'Saved to your downloads',
  copied: 'Copied to the clipboard',
  cancelled: null,
  failed: "That didn't work. Try Save instead.",
  unsupported: "This browser can't do that. Try Save instead.",
};

/**
 * The share system.
 *
 * @example
 * const share = new ShareController(deps);
 * ctx.onShowResult = (facts) => share.showFinished(facts);
 */
export class ShareController {
  private facts: ShareShowFacts | null = null;
  private endedAt = 0;
  private format: ClipFormat | null = null;
  private formatFor = '';
  private task: AbortController | null = null;
  private held: Held | null = null;
  private lastScreen = ui.getState().screen;
  private readonly offs: (() => void)[] = [];
  private readonly shareEnv: ShareEnv;
  private readonly encoderEnv: ClipEncoderEnv;

  constructor(private readonly deps: ShareControllerDeps) {
    this.shareEnv = deps.shareEnv ?? browserShareEnv();
    this.encoderEnv = deps.encoderEnv ?? browserEncoderEnv();
    this.offs.push(
      bindUI({
        onShareCard: ({ format, includeName }) => void this.makeCard(format, includeName),
        onShareClip: ({ key, start, length }) => void this.makeClip(key, start, length),
        onShareCancel: () => this.cancel(),
        onShareDeliver: ({ action }) => this.deliver(action),
        onShareClose: () => this.release(),
      }),
      ui.subscribe((s) => {
        if (s.screen === this.lastScreen) return;
        const left = this.lastScreen === 'rewards';
        this.lastScreen = s.screen;
        if (left) this.clear();
      }),
      deps.onFlagsChanged(() => {
        if (!deps.replaysEnabled() && this.task && shareUI.getState().sheet.task === 'clip') this.cancel();
        this.publishOffer();
      }),
    );
  }

  /**
   * A show ended: offer what it earned.
   *
   * @param facts - The local player's result.
   */
  showFinished(facts: ShareShowFacts): void {
    this.clear();
    this.facts = facts;
    this.endedAt = Date.now();
    this.publishOffer();
  }

  private publishOffer(): void {
    const f = this.facts;
    if (!f) return;
    const offer = this.deps.replaysEnabled()
      ? clipOffer(this.deps.library.list())
      : { rounds: [], defaultKey: null };
    const clips: ShareClipRound[] = offer.rounds.map((c) => ({
      key: c.key,
      roundIndex: c.roundIndex,
      name: c.name,
      isFinal: c.isFinal,
      outcome: c.outcome,
      duration: c.duration,
      defaultStart: c.defaultStart,
      defaultLength: c.defaultLength,
    }));
    const size = clipSize(this.deps.tier());
    const key = `${size.width}x${size.height}`;
    const known: ClipSupport =
      this.formatFor === key ? (this.format ? this.format.encoder : 'none') : 'checking';
    shareUI.getState().setOffer({
      card: isShareworthy(f),
      headline: offerHeadline(f),
      playerName: this.deps.playerName(),
      clips,
      defaultClipKey: offer.defaultKey,
      clipSupport: known,
      clipQuality: `${size.height}p`,
    });
    if (known === 'checking') void this.detectFormat(size.width, size.height, key);
  }

  private async detectFormat(width: number, height: number, key: string): Promise<void> {
    const format: ClipFormat | null = await pickClipFormat(width, height, this.encoderEnv).catch(() => null);
    this.format = format;
    this.formatFor = key;
    shareUI.getState().patchOffer({ clipSupport: format ? format.encoder : 'none' });
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private begin(task: 'card' | 'clip'): AbortController | null {
    if (this.task) return null;
    this.dropHeld();
    const ctl = new AbortController();
    this.task = ctl;
    shareUI
      .getState()
      .patchSheet({ status: 'rendering', task, progress: 0, error: null, notice: null, result: null });
    return ctl;
  }

  private finish(ctl: AbortController, held: Held, extra: Partial<ShareResult>): void {
    if (this.task === ctl) this.task = null;
    if (ctl.signal.aborted || !shareUI.getState().sheet.open) {
      URL.revokeObjectURL(held.url);
      return;
    }
    this.held = held;
    const caps = shareCapabilities(this.shareEnv, held.file);
    shareUI.getState().patchSheet({
      status: 'ready',
      task: null,
      progress: 1,
      result: {
        kind: held.kind,
        url: held.url,
        mime: held.file.type,
        fileName: held.file.name,
        bytes: held.file.size,
        width: 0,
        height: 0,
        canShare: caps.share,
        canDownload: caps.download,
        canCopy: caps.copy,
        ...extra,
      },
    });
  }

  private fail(
    ctl: AbortController,
    err: unknown,
    kind: 'card' | 'clip',
    props: Record<string, AnalyticsValue>,
  ): void {
    if (this.task === ctl) this.task = null;
    const cancelled = isAbort(err) || ctl.signal.aborted;
    this.deps.track(kind === 'card' ? 'share.card' : 'share.clip', {
      ...props,
      outcome: cancelled ? 'render_cancelled' : 'render_failed',
    });
    if (!shareUI.getState().sheet.open) return;
    if (cancelled) {
      shareUI.getState().patchSheet({ status: 'idle', task: null, progress: 0, notice: null });
      return;
    }
    console.warn(`[share] ${kind} failed`, err);
    shareUI.getState().patchSheet({
      status: 'error',
      task: null,
      error:
        kind === 'card'
          ? "Couldn't make the card on this device."
          : `Couldn't make the clip${err instanceof Error && err.message ? `: ${err.message}` : '.'}`,
    });
  }

  private async makeCard(format: ShareCardFormat, includeName: boolean): Promise<void> {
    const f = this.facts;
    if (!f) return;
    const ctl = this.begin('card');
    if (!ctl) return;
    const props: Record<string, AnalyticsValue> = { format, named: includeName, crowned: f.wonCrown };
    try {
      await waitFonts();
      if (ctl.signal.aborted) throw abortError();
      let figure: HTMLCanvasElement | null = null;
      try {
        figure = await renderPose(this.deps.renderer, this.deps.createTumbler, this.deps.look(), f.wonCrown);
      } catch (err) {
        // A backend that cannot read pixels back still gets a card, just without the Tumbler.
        console.warn('[share] pose render failed', err);
      }
      if (ctl.signal.aborted) throw abortError();
      const data = cardDataFromFacts(f, this.deps.playerName(), includeName, this.endedAt);
      const { width, height } = CARD_SIZES[format];
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas unavailable');
      const layout = layoutShareCard(data, format, (text, font) => {
        ctx.font = font;
        return ctx.measureText(text).width;
      });
      drawShareCard(ctx, layout, data, figure);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) throw new Error('PNG encoding failed');
      const file = new File([blob], cardFileName(f.playlistName, format, this.endedAt), {
        type: 'image/png',
      });
      this.finish(ctl, { file, url: URL.createObjectURL(file), kind: 'card', props }, { width, height });
    } catch (err) {
      this.fail(ctl, err, 'card', props);
    }
  }

  private async makeClip(key: string, start: number, length: number): Promise<void> {
    const entry = this.deps.library.get(key);
    const size = clipSize(this.deps.tier());
    const format = this.format;
    const props: Record<string, AnalyticsValue> = {
      format: format?.container ?? 'none',
      encoder: format?.encoder ?? 'none',
      height: size.height,
    };
    const ctl = this.begin('clip');
    if (!ctl) return;
    try {
      if (!this.deps.replaysEnabled()) throw new Error('replays are switched off');
      if (!entry) throw new Error('that round is no longer recorded');
      if (!format) throw new Error("this browser can't record video");
      const win = clampClipWindow({ start, length }, entry.data.header.duration);
      props.seconds = Math.round(win.length);
      let lastPush = 0;
      const blob = await renderClip({
        renderer: this.deps.renderer,
        createView: () => this.deps.createReplayView(entry.data, NO_POST),
        window: win,
        ...size,
        toneMapping: this.deps.toneMapping(),
        roundName: entry.data.header.isFinal
          ? `Final · ${entry.data.header.roundName}`
          : entry.data.header.roundName,
        openSink: (canvas) => openClipSink(format, canvas),
        signal: ctl.signal,
        onProgress: (p) => {
          const now = performance.now();
          if (p < 1 && now - lastPush < 1000 / PROGRESS_HZ) return;
          lastPush = now;
          if (this.task === ctl) shareUI.getState().patchSheet({ progress: p });
        },
      });
      const type = blob.type || format.mime;
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const file = new File([blob], clipFileName(entry.data.header.roundName, ext, this.endedAt), { type });
      this.finish(
        ctl,
        { file, url: URL.createObjectURL(file), kind: 'clip', props },
        { ...size, duration: win.length },
      );
    } catch (err) {
      this.fail(ctl, err, 'clip', props);
    }
  }

  /** Stops the render in progress (the sheet goes back to its options). */
  cancel(): void {
    this.task?.abort();
  }

  // ---------------------------------------------------------------------------
  // Delivery
  // ---------------------------------------------------------------------------

  private deliver(action: 'share' | 'download' | 'copy'): void {
    const held = this.held;
    if (!held) return;
    const title = shareUI.getState().offer?.headline ?? 'Tumble Royale';
    // Called synchronously from the click so Web Share keeps the user activation.
    void deliverFile(held.file, action, this.shareEnv, { title: `Tumble Royale · ${title}` }).then(
      (outcome) => {
        this.deps.track(held.kind === 'card' ? 'share.card' : 'share.clip', {
          ...held.props,
          action,
          outcome,
        });
        if (this.held !== held) return;
        shareUI.getState().patchSheet({ notice: NOTICES[outcome] });
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Lifetime
  // ---------------------------------------------------------------------------

  private dropHeld(): void {
    if (this.held) URL.revokeObjectURL(this.held.url);
    this.held = null;
  }

  /** The sheet closed: stop rendering and drop the file. */
  private release(): void {
    this.cancel();
    this.dropHeld();
  }

  /** Forgets the show (new show, or the rewards screen went away). */
  clear(): void {
    this.release();
    this.facts = null;
    const s = shareUI.getState();
    s.closeSheet();
    s.setOffer(null);
  }

  /** App teardown. */
  dispose(): void {
    this.clear();
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
