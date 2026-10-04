/**
 * Clips: which round and window a clip defaults to (read from real
 * recordings), the 5–15 s trimmer limits, the encoder format ladder
 * (WebCodecs H.264 → VP9 → VP8 → MediaRecorder → none), and the
 * `replays.enabled` gate on what the share sheet offers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareUI, ui, uiEvents } from '@tumble/ui';
import { gatedReplays } from '../src/game/liveOps/flags.ts';
import type { ReplayData } from '../src/game/replay/format.ts';
import { ReplayLibrary } from '../src/game/replay/library.ts';
import { ReplayRecorder, type RecordablePlayer, type ReplayMeta } from '../src/game/replay/recorder.ts';
import { clipBitrate, pickClipFormat, type ClipEncoderEnv } from '../src/game/share/clipEncoder.ts';
import {
  CLIP_TAIL_SECONDS,
  clampClipWindow,
  clipCandidate,
  clipOffer,
  defaultClipRound,
  defaultClipWindow,
  localMoments,
} from '../src/game/share/clipWindow.ts';
import { ShareController, clipSize, type ShareControllerDeps } from '../src/game/share/shareController.ts';
import type { ShareShowFacts } from '../src/game/share/shareFacts.ts';

const START = -3;

function meta(roundIndex: number, isFinal: boolean, localId = 0): ReplayMeta {
  return {
    protocolVersion: 2,
    recordedAt: '2026-10-04T12:00:00.000Z',
    online: false,
    showName: 'Main Show',
    roundId: 'gumdrop-gauntlet',
    roundName: isFinal ? 'Crown Climb' : `Round ${roundIndex + 1}`,
    roundType: 'race',
    roundIndex,
    isFinal,
    seed: 7,
    stage: 1,
    variationId: null,
    qualifyTarget: isFinal ? 1 : 2,
    localId,
    players: [0, 1, 2, 3].map((id) => ({
      id,
      name: `P${id}`,
      isBot: id !== 0,
      team: -1,
      loadout: null,
    })),
  };
}

/**
 * Records a synthetic round of `length` seconds of round time (plus the
 * 3 s countdown). `qualifyAt` / `outAt` are round times for the local player.
 */
function recording(
  roundIndex: number,
  length: number,
  o: { isFinal?: boolean; qualifyAt?: number; outAt?: number; localId?: number } = {},
): ReplayData {
  const rec = new ReplayRecorder(meta(roundIndex, o.isFinal ?? false, o.localId ?? 0));
  const sample = (id: number, t: number, out: RecordablePlayer): boolean => {
    Object.assign(out, {
      x: id,
      y: 1,
      z: Math.max(0, t) * 5,
      vx: 0,
      vy: 0,
      vz: 5,
      state: 1,
      stateTime: 0,
      facing: 0,
      grounded: true,
      flags: 0,
      emote: 0,
    });
    return true;
  };
  for (let f = 0; f <= (length - START) * 60; f++) {
    const t = START + f / 60;
    if (rec.due(t)) rec.frame(t, (id, out) => sample(id, t, out), null, null);
    if (o.qualifyAt !== undefined && Math.abs(t - o.qualifyAt) < 0.5 / 60)
      rec.event(t, { type: 'qualified', player: 0, place: 1 });
    if (o.outAt !== undefined && Math.abs(t - o.outAt) < 0.5 / 60)
      rec.event(t, { type: 'eliminated', player: 0, place: 4 });
    if (Math.abs(t - 5) < 0.5 / 60) rec.event(t, { type: 'qualified', player: 2, place: 1 });
  }
  const qualified = o.qualifyAt !== undefined ? [0] : [];
  const eliminated = o.outAt !== undefined ? [0] : [];
  const data = rec.finish({ qualified, eliminated });
  if (!data) throw new Error('no recording');
  return data;
}

