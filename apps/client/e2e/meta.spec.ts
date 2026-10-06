import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Phase 4 acceptance: create account → customize → queue with a friend in a
 * party → finish the show → XP & unlock persisted server-side.
 *
 * Boots the account API (in-memory PGlite), the matchmaker (short bot-fill
 * wait) and a game server (ticketed rooms, results posted to the API) on
 * private ports, then drives two browser contexts:
 *   A: guest sign-in, buys Gems (dev fake provider, `?debug=1`) and a store
 *      item, equips it, creates a party;
 *   B: opens A's `/join/<code>` invite link, signs in, joins, readies up;
 *   A queues → both get `match_found` → both play the show (autoplay pilot)
 *   → rewards come from the API → `/me`, `/inventory`, `/loadouts` and
 *   `/me/matches` prove it all persisted.
 *
 * Run against a private build so other agents' hot reloads can't interfere:
 *   GAME_URL=http://localhost:17173 npx playwright test e2e/meta.spec.ts
 * META_EXTERNAL=1 reuses already-running servers on the same ports.
 */
const GAME = process.env.GAME_URL ?? 'http://localhost:5173';
const BASE = Number(process.env.META_PORT_BASE ?? 17000);
const API = `http://127.0.0.1:${BASE + 360}`;
const MM = `http://127.0.0.1:${BASE + 370}`;
const GS_PORT = BASE + 350;
const SHOTS = process.env.META_SHOTS ?? 'test-results/meta';
const ROOT = resolve(import.meta.dirname, '../../..');
// Explicit secrets shared by the three services, so the run never depends on .env files.
const SECRETS = {
  JWT_SECRET: 'test-jwt-secret-0123456789-abcdefghijkl',
  INTERNAL_HMAC_SECRET: 'test-internal-hmac-secret-0123456789',
  GAME_TICKET_SECRET: 'test-game-ticket-secret-0123456789',
  GAME_SERVER_SECRET: 'test-game-server-secret-0123456789',
};

const procs: ChildProcess[] = [];
/** Sign-in link tokens the dev API's console mailer printed, oldest first. */
const magicTokens: string[] = [];
let dataDir = '';

function start(app: string, env: Record<string, string>): ChildProcess {
  // `node --import tsx` keeps the server in this one process, so killing it leaves no orphans.
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(ROOT, app),
    env: { ...process.env, LOG_LEVEL: 'warn', ...SECRETS, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = app.split('/').pop();
  p.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    for (const m of line.matchAll(/\/auth\/email\?token=([A-Za-z0-9_-]+)/g)) magicTokens.push(m[1]!);
    if (/results|match|error|ticket/i.test(line)) console.log(`[${tag}] ${line.slice(0, 300)}`);
  });
  p.stderr?.on('data', (d: Buffer) => console.log(`[${tag}!] ${d.toString().trim().slice(0, 300)}`));
  procs.push(p);
  return p;
}

async function healthy(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`${url} never became healthy`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  if (process.env.META_EXTERNAL !== '1') {
    dataDir = mkdtempSync(join(tmpdir(), 'tumble-meta-'));
    start('apps/api', {
      PORT: String(BASE + 360),
      PGLITE_DIR: join(dataDir, 'pglite'),
      PUBLIC_WEB_URL: GAME,
      RATE_LIMIT_MAX: '5000',
    });
    start('apps/matchmaker', {
      PORT: String(BASE + 370),
      MAX_WAIT_MS: '3000',
      HOT_MAX_WAIT_MS: '3000',
      DEFAULT_GAME_SERVER_URL: `ws://localhost:${GS_PORT}/ws`,
      API_URL: API,
    });
    start('apps/game-server', {
      PORT: String(GS_PORT),
      API_URL: API,
      // Empty wins over the root .env, keeping the matchmaker's default-server path.
      MATCHMAKER_URL: '',
      TICKET_FILL_WAIT_MS: '10000',
    });
  }
  await Promise.all([
    healthy(`${API}/health`, 120_000),
    healthy(`${MM}/health`, 60_000),
    healthy(`http://localhost:${GS_PORT}/health`, 120_000),
  ]);
});

