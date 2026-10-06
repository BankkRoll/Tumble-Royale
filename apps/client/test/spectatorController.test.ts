/**
 * The spectator controller against a fake session and a real three.js
 * camera: camera modes and their hand-overs (Reduce Motion cuts), the free
 * camera flying under keys and staying above the kill plane, the online
 * focus hint's rate limit, pin and leader, the broadcast toggles, roster
 * masking, and hotkeys standing down under chat.
 */
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { DEFAULT_SETTINGS, social, ui, type Settings } from '@tumble/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TouchState } from '../src/input/touchState.ts';
import {
  SpectatorController,
  type SpectatorHost,
  type SpectatorRound,
} from '../src/game/spectate/controller.ts';
import { freeCamBounds } from '../src/game/spectate/freeCam.ts';
import { courseBox, overviewPose } from '../src/game/spectate/overview.ts';
import type { RosterPlayer } from '../src/game/spectate/roster.ts';
import { installFakeDom, type FakeDom } from './fakeDom.ts';

const DT = 1 / 60;
const NO_LOOK = { yaw: 0, pitch: 0 };

interface Harness {
  ctl: SpectatorController;
  round: SpectatorRound;
  camera: PerspectiveCamera;
  follows: number[];
  cycles: number[];
  focus: [number, number, number][];
  settings: Settings;
  state: { followed: number; spectating: boolean };
  /** One rendered frame: the controller, then the rig (which we leave alone), then the driver. */
  frame(look?: { yaw: number; pitch: number }): void;
  key(code: string, opts?: Partial<KeyboardEvent>): boolean;
}

let dom: FakeDom;

function harness(players: Partial<RosterPlayer>[] = []): Harness {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1600);
  camera.position.set(0, 10, -20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const view: SpectatorRound['view'] = {
    camera,
    cameraDriver: null,
    players: { feetOf: () => false },
  };
  const round: SpectatorRound = {
    view,
    def: {
      geometry: [{ shape: 'box', position: { x: 0, y: 0, z: 50 }, size: { x: 20, y: 2, z: 120 } }],
      spawn: { origin: { x: 0, y: 1, z: 0 } },
      bounds: { min: { x: -30, y: -10, z: -20 }, max: { x: 30, y: 40, z: 130 } },
      killY: -8,
      type: 'race',
    },
    kind: 'race',
    isFinal: false,
    qualifyTarget: 3,
  };
  const roster: RosterPlayer[] = [
    { id: 1, name: 'Leader', place: 1 },
    { id: 2, name: 'Second', place: 2 },
    { id: 3, name: 'Third', place: 3 },
    ...players,
  ].map((p, i) => ({
    id: p.id ?? 10 + i,
    name: p.name ?? `P${i}`,
    color: '#ff4f9a',
    isBot: false,
    isLocal: false,
    isParty: false,
    isClub: false,
    team: -1,
    status: 'playing',
    place: p.place ?? 0,
    ...p,
  }));
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const state = { followed: -1, spectating: true };
  const follows: number[] = [];
  const cycles: number[] = [];
  const focus: [number, number, number][] = [];
  const host: SpectatorHost = {
    round: () => round,
    watching: () => true,
    spectating: () => state.spectating,
    candidates: () => roster.filter((r) => r.status === 'playing').map((r) => r.id),
    rosterPlayers: () => roster,
    directorPlayers: () =>
      roster.map((r) => ({
        id: r.id,
        status: r.status,
        place: r.place,
        progress: 1 - r.place / 10,
        team: -1,
        danger: 0,
      })),
    teamScores: () => [],
    follow: (id) => {
      state.followed = id;
      follows.push(id);
    },
    followedId: () => state.followed,
    clearBanner: () => undefined,
    sendFocus: (f) => focus.push(f),
    beginSpectating: () => {
      state.spectating = true;
    },
    cycle: (dir) => cycles.push(dir),
    settings: () => settings,
    touch: new TouchState(),
  };
  const ctl = new SpectatorController(host);
  const target = new Vector3();
  return {
    ctl,
    round,
    camera,
    follows,
    cycles,
    focus,
    settings,
    state,
    frame(look = NO_LOOK) {
      ctl.frame(DT, look);
      view.cameraDriver?.(DT, camera, target);
    },
    key(code, opts = {}) {
      const e = {
        code,
        repeat: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        target: null,
        preventDefault: vi.fn(),
        ...opts,
      } as unknown as KeyboardEvent;
      return ctl.handleKey(e);
    },
  };
}

