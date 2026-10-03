import { encodeLobbyFrame, sanitizeLobbyFrame, type LobbyPose, type PartyLobbyFrame } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import {
  LOBBY_INTERP_DELAY_MS,
  LOBBY_SLOT_POSITIONS,
  LobbyFrameSender,
  LobbyInterpolation,
  assignLobbySlots,
  lobbyFraming,
  rosterFromParty,
  type LobbyMember,
} from '../src/game/views/partyLobby.ts';

const member = (userId: string, joinedAt: number): LobbyMember => ({
  userId,
  name: userId.toUpperCase(),
  tag: '0001',
  ready: false,
  joinedAt,
});

const pose = (over: Partial<LobbyPose> = {}): LobbyPose => ({
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  state: 0,
  speed: 0,
  vy: 0,
  grounded: true,
  emote: null,
  ...over,
});

const frame = (seq: number, over: Partial<LobbyPose> = {}): PartyLobbyFrame => {
  const { type: _type, ...f } = encodeLobbyFrame(pose(over), seq);
  return f;
};

describe('lobby slots', () => {
  const members = [member('carol', 300), member('alice', 100), member('bob', 200), member('dave', 400)];

  it('puts the leader in the centre and the rest by join order', () => {
    const slots = assignLobbySlots(members, 'bob');
    expect(slots.map((s) => [s.userId, s.slot, s.leader])).toEqual([
      ['bob', 0, true],
      ['alice', 1, false],
      ['carol', 2, false],
      ['dave', 3, false],
    ]);
  });

  it('gives every member the same layout whoever is local and however the list is ordered', () => {
    const views = [members, [...members].reverse(), [members[2]!, members[0]!, members[3]!, members[1]!]];
    const layouts = views.map((list) => JSON.stringify(assignLobbySlots(list, 'alice')));
    expect(new Set(layouts).size).toBe(1);
    // The roster each client builds differs only by who is local; slots ignore that.
    const party = {
      leaderId: 'alice',
      members: members.map((m) => ({ ...m, displayName: m.name })),
    };
    const a = rosterFromParty(party, 'alice')!;
    const c = rosterFromParty(party, 'carol')!;
    expect(assignLobbySlots(a.members, a.leaderId)).toEqual(assignLobbySlots(c.members, c.leaderId));
  });

  it('breaks join-time ties by id and caps at the slot count', () => {
    const tied = [
      member('zed', 5),
      member('amy', 5),
      member('lead', 9),
      member('kim', 5),
      member('extra', 6),
    ];
    const slots = assignLobbySlots(tied, 'lead');
    expect(slots.map((s) => s.userId)).toEqual(['lead', 'amy', 'kim', 'zed']);
    expect(slots).toHaveLength(LOBBY_SLOT_POSITIONS.length);
  });

  it('re-slots after a promotion or a leave', () => {
    expect(assignLobbySlots(members, 'dave')[0]!.userId).toBe('dave');
    const left = members.filter((m) => m.userId !== 'alice');
    expect(assignLobbySlots(left, 'bob').map((s) => s.userId)).toEqual(['bob', 'carol', 'dave']);
  });

  it('frames solo at the origin and widens for a group', () => {
    expect(lobbyFraming(1)).toEqual({ cx: 0, cz: 0, spread: 0 });
    const two = lobbyFraming(2);
    expect(two.cx).toBeCloseTo(LOBBY_SLOT_POSITIONS[1]!.x / 2);
    expect(two.spread).toBeGreaterThan(0);
    expect(lobbyFraming(4).spread).toBeGreaterThan(two.spread);
  });

  it('builds no roster without a party', () => {
    expect(rosterFromParty(null, 'me')).toBeNull();
  });
});