describe('clip window selection', () => {
  const r1 = recording(0, 60, { qualifyAt: 42 });
  const r2 = recording(1, 50, { qualifyAt: 30 });
  const fin = recording(2, 40, { isFinal: true, qualifyAt: 33 });
  const lost = recording(1, 50, { outAt: 20 });

  it("finds the local player's moments in the event stream", () => {
    // Recording time counts from the first frame, 3 s before the round starts.
    expect(localMoments(r1).qualifiedAt).toBeCloseTo(45, 1);
    expect(localMoments(r1).eliminatedAt).toBeNull();
    expect(localMoments(lost)).toMatchObject({ qualifiedAt: null });
    expect(localMoments(lost).eliminatedAt).toBeCloseTo(23, 1);
    expect(localMoments(recording(0, 20, { qualifyAt: 10, localId: -1 })).qualifiedAt).toBeNull();
  });

  it('ends the default window just after the player qualified', () => {
    const c = clipCandidate('s:0', r1);
    expect(c.outcome).toBe('qualified');
    const w = defaultClipWindow(c);
    expect(w.length).toBe(10);
    expect(w.start + w.length).toBeCloseTo(45 + CLIP_TAIL_SECONDS, 1);
  });

  it('falls back to the last 10 s and fits short recordings', () => {
    const c = clipCandidate('s:1', lost);
    expect(c.outcome).toBe('eliminated');
    const w = defaultClipWindow(c);
    expect(w.start + w.length).toBeCloseTo(c.duration, 6);
    const short = clipCandidate('s:2', recording(0, 2, { qualifyAt: 1 }));
    expect(short.duration).toBeCloseTo(5, 1);
    expect(defaultClipWindow(short)).toEqual({ start: 0, length: short.duration });
  });

  it('defaults to the won final, else the latest qualified round', () => {
    const all = [clipCandidate('a', r1), clipCandidate('b', r2), clipCandidate('c', fin)];
    expect(defaultClipRound(all)?.key).toBe('c');
    expect(defaultClipRound(all.slice(0, 2))?.key).toBe('b');
    expect(defaultClipRound([clipCandidate('x', lost)])).toBeNull();
  });

  it('offers every recorded round in show order with its window', () => {
    const offer = clipOffer([
      { key: 'k2', data: fin },
      { key: 'k0', data: r1 },
      { key: 'k1', data: lost },
    ]);
    expect(offer.rounds.map((r) => r.key)).toEqual(['k0', 'k1', 'k2']);
    expect(offer.defaultKey).toBe('k2');
    for (const r of offer.rounds) {
      expect(r.defaultLength).toBeGreaterThanOrEqual(5);
      expect(r.defaultStart + r.defaultLength).toBeLessThanOrEqual(r.duration + 1e-9);
    }
    expect(clipOffer([{ key: 'k1', data: lost }]).defaultKey).toBe('k1');
    expect(clipOffer([])).toEqual({ rounds: [], defaultKey: null });
  });

  it('clamps trimmer windows to 5–15 s inside the recording', () => {
    expect(clampClipWindow({ start: 58, length: 20 }, 60)).toEqual({ start: 45, length: 15 });
    expect(clampClipWindow({ start: -4, length: 2 }, 60)).toEqual({ start: 0, length: 5 });
    expect(clampClipWindow({ start: 10, length: 10 }, 3)).toEqual({ start: 0, length: 3 });
    expect(clampClipWindow({ start: Number.NaN, length: Number.POSITIVE_INFINITY }, 30)).toEqual({
      start: 0,
      length: 10,
    });
  });
});

describe('clip format ladder', () => {
  const supports =
    (ok: (codec: string) => boolean): ClipEncoderEnv['isConfigSupported'] =>
    async (c) => ({ supported: ok(c.codec), config: c });

  it('prefers H.264 in MP4 at the right level', async () => {
    const seen: VideoEncoderConfig[] = [];
    const f = await pickClipFormat(1920, 1080, {
      isConfigSupported: async (c) => {
        seen.push(c);
        return { supported: c.codec === 'avc1.4d0028', config: c };
      },
    });
    expect(f).toEqual({ encoder: 'webcodecs', container: 'mp4', codec: 'avc1.4d0028', mime: 'video/mp4' });
    expect(seen[0]).toMatchObject({ width: 1920, height: 1080, framerate: 30, avc: { format: 'avc' } });
    expect(seen[0]!.bitrate).toBe(clipBitrate(1080));
  });

  it('falls back to VP9, then VP8, in WebM', async () => {
    expect(
      await pickClipFormat(1280, 720, { isConfigSupported: supports((c) => c.startsWith('vp09')) }),
    ).toEqual({
      encoder: 'webcodecs',
      container: 'webm',
      codec: 'vp09.00.31.08',
      mime: 'video/webm',
    });
    const vp8 = await pickClipFormat(1280, 720, {
      isConfigSupported: async (c) => {
        if (c.codec.startsWith('avc1')) throw new TypeError('unknown codec');
        return { supported: c.codec === 'vp8', config: c };
      },
    });
    expect(vp8?.codec).toBe('vp8');
  });

  it('uses MediaRecorder where WebCodecs is missing or useless', async () => {
    const rec = await pickClipFormat(1280, 720, {
      isConfigSupported: supports(() => false),
      recorderSupports: (m) => m === 'video/webm;codecs=vp8',
      captureStream: true,
    });
    expect(rec).toEqual({
      encoder: 'mediarecorder',
      container: 'webm',
      codec: 'video/webm;codecs=vp8',
      mime: 'video/webm',
    });
    const safari = await pickClipFormat(1280, 720, {
      recorderSupports: (m) => m.startsWith('video/mp4'),
      captureStream: true,
    });
    expect(safari).toMatchObject({ encoder: 'mediarecorder', container: 'mp4', mime: 'video/mp4' });
  });

  it('reports none when nothing can record', async () => {
    expect(await pickClipFormat(1280, 720, {})).toBeNull();
    expect(
      await pickClipFormat(1280, 720, { recorderSupports: () => true, captureStream: false }),
    ).toBeNull();
  });

  it('renders 1080p on High/Ultra and 720p below', () => {
    expect(clipSize('ultra')).toEqual({ width: 1920, height: 1080 });
    expect(clipSize('high')).toEqual({ width: 1920, height: 1080 });
    expect(clipSize('medium')).toEqual({ width: 1280, height: 720 });
    expect(clipSize('low')).toEqual({ width: 1280, height: 720 });
  });
});

