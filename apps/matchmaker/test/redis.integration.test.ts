/**
 * The Redis store against a real server: the Lua scripts behind the tick lock
 * (compare-and-delete, compare-and-renew) and the rate-limit windows, the
 * atomic hash claim, pub/sub, and two matchmakers sharing one Redis. Runs only
 * when `REDIS_URL` is set (the CI services job); the in-process store the
 * rest of the suite uses cannot catch a broken script.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { Matchmaker, userChannel, type MMEvent } from '../src/matchmaker.ts';
import { RedisStore } from '../src/store.ts';
import type { QueueTicket } from '../src/tickets.ts';
import { testEnv } from './helpers.ts';

const REDIS_URL = process.env.REDIS_URL?.trim() || undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

describe.skipIf(!REDIS_URL)('RedisStore against a real server', () => {
  const open: RedisStore[] = [];
  /** Stores sharing one fresh key prefix, as matchmaker instances sharing a Redis do. */
  const stores = (n: number): RedisStore[] => {
    const prefix = `tumble-test:mm:${randomUUID()}:`;
    const out = Array.from({ length: n }, () => new RedisStore(REDIS_URL!, prefix));
    open.push(...out);
    return out;
  };
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close();
  });

  it('releases the tick lock only for the holder', async () => {
    const [a, b] = stores(2) as [RedisStore, RedisStore];
    expect(await a.setNX('tick-lock', 'token-a', 5000)).toBe(true);
    expect(await b.setNX('tick-lock', 'token-b', 5000)).toBe(false);
    expect(await b.delIfEquals('tick-lock', 'token-b')).toBe(false);
    expect(await a.get('tick-lock')).toBe('token-a');
    expect(await a.delIfEquals('tick-lock', 'token-a')).toBe(true);
    expect(await a.get('tick-lock')).toBeNull();
    expect(await b.setNX('tick-lock', 'token-b', 5000)).toBe(true);
  });

  it('renews the tick lock only for the holder', async () => {
    const [a, b] = stores(2) as [RedisStore, RedisStore];
    await a.setNX('tick-lock', 'token-a', 300);
    expect(await b.expireIfEquals('tick-lock', 'token-b', 60_000)).toBe(false);
    expect(await a.expireIfEquals('tick-lock', 'token-a', 60_000)).toBe(true);
    await sleep(400);
    // Renewed past its original 300 ms; the stranger's renewal did nothing.
    expect(await b.get('tick-lock')).toBe('token-a');
    expect(await b.expireIfEquals('tick-lock', 'token-b', 60_000)).toBe(false);
  });

  it('lets a lapsed lock go and refuses the old holder a renewal', async () => {
    const [a, b] = stores(2) as [RedisStore, RedisStore];
    await a.setNX('tick-lock', 'token-a', 150);
    await sleep(250);
    expect(await b.setNX('tick-lock', 'token-b', 5000)).toBe(true);
    expect(await a.expireIfEquals('tick-lock', 'token-a', 5000)).toBe(false);
    expect(await a.delIfEquals('tick-lock', 'token-a')).toBe(false);
    expect(await a.get('tick-lock')).toBe('token-b');
  });

  it('counts fixed rate-limit windows shared by instances', async () => {
    const [a, b] = stores(2) as [RedisStore, RedisStore];
    expect(await a.hitWindow('rl:ip:1', 300)).toMatchObject({ count: 1, ttlMs: 300 });
    const second = await b.hitWindow('rl:ip:1', 300);
    expect(second.count).toBe(2);
    expect(second.ttlMs).toBeGreaterThan(0);
    expect(second.ttlMs).toBeLessThanOrEqual(300);
    await sleep(400);
    expect((await a.hitWindow('rl:ip:1', 300)).count).toBe(1);
  });

  it('counts concurrent hits exactly once each', async () => {
    const [a, b] = stores(2) as [RedisStore, RedisStore];
    const hits = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).hitWindow('rl:burst', 5000)),
    );
    expect(hits.map((h) => h.count).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
  });

  it('lets exactly one instance claim a hash field', async () => {
    const [a, b] = stores(2) as [RedisStore, RedisStore];
    await a.hset('entries', 'p1', '{}');
    const claims = await Promise.all([a.hdel('entries', 'p1'), b.hdel('entries', 'p1')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('delivers pub/sub messages between instances until unsubscribed', async () => {
    const [a, b] = stores(2) as [RedisStore, RedisStore];
    const got: string[] = [];
    const unsubscribe = await b.subscribe('test:chan', (m) => got.push(m));
    await a.publish('test:chan', 'hello');
    await until(() => got.length === 1);
    await unsubscribe();
    await a.publish('test:chan', 'after');
    await sleep(100);
    expect(got).toEqual(['hello']);
  });

  it('keeps pub/sub of environments with different prefixes apart', async () => {
    const [prod] = stores(1) as [RedisStore];
    const [staging] = stores(1) as [RedisStore];
    const got: string[] = [];
    await prod.subscribe(userChannel('u1'), (m) => got.push(m));
    await staging.publish(userChannel('u1'), 'from staging');
    await prod.publish(userChannel('u1'), 'from prod');
    await until(() => got.length === 1);
    await sleep(100);
    expect(got).toEqual(['from prod']);
  });

  it('lets every concurrent subscriber of a channel receive the very next message', async () => {
    const [a, b] = stores(2) as [RedisStore, RedisStore];
    const got: string[] = [];
    await Promise.all([
      b.subscribe('test:race', (m) => got.push(`1:${m}`)),
      b.subscribe('test:race', (m) => got.push(`2:${m}`)),
    ]);
    await a.publish('test:race', 'now');
    await until(() => got.length === 2);
    expect(got.sort()).toEqual(['1:now', '2:now']);
  });

  it('renews the TTL of an existing key only', async () => {
    const [a] = stores(1) as [RedisStore];
    await a.set('match:m1', '{}', 200);
    expect(await a.expire('match:m1', 60_000)).toBe(true);
    expect(await a.expire('match:missing', 60_000)).toBe(false);
    await sleep(300);
    expect(await a.get('match:m1')).toBe('{}');
  });
});

describe.skipIf(!REDIS_URL)('two matchmakers sharing Redis', () => {
  const cfg = loadConfig(testEnv({ DEFAULT_GAME_SERVER_URL: 'ws://gs.test/ws' }));
  const open: RedisStore[] = [];
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close();
  });

  const ticket = (userId: string): QueueTicket => ({
    typ: 'queue',
    sub: userId,
    pid: `solo:${userId}`,
    leaderId: userId,
    playlistId: 'main-show',
    queue: 'casual',
    teamSize: 1,
    maxPlayers: 2,
    minPlayers: 2,
    botsAllowed: true,
    region: 'na',
    members: [{ userId, name: `${userId}#0001`, mu: 25, sigma: 8.3, ordinal: 0 }],
  });

  it('places a lobby once when both tick together, then frees the lock', async () => {
    const prefix = `tumble-test:mm:${randomUUID()}:`;
    const storeA = new RedisStore(REDIS_URL!, prefix);
    const storeB = new RedisStore(REDIS_URL!, prefix);
    open.push(storeA, storeB);
    const a = new Matchmaker(cfg, storeA);
    const b = new Matchmaker(cfg, storeB);
    const found: MMEvent[] = [];
    await storeB.subscribe(userChannel('u1'), (m) => {
      const e = JSON.parse(m) as MMEvent;
      if (e.type === 'match_found') found.push(e);
    });
    await a.enqueue({ userId: 'u1', name: 'u1#0001', region: 'na' }, ticket('u1'));
    await b.enqueue({ userId: 'u2', name: 'u2#0001', region: 'na' }, ticket('u2'));
    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    expect(ra.length + rb.length).toBe(1);
    await until(() => found.length > 0);
    await sleep(100);
    expect(found).toHaveLength(1);
    expect(await storeA.get('tick-lock')).toBeNull();
  });
});
