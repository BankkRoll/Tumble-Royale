/**
 * Account management UI, server-rendered: which sign-in methods show for each
 * server configuration, linked/unlink state, rename cooldown, the welcome
 * screen entry point and the exact deletion copy for each kind of Tumbler.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { confirmDeleteAccount, confirmUnlink } from '../src/components/account.ts';
import { WelcomeScreen } from '../src/screens/FirstLaunch.tsx';
import { ProfileTab } from '../src/screens/menu/ProfileTab.tsx';
import {
  AccountSection,
  RenameField,
  renameLockedUntil,
  WelcomeSignIn,
} from '../src/screens/overlays/AccountSheet.tsx';
import {
  AUTH_PROVIDERS,
  accountUi,
  enabledProviders,
  type AuthProviderId,
  type AuthProviders,
} from '../src/store/account.ts';
import { uiEvents } from '../src/store/events.ts';
import type { ProfileData } from '../src/store/types.ts';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;
(accountUi as unknown as { getInitialState: () => unknown }).getInitialState = accountUi.getState;

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2700}-\u{27BF}]|\u{FE0F}/u;

/** A server offering exactly `ids`. */
const only = (...ids: AuthProviderId[]): AuthProviders =>
  Object.fromEntries(AUTH_PROVIDERS.map((p) => [p, ids.includes(p)])) as AuthProviders;
const ALL: AuthProviders = only(...AUTH_PROVIDERS);
const NONE: AuthProviders = only();

function profile(over: Partial<ProfileData> = {}): ProfileData {
  return {
    id: 'me',
    name: 'Sprinkles',
    tag: '1234',
    level: 3,
    xp: 10,
    xpToNext: 100,
    gumballs: 0,
    gems: 0,
    crowns: 0,
    colors: { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' },
    isGuest: true,
    stats: { shows: 1, finals: 0, roundsQualified: 1, bestStreak: 0 },
    ...over,
  };
}

function setup(opts: {
  session: 'local' | 'online' | 'unreachable';
  providers: AuthProviders | null;
  profile?: Partial<ProfileData>;
  availableAt?: number | null;
}): void {
  ui.getState().setProfile(profile(opts.profile));
  const a = accountUi.getState();
  a.setSession(opts.session);
  a.setProviders(opts.providers);
  a.setNameChangeAvailableAt(opts.availableAt ?? null);
  a.setEmailFlow({ status: 'idle' });
  a.setRename({ status: 'idle' });
  a.setPending(null);
}

/** Visible text of every button in the markup. */
function buttons(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    (m[1] ?? '')
      .replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim(),
  );
}

beforeEach(() => {
  ui.getState().closeDialog();
});

describe('enabledProviders', () => {
  it('keeps display order and drops disabled or unknown servers', () => {
    expect(enabledProviders(only('email', 'google'))).toEqual(['google', 'email']);
    expect(enabledProviders(only('apple', 'github', 'twitch'))).toEqual(['github', 'twitch', 'apple']);
    expect(enabledProviders(null)).toEqual([]);
  });
});

describe('Settings > Account', () => {
  it('is honest when accounts are offline: no link or sign-in buttons', () => {
    setup({ session: 'local', providers: null });
    const html = renderToStaticMarkup(<AccountSection />);
    expect(html).toContain('data-testid="linked-offline"');
    expect(html).not.toContain('data-testid="sign-in-options"');
    expect(buttons(html)).not.toContain('Link');
    expect(html).toContain('Erases it from this device');
  });

  it('explains when the server offers no sign-in methods and hides sign-in entirely', () => {
    setup({ session: 'online', providers: NONE });
    const html = renderToStaticMarkup(<AccountSection />);
    expect(html).toContain('data-testid="linked-none"');
    expect(html).not.toContain('Sign in to an existing Tumbler');
    expect(buttons(html)).not.toContain('Discord');
  });

  it('shows only enabled methods, the linked state and guards the last login', () => {
    setup({
      session: 'online',
      providers: only('discord', 'email'),
      profile: { isGuest: false, linkedProviders: ['email'] },
    });
    const html = renderToStaticMarkup(<AccountSection />);
    expect(html).toContain('data-testid="method-email"');
    expect(html).toContain('data-testid="method-discord"');
    expect(html).not.toContain('data-testid="method-google"');
    expect(html).toMatch(/method-email[\s\S]*?Linked[\s\S]*?<button[^>]*disabled=""[^>]*>Unlink/);
    expect(html).toContain('Link a second login before you can unlink this one.');
    expect(html).toContain('data-testid="sign-in-discord"');
    expect(html).toContain('data-testid="sign-in-email"');
    expect(html).not.toContain('data-testid="sign-in-google"');
  });

  it('lets a method be unlinked while another remains, and still lists a linked method the server turned off', () => {
    setup({
      session: 'online',
      providers: only('google', 'email'),
      profile: { isGuest: false, linkedProviders: ['discord', 'email'] },
    });
    const html = renderToStaticMarkup(<AccountSection />);
    expect(html).toContain('data-testid="method-discord"');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Unlink/);
    expect(html).not.toContain('Link a second login');
  });

  it('lists GitHub, Twitch and Apple when the server enables them, with their linked state', () => {
    setup({
      session: 'online',
      providers: only('github', 'twitch', 'apple'),
      profile: { isGuest: false, linkedProviders: ['github', 'apple'] },
    });
    const html = renderToStaticMarkup(<AccountSection />);
    for (const p of ['github', 'twitch', 'apple']) expect(html).toContain(`data-testid="method-${p}"`);
    expect(html).toMatch(/method-github[\s\S]*?Linked/);
    expect(html).toMatch(/method-twitch[\s\S]*?>Link</);
    expect(html).toContain('data-testid="sign-in-twitch"');
    expect(html).not.toContain('data-testid="method-discord"');
    expect(buttons(html)).toEqual(expect.arrayContaining(['GitHub', 'Twitch', 'Apple']));
  });

  it('has no emoji on any control', () => {
    setup({ session: 'online', providers: ALL, profile: { linkedProviders: ['google'] } });
    const html = renderToStaticMarkup(<AccountSection />) + renderToStaticMarkup(<ProfileTab />);
    expect(buttons(html).filter((t) => EMOJI.test(t))).toEqual([]);
  });
});