describe('lobby interpolation', () => {
  const D = LOBBY_INTERP_DELAY_MS;

  it('renders between the two snapshots around now - delay', () => {
    const buf = new LobbyInterpolation();
    const out = pose();
    buf.push(frame(1, { x: 0, yaw: 3 }), 1000);
    buf.push(frame(2, { x: 1, yaw: -3 }), 1100);
    expect(buf.sample(1050 + D, out)).toBe(true);
    expect(out.x).toBeCloseTo(0.5);
    // Yaw goes the short way round through ±π, not through 0.
    expect(Math.abs(out.yaw)).toBeGreaterThan(3);
    buf.sample(5000, out);
    expect(out.x).toBe(1);
  });

  it('holds the first snapshot until there is something to blend toward', () => {
    const buf = new LobbyInterpolation();
    const out = pose();
    expect(buf.sample(0, out)).toBe(false);
    buf.push(frame(1, { x: 2, state: 13, emote: 'emote.wave' }), 0);
    buf.sample(D * 3, out);
    expect(out).toMatchObject({ x: 2, state: 13, emote: 'emote.wave' });
  });

  it('drops duplicates and late frames but accepts a restarted sender', () => {
    const buf = new LobbyInterpolation();
    expect(buf.push(frame(10, { x: 1 }), 0)).toBe(true);
    expect(buf.push(frame(10, { x: 2 }), 50)).toBe(false);
    expect(buf.push(frame(8, { x: 2 }), 60)).toBe(false);
    expect(buf.push(frame(1000, { x: 2 }), 100)).toBe(true);
    expect(buf.push(frame(0, { x: 2.5 }), 200)).toBe(true);
  });

  it('starts gliding when movement resumes instead of skipping ahead', () => {
    const buf = new LobbyInterpolation();
    const out = pose();
    buf.push(frame(1, { x: 0 }), 0);
    buf.push(frame(2, { x: 1 }), 5000);
    buf.sample(5000 + D - 100, out);
    expect(out.x).toBeLessThan(0.1);
    buf.sample(5000 + D, out);
    expect(out.x).toBeCloseTo(1);
  });

  it('snaps on a teleport', () => {
    const buf = new LobbyInterpolation();
    const out = pose();
    buf.push(frame(1, { x: -5 }), 0);
    buf.push(frame(2, { x: 5 }), 100);
    buf.sample(100, out);
    expect(out.x).toBe(5);
  });

  it('stays bounded under a long stream', () => {
    const buf = new LobbyInterpolation();
    const out = pose();
    for (let i = 1; i < 500; i++) {
      buf.push(frame(i, { x: (i % 50) * 0.05 }), i * 100);
      buf.sample(i * 100, out);
    }
    expect(buf.size).toBeLessThanOrEqual(4);
  });
});

describe('lobby frame sender', () => {
  it('sends at 10 Hz while moving and on discrete changes, keep-alive when still', () => {
    const s = new LobbyFrameSender();
    const still = pose({ x: 1 });
    expect(s.due(0, still)).toBe(true);
    s.take(0, still);
    expect(s.due(500, still)).toBe(false);
    expect(s.due(2000, still)).toBe(true);
    s.take(2000, still);

    const moving = pose({ x: 1.2, speed: 4 });
    expect(s.due(2050, moving)).toBe(false);
    expect(s.due(2100, moving)).toBe(true);
    s.take(2100, moving);

    const emote = pose({ x: 1.2, state: 13, emote: 'emote.wave' });
    expect(s.due(2150, emote)).toBe(false);
    expect(s.due(2175, emote)).toBe(true);
  });

  it('carries the look once, no more often than the gateway accepts', () => {
    const s = new LobbyFrameSender();
    const p = pose();
    const look = {
      colors: ['#ffffff', '#000000', '#ff0000'],
      pattern: 'pattern.solid',
      face: 'face.happy',
      upper: null,
      lower: null,
      headwear: null,
      back: null,
      emotes: ['emote.a', 'emote.b', 'emote.c', 'emote.d'],
      celebration: 'celebration.a',
      victoryPose: 'victory.a',
      nameplate: 'nameplate.a',
      trail: null,
    } as const;
    s.announceLook({ ...look, colors: [...look.colors], emotes: [...look.emotes] });
    expect(s.take(0, p).look).not.toBeNull();
    s.announceLook({ ...look, colors: ['#111111', '#000000', '#ff0000'], emotes: [...look.emotes] });
    expect(s.due(300, p)).toBe(false);
    expect(s.take(300, p).look).toBeNull();
    expect(s.due(1200, p)).toBe(true);
    expect(s.take(1200, p).look?.colors[0]).toBe('#111111');
    expect(s.take(3000, p).look).toBeNull();
  });

  it('produces frames the gateway sanitiser passes through unchanged', () => {
    const s = new LobbyFrameSender();
    const p = pose({ x: 1.234, z: -0.5, yaw: 1.5, state: 1, speed: 3.33 });
    const { seq } = s.take(0, p);
    const msg = encodeLobbyFrame(p, seq);
    const { type: _type, ...wire } = msg;
    expect(sanitizeLobbyFrame(JSON.parse(JSON.stringify(msg)), () => true)).toEqual(wire);
    expect(JSON.stringify(msg).length).toBeLessThan(200);
  });
});