test.afterAll(() => {
  for (const p of procs) p.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

type Account = { userId: string; name: string; partyCode: string | null; partySize: number; leader: boolean };

async function boot(browser: Browser, path: string, label: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${label} pageerror] ${e.message}`));
  const q = `autoplay=1&shows=0&fresh=1&tier=low&apiUrl=${encodeURIComponent(API)}&mmUrl=${encodeURIComponent(MM)}`;
  await page.goto(`${GAME}${path}?${q}`);
  await page.waitForFunction(() => window.__tumble?.screen?.() === 'menu', undefined, { timeout: 120_000 });
  await page.waitForFunction(() => window.__tumble?.account?.() != null, undefined, { timeout: 60_000 });
  return page;
}

const account = (page: Page): Promise<Account | null> => page.evaluate(() => window.__tumble!.account!());
const emit = (page: Page, name: string, payload?: unknown): Promise<void> =>
  page.evaluate(([n, p]) => window.__tumble!.emit!(n as never, p), [name, payload] as const);

/** Calls the API as the page's signed-in guest. */
async function apiAs<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(
    async ([api, p]) => {
      const auth = JSON.parse(localStorage.getItem('tumble.v1.auth') ?? '{}') as { refreshToken?: string };
      const r = await fetch(`${api}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken }),
      });
      const tokens = (await r.json()) as { accessToken: string; refreshToken: string };
      localStorage.setItem('tumble.v1.auth', JSON.stringify({ ...auth, ...tokens }));
      return (
        await fetch(`${api}${p}`, { headers: { authorization: `Bearer ${tokens.accessToken}` } })
      ).json();
    },
    [API, path] as const,
  ) as Promise<T>;
}

