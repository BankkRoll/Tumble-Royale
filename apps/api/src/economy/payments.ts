/**
 * Real-money payment providers for Gem packs.
 *
 * {@link StripePaymentProvider} creates Stripe Checkout sessions and verifies
 * and decodes webhooks into provider-agnostic {@link PaymentEvent}s: checkout
 * completion and expiry, refunds and disputes. {@link FakePaymentProvider}
 * (used when `STRIPE_SECRET_KEY` is unset outside production) completes
 * instantly so the whole purchase flow works without credentials.
 */
import Stripe from 'stripe';
import type { CatalogGemPack } from '../catalog.ts';
import { ApiError } from '../http/errors.ts';

/** Input for a checkout session. */
export interface CheckoutRequest {
  purchaseId: string;
  userId: string;
  pack: CatalogGemPack;
  successUrl: string;
  cancelUrl: string;
}

/** A created checkout. */
export interface CheckoutSession {
  /** Where to send the browser. */
  url: string;
  /** Provider-side id stored on the purchase (Stripe session id). */
  providerRef: string;
  /** True when payment already completed (fake provider). */
  completed: boolean;
}

/**
 * Where a dispute stands: `open` until Stripe closes it, then `won` (funds
 * returned, including inquiries closed without a chargeback) or `lost`.
 */
export type DisputeOutcome = 'open' | 'won' | 'lost';

/** A verified, provider-agnostic payment event. `eventId` makes delivery idempotent. */
export type PaymentEvent =
  | {
      type: 'checkout_completed';
      eventId: string;
      purchaseId: string | null;
      /** Checkout session id. */
      providerRef: string;
      paymentIntent: string | null;
    }
  | {
      type: 'checkout_expired';
      eventId: string;
      purchaseId: string | null;
      providerRef: string;
      /** `expired`: abandoned session; `failed`: a delayed payment method was declined. */
      status: 'expired' | 'failed';
    }
  | {
      type: 'charge_refunded';
      eventId: string;
      paymentIntent: string;
      chargeId: string;
      /** Charged amount in minor units. */
      amount: number;
      /** Cumulative refunded amount in minor units. */
      amountRefunded: number;
    }
  | {
      type: 'dispute';
      eventId: string;
      paymentIntent: string;
      chargeId: string;
      disputeId: string;
      outcome: DisputeOutcome;
    }
  | { type: 'ignored'; eventId: string | null };

/** Payment provider contract. */
export interface PaymentProvider {
  readonly id: 'stripe' | 'fake' | 'disabled';
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /**
   * Verifies and decodes a webhook delivery.
   *
   * @throws {ApiError} 400 on a bad signature.
   */
  parseWebhook(rawBody: string, signature: string | undefined): PaymentEvent;
}

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === 'string' ? v : (v?.id ?? null);

/**
 * Maps a Stripe dispute status onto what it means for the Gems.
 *
 * Inquiries (`warning_*`) are treated like chargebacks while open: they often
 * escalate, and Gems are spent instantly, so waiting would leave nothing to
 * take back. `warning_closed` and `prevented` mean no money moved, so they
 * count as won.
 */
export function disputeOutcome(status: string): DisputeOutcome {
  if (status === 'won' || status === 'warning_closed' || status === 'prevented') return 'won';
  if (status === 'lost') return 'lost';
  return 'open';
}

/** Stripe Checkout implementation. */
export class StripePaymentProvider implements PaymentProvider {
  readonly id = 'stripe' as const;
  private readonly stripe: Stripe;