beforeEach(() => {
  dom = installFakeDom();
  ui.setState({ screen: 'round', overlay: 'none', dialog: null, replay: null });
  social.setState({ chat: { ...social.getState().chat, open: false } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('spectator controller', () => {
  it('goes live with the roster published and comes back quiet with its choices kept', () => {
    const h = harness();
    h.ctl.goLive();
    const s = ui.getState().spectator!;
    expect(s.live).toBe(true);
    expect(s.roster.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(h.round.view.cameraDriver).not.toBeNull();
    h.ctl.setMode('director');
    ui.getState().setOverlay('spectatorRoster');
    h.ctl.goQuiet();
    expect(ui.getState().spectator).toMatchObject({ live: false, mode: 'director', roster: [] });
    expect(ui.getState().overlay).toBe('none');
    expect(h.round.view.cameraDriver).toBeNull();
    h.ctl.dispose();
    expect(ui.getState().spectator).toBeNull();
  });

  it('cycles camera modes on the camera key and keeps Q/E for flying in the free camera', () => {
    const h = harness();
    h.ctl.goLive();
    expect(h.key('KeyF')).toBe(true);
    expect(ui.getState().spectator!.mode).toBe('free');
    expect(h.key('KeyE')).toBe(false);
    expect(h.cycles).toEqual([]);
    h.key('KeyF');
    h.key('KeyF');
    expect(ui.getState().spectator!.mode).toBe('director');
    h.key('KeyE');
    // Picking a player by hand leaves the director for a plain follow.
    expect(h.cycles).toEqual([1]);
    expect(ui.getState().spectator!.mode).toBe('follow');
  });

  it('flies the free camera with held keys and never below the kill plane', () => {
    const h = harness();
    h.ctl.goLive();
    h.ctl.setMode('free');
    const start = h.camera.position.clone();
    h.key('KeyW');
    for (let i = 0; i < 60; i++) h.frame();
    expect(h.camera.position.distanceTo(start)).toBeGreaterThan(5);
    dom.key('keyup', 'KeyW');
    h.key('KeyQ');
    h.key('ShiftLeft');
    for (let i = 0; i < 600; i++) h.frame();
    const floor = freeCamBounds(h.round.def).min.y;
    expect(h.camera.position.y).toBeCloseTo(floor, 5);
    expect(h.camera.position.y).toBeGreaterThan(h.round.def.killY);
  });

  it('stops flying when chat opens over held keys, and ignores hotkeys while typing', () => {
    const h = harness();
    h.ctl.goLive();
    h.ctl.setMode('free');
    h.key('KeyW');
    for (let i = 0; i < 10; i++) h.frame();
    social.setState({ chat: { ...social.getState().chat, open: true } });
    h.frame();
    const at = h.camera.position.clone();
    for (let i = 0; i < 60; i++) h.frame();
    // Velocity bleeds off within a few frames, then the camera rests.
    const rest = h.camera.position.clone();
    for (let i = 0; i < 30; i++) h.frame();
    expect(h.camera.position.distanceTo(rest)).toBeLessThan(1e-3);
    expect(rest.distanceTo(at)).toBeLessThan(3);
    expect(h.key('KeyF')).toBe(false);
    expect(ui.getState().spectator!.mode).toBe('free');
  });

  it('cuts straight to the overview with Reduce Motion and blends without it', () => {
    const h = harness();
    h.settings.accessibility.reduceMotion = true;
    h.ctl.goLive();
    h.ctl.setMode('overview');
    h.frame();
    const cut = h.camera.position.clone();
    h.frame();
    expect(h.camera.position.distanceTo(cut)).toBeLessThan(1e-6);
    // Without Reduce Motion a short hand-over blends over several frames, ending on the overview.
    const g = harness();
    const goal = overviewPose(courseBox(g.round.def), g.camera.fov, g.camera.aspect);
    g.camera.position.set(goal.x + 10, goal.y, goal.z);
    g.camera.lookAt(0, 0, 50);
    g.ctl.goLive();
    g.ctl.setMode('overview');
    g.frame();
    const end = new Vector3(goal.x, goal.y, goal.z);
    const first = g.camera.position.distanceTo(end);
    expect(first).toBeGreaterThan(0.5);
    expect(first).toBeLessThan(10);
    for (let i = 0; i < 120; i++) g.frame();
    expect(g.camera.position.distanceTo(end)).toBeLessThan(1e-6);
  });

  it('sends the free camera focus at most twice a second, and only after it moved', () => {
    const h = harness();
    h.ctl.goLive();
    h.ctl.setMode('free');
    for (let i = 0; i < 120; i++) h.frame();
    expect(h.focus.length).toBe(1);
    h.key('KeyW');
    h.key('ShiftLeft');
    for (let i = 0; i < 180; i++) h.frame();
    expect(h.focus.length).toBeGreaterThan(1);
    expect(h.focus.length).toBeLessThanOrEqual(1 + 6);
    for (const f of h.focus) for (const v of f) expect(Number.isInteger(v)).toBe(true);
  });

  it('pins who it follows and the director stays on them', () => {
    const h = harness();
    h.ctl.goLive();
    h.state.followed = 2;
    h.key('KeyP');
    expect(ui.getState().spectator!.pinnedId).toBe(2);
    expect(ui.getState().spectator!.roster.find((r) => r.id === 2)!.pinned).toBe(true);
    h.ctl.setMode('director');
    h.state.followed = 1;
    for (let i = 0; i < 30; i++) h.frame();
    expect(h.state.followed).toBe(2);
    expect(ui.getState().spectator!.note).toBe('Pinned');
    h.key('KeyP');
    expect(ui.getState().spectator!.pinnedId).toBeNull();
  });

  it('jumps to the leader in follow mode', () => {
    const h = harness();
    h.ctl.goLive();
    h.ctl.setMode('free');
    h.key('KeyL');
    expect(h.follows.at(-1)).toBe(1);
    expect(ui.getState().spectator!.mode).toBe('follow');
  });

  it('toggles the broadcast overlay, help and chroma backdrop (chroma needs the overlay)', () => {
    const h = harness();
    h.ctl.goLive();
    h.key('KeyK');
    expect(ui.getState().spectator).toMatchObject({ broadcast: true, chroma: true });
    h.key('KeyB');
    expect(ui.getState().spectator).toMatchObject({ broadcast: false, chroma: false });
    h.key('KeyH');
    expect(ui.getState().spectator!.help).toBe(true);
    h.key('Tab');
    expect(ui.getState().overlay).toBe('spectatorRoster');
    // With the list open the hotkeys stand down (its search field owns the keys).
    expect(h.key('KeyB')).toBe(false);
  });

  it('starts a spectator seat on the broadcast overlay with help showing', () => {
    const h = harness();
    h.ctl.enableBroadcastSeat();
    expect(ui.getState().spectator).toMatchObject({ broadcast: true, help: true });
  });

  it('masks strangers on the roster in Streamer Mode', () => {
    const h = harness([{ id: 9, name: 'RealName', place: 4 }]);
    h.settings.gameplay.streamerMode = true;
    h.ctl.goLive();
    const names = ui.getState().spectator!.roster.map((r) => r.name);
    expect(names.join(' ')).not.toContain('RealName');
  });

  it('starts on the pinned player when they are still playing', () => {
    const h = harness();
    h.ctl.pin(3);
    expect(
      h.ctl.firstTarget(
        [1, 2, 3],
        () => false,
        () => false,
      ),
    ).toBe(3);
    expect(
      h.ctl.firstTarget(
        [1, 2],
        () => false,
        () => false,
      ),
    ).toBe(1);
  });
});
