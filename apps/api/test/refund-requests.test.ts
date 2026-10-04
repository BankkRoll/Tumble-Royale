/**
 * Real-money refund requests end to end: a player asks for a Gem pack back,
 * staff approve (a Stripe refund through the real `StripePaymentProvider`
 * against a faked Stripe HTTP API) or deny it, and Stripe's signed webhooks
 * move the Gems and the request. Covers role checks, audit rows, provider
 * failures, webhook replays and out-of-order delivery, Gem debt and the
 * manual path when no Stripe key is configured.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuditLog, inventoryItems, purchases, refunds } from '../src/db/schema.ts';
import { verifyLedger } from '../src/economy/ledger.ts';
import { FakePaymentProvider, StripePaymentProvider } from '../src/economy/payments.ts';
import { REAL_MONEY_REFUND_WINDOW_DAYS } from '../src/economy/refunds.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi, type TestUser } from './helpers.ts';

const WEBHOOK_SECRET = 'whsec_test_refunds_0123456789';
const PACK = { id: 'gems.1100', gems: 1100, priceCents: 999 } as const;
const START = '2026-10-04T12:00:00.000Z';
const DAY = 86_400_000;

interface RefundCall {
  body: URLSearchParams;
  idempotencyKey: string | null;
}

const stripe = {
  sessionNo: 0,
  refundNo: 0,
  calls: [] as RefundCall[],
  /** Next refund call answers this error instead (then resets). */
  failNext: null as null | { status: number; message: string },
  /** Runs while Stripe is "processing" the refund call, before it answers. */
  during: null as null | (() => Promise<void>),
};

const fakeStripeApi = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/v1/checkout/sessions') && init?.method === 'POST') {
    const id = `cs_test_r${++stripe.sessionNo}`;
    return Response.json({ id, object: 'checkout.session', url: `https://checkout.stripe.test/${id}` });
  }
  if (url.endsWith('/v1/refunds') && init?.method === 'POST') {
    const headers = new Headers(init.headers);
    stripe.calls.push({
      body: new URLSearchParams(String(init.body)),
      idempotencyKey: headers.get('idempotency-key'),
    });
    if (stripe.failNext) {
      const f = stripe.failNext;
      stripe.failNext = null;
      return Response.json(
        { error: { type: 'invalid_request_error', message: f.message } },
        { status: f.status },
      );
    }
    const during = stripe.during;
    stripe.during = null;
    if (during) await during();
    return Response.json({ id: `re_test_${++stripe.refundNo}`, object: 'refund', status: 'pending' });
  }
  return Response.json({ error: { message: `not stubbed: ${url}` } }, { status: 500 });
}) as typeof fetch;

let api: TestApi;
beforeAll(async () => {
  const payments = new StripePaymentProvider('sk_test_fake', WEBHOOK_SECRET, {
    httpClient: Stripe.createFetchHttpClient(fakeStripeApi),
    maxNetworkRetries: 0,
  });
  api = await createTestApi(START, {}, { payments });
});
afterAll(async () => {
  await api.close();
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const asToken = (token: string) => (method: Method, url: string, body?: unknown) =>
  api.req(method, url, { token, ...(body !== undefined ? { body } : {}) });
const admin = asToken(ADMIN_TOKEN);

let ipNo = 0;
async function staff(role: 'admin' | 'moderator') {
  const u = await api.account();
  expect((await admin('PUT', `/internal/staff/${u.id}`, { role })).statusCode).toBe(200);
  const res = await api.req('POST', '/admin/session', {
    token: u.accessToken,
    ip: `10.201.${Math.floor(++ipNo / 250)}.${ipNo % 250}`,
  });
  expect(res.statusCode).toBe(201);
  return asToken(res.json().token as string);
}

function sign(payload: string, secret = WEBHOOK_SECRET): string {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}

function webhook(type: string, object: Record<string, unknown>, eventId: string, secret?: string) {
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    api_version: '2025-01-01',
    created: Math.floor(Date.now() / 1000),
    type,
    data: { object },
  });
  return api.app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload, secret) },
    payload,
  });
}

