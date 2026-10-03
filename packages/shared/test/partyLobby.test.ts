import { describe, expect, it } from 'vitest';
import {
  encodeLobbyFrame,
  isNewerLobbySeq,
  PARTY_LOBBY_LIMITS,
  sanitizeLobbyFrame,
  sanitizeLobbyLook,
  type LobbyLook,
  type LobbyPose,
} from '../src/index.ts';

const pose: LobbyPose = {
  x: 1.23456,
  y: 0.0049,
  z: -2.71828,
  yaw: Math.PI * 3,
  state: 1,
  speed: 4.26,
  vy: -0.04,
  grounded: true,
  emote: null,
};

const look: LobbyLook = {
  colors: ['#ff6fb5', '#5ce1e6', '#ffffff'],
  pattern: 'pattern.solid',
  face: 'face.happy',
  upper: null,
  lower: null,
  headwear: 'headwear.crown',
  back: null,
  emotes: ['emote.wave', 'emote.dance', 'emote.cheer', 'emote.flex'],
  celebration: 'celebration.confetti',
  victoryPose: 'victory.flex',
  nameplate: 'nameplate.default',
  trail: null,
};

const known = (id: string) => id.startsWith('emote.');

describe('party lobby frames', () => {
  it('quantises the wire message', () => {
    const m = encodeLobbyFrame(pose, 7);
    expect(m).toMatchObject({
      type: 'party_lobby',
      seq: 7,
      x: 1.23,
      y: 0,
      z: -2.72,
      state: 1,
      speed: 4.3,
      vy: 0,
    });
    expect(Math.abs(m.yaw)).toBeCloseTo(3.14, 2);
    expect(m.look).toBeUndefined();
    expect(encodeLobbyFrame(pose, 8, look).look).toBe(look);
  });

  it('round-trips through the sanitiser unchanged', () => {
    const m = encodeLobbyFrame({ ...pose, emote: 'emote.wave', state: 13 }, 3, look);
    const back = sanitizeLobbyFrame(JSON.parse(JSON.stringify(m)), known);
    const { type: _type, ...frame } = m;
    expect(back).toEqual(frame);
  });

  it('drops frames with non-finite or missing numbers', () => {
    expect(sanitizeLobbyFrame({ ...encodeLobbyFrame(pose, 1), x: Number.NaN }, known)).toBeNull();
    expect(sanitizeLobbyFrame({ seq: 1, x: 0, y: 0, z: 0, yaw: 0 }, known)).toBeNull();
    expect(
      sanitizeLobbyFrame(JSON.parse('{"seq":1,"x":1e999,"y":0,"z":0,"yaw":0,"state":0}'), known),
    ).toBeNull();
    expect(sanitizeLobbyFrame('nope', known)).toBeNull();
    expect(sanitizeLobbyFrame([1, 2], known)).toBeNull();
  });

  it('clamps positions to the platform and values to their ranges', () => {
    const f = sanitizeLobbyFrame(
      { seq: 1, x: 300, y: 99, z: 400, yaw: 10, state: 999, speed: 1e6, vy: -1e6, emote: 'emote.nope!' },
      () => false,
    )!;
    expect(Math.hypot(f.x, f.z)).toBeLessThanOrEqual(PARTY_LOBBY_LIMITS.radius + 0.01);
    expect(f.y).toBe(PARTY_LOBBY_LIMITS.maxY);
    expect(f.state).toBe(PARTY_LOBBY_LIMITS.maxState);
    expect(f.speed).toBe(PARTY_LOBBY_LIMITS.maxSpeed);
    expect(f.vy).toBe(-PARTY_LOBBY_LIMITS.maxVerticalSpeed);
    expect(Math.abs(f.yaw)).toBeLessThanOrEqual(Math.PI);
    expect(f.emote).toBeNull();
    expect(f.grounded).toBe(true);
  });

  it('clears unknown emotes and strips malformed looks but keeps the pose', () => {
    const f = sanitizeLobbyFrame(
      { ...encodeLobbyFrame(pose, 2), emote: 'emote.secret', look: { ...look, colors: ['red', 'x', 'y'] } },
      (id) => id === 'emote.wave',
    )!;
    expect(f.emote).toBeNull();
    expect(f.look).toBeUndefined();
    expect(f.x).toBe(1.23);
  });

  it('validates looks structurally', () => {
    expect(sanitizeLobbyLook(look)).toEqual(look);
    expect(sanitizeLobbyLook({ ...look, extra: 'x' })).toEqual(look);
    expect(sanitizeLobbyLook({ ...look, upper: 5 })).toBeNull();
    expect(sanitizeLobbyLook({ ...look, emotes: ['emote.wave'] })).toBeNull();
    expect(sanitizeLobbyLook({ ...look, face: '<script>' })).toBeNull();
    expect(sanitizeLobbyLook(null)).toBeNull();
  });

  it('orders sequence numbers and survives a sender restart', () => {
    expect(isNewerLobbySeq(5, -1)).toBe(true);
    expect(isNewerLobbySeq(6, 5)).toBe(true);
    expect(isNewerLobbySeq(5, 5)).toBe(false);
    expect(isNewerLobbySeq(3, 5)).toBe(false);
    expect(isNewerLobbySeq(0, 500)).toBe(true);
    expect(isNewerLobbySeq(0, 2 ** 31 - 1)).toBe(true);
  });
});

describe('party lobby extras', () => {
  it('round-trips status, grab, ball and bump', () => {
    const m = encodeLobbyFrame(pose, 4, null, {
      status: 'locker',
      grab: 'b1f9c2c0-1111-4222-8333-444455556666',
      ball: [1.234, 0.4, -2, 3.333, 0, -1],
      bump: [2, 1, 0],
    });
    expect(m.ball).toEqual([1.23, 0.4, -2, 3.33, 0, -1]);
    const f = sanitizeLobbyFrame(JSON.parse(JSON.stringify(m)), known)!;
    expect(f).toMatchObject({ status: 'locker', grab: m.grab, ball: m.ball, bump: [2, 1, 0] });
  });

  it('omits the default status and strips malformed extras', () => {
    expect(encodeLobbyFrame(pose, 1, null, { status: 'menu' }).status).toBeUndefined();
    const f = sanitizeLobbyFrame(
      {
        ...encodeLobbyFrame(pose, 1),
        status: 'hacking',
        grab: '<x>',
        ball: [1, 2, 3],
        bump: [Number.NaN, 0, 0],
      },
      known,
    )!;
    expect(f.status).toBeUndefined();
    expect(f.grab).toBeUndefined();
    expect(f.ball).toBeUndefined();
    expect(f.bump).toBeUndefined();
  });

  it('clamps the ball to the platform and its speed', () => {
    const f = sanitizeLobbyFrame({ ...encodeLobbyFrame(pose, 1), ball: [90, 99, 0, 500, -500, 0] }, known)!;
    expect(f.ball).toEqual([PARTY_LOBBY_LIMITS.radius, PARTY_LOBBY_LIMITS.maxY, 0, 25, -25, 0]);
  });

  it('accepts the lobby clips without a catalog', () => {
    expect(sanitizeLobbyFrame({ ...encodeLobbyFrame(pose, 1), emote: 'cheer' }, () => false)!.emote).toBe(
      'cheer',
    );
    expect(sanitizeLobbyFrame({ ...encodeLobbyFrame(pose, 1), emote: 'sit' }, () => false)!.emote).toBeNull();
  });
});
