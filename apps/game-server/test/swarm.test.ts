/**
 * The bot swarm against a real listening server: a burst of clients from one
 * address must all get in despite `maxPendingPerIp` refusals, and every
 * client must ack the round it joins so LOADING ends on acks rather than on
 * the hard cap (which eliminates whoever has not loaded).
 */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SwarmClient } from '../../../tools/bot-swarm/src/client.ts';
import { DEV_HTTP_POLICY, startGameServer, type GameServer } from '../src/server.ts';
import { SimpleShowController } from '../src/show/SimpleShowController.ts';
import { testDeps, type FakeMatchSim } from './helpers.ts';

let server: GameServer | null = null;
const clients: SwarmClient[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.close();
  server = null;
});

const until = async (cond: () => boolean, ms: number): Promise<void> => {
  const end = performance.now() + ms;
  while (!cond() && performance.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe('bot swarm', () => {
  it('retries refused connects and acks every round it joins', async () => {
    const loaded = new Set<number>();
    const sims: FakeMatchSim[] = [];
    const deps = {
      ...testDeps({ now: 0 }, sims),
      now: () => performance.now(),
      createShowController: () => {
        const show = new SimpleShowController({ roundId: 'test-round', playSeconds: 1000 });
        return Object.assign(show, { onPlayerLoaded: (id: number) => void loaded.add(id) });
      },
    };
    const count = 12;
    server = await startGameServer({
      port: 0,
      host: '127.0.0.1',
      deps,
      profileLogMs: 0,
      http: { ...DEV_HTTP_POLICY, maxPendingPerIp: 2 },
      config: { capacity: count, startAtHumans: count, fillWaitMs: 60_000 },
    });
    // Whether a burst overlaps enough handshakes to reach the cap depends on how
    // the host schedules loopback I/O, so two silent sockets hold both pending
    // slots and the swarm is refused until they leave, on any host.
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const holders = [new WebSocket(url), new WebSocket(url)];
    sockets.push(...holders);
    await Promise.all(holders.map((ws) => new Promise((resolve) => ws.once('open', resolve))));
    // Opened in one burst, as `--ramp 0` would.
    for (let i = 0; i < count; i++) {
      const c = new SwarmClient(`ws://127.0.0.1:${server.port}/ws`, i);
      c.connect();
      clients.push(c);
    }
    const timer = setInterval(() => {
      for (const c of clients) c.step();
    }, 16);
    try {
      await until(() => clients.every((c) => c.stats.refused > 0), 5_000);
      expect(clients.filter((c) => c.stats.welcomed)).toHaveLength(0);
      for (const ws of holders) ws.close();
      await until(() => clients.every((c) => c.stats.welcomed) && loaded.size === count, 20_000);
    } finally {
      clearInterval(timer);
    }
    expect(clients.filter((c) => c.stats.welcomed)).toHaveLength(count);
    expect(clients.every((c) => c.stats.refused > 0)).toBe(true);
    expect(loaded.size).toBe(count);
  });
});
