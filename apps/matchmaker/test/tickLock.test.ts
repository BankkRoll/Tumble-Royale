import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { Matchmaker, TICK_LOCK_TTL_MS, userChannel, type MMEvent } from '../src/matchmaker.ts';
import { MemoryStore } from '../src/store.ts';
import type { QueueTicket } from '../src/tickets.ts';
import { testEnv } from './helpers.ts';

const cfg = loadConfig(testEnv({ DEFAULT_GAME_SERVER_URL: 'ws://gs.test/ws' }));

function ticket(userId: string, maxPlayers = 2): QueueTicket {
  return {
    typ: 'queue',
    sub: userId,
    pid: `solo:${userId}`,
    leaderId: userId,
    playlistId: 'main-show',
    queue: 'casual',
    teamSize: 1,
    maxPlayers,
    minPlayers: 2,
    botsAllowed: true,
    region: 'na',
    members: [{ userId, name: `${userId}#0001`, mu: 25, sigma: 8.3, ordinal: 0 }],
  };
}

const player = (userId: string) => ({ userId, name: `${userId}#0001`, region: 'na' });

/**
 * A store that parks the next `hgetall('entries')` (or `hdel('entries', …)`)
 * on a gate, so a test can hold a tick between reading the queue and placing
 * the lobby, or between claiming two entries.
 */
class GatedStore extends MemoryStore {
  private gate: { op: 'hgetall' | 'hdel'; wait: Promise<void>; reached: () => void } | null = null;

  /** Arms the gate; `parked` resolves once a call is held on it. */
  arm(op: 'hgetall' | 'hdel' = 'hgetall'): { parked: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    const parked = new Promise<void>((r) => (reached = r));
    this.gate = { op, wait, reached };
    return { parked, release };
  }

  private async pass(op: 'hgetall' | 'hdel', hash: string): Promise<void> {
    const g = this.gate;
    if (hash !== 'entries' || !g || g.op !== op) return;
    this.gate = null;
    g.reached();
    await g.wait;
  }

  override async hgetall(hash: string): Promise<Record<string, string>> {
    const result = await super.hgetall(hash);
    await this.pass('hgetall', hash);
    return result;
  }

  override async hdel(hash: string, field: string): Promise<boolean> {
    const removed = await super.hdel(hash, field);
    await this.pass('hdel', hash);
    return removed;
  }
}

function events(store: MemoryStore, userId: string): MMEvent[] {
  const out: MMEvent[] = [];
  void store.subscribe(userChannel(userId), (m) => out.push(JSON.parse(m) as MMEvent));
  return out;
}

