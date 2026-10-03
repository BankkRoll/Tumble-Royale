import { RoundPhase, ShowPhase, type RoundPhaseId } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import {
  Button,
  CharacterState,
  createTumblerController,
  emptyInput,
  type CharacterFullState,
} from '../src/character/index.ts';
import { loadRapier } from '../src/index.ts';
import {
  PlayerRoundStatus,
  createMatchSim,
  createTestArenaRound,
  testObstacleModules,
  type MatchPlayerInfo,
  type MatchSimHandle,
} from '../src/match/index.ts';
import {
  PRE_SHOW_LOBBY_ROUND,
  ShowDirector,
  assignBotSkills,
  assignShowParties,
  lobbySpawnPoint,
  scaleRoundDuration,
  type RoundStartInfo,
  type ShowEvent,
} from '../src/show/index.ts';

const R = await loadRapier();
const deps = { createController: createTumblerController, obstacles: testObstacleModules() };

function lobby(ids: number[], mode: 'authority' | 'predict' = 'authority', local = -1): MatchSimHandle {
  const players: MatchPlayerInfo[] = ids.map((id) => ({ id, name: `P${id}`, isBot: false, team: -1 }));
  const sim = createMatchSim(
    {
      R,
      round: PRE_SHOW_LOBBY_ROUND,
      seed: 7,
      stage: 0,
      players,
      mode,
      lobby: true,
      ...(local >= 0 ? { localPlayerId: local } : {}),
    },
    deps,
  );
  sim.setPhase(RoundPhase.Playing, 0);
  return sim;
}

function state(): CharacterFullState {
  return {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    state: 0,
    stateTime: 0,
    facing: 0,
    grounded: false,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    jumpHeld: false,
    prevButtons: 0,
    grabStamina: 0,
    grabTarget: -1,
    stunTimer: 0,
    ghostTimer: 0,
    emote: 0,
    flags: 0,
  };
}

describe('show roster helpers', () => {
  it('draws the same seeded bot skills from the playlist mix', () => {
    const a = assignBotSkills(42, 30, { clumsy: 0, average: 2, sharp: 3 });
    expect(a).toEqual(assignBotSkills(42, 30, { clumsy: 0, average: 2, sharp: 3 }));
    expect(a).not.toContain('clumsy');
    expect(new Set(a).size).toBe(2);
    expect(assignBotSkills(42, 10, { clumsy: 1, average: 0, sharp: 0 })).toEqual(Array(10).fill('clumsy'));
  });

  it('keeps queued parties together and tops them up with bots', () => {
    const parties = assignShowParties(
      [
        { id: 0, isBot: false, partyKey: 'a' },
        { id: 1, isBot: false, partyKey: 'b' },
        { id: 2, isBot: false, partyKey: 'a' },
        { id: 3, isBot: false },
        { id: 4, isBot: true },
        { id: 5, isBot: true },
        { id: 6, isBot: true },
      ],
      2,
    );
    expect(parties.get(0)).toBe(parties.get(2));
    expect(parties.get(1)).toBe(parties.get(4));
    expect(parties.get(3)).toBe(parties.get(5));
    expect(parties.get(6)).not.toBe(parties.get(3));
    expect(assignShowParties([{ id: 0, isBot: false, partyKey: 'a' }], 1).size).toBe(0);
  });
});

describe('director online options', () => {
  const round = createTestArenaRound({ id: 'r1', name: 'r1', type: 'race' });
  const final = createTestArenaRound({
    id: 'f1',
    name: 'f1',
    type: 'final',
    qualification: { mode: 'lastStanding' },
  });

  it('scales round time limits and forwards party ids to match players', () => {
    expect(scaleRoundDuration(round, 1)).toBe(round);
    expect(scaleRoundDuration(round, 1.5).duration.seconds).toBeCloseTo(round.duration.seconds * 1.5);
    const starts: RoundStartInfo[] = [];
    const director = new ShowDirector({
      seed: 3,
      playlist: {
        id: 'duos',
        name: 'Duos',
        partySize: 2,
        pool: [{ roundId: 'r1' }, { roundId: 'f1' }],
        minRounds: 1,
        maxRounds: 2,
      },
      rounds: [round, final],
      participants: [0, 1, 2, 3].map((id) => ({ id, name: `P${id}`, isBot: id > 1, partyId: id >> 1 })),
      roundTimeScale: 2,
      timings: { preShow: 4 },
      host: {
        startRound(info) {
          starts.push(info);
          return {
            setPhase: () => {},
            getStatus: () => ({
              phase: RoundPhase.Loading as RoundPhaseId,
              finished: false,
              players: new Map(),
            }),
            dispose: () => {},
          };
        },
      },
    });
    const events: ShowEvent[] = [];
    director.on((e) => events.push(e));
    director.tick(3.9);
    expect(starts).toHaveLength(0);
    director.tick(0.2);
    expect(starts).toHaveLength(1);
    expect(events.some((e) => e.type === 'showPhase' && e.phase === ShowPhase.InRound)).toBe(true);
    const info = starts[0]!;
    expect(info.round.duration.seconds).toBeCloseTo(
      (info.round.id === 'r1' ? round : final).duration.seconds * 2,
    );
    expect(info.players.map((p) => p.partyId)).toEqual([0, 0, 1, 1]);
  });
});

