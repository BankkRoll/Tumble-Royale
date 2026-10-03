/**
 * Stripe checkout, refunds, disputes and Gem debt through the real webhook
 * route and the real `StripePaymentProvider` signature check. Only Stripe's
 * HTTP API (checkout session creation) is faked; webhook payloads are signed
 * here exactly as Stripe signs them.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purchases } from '../src/db/schema.ts';
import { applyLedger, verifyLedger } from '../src/economy/ledger.ts';
import { StripePaymentProvider } from '../src/economy/payments.ts';
import { reversalTarget } from '../src/economy/reversals.ts';
import { ADMIN_TOKEN, createTestApi, type TestApi, type TestUser } from './helpers.ts';

const WEBHOOK_SECRET = 'whsec_test_0123456789abcdef';
const PACK = { id: 'gems.1100', gems: 1100, priceCents: 999 } as const;

let sessionNo = 0;
const fakeStripeApi = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/v1/checkout/sessions') && init?.method === 'POST') {
    const id = `cs_test_${++sessionNo}`;
    return Response.json({ id, object: 'checkout.session', url: `https://checkout.stripe.test/${id}` });
  }
  return Response.json({ error: { message: `not stubbed: ${url}` } }, { status: 500 });
}) as typeof fetch;

let api: TestApi;
beforeAll(async () => {
  const payments = new StripePaymentProvider('sk_test_fake', WEBHOOK_SECRET, {
    httpClient: Stripe.createFetchHttpClient(fakeStripeApi),
    maxNetworkRetries: 0,
  });
  api = await createTestApi(undefined, {}, { payments });
});
afterAll(async () => {
  await api.close();
});

/** Builds a `Stripe-Signature` header the way Stripe does. */
function sign(payload: string, secret = WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

function webhook(type: string, object: Record<string, unknown>, eventId = `evt_${randomUUID()}`) {
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
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
    payload,
  });
}

async function send(type: string, object: Record<string, unknown>, eventId?: string) {
  const res = await webhook(type, object, eventId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { received: true; duplicate: boolean };
}

interface Checkout {
  purchaseId: string;
  session: string;
  pi: string;
  charge: string;
}

async function checkout(u: TestUser): Promise<Checkout> {
  const res = await api.req('POST', '/gems/checkout', {
    token: u.accessToken,
    headers: { 'idempotency-key': `chk-${randomUUID()}` },
    body: { packId: PACK.id },
  });
  expect(res.statusCode, res.body).toBe(200);
  const j = res.json();
  expect(j).toMatchObject({ status: 'pending', provider: 'stripe' });
  const [row] = await api.ctx.db.select().from(purchases).where(eq(purchases.id, j.purchaseId));
  const tag = randomUUID().slice(0, 8);
  return { purchaseId: j.purchaseId, session: row!.providerRef!, pi: `pi_${tag}`, charge: `ch_${tag}` };
}

const completed = (c: Checkout, eventId?: string) =>
  send(
    'checkout.session.completed',
    {
      id: c.session,
      object: 'checkout.session',
      payment_status: 'paid',
      payment_intent: c.pi,
      metadata: { purchaseId: c.purchaseId },
    },
    eventId,
  );

const refunded = (c: Checkout, amountRefunded: number, eventId?: string) =>
  send(
    'charge.refunded',
    {
      id: c.charge,
      object: 'charge',
      amount: PACK.priceCents,
      amount_refunded: amountRefunded,
      payment_intent: c.pi,
    },
    eventId,
  );

const dispute = (c: Checkout, type: 'created' | 'closed', status: string, eventId?: string) =>
  send(
    `charge.dispute.${type}`,
    { id: `dp_${c.charge}`, object: 'dispute', charge: c.charge, payment_intent: c.pi, status },
    eventId,
  );

async function wallet(u: TestUser): Promise<{ gems: number; gemDebt: number }> {
  const j = (await api.req('GET', '/wallet', { token: u.accessToken })).json();
  return { gems: j.wallet.gems, gemDebt: j.gemDebt };
}

async function purchaseStatus(c: Checkout): Promise<string> {
  const [row] = await api.ctx.db.select().from(purchases).where(eq(purchases.id, c.purchaseId));
  return row!.status;
}

async function spendGems(u: TestUser, amount: number) {
  await api.ctx.db.transaction((tx) =>
    applyLedger(tx, {
      userId: u.id,
      currency: 'gems',
      delta: -amount,
      reason: 'purchase',
      ref: randomUUID(),
    }),
  );
}

async function expectLedgerConsistent(u: TestUser) {
  expect(await verifyLedger(api.ctx.db, u.id)).toEqual({ ok: true, mismatches: [] });
}

async function paidPack(u: TestUser): Promise<Checkout> {
  const c = await checkout(u);
  await completed(c);
  return c;
}

describe('webhook signature', () => {
  it('rejects missing, forged and tampered signatures with 400', async () => {
    const payload = JSON.stringify({
      id: 'evt_x',
      object: 'event',
      type: 'charge.refunded',
      data: { object: {} },
    });
    const post = (headers: Record<string, string>, body = payload) =>
      api.app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'content-type': 'application/json', ...headers },
        payload: body,
      });
    expect((await post({})).statusCode).toBe(400);
    const forged = await post({ 'stripe-signature': sign(payload, 'whsec_wrong') });
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toMatchObject({ error: 'bad_signature' });
    const tampered = await post({ 'stripe-signature': sign(payload) }, payload.replace('evt_x', 'evt_y'));
    expect(tampered.statusCode).toBe(400);
    const stale = await post({ 'stripe-signature': sign(payload, WEBHOOK_SECRET, 1_000_000_000) });
    expect(stale.statusCode).toBe(400);
  });
});

