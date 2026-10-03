import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 3 acceptance: a full offline show with 40 Tumblers runs end to end in
 * the browser — boot → splash → welcome → menu → matchmaking → pre-show →
 * every round (flyover, countdown, play, results) → final → victory/winner
 * cam → player wall → rewards — with zero page errors.
 *
 * `?autoplay=1` drives the local Tumbler with a sharp bot brain and clicks
 * through the UI; `?ts=` speeds the simulation up.
 *
 * BACKEND=webgl npx playwright test e2e/game.spec.ts   (default: auto → WebGPU)
 */
const BACKEND = process.env.BACKEND ?? 'auto';
const TS = Number(process.env.TS ?? 4);
const SHOTS = 'test-results/game';
/** Other suites may wipe test-results mid-run; SHOT_COPY keeps a second copy. */
const COPY = process.env.SHOT_COPY;

async function waitScreen(page: Page, screens: string[], timeout: number): Promise<string> {
  const handle = await page.waitForFunction(
    (ids) => {
      const s = window.__tumble?.screen?.();
      return s && ids.includes(s) ? s : null;
    },
    screens,
    { timeout, polling: 100 },
  );
  return (await handle.jsonValue()) as string;
}

async function waitNextScreen(page: Page, screens: string[], prev: string, timeout: number): Promise<string> {
  const handle = await page.waitForFunction(
    ({ ids, last }) => {
      const s = window.__tumble?.screen?.();
      return s && s !== last && ids.includes(s) ? s : null;
    },
    { ids: screens, last: prev },
    { timeout, polling: 100 },
  );
  return (await handle.jsonValue()) as string;
}

async function snap(page: Page, name: string): Promise<void> {
  const buf = await page.screenshot({ path: `${SHOTS}/${BACKEND}-${name}.png` });
  if (COPY) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(COPY, { recursive: true });
    writeFileSync(`${COPY}/${BACKEND}-${name}.png`, buf);
  }
}

async function perf(page: Page): Promise<{ fps: number; draws: number; tumblers: number; tier: string; memory: unknown }> {
  return page.evaluate(() => ({
    fps: Math.round(window.__tumble!.fps()),
    draws: window.__tumble!.drawCalls!(),
    tumblers: window.__tumble!.tumblers!(),
    tier: window.__tumble!.tier!(),
    memory: window.__tumble!.memory!(),
  }));
}

const FLOW = ['roundIntro', 'roundResults', 'betweenRounds', 'finalHype', 'victory', 'winnerCam', 'playerWall', 'rewards'];

test('full offline show with 40 players, boot to rewards', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) console.log('[console.error]', m.text().slice(0, 300));
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${process.env.GAME_URL ?? ''}/?autoplay=1&ts=${TS}&fresh=1&api=0&seed=11&tier=high&backend=${BACKEND}`);
  await page.waitForFunction(() => window.__tumble?.ready === true, undefined, { timeout: 120_000 });
  console.log('[game] backend', await page.evaluate(() => window.__tumble!.backend));

  await waitScreen(page, ['splash'], 60_000);
  await page.waitForTimeout(3000);
  await snap(page, '01-splash');

  await waitScreen(page, ['menu'], 60_000);
  await page.waitForTimeout(1500);
  await snap(page, '02-menu');

  await waitScreen(page, ['preShow'], 60_000);
  await page.waitForTimeout(2500);
  await snap(page, '03-preshow');

  let round = 0;
  let last = 'preShow';
  for (;;) {
    const s = await waitNextScreen(page, FLOW, last, 300_000);
    last = s;
    if (s === 'roundIntro') {
      round++;
      console.log(`[game] round ${round}: ${await page.evaluate(() => window.__tumble!.roundId!())}`);
      await page.waitForTimeout(1200);
      await snap(page, `04-r${round}-flyover`);
      await page.waitForFunction(() => window.__tumble!.screen!() === 'round' && window.__tumble!.roundPhase!() === 4, undefined, { timeout: 120_000 });
      await page.waitForTimeout(2500);
      const p = await perf(page);
      console.log(`[game] round ${round} playing`, JSON.stringify(p));
      if (round === 1) expect(p.tumblers).toBe(40);
      await snap(page, `05-r${round}-play`);
      last = 'round';
    } else if (s === 'roundResults') {
      await page.waitForTimeout(2600);
      await snap(page, `06-r${round}-results`);
    } else if (s === 'betweenRounds') {
      await page.waitForTimeout(1300);
      await snap(page, `07-r${round}-between`);
    } else if (s === 'finalHype') {
      await page.waitForTimeout(500);
      await snap(page, '08-final-hype');
    } else if (s === 'victory' || s === 'winnerCam') {
      await page.waitForTimeout(2500);
      await snap(page, `09-${s}`);
    } else if (s === 'playerWall') {
      await page.waitForTimeout(4000);
      await snap(page, '10-wall-recap');
      await page.waitForTimeout(9000);
      await snap(page, '11-wall-winner');
    } else if (s === 'rewards') {
      await page.waitForTimeout(3500);
      await snap(page, '12-rewards');
      break;
    }
  }
  console.log(`[game] rounds played: ${round}`);
  expect(round).toBeGreaterThanOrEqual(3);

  const memoryLog = await page.evaluate(() => window.__tumble!.memoryLog);
  console.log('[game] GPU memory per round', JSON.stringify(memoryLog));
  const summary = await page.evaluate(() => window.__tumble!.summary!());
  expect(summary).toBeTruthy();
  expect(errors, errors.join('\n')).toHaveLength(0);
});

/**
 * Real-time performance sample (PERF=1): 40 Tumblers at ts=1, FPS and draw
 * calls averaged over 6 s of the first round's play.
 */
test('perf: 40 Tumblers at real time', async ({ page }) => {
  test.skip(process.env.PERF !== '1', 'set PERF=1');
  test.setTimeout(5 * 60_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${process.env.GAME_URL ?? ''}/?autoplay=1&ts=1&fresh=1&api=0&seed=11&playlist=main-show&tier=${process.env.TIER ?? 'high'}&backend=${BACKEND}`);
  await page.waitForFunction(() => window.__tumble?.screen?.() === 'round' && window.__tumble?.roundPhase?.() === 4, undefined, { timeout: 240_000 });
  await page.waitForTimeout(1500);
  const f0 = await page.evaluate(() => window.__tumble!.frames);
  const t0 = Date.now();
  let draws = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500);
    draws += await page.evaluate(() => window.__tumble!.drawCalls!());
  }
  const f1 = await page.evaluate(() => window.__tumble!.frames);
  const fps = ((f1 - f0) * 1000) / (Date.now() - t0);
  const info = await page.evaluate(() => ({ backend: window.__tumble!.backend, tier: window.__tumble!.tier!(), tumblers: window.__tumble!.tumblers!(), round: window.__tumble!.roundId!() }));
  console.log('[perf]', JSON.stringify({ ...info, fps: Math.round(fps * 10) / 10, drawCalls: Math.round(draws / 12) }));
  await snap(page, `perf-${info.tier}`);
});
