/**
 * Replay UI: the viewer chrome and the entry points render from store state,
 * stay hidden when there is nothing to watch, and keep emoji off their
 * buttons and chips.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OpenReplayButton,
  ReplayLayer,
  ReplayPicker,
  WatchReplayButton,
  formatReplayTime,
} from '../src/screens/Replay.tsx';
import { ui } from '../src/store/uiStore.ts';
import type { ReplayViewerState } from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2700}-\u{27BF}]|\u{FE0F}/u;

function viewer(over: Partial<ReplayViewerState> = {}): ReplayViewerState {
  return {
    title: 'Gumdrop Gauntlet',
    subtitle: 'Round 1 · Main Show',
    time: 65.4,
    duration: 120,
    playing: true,
    speed: 1,
    camera: 'follow',
    povAvailable: false,
    target: { name: 'Sprinkles (you)', color: '#ff4f9a', index: 0, count: 40 },
    markers: [
      { t: 30, kind: 'eliminated', label: 'Bot 3 is out' },
      { t: 90, kind: 'localQualified', label: 'You qualified!' },
    ],
    canSave: true,
    origin: 'show',
    ...over,
  };
}

/** Text of every button and chip in the markup. */
function controlTexts(html: string): string[] {
  const out: string[] = [];
  const re = /<(button|span)[^>]*class="[^"]*(tr-btn|tr-chip)[^"]*"[^>]*>([\s\S]*?)<\/\1>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push((m[3] ?? '').replace(/<[^>]+>/g, ''));
  return out;
}

describe('replay UI', () => {
  beforeEach(() => {
    ui.setState({ replay: null, replays: [], replayLive: false });
  });

  it('renders nothing until a replay is open', () => {
    expect(renderToStaticMarkup(<ReplayLayer />)).toBe('');
  });

  it('renders the viewer with markers, speeds, cameras and save', () => {
    ui.getState().setReplay(viewer());
    const html = renderToStaticMarkup(<ReplayLayer />);
    expect(html).toContain('Gumdrop Gauntlet');
    expect(html).toContain('1:05.4');
    expect(html.match(/tr-replay-marker /g)).toHaveLength(2);
    expect(html).toContain('is-localQualified');
    for (const s of ['0.25×', '0.5×', '1×', '1.5×', '2×']) expect(html).toContain(s);
    expect(html).toContain('Save replay');
    expect(html).toContain('Exit replay');
    // "Your view" is offered but disabled without a camera track.
    expect(html).toMatch(/disabled=""[^>]*>Your view</);
    for (const t of controlTexts(html)) expect(t).not.toMatch(EMOJI);
  });

  it('hides Save for files and patches only changed fields', () => {
    ui.getState().setReplay(viewer({ canSave: false, origin: 'file' }));
    expect(renderToStaticMarkup(<ReplayLayer />)).not.toContain('Save replay');
    const before = ui.getState().replay;
    ui.getState().patchReplay({ time: 65.4 });
    expect(ui.getState().replay).toBe(before);
    ui.getState().patchReplay({ time: 70 });
    expect(ui.getState().replay?.time).toBe(70);
  });

  it('offers results and rewards entry points only for recorded rounds', () => {
    expect(renderToStaticMarkup(<WatchReplayButton roundIndex={0} />)).toBe('');
    expect(renderToStaticMarkup(<ReplayPicker />)).toBe('');
    ui.getState().setReplays([
      {
        key: '1:0',
        roundIndex: 0,
        name: 'Gumdrop Gauntlet',
        type: 'race',
        isFinal: false,
        outcome: 'qualified',
        duration: 80,
      },
      {
        key: '1:1',
        roundIndex: 1,
        name: 'Crown Climb',
        type: 'final',
        isFinal: true,
        outcome: 'eliminated',
        duration: 60,
      },
    ]);
    expect(renderToStaticMarkup(<WatchReplayButton roundIndex={0} />)).toContain('Watch replay');
    expect(renderToStaticMarkup(<WatchReplayButton roundIndex={4} />)).toBe('');
    const picker = renderToStaticMarkup(<ReplayPicker />);
    expect(picker).toContain('R1 · Gumdrop Gauntlet');
    expect(picker).toContain('Final · Crown Climb');
    for (const t of controlTexts(picker)) expect(t).not.toMatch(EMOJI);
    expect(renderToStaticMarkup(<OpenReplayButton />)).toContain('.tumblereplay');
  });

  it('formats the playhead', () => {
    expect(formatReplayTime(0)).toBe('0:00.0');
    expect(formatReplayTime(61.25)).toBe('1:01.3');
    expect(formatReplayTime(-3)).toBe('0:00.0');
  });
});