describe('checkout', () => {
  it('requires a linked account: guests get 403 account_required and no purchase row', async () => {
    const g = await api.guest();
    const res = await api.req('POST', '/gems/checkout', {
      token: g.accessToken,
      headers: { 'idempotency-key': 'guest-checkout-1' },
      body: { packId: PACK.id },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'account_required' });
    expect(await api.ctx.db.select().from(purchases).where(eq(purchases.userId, g.id))).toHaveLength(0);
  });

  it('credits a completed checkout once, however often Stripe delivers it', async () => {
    const u = await api.account();
    const c = await checkout(u);
    expect(await wallet(u)).toEqual({ gems: 0, gemDebt: 0 });
    expect(await completed(c, 'evt_complete_once')).toEqual({ received: true, duplicate: false });
    expect(await completed(c, 'evt_complete_once')).toEqual({ received: true, duplicate: true });
    // A different event for the same session (e.g. async_payment_succeeded) must not double-credit.
    await completed(c);
    expect(await wallet(u)).toEqual({ gems: PACK.gems, gemDebt: 0 });
    expect(await purchaseStatus(c)).toBe('completed');
    await expectLedgerConsistent(u);
  });

  it('marks an expired session expired without Gems, and ignores expiry after completion', async () => {
    const u = await api.account();
    const c = await checkout(u);
    await send('checkout.session.expired', {
      id: c.session,
      object: 'checkout.session',
      payment_status: 'unpaid',
      metadata: { purchaseId: c.purchaseId },
    });
    expect(await purchaseStatus(c)).toBe('expired');
    expect((await wallet(u)).gems).toBe(0);

    const paid = await paidPack(u);
    await send('checkout.session.expired', {
      id: paid.session,
      object: 'checkout.session',
      metadata: { purchaseId: paid.purchaseId },
    });
    expect(await purchaseStatus(paid)).toBe('completed');
    expect((await wallet(u)).gems).toBe(PACK.gems);
  });

  it('acknowledges events for unknown sessions, charges and disputes without effects', async () => {
    const u = await api.account();
    const ghost: Checkout = {
      purchaseId: randomUUID(),
      session: 'cs_ghost',
      pi: 'pi_ghost',
      charge: 'ch_ghost',
    };
    await completed(ghost);
    await send('checkout.session.completed', {
      id: 'cs_ghost_2',
      object: 'checkout.session',
      payment_status: 'paid',
      payment_intent: 'pi_ghost_2',
      metadata: {},
    });
    await refunded(ghost, PACK.priceCents);
    await dispute(ghost, 'created', 'needs_response');
    await send('customer.created', { id: 'cus_1', object: 'customer' });
    await send('charge.refunded', { id: 'ch_no_pi', object: 'charge', amount: 100, amount_refunded: 100 });
    expect(await wallet(u)).toEqual({ gems: 0, gemDebt: 0 });
  });
});

