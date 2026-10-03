/**
 * AccountAuth boot decisions with a fake API: which session the device ends
 * up on after an OAuth/email return, and when the player is asked first.
 */
import { accountUi, ui, uiEvents } from '@tumble/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiAuthResult, ApiClient } from '../src/game/api.ts';
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
}) {
  const api = {
    signedIn: opts.current !== null,
    probe: vi.fn(async () => true),
    authProviders: vi.fn(async () => ({ discord: true, google: false, email: true })),
    exchangeCode: vi.fn(async () => opts.exchange),
    verifyEmail: vi.fn(async () => opts.exchange),
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
  const auth = new AccountAuth(
    {
      api: api as unknown as ApiClient,
      profile: profile as unknown as ProfileStore,
      account: null,
      onLocalProfileChanged: () => undefined,
      reload: vi.fn(),
      navigate: vi.fn(),
    },
    { pathname: '/auth/complete', search: '?provider=discord&code=one-time-code' },
  );
  return { api, profile, auth };
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
    expect(accountUi.getState().providers).toEqual({ discord: true, google: false, email: true });
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
