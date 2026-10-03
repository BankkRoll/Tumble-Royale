import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE, formLobbies, queueStatus, ratingBand, type EngineConfig, type QueueEntry } from '../src/engine.ts';

let seq = 0;
function entry(size: number, opts: Partial<QueueEntry> = {}): QueueEntry {
  const id = `e${++seq}`;
  return {
    id,
    partyId: size > 1 ? `party-${id}` : `solo:${id}`,
    leaderId: `${id}-u0`,
    members: Array.from({ length: size }, (_, i) => ({ userId: `${id}-u${i}`, name: `P${id}${i}`, ordinal: opts.members?.[0]?.ordinal ?? 0 })),
    playlistId: 'main-show',
    queue: 'casual',
    region: 'na',
    teamSize: 1,
    lobbySize: 40,
    minPlayers: 1,
    botsAllowed: true,
    enqueuedAt: 0,
    ...opts,
  };
}
const solos = (n: number, opts: Partial<QueueEntry> = {}) => Array.from({ length: n }, () => entry(1, opts));
const cfg: EngineConfig = { ...DEFAULT_ENGINE, maxWaitMs: 25_000, hotMaxWaitMs: 10_000, hotThreshold: 1000 };

describe('queue fill', () => {
  it('releases a full lobby of 40 immediately without bots', () => {
    const lobbies = formLobbies(solos(40), 0, cfg);
    expect(lobbies).toHaveLength(1);
    expect(lobbies[0]).toMatchObject({ humans: 40, botFill: 0, reason: 'full' });
  });

  it('leaves the overflow queued', () => {
    const lobbies = formLobbies(solos(45), 1000, cfg);
    expect(lobbies).toHaveLength(1);
    expect(lobbies[0]!.humans).toBe(40);
  });

  it('keeps buckets apart', () => {
    const lobbies = formLobbies([...solos(20), ...solos(20, { region: 'eu' })], 0, cfg);
    expect(lobbies).toHaveLength(0);
  });
});

describe('wait-time release with bot fill', () => {
  it('waits up to maxWait, then fills the rest with bots', () => {
    const q = solos(7);
    expect(formLobbies(q, 24_999, cfg)).toHaveLength(0);
    const [lobby] = formLobbies(q, 25_000, cfg);
    expect(lobby).toMatchObject({ humans: 7, botFill: 33, reason: 'timeout', size: 40 });
  });

  it('uses the shorter wait when the region is hot', () => {
    const hot = { ...cfg, hotThreshold: 30 };
    const q = [...solos(10), ...solos(25, { playlistId: 'chaos-mode' })];
    const lobbies = formLobbies(q, 10_000, hot);
    expect(lobbies.map((l) => l.playlistId).sort()).toEqual(['chaos-mode', 'main-show']);
  });

  it('reports a countdown ETA', () => {
    const q = solos(3);
    expect(queueStatus(q[0]!, q, 5_000, cfg)).toMatchObject({ searching: 3, waitedSec: 5, etaSec: 20, band: null });
  });

  it('does not bot-fill playlists that forbid bots until minPlayers humans are present', () => {
    const q = solos(5, { botsAllowed: false, minPlayers: 6, queue: 'ranked', playlistId: 'ranked' });
    expect(formLobbies(q, 60_000, cfg)).toHaveLength(0);
    const more = [...q, entry(1, { botsAllowed: false, minPlayers: 6, queue: 'ranked', playlistId: 'ranked', enqueuedAt: 59_000 })];
    expect(formLobbies(more, 60_000, cfg)[0]).toMatchObject({ humans: 6, botFill: 0 });
  });
});

describe('party integrity', () => {
  it('never splits parties across lobbies', () => {
    const parties = [...Array.from({ length: 13 }, () => entry(3)), entry(4), entry(2), entry(1)];
    const lobbies = formLobbies(parties, 0, cfg);
    expect(lobbies).toHaveLength(1);
    const lobby = lobbies[0]!;
    expect(lobby.humans).toBe(40);
    const placed = new Set(lobby.teams.flat());
    for (const p of parties) {
      const inLobby = p.members.filter((m) => placed.has(m.userId)).length;
      expect([0, p.members.length]).toContain(inLobby);
    }
  });

  it('assembles squads from parties of different sizes', () => {
    const q = [entry(2, { teamSize: 4, playlistId: 'squads', lobbySize: 8 }), entry(3, { teamSize: 4, playlistId: 'squads', lobbySize: 8 }), entry(1, { teamSize: 4, playlistId: 'squads', lobbySize: 8 }), entry(2, { teamSize: 4, playlistId: 'squads', lobbySize: 8 })];
    const [lobby] = formLobbies(q, 0, cfg);
    expect(lobby).toMatchObject({ reason: 'full', humans: 8 });
    expect(lobby!.teams.map((t) => t.length)).toEqual([4, 4]);
    for (const e of q) {
      const team = lobby!.teams.findIndex((t) => t.includes(e.members[0]!.userId));
      for (const m of e.members) expect(lobby!.teams[team]).toContain(m.userId);
    }
  });

  it('pairs duos', () => {
    const q = Array.from({ length: 20 }, () => entry(2, { teamSize: 2, playlistId: 'duos' }));
    const [lobby] = formLobbies(q, 0, cfg);
    expect(lobby!.teams).toHaveLength(20);
    expect(lobby!.teams.every((t) => t.length === 2)).toBe(true);
  });
});

describe('ranked rating bands', () => {
  const ranked = (ordinal: number, enqueuedAt = 0) =>
    entry(1, { queue: 'ranked', playlistId: 'ranked', lobbySize: 2, members: [{ userId: 'x', name: 'x', ordinal }], enqueuedAt });

  it('widens with wait time', () => {
    expect(ratingBand(cfg, 0)).toBe(cfg.band.base);
    expect(ratingBand(cfg, 10_000)).toBeCloseTo(cfg.band.base + 6);
    expect(ratingBand(cfg, 10_000_000)).toBe(cfg.band.max);
  });

  it('only matches distant ratings once the band has widened enough', () => {
    const q = [ranked(0), ranked(10)];
    expect(formLobbies(q, 5_000, { ...cfg, maxWaitMs: 60_000 })).toHaveLength(0);
    const needed = ((10 - cfg.band.base) / cfg.band.perSecond) * 1000;
    const lobbies = formLobbies(q, needed + 1, { ...cfg, maxWaitMs: 60_000 });
    expect(lobbies).toHaveLength(1);
    expect(lobbies[0]).toMatchObject({ reason: 'full', humans: 2 });
  });

  it('matches close ratings immediately', () => {
    expect(formLobbies([ranked(5), ranked(6)], 0, cfg)).toHaveLength(1);
  });
});