async function send(type: string, object: Record<string, unknown>, eventId = `evt_${randomUUID()}`) {
  const res = await webhook(type, object, eventId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { received: true; duplicate: boolean };
}

interface Pack {
  purchaseId: string;
  pi: string;
  charge: string;
}

async function paidPack(u: TestUser): Promise<Pack> {
  const res = await api.req('POST', '/gems/checkout', {
    token: u.accessToken,
    headers: { 'idempotency-key': `chk-${randomUUID()}` },
    body: { packId: PACK.id },
  });
  expect(res.statusCode, res.body).toBe(200);
  const purchaseId = res.json().purchaseId as string;
  const [row] = await api.ctx.db.select().from(purchases).where(eq(purchases.id, purchaseId));
  const tag = randomUUID().slice(0, 8);
  const pack = { purchaseId, pi: `pi_${tag}`, charge: `ch_${tag}` };
  await send('checkout.session.completed', {
    id: row!.providerRef,
    object: 'checkout.session',
    payment_status: 'paid',
    payment_intent: pack.pi,
    metadata: { purchaseId },
  });
  return pack;
}

const refunded = (p: Pack, amountRefunded: number, eventId?: string) =>
  send(
    'charge.refunded',
    {
      id: p.charge,
      object: 'charge',
      amount: PACK.priceCents,
      amount_refunded: amountRefunded,
      payment_intent: p.pi,
    },
    eventId,
  );

const requestRefund = (u: TestUser, p: Pack, reason?: string) =>
  api.req('POST', `/purchases/${p.purchaseId}/refund`, {
    token: u.accessToken,
    ...(reason !== undefined ? { body: { reason } } : {}),
  });

async function requested(u: TestUser, p: Pack): Promise<string> {
  const res = await requestRefund(u, p, 'Bought the wrong pack by accident');
  expect(res.statusCode, res.body).toBe(200);
  return res.json().refundId as string;
}

async function refundRow(id: string) {
  const [row] = await api.ctx.db.select().from(refunds).where(eq(refunds.id, id));
  return row!;
}

async function gems(u: TestUser): Promise<{ gems: number; gemDebt: number }> {
  const j = (await api.req('GET', '/wallet', { token: u.accessToken })).json();
  return { gems: j.wallet.gems, gemDebt: j.gemDebt };
}

const audit = (action: string, targetId: string) =>
  api.ctx.db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.action, action), eq(adminAuditLog.targetId, targetId)));

describe('requesting a Gem pack refund', () => {
  it('files a pending request once and needs a reason', async () => {
    const u = await api.account();
    const p = await paidPack(u);
    const missing = await requestRefund(u, p);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('reason_required');
    const first = await requestRefund(u, p, 'Bought the wrong pack');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      kind: 'real_money',
      status: 'pending',
      credit: { currency: 'usd', amount: PACK.priceCents },
      items: [],
      replayed: false,
    });
    const again = await requestRefund(u, p, 'Please');
    expect(again.json()).toMatchObject({ refundId: first.json().refundId, replayed: true });
    // Nothing moves until staff decide.
    expect(await gems(u)).toEqual({ gems: PACK.gems, gemDebt: 0 });
    const h = (await api.req('GET', '/purchases', { token: u.accessToken })).json();
    expect(h.purchases[0]).toMatchObject({
      kind: 'gem_pack',
      gems: PACK.gems,
      refund: { kind: 'real_money', status: 'pending' },
      eligibility: { eligible: false, reason: 'refund_already_requested' },
    });
  });

  it('closes requests after fourteen days and for reversed payments', async () => {
    const u = await api.account();
    const old = await paidPack(u);
    const disputed = await paidPack(u);
    await send('charge.dispute.created', {
      id: `dp_${disputed.charge}`,
      object: 'dispute',
      charge: disputed.charge,
      payment_intent: disputed.pi,
      status: 'needs_response',
    });
    expect((await requestRefund(u, disputed, 'Disputed already')).json().error).toBe(
      'refund_payment_reversed',
    );
    api.clock.advance(REAL_MONEY_REFUND_WINDOW_DAYS * DAY);
    try {
      const refreshed = await api.req('POST', '/auth/refresh', {
        body: { refreshToken: u.refreshToken },
        ip: '10.202.0.1',
      });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      const late = await requestRefund(
        { ...u, accessToken: refreshed.json().accessToken },
        old,
        'Changed my mind',
      );
      expect(late.statusCode).toBe(409);
      expect(late.json().error).toBe('refund_window_expired');
    } finally {
      api.clock.set(START);
    }
  });
});

