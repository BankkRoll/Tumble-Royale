import { describe, expect, it } from 'vitest';
import {
  encodeLobbyFrame,
  PARTY_LOBBY_LIMITS,
  sanitizeLobbyClaim,
  sanitizeLobbyFrame,
  sanitizeLobbyGame,
  type LobbyGameWire,
  type LobbyLook,
  type LobbyPose,
} from '../src/index.ts';

const pose: LobbyPose = {
  x: 1,
  y: 0,
  z: -1,
  yaw: 0,
  state: 1,
  speed: 3,
  vy: 0,
  grounded: true,
  emote: null,
};

const uuid = (i: number): string => `0000000${i}-1111-4222-8333-444455556666`;

const game = (over: Partial<LobbyGameWire> = {}): LobbyGameWire => ({
  op: 'state',
  id: 12,
  kind: 'potato',
  phase: 'play',
  left: 41.27,
  players: [uuid(1), uuid(2), uuid(3), uuid(4)],
  teams: [0, 0, 0, 0],
  score: [0, 0, 0, 0],
  out: 0b0100,
  it: 1,
  aux: 6.44,
  targets: [],
  win: 0,
  ev: { n: 3, k: 'tag', a: 0, b: 1 },
  ...over,
});

describe('lobby game snapshots', () => {
  it('round-trips a clean snapshot, rounding timers', () => {
    const g = sanitizeLobbyGame(game());
    expect(g).toMatchObject({ kind: 'potato', left: 41.3, aux: 6.4, it: 1, out: 4, ev: { n: 3, k: 'tag' } });
  });

  it('drops snapshots with a broken shape', () => {
    expect(sanitizeLobbyGame(game({ kind: 'darts' as never }))).toBeNull();
    expect(sanitizeLobbyGame(game({ players: [] }))).toBeNull();
    expect(sanitizeLobbyGame(game({ players: [uuid(1), uuid(1)], teams: [0, 0], score: [0, 0] }))).toBeNull();
    expect(sanitizeLobbyGame(game({ players: ['bad id!'], teams: [0], score: [0] }))).toBeNull();
    expect(sanitizeLobbyGame(game({ teams: [0, 2, 0, 0] }))).toBeNull();
    expect(sanitizeLobbyGame(game({ score: [1, 2] }))).toBeNull();
    expect(sanitizeLobbyGame(game({ id: 0 }))).toBeNull();
    expect(sanitizeLobbyGame(game({ players: [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)] }))).toBeNull();
  });

  it('clamps scores, masks and indices to the player list', () => {
    const g = sanitizeLobbyGame(game({ score: [500, -3, 2.6, 0], out: 0xff, win: 0x30, it: 9, left: 9e9 }))!;
    expect(g.score).toEqual([99, 0, 3, 0]);
    expect(g.out).toBe(0b1111);
    expect(g.win).toBe(0);
    expect(g.it).toBe(-1);
    expect(g.left).toBe(600);
  });

  it('scores Goal Rush per team', () => {
    const g = sanitizeLobbyGame(game({ kind: 'goal', teams: [0, 1, 0, 1], score: [2, 1] }));
    expect(g?.score).toEqual([2, 1]);
    expect(sanitizeLobbyGame(game({ kind: 'goal', score: [0, 0, 0, 0] }))).toBeNull();
  });

  it('clamps targets inside the platform and keeps them for Target Hop only', () => {
    const g = sanitizeLobbyGame(game({ kind: 'targets', targets: [30, 0, 9, 4, 1, 1, 1, 5] }))!;
    expect(g.targets).toEqual([5.5, 0, 5, 4, 1, 1, 1, 5]);
    expect(sanitizeLobbyGame(game({ kind: 'targets', targets: [1, 2, 3] }))).toBeNull();
    expect(sanitizeLobbyGame(game({ targets: [1, 1, 1, 1] }))!.targets).toEqual([]);
  });

  it('keeps an end reason only on end', () => {
    expect(sanitizeLobbyGame(game({ op: 'end', reason: 'cancel' }))!.reason).toBe('cancel');
    expect(sanitizeLobbyGame(game({ reason: 'cancel' }))!.reason).toBeUndefined();
  });

  it('strips a malformed event', () => {
    expect(sanitizeLobbyGame(game({ ev: { n: 0, k: 'tag', a: 0, b: 0 } }))!.ev).toBeUndefined();
    expect(sanitizeLobbyGame(game({ ev: { n: 1, k: 'boom' as never, a: 0, b: 0 } }))!.ev).toBeUndefined();
  });
});

