/**
 * The Redis KV against a real server: the Lua counter behind rate limits and
 * nonces, and the pub/sub that keeps every instance's ban cache honest. Runs
 * only when `REDIS_URL` is set (the CI services job); the in-process KV the
 * rest of the suite uses cannot catch a broken script or a prefix mismatch.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../src/db/client.ts';
import { RedisKV } from '../src/kv/redis.ts';
import { BAN_INVALIDATION_CHANNEL } from '../src/http/auth.ts';
import { createScratchDatabase, isolatedRedisKV, TEST_DATABASE_URL, TEST_REDIS_URL } from './backing.ts';
import { createTestApi, type TestApi } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

describe.skipIf(!TEST_REDIS_URL)('RedisKV against a real server', () => {
  const url = TEST_REDIS_URL!;
  const open: RedisKV[] = [];
  const kv = (): RedisKV => {
    const k = isolatedRedisKV(url);
    open.push(k);
    return k;
  };
  afterEach(async () => {
    for (const k of open.splice(0)) await k.close();
  });

  it('starts a window on the first increment and never extends it', async () => {
    const k = kv();
    expect(await k.incr('rl:a', 300)).toBe(1);
    expect(await k.incr('rl:a', 60_000)).toBe(2);
    await sleep(400);
    // The first hit's 300 ms window ended; the second hit must not have extended it.
    expect(await k.get('rl:a')).toBeNull();
    expect(await k.incr('rl:a', 300)).toBe(1);
  });

  it('gives a counter left without a TTL one on the next hit', async () => {
    const k = kv();
    await k.set('rl:stuck', '7');
    expect(await k.incr('rl:stuck', 200)).toBe(8);
    await sleep(300);
    expect(await k.get('rl:stuck')).toBeNull();
  });

  it('counts concurrent hits from two instances exactly once each', async () => {
    const prefix = `tumble-test:${randomUUID()}:`;
    const a = new RedisKV(url, prefix);
    const b = new RedisKV(url, prefix);
    open.push(a, b);
    const hits = await Promise.all(
      Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).incr('rl:burst', 5000)),
    );
    expect([...hits].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  /** Two instances of one environment: same Redis, same prefix. */
  const pair = (): [RedisKV, RedisKV] => {
    const prefix = `tumble-test:${randomUUID()}:`;
    const a = new RedisKV(url, prefix);
    const b = new RedisKV(url, prefix);
    open.push(a, b);
    return [a, b];
  };

  it('delivers published messages to subscribers on another connection', async () => {
    const [pub, sub] = pair();
    const got: string[] = [];
    const unsubscribe = await sub.subscribe('test:chan', (m) => got.push(m));
    await pub.publish('test:chan', 'hello');
    await until(async () => got.length === 1);
    await unsubscribe();
    await pub.publish('test:chan', 'after');
    await sleep(100);
    expect(got).toEqual(['hello']);
  });

  it('keeps pub/sub of environments with different prefixes apart', async () => {
    const prod = kv();
    const staging = kv();
    const got: string[] = [];
    await prod.subscribe(BAN_INVALIDATION_CHANNEL, (m) => got.push(m));
    await staging.publish(BAN_INVALIDATION_CHANNEL, 'staging-user');
    await prod.publish(BAN_INVALIDATION_CHANNEL, 'prod-user');
    await until(async () => got.length === 1);
    await sleep(100);
    expect(got).toEqual(['prod-user']);
  });

  it('resolves every concurrent subscribe only once the channel is really subscribed', async () => {
    const [pub, sub] = pair();
    const got: string[] = [];
    await Promise.all([
      sub.subscribe('test:race', (m) => got.push(`1:${m}`)),
      sub.subscribe('test:race', (m) => got.push(`2:${m}`)),
    ]);
    await pub.publish('test:race', 'now');
    await until(async () => got.length === 2);
    expect(got.sort()).toEqual(['1:now', '2:now']);
  });

  it('releases and renews a lock only for its holder', async () => {
    const [a, b] = pair();
    expect(await a.setNX('lock:x', 'token-a', 200)).toBe(true);
    expect(await b.delIfEquals('lock:x', 'token-b')).toBe(false);
    expect(await b.expireIfEquals('lock:x', 'token-b', 60_000)).toBe(false);
    expect(await a.expireIfEquals('lock:x', 'token-a', 60_000)).toBe(true);
    await sleep(300);
    expect(await b.get('lock:x')).toBe('token-a');
    expect(await a.delIfEquals('lock:x', 'token-a')).toBe(true);
    expect(await b.get('lock:x')).toBeNull();
  });
});

describe.skipIf(!TEST_REDIS_URL)('ban invalidation across API instances on Redis', () => {
  let apis: TestApi[] = [];
  let database: Database | undefined;
  let dropDatabase: (() => Promise<void>) | undefined;
  afterEach(async () => {
    for (const a of apis) await a.close();
    apis = [];
    await database?.close();
    await dropDatabase?.();
  });

  it('drops a cached "not banned" on the other instance right away', async () => {
    const scratch = TEST_DATABASE_URL ? await createScratchDatabase(TEST_DATABASE_URL) : undefined;
    dropDatabase = scratch?.drop;
    database = await openDatabase({ databaseUrl: scratch?.url, pgliteDir: 'memory://' });
    const db = { ...database, close: async () => undefined };
    // Two connections of one environment (one prefix), as two API processes would have;
    // ban invalidations travel between them.
    const prefix = `tumble-test:${randomUUID()}:`;
    const kvA = new RedisKV(TEST_REDIS_URL!, prefix);
    const kvB = new RedisKV(TEST_REDIS_URL!, prefix);
    const a = await createTestApi(undefined, {}, { kv: kvA, database: db });
    const b = await createTestApi(undefined, {}, { kv: kvB, database: db });
    apis = [a, b];

    const seen: string[] = [];
    await kvB.subscribe(BAN_INVALIDATION_CHANNEL, (id) => seen.push(id));
    const u = await a.guest();
    expect((await b.req('GET', '/me', { token: u.accessToken })).statusCode).toBe(200);
    await a.ban(u.id);
    await until(async () => seen.includes(u.id));
    // Without the message B would serve its cached "no bans" for 15 s.
    expect((await b.req('GET', '/me', { token: u.accessToken })).statusCode).toBe(403);
  });
});