test('account → customize → party queue → show → XP & unlock persisted', async ({ browser }) => {
  test.setTimeout(25 * 60_000);

  // --- A: guest account, Gems (dev checkout), a store purchase, equip ----------
  const a = await boot(browser, '/', 'A');
  const accA = (await account(a)) as Account;
  console.log('[meta] A signed in as', accA.name);
  await a.waitForFunction(() => window.__tumble!.ui!.getState().wipe.phase === 'idle', undefined, {
    timeout: 15_000,
  });
  await a.waitForFunction(() => window.__tumble!.ui!.getState().onlineStatus.state === 'online', undefined, {
    timeout: 15_000,
  });
  await a.waitForTimeout(1500);
  await a.screenshot({ path: `${SHOTS}/01-menu-signed-in.png` });

  // Guests may not buy Gems, so A links an email first: the dev API's console
  // mailer prints the sign-in link, which the spec reads from its output.
  const mailed = magicTokens.length;
  await a.evaluate(async (api) => {
    const auth = JSON.parse(localStorage.getItem('tumble.v1.auth') ?? '{}') as { refreshToken?: string };
    const r = await fetch(`${api}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    });
    const tokens = (await r.json()) as { accessToken: string; refreshToken: string };
    localStorage.setItem('tumble.v1.auth', JSON.stringify({ ...auth, ...tokens }));
    const res = await fetch(`${api}/auth/email/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.accessToken}` },
      body: JSON.stringify({ email: `meta-a-${Date.now()}@example.test` }),
    });
    if (res.status !== 202) throw new Error(`email link ${res.status}`);
  }, API);
  await expect
    .poll(() => magicTokens.length, { message: 'the API never printed the sign-in link', timeout: 15_000 })
    .toBeGreaterThan(mailed);

  // The client only sells Gems through Stripe; the dev API's fake checkout grants them for the test.
  await a.evaluate(
    async ([api, magic]) => {
      const auth = JSON.parse(localStorage.getItem('tumble.v1.auth') ?? '{}') as Record<string, unknown>;
      const r = await fetch(`${api}/auth/email/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: magic }),
      });
      if (!r.ok) throw new Error(`email verify ${r.status}`);
      const tokens = (await r.json()) as { accessToken: string; refreshToken: string };
      localStorage.setItem('tumble.v1.auth', JSON.stringify({ ...auth, ...tokens }));
      const res = await fetch(`${api}/gems/checkout`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tokens.accessToken}`,
          'idempotency-key': `e2e-gems-${Date.now()}`,
        },
        body: JSON.stringify({ packId: 'gems.2800' }),
      });
      if (!res.ok) throw new Error(`gem checkout ${res.status}`);
    },
    [API, magicTokens.at(-1)!] as const,
  );
  await emit(a, 'buyGems', { packId: 'gems.2800' }); // UI path: must say "coming soon", not grant
  await a.waitForFunction(() => (window.__tumble!.ui!.getState().profile?.gems ?? 0) >= 2800, undefined, {
    timeout: 30_000,
  });
  const offer = await a.evaluate(() => {
    const s = window.__tumble!.ui!.getState().store!;
    // Today's picks may all be Gumball-priced; the weekly picks and the catalog also sell for Gems.
    const gems = [...s.featured, ...s.daily, ...(s.weekly ?? []), ...(s.catalog ?? [])]
      .filter((o) => o.currency === 'gems' && !o.item.owned && !o.id.startsWith('bundle:'))
      .sort((x, y) => x.price - y.price);
    const o = gems[0];
    return o ? { id: o.id, slot: o.item.slot, name: o.item.name } : null;
  });
  expect(offer, "a Gem-priced offer in today's store").toBeTruthy();
  await a.evaluate(() => window.__tumble!.ui!.getState().setMenuTab('store'));
  await emit(a, 'tryOn', { slot: offer!.slot, itemId: offer!.id });
  await emit(a, 'purchase', { offerId: offer!.id });
  await a.waitForFunction(
    (id) => window.__tumble!.ui!.getState().inventory?.items.some((i) => i.id === id && i.owned),
    offer!.id,
    { timeout: 20_000 },
  );
  await emit(a, 'equip', { slot: offer!.slot, itemId: offer!.id });
  await a.waitForTimeout(2500);
  await a.screenshot({ path: `${SHOTS}/02-store-purchase-equipped.png` });
  const inv = await apiAs<{ items: { id: string }[] }>(a, '/inventory');
  expect(inv.items.map((i) => i.id)).toContain(offer!.id);
  const lo = await apiAs<{ activeIndex: number; slots: ({ items: Record<string, unknown> } | null)[] }>(
    a,
    '/loadouts',
  );
  expect(JSON.stringify(lo.slots[lo.activeIndex]?.items)).toContain(offer!.id);
  console.log('[meta] bought + equipped', offer!.name);

  // --- Party: A creates, B joins with the invite link, readies up -------------
  await a.evaluate(() => window.__tumble!.ui!.getState().setMenuTab('play'));
  await a.evaluate(() => window.__tumble!.ui!.getState().setOverlay('friends'));
  await a.waitForFunction(() => !!window.__tumble!.account!()?.partyCode, undefined, { timeout: 20_000 });
  const code = (await account(a))!.partyCode!;
  console.log('[meta] party code', code);

  const b = await boot(browser, `/join/${code}`, 'B');
  await b.waitForFunction(() => window.__tumble!.account!()?.partySize === 2, undefined, { timeout: 30_000 });
  await a.waitForFunction(() => window.__tumble!.account!()?.partySize === 2, undefined, { timeout: 30_000 });
  await emit(b, 'ready', { ready: true });
  await a.waitForFunction(
    () => window.__tumble!.ui!.getState().party?.members.every((m) => m.ready) === true,
    undefined,
    { timeout: 20_000 },
  );
  await a.waitForTimeout(800);
  await a.screenshot({ path: `${SHOTS}/03-party.png` });
  await a.evaluate(() => window.__tumble!.ui!.getState().setOverlay('none'));

  // --- Queue → match_found on both → play the whole show ----------------------
  await emit(a, 'play', { playlistId: 'main-show' });
  for (const [p, l] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    // Two pages share one software renderer on CI, so the second can take minutes to get there.
    await p.waitForFunction(() => ['matchFound', 'preShow'].includes(window.__tumble!.screen!()), undefined, {
      timeout: 180_000,
    });
    console.log(`[meta] ${l} matched`);
  }
  await a.waitForFunction(() => window.__tumble!.screen!() === 'preShow', undefined, { timeout: 90_000 });
  await a.waitForTimeout(2000);
  await a.screenshot({ path: `${SHOTS}/04-preshow-party.png` });

  const finish = async (p: Page, l: string): Promise<void> => {
    // The show runs at real time on the server; a full 100-player show takes several minutes.
    await p.waitForFunction(() => window.__tumble!.screen!() === 'rewards', undefined, {
      timeout: 20 * 60_000,
      polling: 1000,
    });
    console.log(`[meta] ${l} reached rewards`);
  };
  await Promise.all([finish(a, 'A'), finish(b, 'B')]);
  await a.waitForTimeout(3500);
  await a.screenshot({ path: `${SHOTS}/05-rewards-from-api.png` });
  await b.screenshot({ path: `${SHOTS}/05b-rewards-friend.png` });

  // The server closes the room ~30 s after the show; that must not pop a connection error over rewards.
  await a.waitForTimeout(20_000);

  // --- Persisted -----------------------------------------------------------------
  for (const [p, l] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    expect(
      await p.evaluate(() => window.__tumble!.ui!.getState().dialog),
      `${l} no dialog over rewards`,
    ).toBeNull();
    const rewards = await p.evaluate(() => window.__tumble!.ui!.getState().rewards);
    expect(rewards?.xpLines.length, `${l} rewards lines`).toBeGreaterThan(0);
    const me = await apiAs<{
      xp: { total: number };
      stats: { showsPlayed: number };
      wallet: { gumballs: number };
    }>(p, '/me');
    const shown = rewards!.xpLines.reduce((n, x) => n + x.xp, 0);
    console.log(
      `[meta] ${l} /me xp ${me.xp.total}, shows ${me.stats.showsPlayed}, gumballs ${me.wallet.gumballs}; rewards screen xp ${shown}`,
    );
    expect(me.stats.showsPlayed).toBe(1);
    expect(me.xp.total).toBeGreaterThan(0);
    expect(shown).toBe(me.xp.total);
    const hist = await apiAs<{ matches: { id: string }[] }>(p, '/me/matches');
    expect(hist.matches).toHaveLength(1);
  }
  const invAfter = await apiAs<{ items: { id: string }[] }>(a, '/inventory');
  expect(invAfter.items.map((i) => i.id)).toContain(offer!.id);
});
