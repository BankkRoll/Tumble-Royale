/**
 * Share sheet: every state renders from the share store (idle card and clip
 * options, rendering with progress and Cancel, ready with the actions the
 * browser supports, error, unsupported), the Share button only appears when
 * there is something to share, clips follow `replays.enabled`, Streamer Mode
 * starts the name toggle off, and nothing uses emoji.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { ShareButton, ShareLayer, shareAvailable } from '../src/screens/overlays/ShareSheet.tsx';
import { CLOSED_SHARE_SHEET, shareUI, type ShareOffer, type ShareResult } from '../src/store/share.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(shareUI as unknown as { getInitialState: () => unknown }).getInitialState = shareUI.getState;

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2700}-\u{27BF}]|\u{FE0F}/u;

function offer(over: Partial<ShareOffer> = {}): ShareOffer {
  return {
    card: true,
    headline: 'Crowned!',
    playerName: 'Sprinkles',
    clips: [
      {
        key: '1:0',
        roundIndex: 0,
        name: 'Gumdrop Gauntlet',
        isFinal: false,
        outcome: 'qualified',
        duration: 64,
        defaultStart: 37.5,
        defaultLength: 10,
      },
      {
        key: '1:2',
        roundIndex: 2,
        name: 'Crown Climb',
        isFinal: true,
        outcome: 'qualified',
        duration: 48,
        defaultStart: 30,
        defaultLength: 10,
      },
    ],
    defaultClipKey: '1:2',
    clipSupport: 'webcodecs',
    clipQuality: '720p',
    ...over,
  };
}

function result(over: Partial<ShareResult> = {}): ShareResult {
  return {
    kind: 'card',
    url: 'blob:card',
    mime: 'image/png',
    fileName: 'tumble-royale-main-show-2026-10-04-social.png',
    bytes: 412_000,
    width: 1200,
    height: 630,
    canShare: true,
    canDownload: true,
    canCopy: true,
    ...over,
  };
}

function flags(replays: boolean): void {
  const s = ui.getState();
  ui.setState({ liveOps: { ...s.liveOps, flags: { ...s.liveOps.flags, 'replays.enabled': replays } } });
}

function streamer(on: boolean): void {
  const s = ui.getState().settings;
  ui.setState({ settings: { ...s, gameplay: { ...s.gameplay, streamerMode: on } } });
}

function open(tab: 'card' | 'clip', patch: Partial<typeof CLOSED_SHARE_SHEET> = {}): string {
  shareUI.getState().openSheet(tab);
  shareUI.getState().patchSheet(patch);
  return renderToStaticMarkup(<ShareLayer />);
}

function controls(html: string): string[] {
  const out: string[] = [];
  const re = /<(button)[^>]*>([\s\S]*?)<\/\1>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push((m[2] ?? '').replace(/<[^>]+>/g, ''));
  return out;
}

describe('share sheet', () => {
  beforeEach(() => {
    shareUI.setState({ offer: offer(), sheet: CLOSED_SHARE_SHEET });
    flags(true);
    streamer(false);
  });

  it('renders nothing while closed', () => {
    expect(renderToStaticMarkup(<ShareLayer />)).toBe('');
  });

  it('idle card: formats, name toggle, privacy note and Make card', () => {
    const html = open('card');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-nav-scope="12"');
    expect(html).toContain('Share · Crowned!');
    expect(html).toContain('Post (1200×630)');
    expect(html).toContain('Story (1080×1920)');
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Show my name on the card"/);
    expect(html).toContain('not uploaded');
    expect(html).toMatch(/data-autofocus=""[^>]*data-testid="share-make-card"/);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('data-nav-back=""');
    for (const t of controls(html)) expect(t).not.toMatch(EMOJI);
  });

  it('starts the name toggle off in Streamer Mode', () => {
    streamer(true);
    const html = open('card');
    expect(html).toMatch(/role="switch" aria-checked="false"/);
    expect(html).toContain('Streamer Mode is on');
  });

  it('idle clip: round picker on the default round, lengths and trimmer', () => {
    const html = open('clip');
    expect(html).toContain('data-testid="share-clip-options"');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Final · Crown Climb/);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>R1 · Gumdrop Gauntlet/);
    for (const s of ['5 s', '10 s', '15 s']) expect(html).toContain(s);
    expect(html).toContain('aria-label="Clip start"');
    expect(html).toContain('aria-label="Start 1 second earlier"');
    expect(html).toContain('0:30.0 – 0:40.0 of 0:48.0');
    expect(html).toContain('720p');
    for (const t of controls(html)) expect(t).not.toMatch(EMOJI);
  });

  it('unsupported: explains instead of offering a clip it cannot make', () => {
    shareUI.getState().patchOffer({ clipSupport: 'none' });
    const html = open('clip');
    expect(html).toContain('data-testid="share-clip-unsupported"');
    expect(html).toContain('can&#x27;t record video clips');
    expect(html).not.toContain('share-make-clip');
    shareUI.getState().patchOffer({ clipSupport: 'checking' });
    expect(open('clip')).toContain('Checking what this browser can record');
  });

  it('rendering: spinner, progress, announced status and a focused Cancel that Back triggers', () => {
    const html = open('clip', { status: 'rendering', task: 'clip', progress: 0.42 });
    expect(html).toContain('data-status="rendering"');
    expect(html).toContain('data-testid="share-progress"');
    expect(html).toContain('Rendering clip… 42%');
    expect(html).toMatch(/aria-live="polite"[^>]*>Rendering clip… 42%/);
    expect(html).toMatch(/data-autofocus=""[^>]*data-nav-back=""[^>]*data-testid="share-cancel"/);
    // The close button is gone while busy: Back cancels instead of leaving a render running.
    expect(html).not.toContain('aria-label="Close"');
    expect(html).toContain('Clip progress');
  });

  it('cancel: back to the options with nothing left over', () => {
    open('clip', { status: 'rendering', task: 'clip', progress: 0.5 });
    shareUI.getState().patchSheet({ status: 'idle', task: null, progress: 0 });
    const html = renderToStaticMarkup(<ShareLayer />);
    expect(html).toContain('data-status="idle"');
    expect(html).toContain('share-make-clip');
    expect(html).not.toContain('share-progress');
  });

  it('ready card: preview with alt text and Share / Save / Copy', () => {
    const html = open('card', { status: 'ready', result: result() });
    expect(html).toContain('data-testid="share-preview-card"');
    expect(html).toContain('alt="Your share card, 1200 by 630"');
    expect(html).toContain('share-deliver-share');
    expect(html).toContain('share-deliver-download');
    expect(html).toContain('share-deliver-copy');
    expect(html).toContain('402 KB');
    expect(html).toMatch(/data-autofocus=""[^>]*data-testid="share-deliver-share"/);
  });

  it('ready clip: muted looping video, no autoplay with Reduce Motion, no Copy', () => {
    const r = result({
      kind: 'clip',
      url: 'blob:clip',
      mime: 'video/webm',
      width: 1280,
      height: 720,
      duration: 10,
      canCopy: false,
      canShare: false,
    });
    let html = open('clip', { status: 'ready', result: r });
    expect(html).toContain('data-testid="share-preview-clip"');
    expect(html).toContain('muted=""');
    expect(html).toContain('aria-label="Your clip, 10 seconds, no sound"');
    expect(html).toContain('autoPlay=""');
    expect(html).not.toContain('share-deliver-copy');
    expect(html).not.toContain('share-deliver-share');
    expect(html).toMatch(/data-autofocus=""[^>]*data-testid="share-deliver-download"/);
    const s = ui.getState().settings;
    ui.setState({ settings: { ...s, accessibility: { ...s.accessibility, reduceMotion: true } } });
    html = renderToStaticMarkup(<ShareLayer />);
    expect(html).not.toContain('autoPlay=""');
    ui.setState({ settings: s });
  });

  it('error: message and Try again', () => {
    const html = open('card', { status: 'error', error: "Couldn't make the card on this device." });
    expect(html).toContain('data-testid="share-error"');
    expect(html).toContain('make the card on this device');
    expect(html).toContain('Try again');
  });

  it('shows a delivery notice', () => {
    const html = open('card', { status: 'ready', result: result(), notice: 'Saved to your downloads' });
    expect(html).toContain('Saved to your downloads');
  });
});

describe('Share button and the replays flag', () => {
  beforeEach(() => {
    shareUI.setState({ offer: offer(), sheet: CLOSED_SHARE_SHEET });
    flags(true);
  });

  it('appears only when there is something to share', () => {
    expect(renderToStaticMarkup(<ShareButton />)).toContain('data-testid="share-open"');
    shareUI.setState({ offer: null });
    expect(renderToStaticMarkup(<ShareButton />)).toBe('');
    shareUI.setState({ offer: offer({ card: false, clips: [] }) });
    expect(renderToStaticMarkup(<ShareButton />)).toBe('');
  });

  it('hides the clip tab when replays are switched off', () => {
    flags(false);
    expect(shareAvailable(offer({ card: false }), false)).toBe(false);
    expect(shareAvailable(offer(), false)).toBe(true);
    const html = open('clip');
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('share-card-options');
    shareUI.setState({ offer: offer({ card: false }) });
    expect(renderToStaticMarkup(<ShareButton />)).toBe('');
  });

  it('keeps a clip-only offer usable when no card was earned', () => {
    shareUI.setState({ offer: offer({ card: false, headline: 'Your show' }) });
    expect(renderToStaticMarkup(<ShareButton />)).toContain('Share');
    shareUI.getState().openSheet();
    expect(shareUI.getState().sheet.tab).toBe('clip');
    expect(renderToStaticMarkup(<ShareLayer />)).toContain('share-clip-options');
  });
});
