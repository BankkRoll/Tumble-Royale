import { expect, test, type Page } from '@playwright/test';

/**
 * Button map acceptance (docs/design/SCREENS.md "Button map"): clicks every
 * top-level main-menu control and asserts where it lands. Runs offline
 * (`?api=0`) with a seeded local profile so the menu opens straight away.
 *
 * GAME_URL=http://localhost:4199 npx playwright test e2e/menu.spec.ts --workers=1
 */
const BASE = process.env.GAME_URL ?? '';

function seedProfile(): string {
  const day = new Date().toISOString().slice(0, 10);
  const colors = { primary: '#ff4f9a', secondary: '#ffd23f', tertiary: '#fff7ea', pattern: 'dots' };
  const loadout = (n: number): unknown => ({
    name: `Loadout ${n}`,
    colors,
    items: {
      face: 'face.classic',
      celebration: 'celebration.cheer',
      victory: 'victory.superstar',
      nameplate: 'nameplate.classic',
    },
    emotes: ['emote.wave', 'emote.dance', 'emote.laugh', 'emote.flex'],
  });
  return JSON.stringify({
    version: 1,
    id: 'e2e-menu',
    name: 'Sprinkles',
    tag: '4821',
    totalXp: 30000,
    seasonXp: 12000,
    gumballs: 4250,
    gems: 0,
    crowns: 1,
    crownShards: 12,
    owned: ['headwear.beanie', 'back.cape'],
    loadouts: [1, 2, 3, 4, 5, 6].map(loadout),
    activeLoadout: 0,
    stats: {
      shows: 3,
      finals: 1,
      roundsQualified: 5,
      bestStreak: 1,
      streak: 0,
      roundCounts: { 'Gumdrop Gauntlet': 2 },
    },
    history: [],
    tutorialAnswered: true,
    lastShowDay: day,
    daily: {
      period: day,
      counts: {
        showsPlayed: 50,
        roundsQualified: 50,
        racesQualified: 50,
        survivalsQualified: 50,
        teamRoundsWon: 50,
        jumps: 500,
        dives: 500,
        grabs: 500,
        bounces: 50,
        checkpoints: 50,
        finalsReached: 5,
        emotes: 50,
      },
      claimed: [],
    },
    weekly: { period: 'none', counts: {}, claimed: [] },
    passClaimed: [],
    premiumPass: false,
  });
}

async function state<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(
    (src) => new Function('s', `return (${src})(s)`)(window.__tumble!.ui!.getState()),
    fn,
  ) as Promise<T>;
}

const tab = (page: Page): Promise<string> => state(page, '(s) => s.menuTab');
const screen = (page: Page): Promise<string> => state(page, '(s) => s.screen');
const overlay = (page: Page): Promise<string> => state(page, '(s) => s.overlay');

async function toMenu(page: Page): Promise<void> {
  await page.addInitScript((p) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('tumble.v1.profile', p);
      sessionStorage.setItem('seeded', '1');
    }
  }, seedProfile());
  await page.goto(`${BASE}/?autoplay=0&api=0`);
  await page.waitForFunction(() => window.__tumble?.screen?.() === 'splash', null, { timeout: 60_000 });
  for (let i = 0; i < 40 && (await screen(page)) !== 'menu'; i++) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  }
  expect(await screen(page)).toBe('menu');
  // Let the tab bar / start card finish their entrances.
  await page.waitForTimeout(900);
}

