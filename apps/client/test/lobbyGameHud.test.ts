import { describe, expect, it } from 'vitest';
import type { LobbyGameWire } from '@tumble/shared';
import { buildLobbyHud, eventBanner, introCountdown, resultLine } from '../src/game/views/lobbyGameHud.ts';
import { LOBBY_GAME_INTRO_S, LobbyGameHost, lineUpSpot } from '../src/game/views/lobbyGames.ts';

const NAMES: Record<string, string> = { a: 'Ann', b: 'Bo', c: 'Cy', d: 'Di' };
const who = (id: string) => ({ name: NAMES[id] ?? '?', color: '#123456' });

const game = (over: Partial<LobbyGameWire> = {}): LobbyGameWire => ({
  op: 'state',
  id: 4,
  kind: 'potato',
  phase: 'play',
  left: 0,
  players: ['a', 'b', 'c'],
  teams: [0, 0, 0],
  score: [0, 0, 0],
  out: 0,
  it: 1,
  aux: 5,
  targets: [],
  win: 0,
  ...over,
});

describe('intro countdown', () => {
  it('counts 3, 2, 1 then GO over the intro', () => {
    expect(introCountdown(LOBBY_GAME_INTRO_S)).toBe(3);
    expect(introCountdown(2.4)).toBe(2);
    expect(introCountdown(1.4)).toBe(1);
    expect(introCountdown(0.4)).toBe(0);
  });
});

describe('lobby HUD', () => {
  it('shows Goal Rush as two team rows with the local team marked', () => {
    const hud = buildLobbyHud(
      game({ kind: 'goal', players: ['a', 'b'], teams: [0, 1], score: [2, 1], it: -1, left: 61.2 }),
      'b',
      who,
      { left: 61.2, fuse: null },
      null,
      false,
    );
    expect(hud.rows.map((r) => [r.label, r.score, r.self])).toEqual([
      ['Pink', 2, false],
      ['Blue', 1, true],
    ]);
    expect(hud.clock).toBe(62);
    expect(hud.title).toBe('Goal Rush');
  });

  it('shows Hot Potato players with the holder and the knocked out, and no clock', () => {
    const hud = buildLobbyHud(game({ out: 0b100 }), 'a', who, { left: 0, fuse: 0.5 }, null, false);
    expect(hud.rows.map((r) => [r.label, r.it, r.out])).toEqual([
      ['You', false, false],
      ['Bo', true, false],
      ['Cy', false, true],
    ]);
    expect(hud.clock).toBeNull();
    expect(hud.fuse).toBe(0.5);
  });

  it('counts down during the intro and reports a win on the results card', () => {
    expect(
      buildLobbyHud(game({ phase: 'intro' }), 'a', who, { left: 2.2, fuse: null }, null, false).countdown,
    ).toBe(2);
    const done = buildLobbyHud(
      game({ phase: 'results', win: 0b001, out: 0b110, it: -1 }),
      'a',
      who,
      { left: 4, fuse: null },
      null,
      false,
    );
    expect(done.result).toBe('You win!');
    expect(done.won).toBe(true);
  });
});

describe('results lines', () => {
  it('names the winners from every point of view', () => {
    expect(resultLine(game({ phase: 'results', win: 0b010 }), 'a', who)).toBe('Bo wins!');
    expect(resultLine(game({ phase: 'results', win: 0b011 }), 'a', who)).toBe('You & Bo win!');
    expect(resultLine(game({ phase: 'results', win: 0b110 }), 'a', who)).toBe('Bo & Cy win!');
    expect(resultLine(game({ phase: 'results', win: 0 }), 'a', who)).toBe('Draw!');
    expect(resultLine(game({ phase: 'results', reason: 'cancel' }), 'a', who)).toBe('Game cancelled');
    expect(resultLine(game({ kind: 'goal', teams: [0, 1, 0], score: [1, 3], win: 0b010 }), 'a', who)).toBe(
      'Blue team wins!',
    );
    expect(resultLine(game({ kind: 'targets', players: ['a'], teams: [0], score: [7] }), 'a', who)).toBe(
      'You scored 7!',
    );
  });
});

describe('event call-outs', () => {
  it('shows goals to everyone and tags, pops and points to whoever they concern', () => {
    const g = game();
    expect(eventBanner(game({ kind: 'goal' }), { n: 1, k: 'goal', a: 1, b: 0 }, 'a', who)).toEqual({
      text: 'GOAL!',
      tone: 'blue',
    });
    expect(eventBanner(g, { n: 1, k: 'tag', a: 1, b: 0 }, 'a', who)?.text).toBe("You're it!");
    expect(eventBanner(g, { n: 1, k: 'tag', a: 0, b: 1 }, 'a', who)?.text).toBe('Passed!');
    expect(eventBanner(g, { n: 1, k: 'tag', a: -1, b: 2 }, 'a', who)?.text).toBe('Cy has it!');
    expect(eventBanner(g, { n: 1, k: 'tag', a: 1, b: 2 }, 'a', who)).toBeNull();
    expect(eventBanner(g, { n: 1, k: 'pop', a: 0, b: -1 }, 'a', who)?.text).toBe('POP! You are out');
    expect(
      eventBanner(game({ kind: 'targets', score: [4, 0, 0] }), { n: 1, k: 'hit', a: 0, b: 1 }, 'a', who),
    ).toEqual({ text: '4 pts', tone: 'mint' });
    expect(eventBanner(game({ kind: 'targets' }), { n: 1, k: 'hit', a: 1, b: 1 }, 'a', who)).toBeNull();
  });
});

describe('line-up', () => {
  it('puts Goal Rush teams on their own half facing the goal they attack', () => {
    const host = new LobbyGameHost(() => 0.5);
    const g = host.start('goal', ['a', 'b', 'c', 'd']);
    const out = { x: 0, z: 0, yaw: 0 };
    const spots = [0, 1, 2, 3].map((i) => {
      expect(lineUpSpot(g, i, out)).toBe(true);
      return { ...out };
    });
    expect(spots[0]!.x).toBeLessThan(0);
    expect(spots[1]!.x).toBeGreaterThan(0);
    expect(spots[0]!.z).not.toBe(spots[2]!.z);
    expect(Math.sin(spots[0]!.yaw)).toBeCloseTo(1);
    expect(Math.sin(spots[1]!.yaw)).toBeCloseTo(-1);
  });

  it('rings Hot Potato players around the centre and leaves Target Hop alone', () => {
    const host = new LobbyGameHost(() => 0.5);
    const out = { x: 0, z: 0, yaw: 0 };
    const g = host.start('potato', ['a', 'b', 'c']);
    lineUpSpot(g, 0, out);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(2.4);
    expect(lineUpSpot(host.start('targets', ['a']), 0, out)).toBe(false);
  });
});