describe('replays.enabled gating', () => {
  const facts: ShareShowFacts = {
    playlistName: 'Main Show',
    rounds: [{ name: 'Round 1', type: 'race', qualified: true }],
    reachedFinal: false,
    wonCrown: false,
    place: 2,
    participants: 4,
  };
  let controller: ShareController | null = null;

  afterEach(() => {
    controller?.dispose();
    controller = null;
  });

  function setup(enabled: { on: boolean }): { flagsChanged: () => void; deps: ShareControllerDeps } {
    const library = new ReplayLibrary();
    library.beginShow();
    library.add(recording(0, 30, { qualifyAt: 20 }));
    let listener: () => void = () => {};
    const deps: ShareControllerDeps = {
      renderer: {} as ShareControllerDeps['renderer'],
      createTumbler: () => {
        throw new Error('not in this test');
      },
      look: () => ({}) as ReturnType<ShareControllerDeps['look']>,
      playerName: () => 'Sprinkles',
      library,
      createReplayView: () => {
        throw new Error('not in this test');
      },
      tier: () => 'medium',
      toneMapping: () => 'neutral',
      replaysEnabled: () => enabled.on,
      onFlagsChanged: (fn) => {
        listener = fn;
        return () => {};
      },
      track: vi.fn(),
      shareEnv: {},
      encoderEnv: { isConfigSupported: async (c) => ({ supported: c.codec.startsWith('vp09'), config: c }) },
    };
    controller = new ShareController(deps);
    return { flagsChanged: () => listener(), deps };
  }

  it('offers clips while the flag is on and hides them when it flips off', async () => {
    const flag = { on: true };
    const { flagsChanged } = setup(flag);
    controller!.showFinished(facts);
    const offer = shareUI.getState().offer!;
    expect(offer.card).toBe(true);
    expect(offer.clips).toHaveLength(1);
    expect(offer.clipQuality).toBe('720p');
    expect(offer.clipSupport).toBe('checking');
    await vi.waitFor(() => expect(shareUI.getState().offer?.clipSupport).toBe('webcodecs'));
    flag.on = false;
    flagsChanged();
    expect(shareUI.getState().offer?.clips).toEqual([]);
    expect(shareUI.getState().offer?.card).toBe(true);
  });

  it('never offers clips when the flag is off at the end of the show', () => {
    setup({ on: false });
    controller!.showFinished(facts);
    expect(shareUI.getState().offer?.clips).toEqual([]);
  });

  it('refuses a clip request while the flag is off', async () => {
    const flag = { on: true };
    const { deps } = setup(flag);
    controller!.showFinished(facts);
    await vi.waitFor(() => expect(shareUI.getState().offer?.clipSupport).toBe('webcodecs'));
    const key = shareUI.getState().offer!.clips[0]!.key;
    flag.on = false;
    shareUI.getState().openSheet('clip');
    uiEvents.emit('shareClip', { key, start: 0, length: 10 });
    await vi.waitFor(() => expect(shareUI.getState().sheet.status).toBe('error'));
    expect(shareUI.getState().sheet.error).toMatch(/replays are switched off/);
    expect(deps.track).toHaveBeenCalledWith(
      'share.clip',
      expect.objectContaining({ outcome: 'render_failed' }),
    );
  });

  it('records nothing in a show that started with the flag off', () => {
    const inner = {
      showStarted: vi.fn(),
      roundStarted: vi.fn(),
      frame: vi.fn(),
      event: vi.fn(),
      roundEnded: vi.fn(),
    };
    const flag = { on: false };
    const hooks = gatedReplays(inner, () => flag.on);
    hooks.showStarted();
    hooks.roundStarted({} as never, {} as never, {} as never);
    hooks.frame();
    expect(inner.showStarted).toHaveBeenCalled();
    expect(inner.roundStarted).not.toHaveBeenCalled();
    expect(inner.frame).not.toHaveBeenCalled();
  });

  it('drops the offer when the rewards screen goes away', () => {
    setup({ on: true });
    ui.setState({ screen: 'rewards' });
    controller!.showFinished(facts);
    shareUI.getState().openSheet();
    expect(shareUI.getState().sheet.open).toBe(true);
    ui.setState({ screen: 'menu' });
    expect(shareUI.getState().offer).toBeNull();
    expect(shareUI.getState().sheet.open).toBe(false);
  });
});
