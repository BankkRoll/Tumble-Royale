import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Main-menu 3D lobby: mouse buttons never drive the Tumbler in menus, idle
 * play keeps it on the platform, and the lobby emote picker plays an emote.
 *
 * Run against a private server so other agents' hot reloads can't interfere:
 *   GAME_URL=http://localhost:4199 npx playwright test e2e/lobby.spec.ts
 * LOBBY_SHOTS=<dir> also saves screenshots (1440×900 and 390×844).
 */
const GAME = process.env.GAME_URL ?? 'http://localhost:5173';
const SHOTS = process.env.LOBBY_SHOTS;
const DIVE = 4;
const DIVE_SLIDE = 5;
const EMOTE = 13;
const WALL_RADIUS = 5.7;

interface LobbyState {
  state: number;
  position: { x: number; y: number; z: number };
  idlePlaying: boolean;
  cameraPitch: number;
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  return errors;
}

async function lobby(page: Page): Promise<LobbyState> {
  const s = await page.evaluate(() => window.__tumble?.lobbyState?.() ?? null);
  expect(s, 'lobby hook is live on the menu').not.toBeNull();
  return s!;
}

async function snap(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { width } = page.viewportSize()!;
  await page.screenshot({ path: `${SHOTS}/${width}-${name}.png` });
}

/** Boots a fresh profile straight to the menu's Play tab. */
async function toMenu(page: Page, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  // NOTE: against a dev server, other edits in the monorepo would hot-reload the page mid-test; never connect the HMR socket.
  await page.routeWebSocket(/\/\?token=/, () => undefined);
  await page.goto(`${GAME}/?autoplay=0&api=0&fresh=1&tier=high`);
  await page.waitForFunction(() => window.__tumble?.ready === true, undefined, { timeout: 120_000 });
  await page.waitForFunction(() => window.__tumble?.screen?.() === 'splash', undefined, { timeout: 60_000 });
  await page.waitForTimeout(400);
  for (let i = 0; i < 60; i++) {
    const screen = await page.evaluate(() => window.__tumble!.screen!());
    if (screen === 'menu') break;
    await page.evaluate((s) => {
      const t = window.__tumble!;
      if (s === 'splash') t.emit!('start');
      else if (s === 'welcome')
        t.emit!('welcomeDone', {
          name: 'Lobby Tester',
          colors: { primary: '#ff5fa8', secondary: '#ffd23f', pattern: 'plain' },
        });
      else if (s === 'tutorialPrompt') t.emit!('tutorialChoice', { accept: false, dontAskAgain: true });
    }, screen);
    await page.waitForTimeout(500);
  }
  await page.waitForFunction(
    () => window.__tumble?.screen?.() === 'menu' && window.__tumble.ui!.getState().menuTab === 'play',
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(() => window.__tumble?.lobbyState?.() != null, undefined, { timeout: 30_000 });
  // Wipe transition and the menu intro animations.
  await page.waitForTimeout(2200);
  await expect(page.locator('.tr-lobby-emote-btn')).toBeVisible();
}

/** A viewport point where the canvas itself receives the click (no UI on top). */
async function emptyCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(() => {
    const w = innerWidth;
    const h = innerHeight;
    for (const [fx, fy] of [
      [0.5, 0.55],
      [0.45, 0.4],
      [0.55, 0.65],
      [0.4, 0.5],
      [0.6, 0.45],
      [0.5, 0.3],
    ] as const) {
      const x = Math.round(w * fx);
      const y = Math.round(h * fy);
      if (document.elementFromPoint(x, y) instanceof HTMLCanvasElement) return { x, y };
    }
    return null;
  });
  expect(p, 'some of the stage is clickable canvas').not.toBeNull();
  return p!;
}