describe('lobby game claims', () => {
  it('accepts tags and hits', () => {
    expect(sanitizeLobbyClaim({ id: 3, k: 'tag', target: uuid(2) })).toEqual({
      id: 3,
      k: 'tag',
      target: uuid(2),
    });
    expect(sanitizeLobbyClaim({ id: 3, k: 'hit', t: 2, g: 7, extra: 1 })).toEqual({
      id: 3,
      k: 'hit',
      t: 2,
      g: 7,
    });
  });

  it('rejects malformed claims', () => {
    expect(sanitizeLobbyClaim({ id: 3, k: 'tag' })).toBeNull();
    expect(sanitizeLobbyClaim({ id: 3, k: 'hit', t: 3, g: 1 })).toBeNull();
    expect(sanitizeLobbyClaim({ id: -1, k: 'hit', t: 0, g: 1 })).toBeNull();
    expect(sanitizeLobbyClaim({ id: 1, k: 'score' })).toBeNull();
  });
});

describe('lobby game frames', () => {
  const look: LobbyLook = {
    colors: ['#ff6fb5', '#5ce1e6', '#ffffff'],
    pattern: 'pattern.stripes-diagonal',
    face: 'face.happy-sparkle',
    upper: 'upper.varsity-jacket',
    lower: 'lower.cargo-shorts',
    headwear: 'headwear.traffic-cone-deluxe',
    back: 'back.jetpack-retro',
    emotes: ['emote.wave', 'emote.dance-floss', 'emote.cheer', 'emote.flex-double'],
    celebration: 'celebration.confetti-cannon',
    victoryPose: 'victory.flex-trophy',
    nameplate: 'nameplate.candy-stripes',
    trail: 'trail.rainbow-sparkle',
  };

  it('carries game and claim through encode and sanitise', () => {
    const msg = encodeLobbyFrame(pose, 4, null, { game: game(), claim: { id: 12, k: 'hit', t: 0, g: 2 } });
    const f = sanitizeLobbyFrame(JSON.parse(JSON.stringify(msg)), () => true)!;
    expect(f.game?.it).toBe(1);
    expect(f.claim).toEqual({ id: 12, k: 'hit', t: 0, g: 2 });
  });

  it('strips a bad game but still relays the pose', () => {
    const f = sanitizeLobbyFrame(
      { ...encodeLobbyFrame(pose, 4), game: { op: 'nope' }, claim: 7 },
      () => true,
    )!;
    expect(f.x).toBe(1);
    expect(f.game).toBeUndefined();
    expect(f.claim).toBeUndefined();
  });

  it('fits the busiest leader frame (look, ball, full game) under the size cap', () => {
    const g = game({
      kind: 'targets',
      score: [12, 14, 9, 30],
      targets: [-4.12, 3.33, 3, 1234, 2.22, -1.11, 1, 1235, 0.5, 4.44, 1, 1236],
      left: 44.4,
    });
    const msg = encodeLobbyFrame({ ...pose, emote: 'emote.dance-floss' }, 2 ** 30, look, {
      status: 'locker',
      grab: uuid(2),
      ball: [-4.44, 0.71, 3.33, -12.34, 5.55, 9.87],
      game: g,
    });
    expect(JSON.stringify(msg).length).toBeLessThan(PARTY_LOBBY_LIMITS.maxBytes);
  });
});
