/**
 * Real-money payment providers for Gem packs.
 *
 * {@link StripePaymentProvider} creates Stripe Checkout sessions and verifies
 * webhook signatures. {@link FakePaymentProvider} (used when
 * `STRIPE_SECRET_KEY` is unset) completes instantly so the whole purchase flow
 * works in development without credentials.
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

/** A verified, provider-agnostic payment event. */
export interface PaymentEvent {
  type: 'checkout_completed' | 'checkout_expired' | 'ignored';
  purchaseId: string | null;
  providerRef: string | null;
}

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

/** Stripe Checkout implementation. */
export class StripePaymentProvider implements PaymentProvider {
  readonly id = 'stripe' as const;
  private readonly stripe: Stripe;

  /**
   * @param secretKey - `STRIPE_SECRET_KEY`.
   * @param webhookSecret - `STRIPE_WEBHOOK_SECRET`; webhooks are rejected without it.
   */
  constructor(
    secretKey: string,
    private readonly webhookSecret: string | undefined,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
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
        metadata: { purchaseId: req.purchaseId, packId: req.pack.id },
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
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw new ApiError(400, 'bad_signature', 'Invalid Stripe signature');
    }
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const s = event.data.object;
      if (s.payment_status !== 'paid') return { type: 'ignored', purchaseId: null, providerRef: s.id };
      return { type: 'checkout_completed', purchaseId: s.metadata?.purchaseId ?? null, providerRef: s.id };
    }
    if (event.type === 'checkout.session.expired') {
      const s = event.data.object;
      return { type: 'checkout_expired', purchaseId: s.metadata?.purchaseId ?? null, providerRef: s.id };
    }
    return { type: 'ignored', purchaseId: null, providerRef: null };
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