  /**
   * @param secretKey - `STRIPE_SECRET_KEY`.
   * @param webhookSecret - `STRIPE_WEBHOOK_SECRET`; webhooks are rejected without it.
   * @param stripeConfig - Extra SDK options; tests inject a fake `httpClient`.
   */
  constructor(
    secretKey: string,
    private readonly webhookSecret: string | undefined,
    stripeConfig: Stripe.StripeConfig = {},
  ) {
    this.stripe = new Stripe(secretKey, stripeConfig);
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const metadata = { purchaseId: req.purchaseId, packId: req.pack.id, userId: req.userId };
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: req.pack.currency,
              unit_amount: req.pack.priceCents,
              product_data: { name: `${req.pack.name} (${req.pack.gems} Gems)` },
            },
          },
        ],
        client_reference_id: req.userId,
        metadata,
        // Copied onto the PaymentIntent so refunds and disputes in the Stripe
        // dashboard can be traced back to the purchase by support.
        payment_intent_data: { metadata },
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
      },
      // Stripe's own idempotency guards against a double session if we retry.
      { idempotencyKey: `checkout:${req.purchaseId}` },
    );
    if (!session.url) throw new ApiError(502, 'payment_provider_error', 'Stripe returned no checkout URL');
    return { url: session.url, providerRef: session.id, completed: false };
  }

  parseWebhook(rawBody: string, signature: string | undefined): PaymentEvent {
    if (!this.webhookSecret) throw new ApiError(503, 'webhook_disabled', 'STRIPE_WEBHOOK_SECRET is not set');
    if (!signature) throw new ApiError(400, 'bad_signature', 'Missing Stripe-Signature header');
    let event: Stripe.Event;
    // SECURITY: nothing in the body is trusted until the signature over the
    // exact raw bytes checks out; constructEvent also bounds the timestamp age.
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw new ApiError(400, 'bad_signature', 'Invalid Stripe signature');
    }
    const eventId = event.id;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const s = event.data.object;
        if (s.payment_status !== 'paid') return { type: 'ignored', eventId };
        return {
          type: 'checkout_completed',
          eventId,
          purchaseId: s.metadata?.purchaseId ?? null,
          providerRef: s.id,
          paymentIntent: idOf(s.payment_intent),
        };
      }
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        const s = event.data.object;
        return {
          type: 'checkout_expired',
          eventId,
          purchaseId: s.metadata?.purchaseId ?? null,
          providerRef: s.id,
          status: event.type === 'checkout.session.expired' ? 'expired' : 'failed',
        };
      }
      case 'charge.refunded': {
        const c = event.data.object;
        const paymentIntent = idOf(c.payment_intent);
        if (!paymentIntent) return { type: 'ignored', eventId };
        return {
          type: 'charge_refunded',
          eventId,
          paymentIntent,
          chargeId: c.id,
          amount: c.amount,
          amountRefunded: c.amount_refunded,
        };
      }
      case 'charge.dispute.created':
      case 'charge.dispute.closed':
      case 'charge.dispute.funds_reinstated': {
        const d = event.data.object;
        const paymentIntent = idOf(d.payment_intent);
        const chargeId = idOf(d.charge);
        if (!paymentIntent || !chargeId) return { type: 'ignored', eventId };
        return {
          type: 'dispute',
          eventId,
          paymentIntent,
          chargeId,
          disputeId: d.id,
          // `funds_reinstated` can arrive with a stale status; the money is back either way.
          outcome: event.type === 'charge.dispute.funds_reinstated' ? 'won' : disputeOutcome(d.status),
        };
      }
      default:
        return { type: 'ignored', eventId };
    }
  }
}

/** Development provider: every checkout succeeds immediately. */
export class FakePaymentProvider implements PaymentProvider {
  readonly id = 'fake' as const;

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    return { url: req.successUrl, providerRef: `fake_${req.purchaseId}`, completed: true };
  }

  parseWebhook(): PaymentEvent {
    throw new ApiError(404, 'not_found', 'Webhooks are not used by the fake payment provider');
  }
}

/**
 * Production provider when Stripe isn't configured: Gem checkout is refused
 * rather than silently falling back to the fake provider, which would grant
 * Gems for free on a public deployment.
 */
export class DisabledPaymentProvider implements PaymentProvider {
  readonly id = 'disabled' as const;

  async createCheckout(): Promise<CheckoutSession> {
    throw new ApiError(503, 'payments_unavailable', 'Gem purchases are coming soon');
  }

  parseWebhook(): PaymentEvent {
    throw new ApiError(404, 'not_found', 'Payments are not configured');
  }
}