describe('refunds', () => {
  it('takes the Gems back on a full refund, exactly once', async () => {
    const u = await api.account();
    const c = await paidPack(u);
    expect(await refunded(c, PACK.priceCents, 'evt_refund_once')).toMatchObject({ duplicate: false });
    expect(await refunded(c, PACK.priceCents, 'evt_refund_once')).toMatchObject({ duplicate: true });
    await refunded(c, PACK.priceCents);
    expect(await wallet(u)).toEqual({ gems: 0, gemDebt: 0 });
    expect(await purchaseStatus(c)).toBe('refunded');
    await expectLedgerConsistent(u);
  });

  it('reverses a partial refund proportionally (rounded against the player), then the rest', async () => {
    const u = await api.account();
    const c = await paidPack(u);
    await refunded(c, 500);
    const share = Math.ceil((PACK.gems * 500) / PACK.priceCents);
    expect(await wallet(u)).toEqual({ gems: PACK.gems - share, gemDebt: 0 });
    expect(await purchaseStatus(c)).toBe('partially_refunded');
    // A redelivered older event with a smaller cumulative amount changes nothing.
    await refunded(c, 200);
    expect((await wallet(u)).gems).toBe(PACK.gems - share);
    await refunded(c, PACK.priceCents);
    expect(await wallet(u)).toEqual({ gems: 0, gemDebt: 0 });
    await expectLedgerConsistent(u);
  });

  it('books spent Gems as debt, blocks checkout, and repays the debt from later credits', async () => {
    const u = await api.account();
    const c = await paidPack(u);
    await spendGems(u, 900);
    await refunded(c, PACK.priceCents);
    expect(await wallet(u)).toEqual({ gems: 0, gemDebt: 900 });
    await expectLedgerConsistent(u);

    const blocked = await api.req('POST', '/gems/checkout', {
      token: u.accessToken,
      headers: { 'idempotency-key': `chk-${randomUUID()}` },
      body: { packId: PACK.id },
    });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json()).toMatchObject({ error: 'payment_debt', details: { gemDebt: 900 } });

    await api.grant(u.id, 'gems', 500);
    expect(await wallet(u)).toEqual({ gems: 0, gemDebt: 400 });
    await api.grant(u.id, 'gems', 600);
    expect(await wallet(u)).toEqual({ gems: 200, gemDebt: 0 });
    await expectLedgerConsistent(u);
    await checkout(u);
  });

  it('applies a refund that arrives before the checkout completion', async () => {
    const u = await api.account();
    const c = await checkout(u);
    await refunded(c, PACK.priceCents);
    expect(await wallet(u)).toEqual({ gems: 0, gemDebt: 0 });
    await completed(c);
    expect(await wallet(u)).toEqual({ gems: 0, gemDebt: 0 });
    expect(await purchaseStatus(c)).toBe('refunded');
    await expectLedgerConsistent(u);
  });

  it('lets an admin write the debt off', async () => {
    const u = await api.account();
    const c = await paidPack(u);
    await spendGems(u, PACK.gems);
    await refunded(c, PACK.priceCents);
    expect((await wallet(u)).gemDebt).toBe(PACK.gems);
    const res = await api.req('POST', `/internal/payments/debt/${u.id}/forgive`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.json()).toEqual({ userId: u.id, forgiven: PACK.gems, gemDebt: 0 });
    expect(
      (await api.req('POST', `/internal/payments/debt/${u.id}/forgive`, { token: u.accessToken })).statusCode,
    ).toBe(401);
    await expectLedgerConsistent(u);
    await checkout(u);
  });
});

