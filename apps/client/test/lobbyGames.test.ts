import { describe, expect, it } from 'vitest';
import { sanitizeLobbyGame, type LobbyGameWire } from '@tumble/shared';
import {
  GOAL,
  LOBBY_GAME_CANCEL_S,
  LOBBY_GAME_INFO,
  LOBBY_GAME_INTRO_S,
  LOBBY_GAME_RESULTS_S,
  LobbyGameHost,
  LobbyGameTracker,
  POTATO,
  TARGETS,
  goalAt,
  placeTarget,
  splitTeams,
  targetUnder,
  winnersOf,
  type PlayerLookup,
  type PlayerSample,
} from '../src/game/views/lobbyGames.ts';

/** Small deterministic LCG so tests do not depend on Math.random. */
function seeded(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const A = 'user-a';
const B = 'user-b';
const C = 'user-c';
const D = 'user-d';

function positions(map: Record<string, [number, number]>): PlayerLookup {
  return (id: string, out: PlayerSample) => {
    const p = map[id];
    if (!p) return false;
    out.x = p[0];
    out.y = 0;
    out.z = p[1];
    return true;
  };
}

function toPlay(host: LobbyGameHost): void {
  host.tick(LOBBY_GAME_INTRO_S + 0.01);
}

describe('team split and goals', () => {
  it('alternates teams by slot', () => {
    expect(splitTeams(1)).toEqual([0]);
    expect(splitTeams(2)).toEqual([0, 1]);
    expect(splitTeams(3)).toEqual([0, 1, 0]);
    expect(splitTeams(4)).toEqual([0, 1, 0, 1]);
  });

  it('only counts a ball fully past the line, under the bar, between the posts', () => {
    const x = GOAL.lineX + GOAL.inside;
    expect(goalAt(x + 0.1, 0.7, 0)).toBe(1);
    expect(goalAt(-x - 0.1, 0.7, 0.5)).toBe(0);
    expect(goalAt(x - 0.3, 0.7, 0)).toBe(-1);
    expect(goalAt(x + 0.1, 0.7, GOAL.halfWidth + 0.2)).toBe(-1);
    expect(goalAt(x + 0.1, GOAL.height + 0.5, 0)).toBe(-1);
  });
});

describe('Goal Rush', () => {
  it('runs intro, scores goals for the attacking team and ends at three', () => {
    const host = new LobbyGameHost(seeded());
    const g = host.start('goal', [A, B, C, D]);
    expect(g).toMatchObject({ phase: 'intro', teams: [0, 1, 0, 1], score: [0, 0] });
    expect(host.takeBallReset()).toBe(true);
    expect(host.ballHeld).toBe(true);
    expect(host.scoreGoal(1)).toBe(false);
    toPlay(host);
    expect(host.game!.phase).toBe('play');
    expect(host.game!.left).toBe(LOBBY_GAME_INFO.goal.playS);
    expect(host.ballHeld).toBe(false);

    // Ball in the +x goal (team 1's): team 0 scores.
    expect(host.scoreGoal(1)).toBe(true);
    expect(host.game!.score).toEqual([1, 0]);
    expect(host.game!.ev).toMatchObject({ k: 'goal', a: 0, b: 1 });
    expect(host.ballHeld).toBe(true);
    expect(host.scoreGoal(1)).toBe(false);
    host.tick(GOAL.kickoffS);
    expect(host.takeBallReset()).toBe(true);
    expect(host.scoreGoal(0)).toBe(true);
    expect(host.game!.score).toEqual([1, 1]);
    host.tick(GOAL.kickoffS);
    host.scoreGoal(1);
    host.tick(GOAL.kickoffS);
    host.scoreGoal(1);
    expect(host.game).toMatchObject({ phase: 'results', score: [3, 1], win: 0b0101, reason: 'done' });
    host.tick(LOBBY_GAME_RESULTS_S);
    expect(host.game).toBeNull();
  });

  it('calls a level game at time up a draw', () => {
    const host = new LobbyGameHost(seeded());
    host.start('goal', [A, B]);
    toPlay(host);
    host.scoreGoal(0);
    host.tick(GOAL.kickoffS);
    host.scoreGoal(1);
    host.tick(LOBBY_GAME_INFO.goal.playS);
    expect(host.game).toMatchObject({ phase: 'results', score: [1, 1], win: 0 });
  });

  it('lets a solo player score in either goal', () => {
    const host = new LobbyGameHost(seeded());
    host.start('goal', [A]);
    toPlay(host);
    host.scoreGoal(0);
    host.tick(GOAL.kickoffS);
    host.scoreGoal(1);
    expect(host.game!.score).toEqual([2, 0]);
  });
});

describe('Hot Potato', () => {
  it('drops the potato on someone, passes it on a valid tag and pops at the fuse', () => {
    const host = new LobbyGameHost(seeded(7));
    host.start('potato', [A, B, C]);
    toPlay(host);
    const g = host.game!;
    expect(g.it).toBeGreaterThanOrEqual(0);
    expect(g.aux).toBeGreaterThanOrEqual(POTATO.fuseMinS);
    expect(g.aux).toBeLessThanOrEqual(POTATO.fuseMaxS);
    expect(g.ev).toMatchObject({ k: 'tag', a: -1, b: g.it });

    const holder = g.players[g.it]!;
    const other = g.players.find((p) => p !== holder)!;
    const third = g.players.find((p) => p !== holder && p !== other)!;
    const near = positions({ [holder]: [0, 0], [other]: [1, 0], [third]: [5, 0] });
    host.tick(POTATO.tagCooldownS);

    expect(host.claim(other, { id: g.id, k: 'tag', target: holder }, near)).toBe('not_it');
    expect(host.claim(holder, { id: g.id, k: 'tag', target: third }, near)).toBe('too_far');
    expect(host.claim(holder, { id: g.id + 1, k: 'tag', target: other }, near)).toBe('stale');
    expect(host.claim(holder, { id: g.id, k: 'tag', target: 'stranger' }, near)).toBe('bad_target');
    expect(host.claim(holder, { id: g.id, k: 'tag', target: other }, near)).toBe('ok');
    expect(g.players[g.it]).toBe(other);
    expect(g.ev).toMatchObject({ k: 'tag', a: g.players.indexOf(holder), b: g.it });

    // Straight back: first the holder cooldown, then the pass-back rule.
    expect(host.claim(other, { id: g.id, k: 'tag', target: holder }, near)).toBe('cooldown');
    host.tick(POTATO.tagCooldownS);
    expect(host.claim(other, { id: g.id, k: 'tag', target: holder }, near)).toBe('pass_back');
    host.tick(POTATO.passBackS);
    expect(host.claim(other, { id: g.id, k: 'tag', target: holder }, near)).toBe('ok');

    // Let the fuse burn out.
    const it = g.it;
    host.tick(POTATO.fuseMaxS);
    expect(g.out & (1 << it)).toBeTruthy();
    expect(g.ev).toMatchObject({ k: 'pop', a: it });
    expect(g.it).toBe(-1);
    expect(host.claim(g.players[it]!, { id: g.id, k: 'tag', target: third }, near)).toBe('not_playing');
    host.tick(POTATO.breakS);
    expect(g.it).toBeGreaterThanOrEqual(0);
    expect(g.out & (1 << g.it)).toBe(0);
  });

  it('makes the last one standing the winner', () => {
    const host = new LobbyGameHost(seeded(3));
    host.start('potato', [A, B]);
    toPlay(host);
    const g = host.game!;
    const loser = g.it;
    host.tick(POTATO.fuseMaxS);
    expect(g.phase).toBe('results');
    expect(g.win).toBe(1 << (1 - loser));
  });

  it('moves the potato on when its holder becomes a spectator', () => {
    const host = new LobbyGameHost(seeded(5));
    host.start('potato', [A, B, C]);
    toPlay(host);
    const g = host.game!;
    const holder = g.players[g.it]!;
    host.spectate(holder);
    expect(g.out & (1 << g.players.indexOf(holder))).toBeTruthy();
    expect(g.it).toBeGreaterThanOrEqual(0);
    expect(g.players[g.it]).not.toBe(holder);
    expect(g.aux).toBeGreaterThanOrEqual(3);
  });

  it('ends with a winner when spectating leaves one player', () => {
    const host = new LobbyGameHost(seeded(5));
    host.start('potato', [A, B]);
    toPlay(host);
    host.spectate(A);
    expect(host.game).toMatchObject({ phase: 'results', win: 0b10 });
  });
});

describe('Target Hop', () => {
  it('places targets apart and off the fixed props', () => {
    const rng = seeded(11);
    const out = { x: 0, z: 0 };
    for (let i = 0; i < 200; i++) {
      placeTarget(rng, [0, 0, 1, 1], out);
      expect(Math.hypot(out.x, out.z)).toBeLessThanOrEqual(TARGETS.spawnRadius + 1e-9);
      expect(Math.hypot(out.x, out.z)).toBeGreaterThanOrEqual(TARGETS.spacing - 1e-9);
      expect(Math.hypot(out.x - 3.2, out.z + 2.6)).toBeGreaterThanOrEqual(1.2 - 1e-9);
    }
  });

  it('finds the target under a Tumbler that landed on it', () => {
    const t = [1, 1, 1, 3, -2, 0, 0, 4, 3, 3, 3, 9];
    expect(targetUnder(1.3, 0, 1.2, t)).toBe(0);
    expect(targetUnder(-2, 0, 0, t)).toBe(-1);
    expect(targetUnder(3, 0.2, 3.1, t)).toBe(2);
    expect(targetUnder(1, TARGETS.maxY + 0.5, 1, t)).toBe(-1);
  });

  it('scores validated hits, respawns targets and ends at the target score', () => {
    const host = new LobbyGameHost(seeded(2));
    host.start('targets', [A, B]);
    toPlay(host);
    const g = host.game!;
    expect(g.targets).toHaveLength(TARGETS.count * 4);
    const [tx, tz, value, gen] = g.targets as [number, number, number, number];
    const on = positions({ [A]: [tx, tz], [B]: [tx + 4, tz] });
    expect(host.claim(B, { id: g.id, k: 'hit', t: 0, g: gen }, on)).toBe('too_far');
    expect(host.claim(A, { id: g.id, k: 'hit', t: 0, g: gen + 1 }, on)).toBe('stale');
    expect(host.claim(A, { id: g.id, k: 'hit', t: 0, g: gen }, on)).toBe('ok');
    expect(g.score[0]).toBe(value);
    expect(g.targets[2]).toBe(0);
    expect(g.ev).toMatchObject({ k: 'hit', a: 0, b: 0 });
    // Same target again before it respawns: gone.
    expect(host.claim(A, { id: g.id, k: 'hit', t: 0, g: gen }, on)).toBe('stale');
    host.tick(TARGETS.respawnS);
    expect(g.targets[2]).toBeGreaterThan(0);
    expect(g.targets[3]).toBe(gen + 1);

    for (let i = 0; i < 40 && g.phase === 'play'; i++) {
      const t = g.targets as number[];
      const where = positions({ [A]: [t[0]!, t[1]!] });
      host.claim(A, { id: g.id, k: 'hit', t: 0, g: t[3]! }, where);
      host.tick(TARGETS.respawnS);
    }
    expect(g.phase).toBe('results');
    expect(g.score[0]).toBeGreaterThanOrEqual(TARGETS.toWin);
    expect(g.win).toBe(0b01);
  });

  it('calls everyone level a draw but a solo score a win', () => {
    const base: LobbyGameWire = {
      op: 'end',
      id: 1,
      kind: 'targets',
      phase: 'results',
      left: 0,
      players: [A, B],
      teams: [0, 0],
      score: [4, 4],
      out: 0,
      it: -1,
      aux: 0,
      targets: [],
      win: 0,
    };
    expect(winnersOf(base)).toBe(0);
    expect(winnersOf({ ...base, score: [4, 6] })).toBe(0b10);
    expect(winnersOf({ ...base, players: [A], teams: [0], score: [3] })).toBe(1);
  });
});

describe('cancel and spectators', () => {
  it('cancels when nobody is left playing', () => {
    const host = new LobbyGameHost(seeded());
    host.start('goal', [A, B]);
    host.spectate(A);
    expect(host.game!.phase).toBe('intro');
    host.spectate(B);
    expect(host.game).toMatchObject({
      phase: 'results',
      reason: 'cancel',
      left: LOBBY_GAME_CANCEL_S,
      win: 0,
    });
    host.tick(LOBBY_GAME_CANCEL_S);
    expect(host.game).toBeNull();
  });

  it('labels snapshots start, event, state and end', () => {
    const host = new LobbyGameHost(seeded());
    host.start('goal', [A, B]);
    expect(host.wire()!.op).toBe('start');
    toPlay(host);
    expect(host.wire()!.op).toBe('state');
    host.scoreGoal(1);
    expect(host.wire()!.op).toBe('event');
    expect(host.wire()!.op).toBe('state');
    host.cancel();
    expect(host.wire()).toMatchObject({ op: 'end', reason: 'cancel' });
  });

  it('produces snapshots the shared sanitiser accepts unchanged', () => {
    const host = new LobbyGameHost(seeded(9));
    host.start('targets', ['0000-a', '0000-b', '0000-c']);
    toPlay(host);
    const w = JSON.parse(JSON.stringify(host.wire())) as LobbyGameWire;
    expect(sanitizeLobbyGame(w)).toEqual(w);
  });
});

describe('game tracker', () => {
  it('reports a start, each event once, phase changes and the end', () => {
    const host = new LobbyGameHost(seeded());
    const t = new LobbyGameTracker();
    host.start('goal', [A, B]);
    let c = t.update(host.wire());
    expect(c).toMatchObject({ started: true, phase: 'intro', event: null, ended: false });
    c = t.update(host.wire());
    expect(c).toMatchObject({ started: false, phase: null });
    toPlay(host);
    expect(t.update(host.wire()).phase).toBe('play');
    host.scoreGoal(1);
    expect(t.update(host.wire()).event).toMatchObject({ k: 'goal' });
    expect(t.update(host.wire()).event).toBeNull();
    expect(t.update(null).ended).toBe(true);
    expect(t.update(null).ended).toBe(false);
  });

  it('treats a member joining mid-game as a start without replaying old events', () => {
    const host = new LobbyGameHost(seeded());
    host.start('goal', [A, B]);
    toPlay(host);
    host.scoreGoal(0);
    const t = new LobbyGameTracker();
    const copy = JSON.parse(JSON.stringify(host.wire())) as LobbyGameWire;
    const c = t.update(copy);
    expect(c.started).toBe(true);
    expect(c.event).toBeNull();
  });

  it('ends the old game when a new one replaces it', () => {
    const host = new LobbyGameHost(seeded());
    const t = new LobbyGameTracker();
    host.start('goal', [A, B]);
    t.update(JSON.parse(JSON.stringify(host.wire())) as LobbyGameWire);
    host.start('potato', [A, B]);
    const c = t.update(JSON.parse(JSON.stringify(host.wire())) as LobbyGameWire);
    expect(c).toMatchObject({ ended: true, started: true });
  });
});