describe('rename', () => {
  it('shows the cooldown and disables Rename online', () => {
    const later = Date.now() + 5 * 86_400_000;
    setup({ session: 'online', providers: ALL, availableAt: later });
    const html = renderToStaticMarkup(<RenameField testId="r" />);
    expect(html).toContain('data-testid="r-cooldown"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="r-edit"/);
  });

  it('allows renaming a local Tumbler any time', () => {
    setup({ session: 'local', providers: null, availableAt: Date.now() + 86_400_000 });
    const html = renderToStaticMarkup(<RenameField testId="r" />);
    expect(html).not.toContain('r-cooldown');
    expect(html).not.toMatch(/disabled=""[^>]*data-testid="r-edit"/);
  });

  it('appears on the Profile tab account card', () => {
    setup({ session: 'online', providers: ALL });
    expect(renderToStaticMarkup(<ProfileTab />)).toContain('data-testid="profile-rename-edit"');
  });

  it('computes the unlock date', () => {
    expect(renameLockedUntil(null, 0)).toBeNull();
    expect(renameLockedUntil(10, 20)).toBeNull();
    expect(renameLockedUntil(30, 20)?.getTime()).toBe(30);
  });
});

describe('welcome screen', () => {
  it('offers sign-in to an existing Tumbler only when the server has a method', () => {
    setup({ session: 'local', providers: NONE });
    expect(renderToStaticMarkup(<WelcomeSignIn />)).toBe('');
    accountUi.getState().setProviders(only('email'));
    expect(renderToStaticMarkup(<WelcomeScreen />)).toContain('Sign in to an existing Tumbler');
  });
});

describe('delete confirmation copy', () => {
  it('says a local Tumbler is erased from this device only', () => {
    setup({ session: 'local', providers: null });
    confirmDeleteAccount();
    const d = ui.getState().dialog!;
    expect(d.body).toContain('only lives on this device');
    expect(d.body).not.toContain('servers');
    expect(d.buttons?.map((b) => b.label)).toEqual(['Keep playing', 'Delete']);
  });

  it('says an online Tumbler is deleted from the servers too', () => {
    setup({ session: 'online', providers: ALL });
    confirmDeleteAccount();
    const d = ui.getState().dialog!;
    expect(d.body).toContain('permanently deletes Sprinkles#1234 from the Tumble Royale servers');
    expect(d.buttons?.map((b) => b.label)).toEqual(['Keep playing', 'Delete forever']);
  });

  it('refuses up front when the server account is unreachable', () => {
    setup({ session: 'unreachable', providers: null });
    let emitted = false;
    const off = uiEvents.on('accountAction', () => {
      emitted = true;
    });
    confirmDeleteAccount();
    off();
    expect(ui.getState().dialog?.kind).toBe('info');
    expect(ui.getState().dialog?.body).toContain('Nothing was deleted');
    expect(emitted).toBe(false);
  });

  it('emits the unlink intent only after confirmation', () => {
    setup({ session: 'online', providers: ALL, profile: { linkedProviders: ['google', 'email'] } });
    const seen: string[] = [];
    const off = uiEvents.on('accountAction', ({ action }) => seen.push(action));
    confirmUnlink('google');
    expect(ui.getState().dialog?.body).toContain('You can still sign in with Email.');
    uiEvents.emit('dialogResult', { dialogId: 'unlink-google', buttonId: 'confirm' });
    off();
    expect(seen).toEqual(['unlink-google']);
  });
});