describe('disputes', () => {
  it('reverses on dispute creation and restores when the dispute is won', async () => {
    const u = await api.account();
    const c = await paidPack(u);
    await dispute(c, 'created', 'needs_response');
    expect(await wallet(u)).toEqual({ gems: 0, gemDebt: 0 });
    expect(await purchaseStatus(c)).toBe('disputed');
    await dispute(c, 'closed', 'won');
    expect(await wallet(u)).toEqual({ gems: PACK.gems, gemDebt: 0 });
    expect(await purchaseStatus(c)).toBe('completed');
    await expectLedgerConsistent(u);
  });

  it('keeps the Gems reversed when the dispute is lost', async () => {
    const u = await api.account();
    const c = await paidPack(u);
    await dispute(c, 'created', 'warning_needs_response');
    await dispute(c, 'closed', 'lost');
    expect(await wallet(u)).toEqual({ gems: 0, gemDebt: 0 });
    expect(await purchaseStatus(c)).toBe('charged_back');
  });

  it('settles debt first when a won dispute restores Gems that had been spent', async () => {
    const u = await api.account();
    const c = await paidPack(u);
    await spendGems(u, 1000);
    await dispute(c, 'created', 'needs_response');
    expect(await wallet(u)).toEqual({ gems: 0, gemDebt: 1000 });
    await dispute(c, 'closed', 'won');
    expect(await wallet(u)).toEqual({ gems: 100, gemDebt: 0 });
    await expectLedgerConsistent(u);
  });

  it('ignores a duplicate created event and a created event delivered after the close', async () => {
    const u = await api.account();
    const c = await paidPack(u);
    await dispute(c, 'closed', 'won', 'evt_dispute_closed_first');
    expect((await wallet(u)).gems).toBe(PACK.gems);
    await dispute(c, 'created', 'needs_response', 'evt_dispute_created_late');
    await dispute(c, 'created', 'needs_response', 'evt_dispute_created_late');
    expect(await wallet(u)).toEqual({ gems: PACK.gems, gemDebt: 0 });
    expect(await purchaseStatus(c)).toBe('completed');
  });

  it('keeps a partial refund reversed after a won dispute', async () => {
    const u = await api.account();
    const c = await paidPack(u);
    await refunded(c, 500);
    await dispute(c, 'created', 'needs_response');
    expect((await wallet(u)).gems).toBe(0);
    await dispute(c, 'closed', 'won');
    expect((await wallet(u)).gems).toBe(PACK.gems - Math.ceil((PACK.gems * 500) / PACK.priceCents));
    await expectLedgerConsistent(u);
  });
});

describe('reversalTarget', () => {
  it('rounds partial refunds up and never exceeds the pack', () => {
    expect(reversalTarget(1100, 999, { amountRefundedCents: 0, disputeStatus: null })).toBe(0);
    expect(reversalTarget(1100, 999, { amountRefundedCents: 1, disputeStatus: null })).toBe(2);
    expect(reversalTarget(1100, 999, { amountRefundedCents: 5000, disputeStatus: null })).toBe(1100);
    expect(reversalTarget(1100, 999, { amountRefundedCents: 0, disputeStatus: 'open' })).toBe(1100);
    expect(reversalTarget(1100, 999, { amountRefundedCents: 0, disputeStatus: 'won' })).toBe(0);
  });
});
