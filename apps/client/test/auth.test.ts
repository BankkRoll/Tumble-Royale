/**
 * AccountAuth boot decisions with a fake API: which session the device ends
 * up on after an OAuth/email return, and when the player is asked first.
 */
import { accountUi, ui, uiEvents } from '@tumble/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiAuthResult, type ApiClient } from '../src/game/api.ts';
import { AccountAuth } from '../src/game/online/auth.ts';
import type { ProfileStore } from '../src/game/profile.ts';

vi.stubGlobal('history', { replaceState: vi.fn() });

function result(userId: string, outcome: ApiAuthResult['outcome']): ApiAuthResult {
  return {
    accessToken: `access-${userId}`,
    refreshToken: `refresh-${userId}`,
    user: { id: userId, displayName: 'Owner', tag: '0001', isGuest: false },
    outcome,
    provider: 'discord',
  };
}

function fakes(opts: {
  current: string | null;
  guest?: boolean;
  profile?: boolean;
  exchange: ApiAuthResult;
  at?: { pathname: string; search: string };
}) {
  const api = {
    signedIn: opts.current !== null,
    probe: vi.fn(async () => true),
    authProviders: vi.fn(async () => ({ discord: true, google: false, github: true, email: true })),
    exchangeCode: vi.fn(async () => opts.exchange),
    verifyEmail: vi.fn(async () => opts.exchange),
    verifyStaffLink: vi.fn(async () => opts.exchange),
    startOAuth: vi.fn(async () => ({ url: 'https://provider.example/authorize' })),
    currentUserId: vi.fn(() => opts.current),
    me: vi.fn(async () => ({ displayName: 'Guesty', isGuest: opts.guest ?? true })),
    adoptSession: vi.fn(),
    signOut: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
  };
  let exists = opts.profile ?? opts.current !== null;
  const profile = {
    get exists() {
      return exists;
    },
    name: 'Guesty',
    clear: vi.fn(() => {
      exists = false;
    }),
    create: vi.fn(() => {
      exists = true;
    }),
    answerTutorial: vi.fn(),
  };
  const navigate = vi.fn();
  const auth = new AccountAuth(
    {
      api: api as unknown as ApiClient,
      profile: profile as unknown as ProfileStore,
      account: null,
      onLocalProfileChanged: () => undefined,
      reload: vi.fn(),
      navigate,
    },
    opts.at ?? { pathname: '/auth/complete', search: '?provider=discord&code=one-time-code' },
  );
  return { api, profile, auth, navigate };
}

/** Answers the next dialog with the given button. */
function answerNextDialog(buttonId: string): void {
  const off = ui.subscribe((s) => {
    if (!s.dialog) return;
    off();
    const id = s.dialog.id;
    queueMicrotask(() => {
      uiEvents.emit('dialogResult', { dialogId: id, buttonId });
      ui.getState().closeDialog();
    });
  });
}

beforeEach(() => {
  ui.getState().closeDialog();
  accountUi.getState().setProviders(null);
});

