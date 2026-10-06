/**
 * A Stripe double for payment tests: the real `StripePaymentProvider` (with
 * its signature check) talking to a fake Stripe HTTP API, plus helpers that
 * sign webhook deliveries exactly as Stripe does.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { expect } from 'vitest';
import { purchases } from '../src/db/schema.ts';
import { StripePaymentProvider } from '../src/economy/payments.ts';
import type { TestApi, TestUser } from './helpers.ts';

/** Signing secret the fake provider is configured with. */
export const WEBHOOK_SECRET = 'whsec_test_0123456789abcdef';
/** The Gem pack the payment tests buy. */
export const PACK = { id: 'gems.1100', gems: 1100, priceCents: 999 } as const;

/** A paid Gem pack checkout and the Stripe ids its webhooks name. */
export interface PaidPack {
  purchaseId: string;
  session: string;
  pi: string;
  charge: string;
}

/**
 * A provider whose checkout sessions and refunds succeed against a fake API.
 *
 * @returns Build options for `createTestApi`.
 */
export function fakeStripe(): { payments: StripePaymentProvider } {
  let n = 0;
  const api = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/v1/checkout/sessions') && init?.method === 'POST') {
      const id = `cs_test_${randomUUID().slice(0, 8)}_${++n}`;
      return Response.json({ id, object: 'checkout.session', url: `https://checkout.stripe.test/${id}` });
    }
    if (url.endsWith('/v1/refunds') && init?.method === 'POST')
      return Response.json({ id: `re_test_${++n}`, object: 'refund', status: 'pending' });
    return Response.json({ error: { message: `not stubbed: ${url}` } }, { status: 500 });
  }) as typeof fetch;
  return {
    payments: new StripePaymentProvider('sk_test_fake', WEBHOOK_SECRET, {
      httpClient: Stripe.createFetchHttpClient(api),
      maxNetworkRetries: 0,
    }),
  };
}

function sign(payload: string): string {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex')}`;
}

/**
 * Delivers a signed webhook event.
 *
 * @returns The raw response (not asserted, so races can inspect failures).
 */
export function webhook(
  api: TestApi,
  type: string,
  object: Record<string, unknown>,
  eventId = `evt_${randomUUID()}`,
) {
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

/** Starts a Gem pack checkout and returns the ids its webhooks will carry. */
export async function startCheckout(api: TestApi, u: TestUser): Promise<PaidPack> {
  const res = await api.req('POST', '/gems/checkout', {
    token: u.accessToken,
    headers: { 'idempotency-key': `chk-${randomUUID()}` },
    body: { packId: PACK.id },
  });
  expect(res.statusCode, res.body).toBe(200);
  const purchaseId = res.json().purchaseId as string;
  const [row] = await api.ctx.db.select().from(purchases).where(eq(purchases.id, purchaseId));
  const tag = randomUUID().slice(0, 8);
  return { purchaseId, session: row!.providerRef!, pi: `pi_${tag}`, charge: `ch_${tag}` };
}

/** The `checkout.session.completed` object for a checkout. */
export const completedSession = (p: PaidPack, over: Record<string, unknown> = {}) => ({
  id: p.session,
  object: 'checkout.session',
  payment_status: 'paid',
  payment_intent: p.pi,
  metadata: { purchaseId: p.purchaseId },
  ...over,
});

/** The `charge.refunded` object for a checkout. */
export const refundedCharge = (p: PaidPack, amountRefunded: number) => ({
  id: p.charge,
  object: 'charge',
  amount: PACK.priceCents,
  amount_refunded: amountRefunded,
  payment_intent: p.pi,
});

/** A checkout that Stripe reported paid. */
export async function paidPack(api: TestApi, u: TestUser): Promise<PaidPack> {
  const p = await startCheckout(api, u);
  const res = await webhook(api, 'checkout.session.completed', completedSession(p));
  expect(res.statusCode, res.body).toBe(200);
  return p;
}