describe('lobby match sim', () => {
  it('adds and removes players live and releases grabs on leave', () => {
    const sim = lobby([0, 1]);
    const s = state();
    // Land everyone first.
    for (let i = 0; i < 60; i++) sim.step();
    expect(sim.getStatus().players.size).toBe(2);
    expect(
      sim.addPlayer(
        { id: 5, name: 'late', isBot: false, team: -1 },
        lobbySpawnPoint(5, { x: 0, y: 3, z: 0 }),
      ),
    ).toBe(true);
    expect(sim.addPlayer({ id: 5, name: 'dup', isBot: false, team: -1 }, { x: 0, y: 3, z: 0 })).toBe(false);
    for (let i = 0; i < 90; i++) sim.step();
    expect(sim.getPlayerState(5, s)).toBe(true);
    expect(s.grounded).toBe(true);
    expect(s.pos.y).toBeLessThan(1.5);
    expect(sim.getStandings()).toContain(5);

    // Put 1 right in front of 0 and grab.
    sim.getPlayerState(0, s);
    const p0 = { ...s.pos };
    const s1 = state();
    sim.getPlayerState(1, s1);
    s1.pos.x = p0.x;
    s1.pos.z = p0.z + 1.1;
    s1.pos.y = p0.y;
    s1.vel.x = s1.vel.y = s1.vel.z = 0;
    sim.setPlayerState(1, s1);
    const grab = emptyInput();
    grab.buttons = Button.Grab;
    let grabbed = false;
    for (let i = 0; i < 30 && !grabbed; i++) {
      sim.setInput(0, grab);
      sim.step();
      grabbed = sim.events.drain().some((e) => e.type === 'grabStart' && e.player === 0 && e.target === 1);
    }
    expect(grabbed).toBe(true);
    sim.getPlayerState(1, s1);
    expect(s1.state).toBe(CharacterState.Grabbed);

    expect(sim.removePlayer(0)).toBe(true);
    expect(sim.removePlayer(0)).toBe(false);
    for (let i = 0; i < 5; i++) sim.step();
    sim.getPlayerState(1, s1);
    expect(s1.state).not.toBe(CharacterState.Grabbed);
    expect(sim.getPlayerState(0, s)).toBe(false);
    expect(sim.getStatus().players.has(0)).toBe(false);
    expect(sim.getStandings()).not.toContain(0);
    // The id can rejoin.
    expect(sim.addPlayer({ id: 0, name: 'back', isBot: false, team: -1 }, { x: 0, y: 2, z: 0 })).toBe(true);
    sim.step();
    sim.dispose();
  });

  it('never qualifies or eliminates and respawns fallers', () => {
    const sim = lobby([0]);
    const s = state();
    sim.getPlayerState(0, s);
    s.pos.x = 40;
    sim.setPlayerState(0, s);
    for (let i = 0; i < 400; i++) sim.step();
    const st = sim.getStatus();
    expect(st.players.get(0)?.status).toBe(PlayerRoundStatus.Playing);
    expect(st.finished).toBe(false);
    sim.getPlayerState(0, s);
    expect(Math.hypot(s.pos.x, s.pos.z)).toBeLessThan(17);
    sim.dispose();
  });

  it('predict-mode lobbies add remote proxies too', () => {
    const sim = lobby([0, 1], 'predict', 0);
    expect(sim.addPlayer({ id: 2, name: 'x', isBot: false, team: -1 }, { x: 3, y: 0, z: 0 })).toBe(true);
    sim.setRemoteProxy(2, { x: 3, y: 1, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 }, 0);
    sim.step();
    expect(sim.removePlayer(2)).toBe(true);
    sim.step();
    sim.dispose();
  });
});

describe('server hit assist', () => {
  it('assistGrab follows normal grab eligibility', () => {
    const sim = lobby([0, 1]);
    for (let i = 0; i < 60; i++) sim.step();
    expect(sim.assistGrab(0, 0)).toBe(false);
    expect(sim.assistGrab(0, 9)).toBe(false);
    expect(sim.assistGrab(0, 1)).toBe(true);
    // The hold lasts only while the grabber keeps Grab held, like any grab.
    const hold = emptyInput();
    hold.buttons = Button.Grab;
    sim.setInput(0, hold);
    sim.step();
    const s = state();
    sim.getPlayerState(1, s);
    expect(s.state).toBe(CharacterState.Grabbed);
    // Already holding: a second assist is refused.
    expect(sim.assistGrab(0, 1)).toBe(false);
    sim.dispose();
  });

  it('assistTackle stuns the victim away from the diver', () => {
    const sim = lobby([0, 1]);
    for (let i = 0; i < 60; i++) sim.step();
    const a = state();
    const b = state();
    sim.getPlayerState(0, a);
    sim.getPlayerState(1, b);
    expect(sim.assistTackle(0, 1, 5)).toBe(true);
    sim.step();
    sim.getPlayerState(1, b);
    expect(b.state).toBe(CharacterState.Stunned);
    expect(sim.assistTackle(0, 1, 5)).toBe(false);
    sim.dispose();
  });
});
