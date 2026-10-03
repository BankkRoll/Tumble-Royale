import { describe, expect, it } from 'vitest';
import { gemCheckoutMode } from '../src/game/online/gemCheckout.ts';

describe('gem checkout mode', () => {
  it('enables real checkout only for Stripe', () => {
    expect(gemCheckoutMode({ provider: 'stripe', checkout: 'live' })).toBe('enabled');
    expect(gemCheckoutMode({ provider: 'stripe' })).toBe('enabled');
  });

  it('allows the dev fake provider as a labelled test purchase', () => {
    expect(gemCheckoutMode({ provider: 'fake', checkout: 'test' })).toBe('test');
    expect(gemCheckoutMode({ provider: 'fake' })).toBe('test');
  });

  it('shows "Coming soon" without a provider that can complete a purchase', () => {
    expect(gemCheckoutMode({ provider: 'disabled', checkout: 'unavailable' })).toBe('comingSoon');
    expect(gemCheckoutMode({ provider: 'fake', checkout: 'unavailable' })).toBe('comingSoon');
    expect(gemCheckoutMode({ provider: 'disabled', checkout: 'live' })).toBe('comingSoon');
    expect(gemCheckoutMode(null)).toBe('comingSoon');
  });
});