test.describe('main-menu lobby', () => {
  test.setTimeout(4 * 60_000);

  test('mouse clicks on the canvas and UI never make the Tumbler dive', async ({ page }) => {
    const errors = trackErrors(page);
    await toMenu(page);
    await snap(page, '01-standing');

    const states: number[] = [];
    const sample = async (): Promise<void> => {
      states.push((await lobby(page)).state);
    };

    const pt = await emptyCanvasPoint(page);
    for (let i = 0; i < 6; i++) {
      await page.mouse.click(pt.x, pt.y);
      for (let k = 0; k < 4; k++) {
        await sample();
        await page.waitForTimeout(60);
      }
    }
    expect((await lobby(page)).idlePlaying, 'an empty-canvas click starts idle play').toBe(true);
    expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();

    await page.mouse.down({ button: 'left' });
    for (let k = 0; k < 8; k++) {
      await sample();
      await page.waitForTimeout(60);
    }
    await page.mouse.up({ button: 'left' });
    await page.mouse.click(pt.x, pt.y, { button: 'right' });

    // Opening and closing the emote picker and hopping between tabs are UI clicks, not gameplay presses.
    await page.keyboard.press('Escape');
    for (const sel of [
      '.tr-lobby-emote-btn',
      '.tr-lobby-emote-btn',
      '[data-tab="locker"]',
      '[data-tab="play"]',
    ]) {
      await page.locator(sel).first().click();
      for (let k = 0; k < 4; k++) {
        await sample();
        await page.waitForTimeout(60);
      }
    }
    await page.waitForTimeout(1500);
    await sample();

    for (const tab of ['store', 'pass']) {
      await page.locator(`[data-tab="${tab}"]`).first().click();
      await page.waitForTimeout(1400);
      await sample();
      await snap(page, `06-dressing-${tab}`);
    }
    await page.locator('[data-tab="play"]').first().click();

    expect(
      states.filter((s) => s === DIVE || s === DIVE_SLIDE),
      `states seen: ${states.join(',')}`,
    ).toHaveLength(0);
    expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('holding a move key toward the edge keeps the Tumbler on the platform', async ({ page }) => {
    const errors = trackErrors(page);
    await toMenu(page);
    await page.locator('canvas').first().focus();

    let maxR = 0;
    let minY = Infinity;
    const pitches: number[] = [];
    for (const key of ['KeyW', 'KeyA', 'KeyD']) {
      await page.keyboard.down(key);
      for (let i = 0; i < 25; i++) {
        await page.waitForTimeout(160);
        const s = await lobby(page);
        maxR = Math.max(maxR, Math.hypot(s.position.x, s.position.z));
        minY = Math.min(minY, s.position.y);
        if (s.idlePlaying) pitches.push(s.cameraPitch);
        if (key === 'KeyW' && i === 12) await snap(page, '02-idle-play');
      }
      // Spam jumps into the wall too: still no way over it.
      if (key === 'KeyW') {
        for (let j = 0; j < 4; j++) {
          await page.keyboard.press('Space');
          await page.waitForTimeout(350);
          const s = await lobby(page);
          maxR = Math.max(maxR, Math.hypot(s.position.x, s.position.z));
          minY = Math.min(minY, s.position.y);
        }
      }
      await page.keyboard.up(key);
    }
    const end = await lobby(page);
    console.log(
      `[lobby] max radius ${maxR.toFixed(2)} m, min y ${minY.toFixed(2)} m, pitch ${Math.min(...pitches).toFixed(1)}–${Math.max(...pitches).toFixed(1)}°`,
    );
    expect(end.idlePlaying).toBe(true);
    expect(maxR, 'reached the rim').toBeGreaterThan(WALL_RADIUS - 1.2);
    expect(maxR, 'never past the rim wall').toBeLessThan(WALL_RADIUS + 0.2);
    expect(minY, 'never fell').toBeGreaterThan(-0.3);
    expect(Math.max(...pitches), 'never near top-down').toBeLessThan(40);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(1600);
    const back = await lobby(page);
    expect(back.idlePlaying).toBe(false);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    test(`emote picker plays an emote on the lobby Tumbler (${w}×${h})`, async ({ page }) => {
      const errors = trackErrors(page);
      await toMenu(page, w, h);
      if (w === 390) await snap(page, '01-standing');
      await page.locator('.tr-lobby-emote-btn').click();
      const item = page.locator('.tr-lobby-emote-item:not(.is-locked)').first();
      await expect(item).toBeVisible();
      await page.waitForTimeout(450);
      await snap(page, '03-emote-wheel');
      expect(await page.locator('.tr-lobby-emotes').textContent()).not.toMatch(/\p{Extended_Pictographic}/u);
      await item.click();
      await page.waitForFunction((e) => window.__tumble?.lobbyState?.()?.state === e, EMOTE, {
        timeout: 5000,
        polling: 50,
      });
      await page.waitForTimeout(700);
      await snap(page, '04-confetti');
      expect(await page.locator('.tr-lobby-emote-panel').count(), 'picker closes after a pick').toBe(0);

      // B opens the picker from the keyboard, 1 plays the first equipped emote.
      await page.waitForTimeout(2600);
      await page.keyboard.press('KeyB');
      await expect(page.locator('.tr-lobby-emote-panel')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.tr-lobby-emote-panel')).toHaveCount(0);
      expect(await page.evaluate(() => window.__tumble!.screen!())).toBe('menu');
      await page.keyboard.press('Digit1');
      await page.waitForFunction((e) => window.__tumble?.lobbyState?.()?.state === e, EMOTE, {
        timeout: 5000,
        polling: 50,
      });

      // Emote during idle play too.
      await page.waitForTimeout(2800);
      await page.keyboard.down('KeyS');
      await page.waitForTimeout(700);
      await page.keyboard.up('KeyS');
      await page.waitForTimeout(500);
      expect((await lobby(page)).idlePlaying).toBe(true);
      await page.locator('.tr-lobby-emote-btn').click();
      await page.locator('.tr-lobby-emote-item:not(.is-locked)').first().click();
      await page.waitForFunction((e) => window.__tumble?.lobbyState?.()?.state === e, EMOTE, {
        timeout: 5000,
        polling: 50,
      });
      await page.waitForTimeout(600);
      await snap(page, '05-idle-emote');
      expect(errors, errors.join('\n')).toHaveLength(0);
    });
  }
});
