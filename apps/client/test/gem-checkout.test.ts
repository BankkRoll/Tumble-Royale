import { ui, uiEvents } from '@tumble/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  explainGemCheckoutRefusal,
  gemCheckoutMode,
  LINK_FOR_GEMS_DIALOG,
} from '../src/game/online/gemCheckout.ts';

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

describe('gem checkout refusals', () => {
  beforeEach(() => {
    ui.setState({ dialog: null });
  });

  it('asks a guest to link an account and opens the account settings on confirm', () => {
    const openAccount = vi.fn();
    expect(explainGemCheckoutRefusal('account_required', undefined, openAccount)).toBe(true);
    expect(ui.getState().dialog).toMatchObject({
      id: LINK_FOR_GEMS_DIALOG,
      title: 'Link an account to buy Gems',
    });
    uiEvents.emit('dialogResult', { dialogId: LINK_FOR_GEMS_DIALOG, buttonId: 'link' });
    expect(openAccount).toHaveBeenCalledTimes(1);
    uiEvents.emit('dialogResult', { dialogId: LINK_FOR_GEMS_DIALOG, buttonId: 'link' });
    expect(openAccount).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the guest declines, and a reopened prompt fires once', () => {
    const openAccount = vi.fn();
    explainGemCheckoutRefusal('account_required', undefined, openAccount);
    uiEvents.emit('dialogResult', { dialogId: LINK_FOR_GEMS_DIALOG, buttonId: 'cancel' });
    expect(openAccount).not.toHaveBeenCalled();
    explainGemCheckoutRefusal('account_required', undefined, openAccount);
    explainGemCheckoutRefusal('account_required', undefined, openAccount);
    uiEvents.emit('dialogResult', { dialogId: LINK_FOR_GEMS_DIALOG, buttonId: 'link' });
    expect(openAccount).toHaveBeenCalledTimes(1);
  });

  it('explains paused purchases while the account owes Gems', () => {
    expect(explainGemCheckoutRefusal('payment_debt', { gemDebt: 900 })).toBe(true);
    expect(ui.getState().dialog).toMatchObject({
      id: 'gems-payment-debt',
      title: 'Gem purchases are paused',
    });
    expect(ui.getState().dialog?.body).toContain('900 Gems owed');
  });

  it('leaves other errors to the generic handler', () => {
    expect(explainGemCheckoutRefusal('payments_unavailable')).toBe(false);
    expect(explainGemCheckoutRefusal(undefined)).toBe(false);
    expect(ui.getState().dialog).toBeNull();
  });
});