describe('AccountAuth.boot', () => {
  it('cleans the URL and publishes the enabled sign-in methods', async () => {
    const { auth } = fakes({ current: 'me', exchange: result('me', 'linked') });
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
    await auth.boot();
    expect(accountUi.getState().providers).toEqual({
      discord: true,
      google: false,
      github: true,
      twitch: false,
      apple: false,
      email: true,
    });
  });

  it('keeps the device token when the sign-in landed on the same account', async () => {
    const { api, profile, auth } = fakes({ current: 'me', exchange: result('me', 'linked') });
    await auth.boot();
    expect(api.exchangeCode).toHaveBeenCalledWith('one-time-code');
    expect(api.adoptSession).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'access-me' }),
      true,
    );
    expect(profile.clear).not.toHaveBeenCalled();
  });

  it('adopts an existing Tumbler straight away on a fresh device', async () => {
    const { api, profile, auth } = fakes({
      current: null,
      profile: false,
      exchange: result('owner', 'signedIn'),
    });
    await auth.boot();
    expect(ui.getState().dialog).toBeNull();
    expect(api.adoptSession).toHaveBeenCalledWith(expect.anything(), false);
    expect(profile.create).toHaveBeenCalledWith('Owner', expect.anything());
    expect(profile.answerTutorial).toHaveBeenCalled();
  });

  it('asks before replacing a guest, and revokes the new session when the player keeps it', async () => {
    const { api, profile, auth } = fakes({
      current: 'guest',
      guest: true,
      exchange: result('owner', 'switched'),
    });
    answerNextDialog('keep');
    await auth.boot();
    expect(api.revoke).toHaveBeenCalledWith('refresh-owner');
    expect(api.adoptSession).not.toHaveBeenCalled();
    expect(profile.clear).not.toHaveBeenCalled();
  });

  it('switches when the player confirms', async () => {
    const { api, profile, auth } = fakes({
      current: 'guest',
      guest: true,
      exchange: result('owner', 'switched'),
    });
    answerNextDialog('switch');
    await auth.boot();
    expect(api.signOut).toHaveBeenCalled();
    expect(api.adoptSession).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'refresh-owner' }),
      false,
    );
    expect(profile.clear).toHaveBeenCalled();
    expect(profile.create).toHaveBeenCalled();
  });

  it('switches without asking when the current Tumbler has its own login', async () => {
    const { api, auth } = fakes({
      current: 'linked-user',
      guest: false,
      exchange: result('owner', 'switched'),
    });
    await auth.boot();
    expect(ui.getState().dialog).toBeNull();
    expect(api.adoptSession).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('leaves everything alone when the code cannot be exchanged', async () => {
    const { api, profile, auth } = fakes({ current: 'me', exchange: result('me', 'linked') });
    api.exchangeCode.mockRejectedValueOnce(new Error('expired'));
    await auth.boot();
    expect(api.adoptSession).not.toHaveBeenCalled();
    expect(profile.clear).not.toHaveBeenCalled();
  });
});

describe('staff sign-in links', () => {
  const staffResult = (): ApiAuthResult => ({ ...result('owner', 'signedIn'), provider: 'link' });

  it('redeem the token, adopt the session and open the console', async () => {
    const { api, auth, navigate } = fakes({
      current: null,
      profile: false,
      exchange: staffResult(),
      at: { pathname: '/auth/staff', search: '?token=staff-token' },
    });
    await auth.boot();
    expect(api.verifyStaffLink).toHaveBeenCalledWith('staff-token');
    expect(api.adoptSession).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'access-owner' }), false);
    expect(navigate).toHaveBeenCalledWith('/admin');
  });

  it('stay on the game and explain when the link has expired', async () => {
    const { api, auth, navigate } = fakes({
      current: null,
      profile: false,
      exchange: staffResult(),
      at: { pathname: '/auth/staff', search: '?token=old' },
    });
    api.verifyStaffLink.mockRejectedValueOnce(new ApiError(400, 'invalid_token', 'expired'));
    await auth.boot();
    expect(api.adoptSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(ui.getState().toasts.at(-1)?.title).toBe('That sign-in link has expired');
  });

  it('do not open the console when the player keeps the guest already on this device', async () => {
    const { auth, navigate } = fakes({
      current: 'guest',
      guest: true,
      exchange: staffResult(),
      at: { pathname: '/auth/staff', search: '?token=t' },
    });
    answerNextDialog('keep');
    await auth.boot();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('leaving for a provider', () => {
  it('sends the intent along and goes to the provider', async () => {
    const { api, auth, navigate } = fakes({ current: null, exchange: result('me', 'linked'), at: { pathname: '/', search: '' } });
    await auth.handle('signIn-twitch', undefined);
    expect(api.startOAuth).toHaveBeenCalledWith('twitch', false, 'signIn');
    expect(navigate).toHaveBeenCalledWith('https://provider.example/authorize');
    await auth.handle('signIn-myspace', undefined);
    expect(api.startOAuth).toHaveBeenCalledTimes(1);
  });
});