describe('tick lock across instances', () => {
  it('places a lobby once when two instances tick together', async () => {
    const store = new MemoryStore();
    const a = new Matchmaker(cfg, store);
    const b = new Matchmaker(cfg, store);
    const seen = events(store, 'u1');
    await a.enqueue(player('u1'), ticket('u1'));
    await b.enqueue(player('u2'), ticket('u2'));
    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    expect(ra.length + rb.length).toBe(1);
    expect(seen.filter((e) => e.type === 'match_found')).toHaveLength(1);
    expect(await store.get('tick-lock')).toBeNull();
  });

  it('never releases a lock another instance took after it expired mid-tick', async () => {
    let clock = 1_000_000;
    const store = new GatedStore(() => clock);
    const a = new Matchmaker(cfg, store, () => clock);
    const b = new Matchmaker(cfg, store, () => clock);
    await a.enqueue(player('u1'), ticket('u1'));
    await a.enqueue(player('u2'), ticket('u2'));

    const gateA = store.arm();
    const tickA = a.tick();
    await gateA.parked;
    // A stalls past the lock TTL (GC pause, Redis latency); B takes over.
    clock += TICK_LOCK_TTL_MS + 1;
    const gateB = store.arm();
    const tickB = b.tick();
    await gateB.parked;
    const bToken = await store.get('tick-lock');
    expect(bToken).not.toBeNull();

    gateA.release();
    expect(await tickA).toEqual([]);
    // A noticed it lost the lock: it neither placed the lobby nor deleted B's lock.
    expect(await store.get('tick-lock')).toBe(bToken);

    gateB.release();
    expect(await tickB).toHaveLength(1);
    expect(await store.get('tick-lock')).toBeNull();
  });

  it('does not place an entry cancelled while the tick was forming its lobby', async () => {
    const store = new GatedStore();
    const mm = new Matchmaker(cfg, store);
    const u2 = events(store, 'u2');
    await mm.enqueue(player('u1'), ticket('u1'));
    await mm.enqueue(player('u2'), ticket('u2'));

    const gate = store.arm();
    const tick = mm.tick();
    await gate.parked;
    expect(await mm.cancel('u2')).toBe(true);
    gate.release();

    expect(await tick).toEqual([]);
    expect(u2.some((e) => e.type === 'match_found')).toBe(false);
    expect(u2.some((e) => e.type === 'queue_cancelled')).toBe(true);
    // The other player keeps their place in the queue.
    expect(await mm.entryFor('u1')).not.toBeNull();
  });

  it('replaces an entry re-queued while the tick was forming its lobby', async () => {
    const store = new GatedStore();
    const mm = new Matchmaker(cfg, store);
    await mm.enqueue(player('u1'), ticket('u1'));
    await mm.enqueue(player('u2'), ticket('u2'));
    const old = await mm.entryFor('u1');

    const gate = store.arm();
    const tick = mm.tick();
    await gate.parked;
    await mm.cancel('u2');
    const fresh = await mm.enqueue(player('u1'), ticket('u1', 4));
    gate.release();
    expect(await tick).toEqual([]);

    const entries = await mm.entries();
    expect(entries.map((e) => e.id)).toEqual([fresh.id]);
    expect(entries.some((e) => e.id === old?.id)).toBe(false);
  });

  it('puts claimed entries back when a lobby falls through, except ones cancelled meanwhile', async () => {
    let clock = 1_000_000;
    const store = new GatedStore(() => clock);
    const mm = new Matchmaker(cfg, store, () => clock);
    const seen = { u1: events(store, 'u1'), u2: events(store, 'u2'), u3: events(store, 'u3') };
    // Lobby of three, claimed oldest first: u1, then (gate) u2, u3.
    await mm.enqueue(player('u1'), ticket('u1', 3));
    clock += 1;
    await mm.enqueue(player('u2'), ticket('u2', 3));
    clock += 1;
    await mm.enqueue(player('u3'), ticket('u3', 3));

    const gate = store.arm('hdel');
    const tick = mm.tick();
    await gate.parked;
    // u1 is claimed (cancel can only drop its pointer); u2 is still in the queue, u3 untouched.
    expect(await mm.cancel('u1')).toBe(false);
    expect(await mm.cancel('u3')).toBe(true);
    gate.release();
    expect(await tick).toEqual([]);

    // u2 (claimed and still wanted) goes back; u1 (cancelled mid-claim) and u3 (cancelled) do not.
    expect((await mm.entries()).flatMap((e) => e.members.map((m) => m.userId))).toEqual(['u2']);
    for (const list of Object.values(seen)) expect(list.some((e) => e.type === 'match_found')).toBe(false);
  });

  it('places a lobby claimed in full even if a member cancels after the claim', async () => {
    const store = new MemoryStore();
    const mm = new Matchmaker(cfg, store);
    const seen = events(store, 'u2');
    await mm.enqueue(player('u1'), ticket('u1'));
    await mm.enqueue(player('u2'), ticket('u2'));
    const created = await mm.tick();
    expect(created).toHaveLength(1);
    // Too late: the match stands and the cancel is a no-op.
    expect(await mm.cancel('u2')).toBe(false);
    expect(seen.filter((e) => e.type === 'match_found')).toHaveLength(1);
  });

  it('refuses a re-queue while a tick holds the entry, and a cancel then wins over the put-back', async () => {
    const store = new MemoryStore();
    const mm = new Matchmaker(cfg, store);
    const entry = await mm.enqueue(player('u1'), ticket('u1'));
    // What a tick's claim looks like from outside: the entry is out of the hash, the pointer is still there.
    await store.hdel('entries', entry.id);
    await expect(mm.enqueue(player('u1'), ticket('u1'))).rejects.toMatchObject({
      status: 409,
      code: 'match_forming',
    });
    expect(await mm.cancel('u1')).toBe(false);
    expect(await store.get('user-entry:u1')).toBeNull();
  });

  it('releases lobby locks only for their owner', async () => {
    const store = new MemoryStore();
    await store.set('k', 'mine', 1000);
    expect(await store.delIfEquals('k', 'theirs')).toBe(false);
    expect(await store.expireIfEquals('k', 'theirs', 5000)).toBe(false);
    expect(await store.get('k')).toBe('mine');
    expect(await store.expireIfEquals('k', 'mine', 5000)).toBe(true);
    expect(await store.delIfEquals('k', 'mine')).toBe(true);
    expect(await store.get('k')).toBeNull();
  });
});
