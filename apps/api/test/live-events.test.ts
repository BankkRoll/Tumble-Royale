/**
 * Limited-time events on the API: the public list, progress from verified
 * shows only (exact window boundaries, shows straddling the end, a game
 * server clock running ahead, duplicate and concurrent reports, custom
 * lobbies), tier and challenge claims (exactly once, also when concurrent),
 * settlement of ended events, the kill switch and per-event switch, operator
 * overrides, auth, input validation and rate limits. Runs on memory storage
 * and, in CI, on Redis + Postgres.
 */
import { eventShowPoints, type EventShowFacts } from '@tumble/content/progression';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogEvent } from '../src/catalog.ts';
import {
  currenciesLedger,
  eventMatchCredits,
  eventProgress,
  eventTierClaims,
  events as analyticsEvents,
} from '../src/db/schema.ts';
import { verifyLedger } from '../src/economy/ledger.ts';
import type { MatchResultInput } from '../src/matches/schema.ts';
import { ADMIN_TOKEN, buildShow, createTestApi, type TestApi, type TestUser } from './helpers.ts';
import { BACKENDS } from './infra.ts';

const START = '2026-10-02T12:00:00.000Z';
const MOON = 'moonlit-mischief';
const FROST = 'frostbite-frolic';
const iso = (ms: number) => new Date(ms).toISOString();
/** A window ending the day after START, so a test can jump past it within a refresh token's life. */
const SHORT = { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-03T00:00:00.000Z' };
const SHORT_END = Date.parse(SHORT.endsAt);

interface ProgressView {
  eventId: string;
  points: number;
  shows: number;
  tierReached: number;
  claimedTiers: number[];
  challenges: { id: string; progress: number; target: number; completed: boolean; claimed: boolean }[];
}

describe.each(BACKENDS)('live events ($name)', (backend) => {
  let api: TestApi;
  let moon: CatalogEvent;
  beforeAll(async () => {
    api = await createTestApi(START, backend.env);
    moon = api.ctx.catalog.events.find((e) => e.id === MOON)!;
  });
  afterAll(async () => {
    await api.close();
  });

  const admin = (method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    api.req(method, url, { token: ADMIN_TOKEN, ...(body !== undefined ? { body } : {}) });
  const flag = (key: string, enabled: boolean) => admin('PUT', `/internal/flags/${key}`, { enabled });
  const setWindow = async (id: string, body: { startsAt?: string; endsAt?: string; enabled?: boolean }) => {
    const res = await admin('PUT', `/internal/live-events/${id}`, body);
    expect(res.statusCode, res.body).toBe(200);
    await backend.settle();
  };

  beforeEach(async () => {
    api.clock.set(START);
    await admin('DELETE', `/internal/live-events/${MOON}`);
    await admin('DELETE', `/internal/live-events/${FROST}`);
    await flag('events.enabled', true);
    await backend.settle();
  });

  let ipNo = 0;
  /** Jumps the clock (past the 15-minute access token) and refreshes the player's session. */
  async function at(when: string, u: TestUser): Promise<void> {
    api.clock.set(when);
    ipNo++;
    const r = await api.req('POST', '/auth/refresh', {
      body: { refreshToken: u.refreshToken },
      ip: `10.66.${Math.floor(ipNo / 250)}.${ipNo % 250}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    u.accessToken = r.json().accessToken;
    u.refreshToken = r.json().refreshToken;
  }

  const show = (
    u: TestUser,
    opts: { placement?: number; playlistId?: string; startIso?: string; queue?: 'casual' | 'custom' } = {},
  ): MatchResultInput => {
    const m = buildShow({
      humans: [{ userId: u.id, placement: opts.placement ?? 1 }],
      ...(opts.queue ? { queue: opts.queue } : {}),
      startIso: opts.startIso ?? iso(api.clock.now().getTime() - 10 * 60_000),
    });
    if (opts.playlistId) m.playlistId = opts.playlistId;
    return m;
  };
  const crownFacts = (playlistId: string): EventShowFacts => ({
    playlistId,
    roundsQualified: 4,
    qualifiedByType: { race: 1, survival: 1, team: 1, final: 1 },
    reachedFinal: true,
    crowned: true,
    placement: 1,
  });
  const progress = async (u: TestUser, id = MOON): Promise<ProgressView> => {
    const res = await api.req('GET', '/live-events/progress', { token: u.accessToken });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().progress as ProgressView[]).find((p) => p.eventId === id)!;
  };
  const claimTier = (u: TestUser, tier: unknown, id = MOON) =>
    api.req('POST', `/live-events/${id}/claim`, { token: u.accessToken, body: { tier } });
  const claimChallenge = (u: TestUser, challengeId: string, id = MOON) =>
    api.req('POST', `/live-events/${id}/challenges/claim`, { token: u.accessToken, body: { challengeId } });
  const givePoints = async (u: TestUser, points: number, id = MOON) => {
    await api.ctx.db
      .insert(eventProgress)
      .values({ userId: u.id, eventId: id, points })
      .onConflictDoUpdate({ target: [eventProgress.userId, eventProgress.eventId], set: { points } });
  };
  const wallet = async (u: TestUser) =>
    (await api.req('GET', '/wallet', { token: u.accessToken })).json().wallet as {
      gumballs: number;
      gems: number;
      crownShards: number;
    };

  // ---------------------------------------------------------------------------
  // Public list
  // ---------------------------------------------------------------------------

  it('lists the live and the upcoming event publicly, with their tracks', async () => {
    const res = await api.req('GET', '/live-events');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.serverTime).toBe(Date.parse(START));
    expect(body.events.map((e: { id: string; phase: string }) => [e.id, e.phase])).toEqual([
      [MOON, 'live'],
      [FROST, 'upcoming'],
    ]);
    const m = body.events[0];
    expect(m).toMatchObject({
      name: moon.name,
      startsAt: moon.startsAt,
      endsAt: moon.endsAt,
      playlistIds: moon.playlistIds,
      icon: moon.icon,
    });
    expect(m.tiers).toHaveLength(moon.tiers.length);
    expect(m.challenges[0]).toMatchObject({ id: moon.challenges[0]!.id, title: moon.challenges[0]!.title });
    expect((await api.req('GET', '/live-events?all=1')).statusCode).toBe(400);
  });

  it('keeps an ended event listed for two weeks, then drops it', async () => {
    api.clock.set(iso(Date.parse(moon.endsAt) + 13 * 86_400_000));
    let ids = (await api.req('GET', '/live-events')).json().events.map((e: { id: string }) => e.id);
    expect(ids).toContain(MOON);
    api.clock.set(iso(Date.parse(moon.endsAt) + 15 * 86_400_000));
    ids = (await api.req('GET', '/live-events')).json().events.map((e: { id: string }) => e.id);
    expect(ids).not.toContain(MOON);
  });

  // ---------------------------------------------------------------------------
  // Auth and input
  // ---------------------------------------------------------------------------

  it('requires a signed-in player for progress and claims', async () => {
    expect((await api.req('GET', '/live-events/progress')).statusCode).toBe(401);
    expect((await api.req('POST', `/live-events/${MOON}/claim`, { body: { tier: 1 } })).statusCode).toBe(401);
    expect(
      (await api.req('POST', `/live-events/${MOON}/challenges/claim`, { body: { challengeId: 'x' } }))
        .statusCode,
    ).toBe(401);
    expect((await api.req('GET', '/live-events/progress', { token: 'nope' })).statusCode).toBe(401);
  });

  it('validates claims', async () => {
    const u = await api.guest();
    for (const tier of [0, -1, 1.5, 'one', null, 1000])
      expect((await claimTier(u, tier)).statusCode).toBe(400);
    const extra = await api.req('POST', `/live-events/${MOON}/claim`, {
      token: u.accessToken,
      body: { tier: 1, track: 'premium' },
    });
    expect(extra.statusCode).toBe(400);
    expect(
      (await api.req('POST', '/live-events/BAD ID/claim', { token: u.accessToken, body: { tier: 1 } }))
        .statusCode,
    ).toBe(400);
    expect((await claimTier(u, 1, 'no-such-event')).statusCode).toBe(404);
    expect((await claimTier(u, moon.tiers.length + 1)).statusCode).toBe(404);
    expect((await claimChallenge(u, 'Not An Id!')).statusCode).toBe(400);
    expect((await claimChallenge(u, 'no-such-challenge')).statusCode).toBe(404);
    expect((await api.req('GET', '/live-events/progress?x=1', { token: u.accessToken })).statusCode).toBe(
      400,
    );
  });

  // ---------------------------------------------------------------------------
  // Progress from shows
  // ---------------------------------------------------------------------------

  it('credits a show from the server result, multiplied in the featured playlist', async () => {
    const u = await api.guest();
    const res = await api.postMatch(show(u));
    expect(res.statusCode).toBe(200);
    const plain = eventShowPoints(moon, crownFacts('main-show'));
    const update = res.json().rewards[0].events[0];
    expect(update).toMatchObject({
      eventId: MOON,
      name: moon.name,
      gained: plain,
      pointsBefore: 0,
      pointsAfter: plain,
      tierBefore: 0,
      tiers: moon.tiers.length,
    });
    expect(update.tierAfter).toBe(moon.tiers.filter((t) => t.points <= plain).length);
    const p = await progress(u);
    expect(p).toMatchObject({ points: plain, shows: 1 });
    const byId = new Map(p.challenges.map((c) => [c.id, c]));
    expect(byId.get('mm-play-25')!.progress).toBe(1);
    expect(byId.get('mm-race-20')!.progress).toBe(1);
    expect(byId.get('mm-survive-15')!.progress).toBe(1);
    // Scoped to Chaos Mode: a Main Show crown does not count.
    expect(byId.get('mm-crown-event-1')!.progress).toBe(0);

    const res2 = await api.postMatch(show(u, { playlistId: 'chaos-mode' }));
    const doubled = eventShowPoints(moon, crownFacts('chaos-mode'));
    expect(doubled).toBe(Math.round(plain * moon.points.eventPlaylistMultiplier));
    expect(res2.json().rewards[0].events[0]).toMatchObject({ gained: doubled, pointsBefore: plain });
    const p2 = await progress(u);
    expect(p2.points).toBe(plain + doubled);
    const crown = p2.challenges.find((c) => c.id === 'mm-crown-event-1')!;
    expect(crown).toMatchObject({ progress: 1, completed: true, claimed: false });
    // The upcoming event got nothing.
    expect(await progress(u, FROST)).toMatchObject({ points: 0, shows: 0 });
  });

  it('never counts a replayed or concurrently duplicated report twice', async () => {
    const u = await api.guest();
    const m = show(u);
    const [a, b] = await Promise.all([api.postMatch(m), api.postMatch(m)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const replay = await api.postMatch(m);
    expect(replay.json().alreadyProcessed).toBe(true);
    expect(replay.json().rewards[0].events).toEqual(a.json().rewards[0].events);
    const p = await progress(u);
    expect(p).toMatchObject({ points: eventShowPoints(moon, crownFacts('main-show')), shows: 1 });
    const credits = await api.ctx.db
      .select()
      .from(eventMatchCredits)
      .where(eq(eventMatchCredits.userId, u.id));
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ eventId: MOON, matchId: m.matchId });
  });

  it('grants nothing for custom lobbies', async () => {
    const u = await api.guest();
    const res = await api.postMatch(show(u, { queue: 'custom' }));
    expect(res.json().rewards[0].events).toEqual([]);
    expect(await progress(u)).toMatchObject({ points: 0, shows: 0 });
  });

  it('counts shows by their start, exactly on the window boundaries', async () => {
    const open = Date.parse('2026-10-03T00:00:00.000Z');
    const close = open + 3_600_000;
    await setWindow(MOON, { startsAt: iso(open), endsAt: iso(close) });
    const u = await api.guest();
    // Results arrive well after the window closed; only the start matters.
    await at(iso(close + 30 * 60_000), u);
    const counted = async (startMs: number) =>
      (await api.postMatch(show(u, { startIso: iso(startMs) }))).json().rewards[0].events.length;
    expect(await counted(open - 1)).toBe(0);
    expect(await counted(open)).toBe(1);
    expect(await counted(close - 1)).toBe(1);
    expect(await counted(close)).toBe(0);
    expect((await progress(u)).shows).toBe(2);
  });

  it('counts a show that straddles the end and settles it after the event', async () => {
    const end = Date.parse('2026-10-03T00:00:00.000Z');
    await setWindow(MOON, { startsAt: '2026-10-01T00:00:00.000Z', endsAt: iso(end) });
    const u = await api.guest();
    await at(iso(end + 60 * 60_000), u);
    // Started five minutes before the end, finished after it, reported an hour later.
    const m = show(u, { startIso: iso(end - 5 * 60_000), playlistId: 'chaos-mode' });
    const res = await api.postMatch(m);
    expect(res.json().rewards[0].events).toHaveLength(1);
    const gained = eventShowPoints(moon, crownFacts('chaos-mode'));
    const read = (await api.req('GET', '/live-events/progress', { token: u.accessToken })).json();
    const reached = moon.tiers.filter((t) => t.points <= gained + 300).map((t) => t.tier);
    expect(read.settled).toEqual([
      expect.objectContaining({ eventId: MOON, challenges: ['mm-crown-event-1'], tiers: reached }),
    ]);
  });

  it('caps a start reported in the future at the API clock', async () => {
    // A game server whose clock runs ahead reports a start after the event's end
    // while the API, which keeps the reference clock, is still inside the window.
    const end = Date.parse('2026-10-02T12:30:00.000Z');
    await setWindow(MOON, { startsAt: '2026-10-01T00:00:00.000Z', endsAt: iso(end) });
    const u = await api.guest();
    const ahead = await api.postMatch(show(u, { startIso: iso(end + 10 * 60_000) }));
    expect(ahead.json().rewards[0].events).toHaveLength(1);
    // A clock running behind can only make a show look earlier, never later than the API's now.
    const before = await api.postMatch(show(u, { startIso: '2026-09-30T23:59:00.000Z' }));
    expect(before.json().rewards[0].events).toEqual([]);
  });

  it('records nothing and refuses claims while events.enabled is off', async () => {
    const u = await api.guest();
    await givePoints(u, 1000);
    await flag('events.enabled', false);
    await backend.settle();
    expect((await api.req('GET', '/live-events')).json().enabled).toBe(false);
    const res = await api.postMatch(show(u));
    expect(res.json().rewards[0].events).toEqual([]);
    const claim = await claimTier(u, 1);
    expect(claim.statusCode).toBe(503);
    expect(claim.json()).toMatchObject({ error: 'feature_disabled', details: { flag: 'events.enabled' } });
    expect((await claimChallenge(u, 'mm-play-25')).statusCode).toBe(503);
    const read = (await api.req('GET', '/live-events/progress', { token: u.accessToken })).json();
    expect(read.enabled).toBe(false);
    expect(read.progress.find((p: ProgressView) => p.eventId === MOON).points).toBe(1000);

    await flag('events.enabled', true);
    await backend.settle();
    expect((await claimTier(u, 1)).statusCode).toBe(200);
  });

  it('withdraws a disabled event: hidden, not counted, not claimable, never settled', async () => {
    const u = await api.guest();
    await givePoints(u, 1000);
    await setWindow(MOON, { ...SHORT, enabled: false });
    expect((await api.req('GET', '/live-events')).json().events.map((e: { id: string }) => e.id)).toEqual([
      FROST,
    ]);
    expect((await api.postMatch(show(u))).json().rewards[0].events).toEqual([]);
    const claim = await claimTier(u, 1);
    expect(claim.statusCode).toBe(409);
    expect(claim.json().error).toBe('event_disabled');
    await at(iso(SHORT_END + 60_000), u);
    expect((await api.req('GET', '/live-events/progress', { token: u.accessToken })).json().settled).toEqual(
      [],
    );
    expect(await api.ctx.db.select().from(eventTierClaims).where(eq(eventTierClaims.userId, u.id))).toEqual(
      [],
    );
  });

  it('awards nothing for shows that start after the event ended', async () => {
    await setWindow(MOON, SHORT);
    const u = await api.guest();
    await at(iso(SHORT_END + 60 * 60_000), u);
    const res = await api.postMatch(show(u));
    expect(res.json().rewards[0].events).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Claims
  // ---------------------------------------------------------------------------

  it('refuses claims on an upcoming event', async () => {
    const u = await api.guest();
    const res = await claimTier(u, 1, FROST);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('event_not_started');
  });

  it('pays a reached tier once, on the ledger under event:<id>:<tier>', async () => {
    const u = await api.guest();
    const locked = await claimTier(u, 1);
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toMatchObject({
      error: 'tier_locked',
      details: { points: 0, needed: moon.tiers[0]!.points },
    });

    await givePoints(u, moon.tiers[0]!.points);
    const before = await wallet(u);
    const res = await claimTier(u, 1);
    expect(res.statusCode, res.body).toBe(200);
    const gumballs = moon.tiers[0]!.rewards.find((r) => r.type === 'gumballs') as { amount: number };
    expect(res.json()).toMatchObject({
      eventId: MOON,
      tier: 1,
      rewards: [{ type: 'gumballs', granted: true }],
    });
    expect(res.json().wallet.gumballs).toBe(before.gumballs + gumballs.amount);
    expect(res.json().progress.claimedTiers).toEqual([1]);
    expect((await claimTier(u, 1)).json().error).toBe('already_claimed');
    expect((await claimTier(u, 2)).json().error).toBe('tier_locked');
    const ledger = await api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(and(eq(currenciesLedger.userId, u.id), eq(currenciesLedger.reason, 'event_reward')));
    expect(ledger.map((l) => l.ref)).toEqual([`event:${MOON}:1`]);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('grants event cosmetics and XP tiers', async () => {
    const u = await api.guest();
    const cosmeticTier = moon.tiers.find((t) => t.rewards.some((r) => r.type === 'cosmetic'))!;
    const xpTier = moon.tiers.find((t) => t.rewards.some((r) => r.type === 'xp'))!;
    await givePoints(u, Math.max(cosmeticTier.points, xpTier.points));
    const itemId = (cosmeticTier.rewards.find((r) => r.type === 'cosmetic') as { id: string }).id;
    const xpBefore = (await api.req('GET', '/me', { token: u.accessToken })).json().xp.total as number;
    expect((await claimTier(u, cosmeticTier.tier)).statusCode).toBe(200);
    expect((await claimTier(u, xpTier.tier)).statusCode).toBe(200);
    const items = (await api.req('GET', '/inventory', { token: u.accessToken })).json().items as {
      id: string;
    }[];
    expect(items.map((i) => i.id)).toContain(itemId);
    const xpAmount = (xpTier.rewards.find((r) => r.type === 'xp') as { amount: number }).amount;
    const xpAfter = (await api.req('GET', '/me', { token: u.accessToken })).json().xp.total as number;
    expect(xpAfter - xpBefore).toBe(xpAmount);
    const log = (await api.req('GET', '/collection?owned=true', { token: u.accessToken })).json();
    const entry = log.entries.find((e: { id: string }) => e.id === itemId);
    expect(entry.sources).toEqual([{ kind: 'event', label: `${moon.name} event tier ${cosmeticTier.tier}` }]);
  });

  it('pays one reward when the same tier is claimed concurrently', async () => {
    const u = await api.guest();
    await givePoints(u, moon.tiers[0]!.points);
    const codes = (await Promise.all([claimTier(u, 1), claimTier(u, 1), claimTier(u, 1)])).map(
      (r) => r.statusCode,
    );
    expect(codes.sort()).toEqual([200, 409, 409]);
    const ledger = await api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(and(eq(currenciesLedger.userId, u.id), eq(currenciesLedger.reason, 'event_reward')));
    expect(ledger).toHaveLength(1);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('pays a completed challenge once: points to the track, XP to the account', async () => {
    const u = await api.guest();
    const notYet = await claimChallenge(u, 'mm-crown-event-1');
    expect(notYet.statusCode).toBe(409);
    expect(notYet.json().error).toBe('not_completed');
    await api.postMatch(show(u, { playlistId: 'chaos-mode' }));
    const before = (await progress(u)).points;
    const def = moon.challenges.find((c) => c.id === 'mm-crown-event-1')!;
    const results = await Promise.all([claimChallenge(u, def.id), claimChallenge(u, def.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const ok = results.find((r) => r.statusCode === 200)!.json();
    expect(ok).toMatchObject({ eventId: MOON, challengeId: def.id, points: def.points, xp: def.rewardXp });
    expect(ok.progress.points).toBe(before + def.points);
    const after = await progress(u);
    expect(after.points).toBe(before + def.points);
    expect(after.challenges.find((c) => c.id === def.id)).toMatchObject({ completed: true, claimed: true });
  });

  it('rate limits claims per player', async () => {
    const u = await api.guest();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await claimTier(u, 1)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 409)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
  });

  // ---------------------------------------------------------------------------
  // Settlement
  // ---------------------------------------------------------------------------

  it('pays every earned but unclaimed reward once the event has ended', async () => {
    const u = await api.guest();
    await api.postMatch(show(u, { playlistId: 'chaos-mode' }));
    await givePoints(u, moon.tiers[2]!.points);
    expect((await claimTier(u, 1)).statusCode).toBe(200);
    const live = (await api.req('GET', '/live-events/progress', { token: u.accessToken })).json();
    expect(live.settled).toEqual([]);

    await setWindow(MOON, SHORT);
    await at(SHORT.endsAt, u);
    const before = await wallet(u);
    const res = (await api.req('GET', '/live-events/progress', { token: u.accessToken })).json();
    const crown = moon.challenges.find((c) => c.id === 'mm-crown-event-1')!;
    const reached = moon.tiers
      .filter((t) => t.points <= moon.tiers[2]!.points + crown.points)
      .map((t) => t.tier);
    expect(res.settled).toHaveLength(1);
    expect(res.settled[0]).toMatchObject({
      eventId: MOON,
      challenges: ['mm-crown-event-1'],
      points: crown.points,
      tiers: reached.filter((t) => t !== 1),
    });
    const p = res.progress.find((x: ProgressView) => x.eventId === MOON) as ProgressView;
    expect(p.claimedTiers).toEqual(reached);
    const after = await wallet(u);
    const paidGumballs = moon.tiers
      .filter((t) => reached.includes(t.tier) && t.tier !== 1)
      .flatMap((t) => t.rewards)
      .reduce((s, r) => s + (r.type === 'gumballs' ? r.amount : 0), 0);
    // XP rewards can level the player up, which pays Gumballs of its own.
    expect(after.gumballs - before.gumballs).toBeGreaterThanOrEqual(paidGumballs);
    const eventGumballs = await api.ctx.db
      .select()
      .from(currenciesLedger)
      .where(
        and(
          eq(currenciesLedger.userId, u.id),
          eq(currenciesLedger.reason, 'event_reward'),
          eq(currenciesLedger.currency, 'gumballs'),
        ),
      );
    const tier1 = moon.tiers[0]!.rewards.find((r) => r.type === 'gumballs') as { amount: number };
    expect(eventGumballs.reduce((s, l) => s + l.delta, 0)).toBe(paidGumballs + tier1.amount);
    const rows = await api.ctx.db
      .select()
      .from(eventTierClaims)
      .where(and(eq(eventTierClaims.userId, u.id), eq(eventTierClaims.auto, true)));
    expect(rows.map((r) => r.tier).sort((a, b) => a - b)).toEqual(reached.filter((t) => t !== 1));

    const again = (await api.req('GET', '/live-events/progress', { token: u.accessToken })).json();
    expect(again.settled).toEqual([]);
    expect(await wallet(u)).toEqual(after);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('still lets a player claim between the end and their next read', async () => {
    const u = await api.guest();
    await givePoints(u, moon.tiers[0]!.points);
    await setWindow(MOON, SHORT);
    await at(iso(SHORT_END + 1000), u);
    expect((await claimTier(u, 1)).statusCode).toBe(200);
    expect((await api.req('GET', '/live-events/progress', { token: u.accessToken })).json().settled).toEqual(
      [],
    );
  });

  // ---------------------------------------------------------------------------
  // Operators
  // ---------------------------------------------------------------------------

  it('only lets the admin read and change event windows', async () => {
    const u = await api.guest();
    expect((await api.req('GET', '/internal/live-events')).statusCode).toBe(401);
    expect((await api.req('GET', '/internal/live-events', { token: u.accessToken })).statusCode).toBe(401);
    expect(
      (
        await api.req('PUT', `/internal/live-events/${MOON}`, {
          token: u.accessToken,
          body: { enabled: false },
        })
      ).statusCode,
    ).toBe(401);
    const list = (await admin('GET', '/internal/live-events')).json();
    expect(list.enabled).toBe(true);
    expect(list.events.find((e: { id: string }) => e.id === MOON)).toMatchObject({
      phase: 'live',
      enabled: true,
      overridden: false,
      bundled: { startsAt: moon.startsAt, endsAt: moon.endsAt },
    });
  });

  it('validates overrides', async () => {
    const put = (body: unknown, id = MOON) => admin('PUT', `/internal/live-events/${id}`, body);
    expect(
      (await put({ startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-05T00:00:00Z' })).json().error,
    ).toBe('invalid_window');
    expect((await put({ endsAt: '2026-09-01T00:00:00Z' })).json().error).toBe('invalid_window');
    expect(
      (await put({ startsAt: '2026-10-01T00:00:00Z', endsAt: '2027-03-01T00:00:00Z' })).json().error,
    ).toBe('invalid_window');
    expect((await put({})).json().error).toBe('empty_patch');
    expect((await put({ enabled: 'yes' })).statusCode).toBe(400);
    expect((await put({ startsAt: 'tomorrow' })).statusCode).toBe(400);
    expect((await put({ featured: true })).statusCode).toBe(400);
    expect((await put({ enabled: false }, 'no-such-event')).statusCode).toBe(404);
    expect((await admin('DELETE', '/internal/live-events/no-such-event')).statusCode).toBe(404);
  });

  it('reschedules, audits and resets an event', async () => {
    // Bring the winter event forward so it is live now.
    await setWindow(FROST, { startsAt: '2026-10-02T00:00:00.000Z', endsAt: '2026-10-09T00:00:00.000Z' });
    const pub = (await api.req('GET', '/live-events')).json();
    expect(pub.events.find((e: { id: string }) => e.id === FROST)).toMatchObject({
      phase: 'live',
      startsAt: '2026-10-02T00:00:00.000Z',
    });
    const u = await api.guest();
    const res = await api.postMatch(show(u, { playlistId: 'squads' }));
    expect(
      res
        .json()
        .rewards[0].events.map((e: { eventId: string }) => e.eventId)
        .sort(),
    ).toEqual([FROST, MOON]);
    const audit = await api.ctx.db
      .select()
      .from(analyticsEvents)
      .where(eq(analyticsEvents.name, 'audit.admin.event_override'));
    expect(audit.at(-1)!.props).toMatchObject({ eventId: FROST, enabled: true });

    const reset = await admin('DELETE', `/internal/live-events/${FROST}`);
    expect(reset.json().event).toMatchObject({ phase: 'upcoming', overridden: false });
    expect(
      (
        await api.ctx.db
          .select()
          .from(analyticsEvents)
          .where(eq(analyticsEvents.name, 'audit.admin.event_reset'))
      ).length,
    ).toBeGreaterThan(0);
  });

  it('goes away with the account', async () => {
    const u = await api.guest();
    await api.postMatch(show(u));
    const del = await api.req('DELETE', '/me', { token: u.accessToken, body: { confirm: 'DELETE' } });
    expect([200, 204]).toContain(del.statusCode);
    expect(await api.ctx.db.select().from(eventProgress).where(eq(eventProgress.userId, u.id))).toEqual([]);
    expect(
      await api.ctx.db.select().from(eventMatchCredits).where(eq(eventMatchCredits.userId, u.id)),
    ).toEqual([]);
  });
});
