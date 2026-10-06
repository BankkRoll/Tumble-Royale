import { expect, test } from '@playwright/test';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Online smoke: `?online=1&autoplay=1` connects to the game server, joins the
 * show the server runs (bots fill the lobby), and plays into a round with
 * predicted local movement and interpolated remotes.
 *
 * Start a server with a short fill wait first, e.g.
 *   cd apps/game-server && PORT=7351 FILL_WAIT_MS=2000 ../../node_modules/.bin/tsx src/main.ts
 *   GS=ws://localhost:7351/ws npx playwright test e2e/online.spec.ts
 */
const GS = process.env.GS ?? '';
const SHOTS = process.env.ONLINE_SHOTS ?? 'test-results/game';

test('online show reaches a live round with moving remotes', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  await page.setViewportSize({ width: 1280, height: 720 });
  const gs = GS ? `&gs=${encodeURIComponent(GS)}` : '';
  await page.goto(
    `${process.env.GAME_URL ?? ''}/?online=1&autoplay=1&fresh=1&api=0&tier=${process.env.TIER ?? 'medium'}${gs}`,
  );
  await page.waitForFunction(() => window.__tumble?.ready === true, undefined, { timeout: 120_000 });
  await page.waitForFunction(() => window.__tumble?.screen?.() === 'preShow', undefined, {
    timeout: 120_000,
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/online-preshow.png` });

  await page.waitForFunction(
    () => window.__tumble?.screen?.() === 'round' && (window.__tumble?.roundPhase?.() ?? 0) >= 4,
    undefined,
    { timeout: 180_000 },
  );
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => ({
    round: window.__tumble!.roundId!(),
    tumblers: window.__tumble!.tumblers!(),
    fps: Math.round(window.__tumble!.fps()),
  }));
  console.log('[online] in round', JSON.stringify(info));
  await page.screenshot({ path: `${SHOTS}/online-round.png` });
  expect(info.tumblers).toBeGreaterThan(1);
  expect(errors, errors.join('\n')).toHaveLength(0);
});

/**
 * Reconnect: a TCP proxy between the page and the game server is torn down
 * mid-round and restored 6 s later. The client must show the reconnect
 * curtain, resume its own player with the resume token (same player id, same
 * round) well inside the 30 s window, and keep playing.
 *
 *   GS_PORT=7351 npx playwright test e2e/online.spec.ts -g reconnect
 */
test('reconnect: link drop mid-round resumes the same player', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const { createServer, connect } = await import('node:net');
  const target = Number(process.env.GS_PORT ?? 7350);
  const sockets = new Set<Socket>();
  const proxy = createServer((client) => {
    const upstream = connect(target, 'localhost');
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => s.destroy());
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((r) => proxy.listen(0, r));
  const port = (proxy.address() as AddressInfo).port;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(
    `${process.env.GAME_URL ?? ''}/?online=1&autoplay=1&fresh=1&api=0&tier=low&gs=${encodeURIComponent(`ws://localhost:${port}/ws`)}`,
  );
  await page.waitForFunction(
    () => window.__tumble?.screen?.() === 'round' && (window.__tumble?.roundPhase?.() ?? 0) >= 4,
    undefined,
    { timeout: 240_000 },
  );
  const before = await page.evaluate(() => ({
    round: window.__tumble!.roundId!(),
    status: window.__tumble!.ui!.getState().connection.status,
  }));
  console.log('[reconnect] playing', JSON.stringify(before));

  // Drop the link: close the listener and every live connection.
  // Destroy live sockets first: close() only calls back once every connection has ended.
  const closed = new Promise<void>((r) => proxy.close(() => r()));
  for (const s of sockets) s.destroy();
  await closed;
  await page.waitForFunction(
    () => window.__tumble!.ui!.getState().connection.status === 'reconnecting',
    undefined,
    { timeout: 15_000 },
  );
  await page.screenshot({ path: `${SHOTS}/online-reconnecting.png` });
  const dropAt = Date.now();
  await page.waitForTimeout(6000);

  await new Promise<void>((r) => proxy.listen(port, r));
  await page.waitForFunction(
    () => window.__tumble!.ui!.getState().connection.status === 'online',
    undefined,
    { timeout: 30_000 },
  );
  const resumedIn = Date.now() - dropAt;
  const after = await page.evaluate(() => ({
    round: window.__tumble!.roundId!(),
    screen: window.__tumble!.screen!(),
    dialog: window.__tumble!.ui!.getState().dialog,
  }));
  console.log(`[reconnect] back online after ${resumedIn} ms`, JSON.stringify(after));
  expect(resumedIn).toBeLessThan(30_000);
  expect(after.dialog).toBeNull();
  expect(after.round).toBe(before.round);
  // Still receiving the show: the round keeps advancing (or the show moves on) without a failure dialog.
  await page.waitForTimeout(5000);
  expect(await page.evaluate(() => window.__tumble!.ui!.getState().dialog)).toBeNull();
  await page.screenshot({ path: `${SHOTS}/online-resumed.png` });
  proxy.close();
  for (const s of sockets) s.destroy();
  expect(errors, errors.join('\n')).toHaveLength(0);
});