describe('the refund queue', () => {
  it('keeps every refund route from players and approvals from moderators', async () => {
    const id = randomUUID();
    const routes: [Method, string, unknown?][] = [
      ['GET', '/internal/refunds'],
      ['GET', `/internal/refunds/${id}`],
      ['POST', `/internal/refunds/${id}/approve`, {}],
      ['POST', `/internal/refunds/${id}/deny`, { reason: 'nope nope' }],
    ];
    const player = await api.account();
    for (const [method, url, body] of routes) {
      for (const token of [undefined, player.accessToken]) {
        const res = await api.req(method, url, { ...(token ? { token } : {}), ...(body ? { body } : {}) });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    }
    const mod = await staff('moderator');
    const approve = await mod('POST', `/internal/refunds/${id}/approve`, {});
    expect(approve.statusCode).toBe(403);
    expect(approve.json().error).toBe('insufficient_role');
    expect((await mod('GET', '/internal/refunds')).statusCode).toBe(200);
    expect((await mod('POST', `/internal/refunds/${id}/deny`, { reason: 'nope nope' })).statusCode).toBe(404);
  });

  it('lists open requests oldest first with the player and shows one in detail', async () => {
    const mod = await staff('moderator');
    const u = await api.account();
    const p = await paidPack(u);
    const id = await requested(u, p);
    const list = (await mod('GET', `/internal/refunds?userId=${u.id}`)).json();
    expect(list.refunds).toEqual([
      expect.objectContaining({
        id,
        status: 'pending',
        kind: 'real_money',
        offerId: PACK.id,
        playerReason: 'Bought the wrong pack by accident',
        displayName: expect.any(String),
      }),
    ]);
    expect((await mod('GET', '/internal/refunds?status=bogus')).statusCode).toBe(400);
    const detail = (await mod('GET', `/internal/refunds/${id}`)).json();
    expect(detail).toMatchObject({
      refund: { id, status: 'pending' },
      purchase: { id: p.purchaseId, kind: 'gem_pack', paymentIntent: p.pi, price: PACK.priceCents },
      player: { id: u.id, gems: PACK.gems, gemDebt: 0, purchases: 1 },
      history: [expect.objectContaining({ id })],
      ledger: [expect.objectContaining({ reason: 'gem_pack', delta: PACK.gems, ref: p.purchaseId })],
      provider: 'stripe',
    });
  });

  it('approves through Stripe, then the webhook takes the Gems and closes the request', async () => {
    const boss = await staff('admin');
    const u = await api.account();
    const p = await paidPack(u);
    const id = await requested(u, p);
    const res = await boss('POST', `/internal/refunds/${id}/approve`, { note: 'Accidental purchase' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'stripe', refund: { status: 'processing', attempts: 1 } });
    const call = stripe.calls.at(-1)!;
    expect(call.body.get('payment_intent')).toBe(p.pi);
    expect(call.body.get('amount')).toBe(String(PACK.priceCents));
    expect(call.body.get('metadata[refundId]')).toBe(id);
    expect(call.idempotencyKey).toBe(`refund:${id}:1`);
    expect((await refundRow(id)).providerRefundId).toMatch(/^re_test_/);
    expect(await gems(u)).toEqual({ gems: PACK.gems, gemDebt: 0 });
    expect(await audit('refund.approve', id)).toEqual([
      expect.objectContaining({ reason: 'Accidental purchase', actorRole: 'admin' }),
    ]);

    const eventId = `evt_${randomUUID()}`;
    expect(await refunded(p, PACK.priceCents, eventId)).toEqual({ received: true, duplicate: false });
    expect(await refunded(p, PACK.priceCents, eventId)).toEqual({ received: true, duplicate: true });
    expect(await gems(u)).toEqual({ gems: 0, gemDebt: 0 });
    expect((await refundRow(id)).status).toBe('refunded');
    const again = await boss('POST', `/internal/refunds/${id}/approve`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('refund_already_decided');
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('survives the webhook landing before Stripe answers the refund call', async () => {
    const u = await api.account();
    const p = await paidPack(u);
    const id = await requested(u, p);
    stripe.during = async () => {
      await refunded(p, PACK.priceCents);
    };
    const res = await admin('POST', `/internal/refunds/${id}/approve`, {});
    expect(res.statusCode, res.body).toBe(200);
    const row = await refundRow(id);
    expect(row.status).toBe('refunded');
    expect(row.providerRefundId).toMatch(/^re_test_/);
    expect(await gems(u)).toEqual({ gems: 0, gemDebt: 0 });
  });

  it('marks a refused Stripe refund failed, audits it and allows a fresh retry', async () => {
    const boss = await staff('admin');
    const u = await api.account();
    const p = await paidPack(u);
    const id = await requested(u, p);
    stripe.failNext = { status: 400, message: 'Charge already refunded elsewhere' };
    const res = await boss('POST', `/internal/refunds/${id}/approve`, {});
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('payment_provider_error');
    const failed = await refundRow(id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed.lastError).toContain('Charge already refunded elsewhere');
    expect(await audit('refund.provider_failed', id)).toHaveLength(1);
    expect(await gems(u)).toEqual({ gems: PACK.gems, gemDebt: 0 });

    const retry = await boss('POST', `/internal/refunds/${id}/approve`, {});
    expect(retry.statusCode, retry.body).toBe(200);
    expect(stripe.calls.at(-1)!.idempotencyKey).toBe(`refund:${id}:2`);
    expect((await refundRow(id)).status).toBe('processing');
  });

  it('marks the request failed when Stripe later reports the refund failed, without re-crediting', async () => {
    const u = await api.account();
    const p = await paidPack(u);
    const id = await requested(u, p);
    expect((await admin('POST', `/internal/refunds/${id}/approve`, {})).statusCode).toBe(200);
    const providerRefundId = (await refundRow(id)).providerRefundId!;
    await refunded(p, PACK.priceCents);
    const failedEvent = `evt_${randomUUID()}`;
    const failure = {
      id: providerRefundId,
      object: 'refund',
      status: 'failed',
      failure_reason: 'expired_or_canceled_card',
      payment_intent: p.pi,
      metadata: { refundId: id },
    };
    expect(await send('refund.failed', failure, failedEvent)).toEqual({ received: true, duplicate: false });
    expect(await send('refund.failed', failure, failedEvent)).toEqual({ received: true, duplicate: true });
    const row = await refundRow(id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('expired_or_canceled_card');
    // Per the reversal policy the Gems stay reversed; support restores them by hand.
    expect(await gems(u)).toEqual({ gems: 0, gemDebt: 0 });
    // A stale charge.refunded delivered afterwards must not hide the failure.
    await refunded(p, PACK.priceCents);
    expect((await refundRow(id)).status).toBe('failed');
  });

  it('ignores refund failures with a bad signature or for refunds it does not know', async () => {
    const u = await api.account();
    const p = await paidPack(u);
    const id = await requested(u, p);
    expect((await admin('POST', `/internal/refunds/${id}/approve`, {})).statusCode).toBe(200);
    const object = { id: 're_unknown', object: 'refund', status: 'failed', metadata: { refundId: id } };
    const forged = await webhook('refund.failed', object, `evt_${randomUUID()}`, 'whsec_wrong');
    expect(forged.statusCode).toBe(400);
    expect((await refundRow(id)).status).toBe('processing');
    await send('refund.failed', { ...object, metadata: { refundId: 'not-a-uuid' } });
    await send('refund.updated', { ...object, status: 'succeeded' });
    expect((await refundRow(id)).status).toBe('processing');
  });

  it('turns a refund issued straight from the Stripe dashboard into a closed request', async () => {
    const u = await api.account();
    const full = await paidPack(u);
    const partial = await paidPack(u);
    const a = await requested(u, full);
    const b = await requested(u, partial);
    await refunded(full, PACK.priceCents);
    await refunded(partial, 500);
    expect((await refundRow(a)).status).toBe('refunded');
    expect((await refundRow(b)).status).toBe('partially_refunded');
    expect((await admin('POST', `/internal/refunds/${a}/deny`, { reason: 'too late' })).statusCode).toBe(409);
  });

  it('books spent Gems as debt and keeps cosmetics bought with them', async () => {
    const u = await api.account();
    const p = await paidPack(u);
    const hat = api.ctx.catalog.cosmetics.find((c) => c.source === 'store' && c.price?.currency === 'gems')!;
    const buy = await api.req('POST', '/purchase', {
      token: u.accessToken,
      headers: { 'idempotency-key': `buy-${randomUUID()}` },
      body: { offerId: hat.id },
    });
    expect(buy.statusCode, buy.body).toBe(200);
    const spent = PACK.gems - (await gems(u)).gems;
    const id = await requested(u, p);
    expect((await admin('POST', `/internal/refunds/${id}/approve`, {})).statusCode).toBe(200);
    await refunded(p, PACK.priceCents);
    expect(await gems(u)).toEqual({ gems: 0, gemDebt: spent });
    const owned = await api.ctx.db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.userId, u.id), eq(inventoryItems.cosmeticId, hat.id)));
    expect(owned).toHaveLength(1);
    expect((await verifyLedger(api.ctx.db, u.id)).ok).toBe(true);
  });

  it('lets a moderator deny with a reason the player sees, audited', async () => {
    const mod = await staff('moderator');
    const u = await api.account();
    const p = await paidPack(u);
    const id = await requested(u, p);
    expect((await mod('POST', `/internal/refunds/${id}/deny`, {})).statusCode).toBe(400);
    const res = await mod('POST', `/internal/refunds/${id}/deny`, { reason: 'Gems were already spent' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().refund).toMatchObject({ status: 'denied', decisionReason: 'Gems were already spent' });
    expect(await audit('refund.deny', id)).toEqual([
      expect.objectContaining({ actorRole: 'moderator', reason: 'Gems were already spent' }),
    ]);
    const h = (await api.req('GET', '/purchases', { token: u.accessToken })).json();
    expect(h.purchases[0]).toMatchObject({
      refund: { status: 'denied', decisionReason: 'Gems were already spent' },
      eligibility: { eligible: false, reason: 'refund_already_requested' },
    });
    expect((await mod('POST', `/internal/refunds/${id}/deny`, { reason: 'again again' })).statusCode).toBe(
      409,
    );
    expect((await requestRefund(u, p, 'Please reconsider')).json()).toMatchObject({ replayed: true });
  });

  it('refuses decisions on self-service refunds', async () => {
    const u = await api.guest();
    await api.grant(u.id, 'gumballs', 50_000);
    const item = api.ctx.catalog.cosmetics.find(
      (c) => c.source === 'store' && c.price?.currency === 'gumballs',
    )!;
    const buy = await api.req('POST', '/purchase', {
      token: u.accessToken,
      headers: { 'idempotency-key': `buy-${randomUUID()}` },
      body: { offerId: item.id },
    });
    const r = await api.req('POST', `/purchases/${buy.json().purchaseId}/refund`, { token: u.accessToken });
    const id = r.json().refundId as string;
    expect((await admin('POST', `/internal/refunds/${id}/approve`, {})).json().error).toBe(
      'refund_not_decidable',
    );
    const list = (await admin('GET', `/internal/refunds?status=all&kind=self_service&userId=${u.id}`)).json();
    expect(list.refunds).toEqual([expect.objectContaining({ id, status: 'completed' })]);
  });
});

describe('without a Stripe key', () => {
  let dev: TestApi;
  beforeAll(async () => {
    dev = await createTestApi(START, {}, { payments: new FakePaymentProvider() });
  });
  afterAll(async () => {
    await dev.close();
  });

  it('marks an approved request for manual processing', async () => {
    const u = await dev.account();
    const buy = await dev.req('POST', '/gems/checkout', {
      token: u.accessToken,
      headers: { 'idempotency-key': `chk-${randomUUID()}` },
      body: { packId: PACK.id },
    });
    expect(buy.json().status).toBe('completed');
    const r = await dev.req('POST', `/purchases/${buy.json().purchaseId}/refund`, {
      token: u.accessToken,
      body: { reason: 'Testing refunds' },
    });
    expect(r.statusCode, r.body).toBe(200);
    const id = r.json().refundId as string;
    const res = await dev.req('POST', `/internal/refunds/${id}/approve`, { token: ADMIN_TOKEN, body: {} });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'manual', refund: { status: 'manual', attempts: 0 } });
    const rows = await dev.ctx.db
      .select()
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.action, 'refund.approve'), eq(adminAuditLog.targetId, id)));
    expect(rows[0]!.details).toMatchObject({ mode: 'manual' });
    // Gems stay until money actually moves back.
    const wallet = (await dev.req('GET', '/wallet', { token: u.accessToken })).json();
    expect(wallet.wallet.gems).toBe(PACK.gems);
  });
});
