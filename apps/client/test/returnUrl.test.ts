import { describe, expect, it } from 'vitest';
import {
  authErrorMessage,
  cleanReturnUrl,
  outcomeMessage,
  parseBootReturn,
  tokenSubject,
} from '../src/game/online/returnUrl.ts';

describe('parseBootReturn', () => {
  it('reads an OAuth success with its provider', () => {
    expect(parseBootReturn('/auth/complete', '?provider=discord&code=abc123')).toEqual({
      kind: 'oauth',
      code: 'abc123',
      provider: 'discord',
    });
  });

  it('reads OAuth errors, including the legacy URL without a provider', () => {
    expect(parseBootReturn('/auth/complete', '?provider=google&error=access_denied')).toEqual({
      kind: 'oauthError',
      error: 'access_denied',
      provider: 'google',
    });
    expect(parseBootReturn('/auth/complete/', '?error=provider_disabled')).toEqual({
      kind: 'oauthError',
      error: 'provider_disabled',
      provider: null,
    });
    expect(parseBootReturn('/auth/complete', '')).toMatchObject({
      kind: 'oauthError',
      error: 'missing_code',
    });
  });

  it('reads an email magic link', () => {
    expect(parseBootReturn('/auth/email', '?token=tok_123')).toEqual({ kind: 'email', token: 'tok_123' });
    expect(parseBootReturn('/auth/email', '')).toMatchObject({ kind: 'oauthError', error: 'invalid_token' });
  });

  it('reads Stripe checkout returns', () => {
    expect(parseBootReturn('/store', '?checkout=success&purchase=p-1')).toEqual({
      kind: 'checkout',
      status: 'success',
      purchaseId: 'p-1',
    });
    expect(parseBootReturn('/store', '?checkout=cancel&purchase=p-1')).toMatchObject({ status: 'cancel' });
    expect(parseBootReturn('/store', '?checkout=bogus')).toBeNull();
  });

  it('ignores ordinary launches and unknown providers', () => {
    expect(parseBootReturn('/', '?apiUrl=http://x')).toBeNull();
    expect(parseBootReturn('/join/ABCDEF', '')).toBeNull();
    expect(parseBootReturn('/auth/complete', '?provider=myspace&code=x')).toMatchObject({ provider: null });
  });
});

describe('cleanReturnUrl', () => {
  it('drops one-time codes and keeps dev flags', () => {
    expect(cleanReturnUrl('?provider=discord&code=abc')).toBe('/');
    expect(cleanReturnUrl('?token=t&apiUrl=http%3A%2F%2Flocalhost%3A7360')).toBe(
      '/?apiUrl=http%3A%2F%2Flocalhost%3A7360',
    );
    expect(cleanReturnUrl('?checkout=success&purchase=p&debug=1')).toBe('/?debug=1');
  });
});

describe('messages', () => {
  it('words cancellations, disabled providers and expired links honestly', () => {
    expect(authErrorMessage('access_denied', 'discord').title).toBe('Sign-in cancelled');
    expect(authErrorMessage('provider_disabled', 'google').title).toBe("Google sign-in isn't set up here");
    expect(authErrorMessage('invalid_token', 'email').title).toBe('That email link has expired');
    expect(authErrorMessage('weird_code', null).body).toContain('weird_code');
  });

  it('says what a sign-in did', () => {
    expect(outcomeMessage('linked', 'discord', 'Pip').title).toBe('Discord linked');
    expect(outcomeMessage('alreadyLinked', 'email', 'Pip').title).toBe('Email was already linked');
    expect(outcomeMessage('switched', 'google', 'Pip').title).toBe('Signed in as Pip');
    expect(outcomeMessage('created', 'google', 'Pip').body).toContain('made a new one');
  });
});

describe('tokenSubject', () => {
  it('reads the account id from an access token', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1', typ: 'access' })).toString('base64url');
    expect(tokenSubject(`h.${payload}.s`)).toBe('user-1');
    expect(tokenSubject('garbage')).toBeNull();
    expect(tokenSubject(null)).toBeNull();
  });
});