test.describe('main menu button map', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await toMenu(page);
  });

  test('top tabs, Q/E cycling and level badge', async ({ page }) => {
    for (const t of ['locker', 'store', 'pass', 'challenges', 'profile', 'leaderboards', 'news', 'play']) {
      await page.click(`[data-tab="${t}"]`);
      await expect.poll(() => tab(page)).toBe(t);
      await expect(page.getByTestId(`panel-${t}`)).toBeVisible();
    }
    for (const label of await page.locator('[role="tab"][data-tab]').allInnerTexts()) {
      expect(label.trim()).toMatch(/^[A-Za-z ]+$/);
    }
    await page.keyboard.press('KeyE');
    await expect.poll(() => tab(page)).toBe('locker');
    await page.keyboard.press('KeyQ');
    await expect.poll(() => tab(page)).toBe('play');
    await page.getByTestId('level-badge').click();
    await expect.poll(() => tab(page)).toBe('profile');
  });

  test('wallet pills open the right popovers (never a purchase)', async ({ page }) => {
    await page.getByTestId('wallet-pill-gumballs').getByRole('button').click();
    const earn = page.getByTestId('wallet-gumballs');
    await expect(earn).toBeVisible();
    await expect(earn).toContainText('earned by playing');
    await page.getByTestId('earn-challenges').click();
    await expect.poll(() => tab(page)).toBe('challenges');
    await expect(earn).toBeHidden();

    await page.getByTestId('wallet-pill-gumballs').getByRole('button').click();
    await page.getByTestId('earn-pass').click();
    await expect.poll(() => tab(page)).toBe('pass');

    await page.getByTestId('wallet-pill-gems').getByRole('button').click();
    const gems = page.getByTestId('wallet-gems');
    await expect(gems).toContainText('Coming soon');
    await expect(gems).toContainText('Secure checkout via Stripe');
    for (const b of await gems.locator('.tr-gem-pack').all()) await expect(b).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(gems).toBeHidden();
  });

  test('bell, friends, settings', async ({ page }) => {
    await page.getByTestId('btn-notifications').click();
    await expect.poll(() => overlay(page)).toBe('notifications');
    // A click outside an open drop-down only closes it (click-catcher), so close between checks.
    await page.evaluate(() => window.__tumble!.ui!.getState().setOverlay('none'));
    await page.getByTestId('btn-friends').click();
    await expect.poll(() => overlay(page)).toBe('friends');
    await page.evaluate(() => window.__tumble!.ui!.getState().setOverlay('none'));
    await page.getByTestId('btn-settings').click();
    await expect.poll(() => overlay(page)).toBe('settings');
    await page.evaluate(() => window.__tumble!.ui!.getState().setOverlay('none'));
  });

  test('Play tab: info cards go to their tabs, start cluster controls', async ({ page }) => {
    await page.getByTestId('season-card').click();
    await expect.poll(() => tab(page)).toBe('pass');
    await page.click('[data-tab="play"]');

    await page.getByTestId('challenges-card').click();
    await expect.poll(() => tab(page)).toBe('challenges');
    await page.click('[data-tab="play"]');

    await page.getByTestId('news-card').click();
    await expect.poll(() => tab(page)).toBe('news');
    await expect(page.getByTestId('news-reader')).toBeVisible();
    await page.getByTestId('news-back').click();
    await expect(page.getByTestId('news-reader')).toBeHidden();
    await page.click('[data-tab="play"]');

    await page.getByTestId('party-invite').first().click();
    await expect.poll(() => overlay(page)).toBe('friends');
    await page.evaluate(() => window.__tumble!.ui!.getState().setOverlay('none'));

    // Offline (api=0): Play Online shows the offline state; Vs Bots is the mode.
    await expect(page.getByTestId('mode-online')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('mode-offline')).toHaveAttribute('aria-checked', 'true');

    await page.getByTestId('mode-custom').click();
    await expect.poll(() => overlay(page)).toBe('privateShow');
    await expect(page.getByTestId('custom-offline')).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect.poll(() => overlay(page)).toBe('none');

    await page.getByTestId('join-code').click();
    await expect.poll(() => overlay(page)).toBe('joinCode');
    await page.keyboard.press('Escape');
    await expect.poll(() => overlay(page)).toBe('none');
    await page.waitForTimeout(1500);

    await page.getByTestId('play').click();
    await expect.poll(() => screen(page), { timeout: 30_000 }).not.toBe('menu');
  });

  test('Pass and Challenges controls', async ({ page }) => {
    await page.click('[data-tab="pass"]');
    await expect(page.getByTestId('pass-track')).toBeVisible();
    await expect(page.getByTestId('pass-preview')).toBeVisible();
    const claimAll = page.getByTestId('pass-claim-all');
    await expect(claimAll).toBeEnabled();
    await claimAll.click();
    await expect(claimAll).toBeDisabled();

    await page.click('[data-tab="challenges"]');
    const ready = page.locator('[data-state="ready"]').first();
    await expect(ready).toBeVisible();
    const id = await ready.getAttribute('data-testid');
    await ready.getByTestId('challenge-claim').click();
    await expect(page.getByTestId(id!)).toHaveAttribute('data-state', 'claimed');
  });

  test('Store try-on and Profile / Ranks', async ({ page }) => {
    await page.click('[data-tab="store"]');
    await page.locator('.tr-store .tr-item').first().click();
    await expect(page.getByTestId('trying-on')).toBeVisible();
    await page.click('[data-tab="profile"]');
    await expect(page.getByTestId('profile-card')).toBeVisible();
    await page.getByTestId('edit-banner').click();
    await expect.poll(() => tab(page)).toBe('locker');
    await page.click('[data-tab="leaderboards"]');
    await expect(page.getByTestId('rank-ladder')).toBeVisible();
    await page.getByTestId('lb-self').first().click();
    await expect(page.getByTestId('inspect-profile')).toBeVisible();
  });
});
