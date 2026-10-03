/**
 * Account sign-in methods and lifecycle on the client.
 *
 * Responsibilities:
 * - publish which sign-in methods the server offers (`GET /auth/providers`)
 *   and where this device's Tumbler lives, for the account UI;
 * - finish OAuth (`/auth/complete`) and email (`/auth/email`) returns on boot:
 *   trade the code/token for a session, clean the URL, and adopt the session,
 *   asking first when that would abandon an unbacked-up guest Tumbler;
 * - start linking and "sign in to an existing Tumbler" (Discord, Google,
 *   email magic links), unlink methods, rename and delete the account.
 *
 * The guest-only path never needs any of this: with no methods enabled the
 * UI hides them and a Tumbler simply lives on the device.
 */
import {
  accountUi,
  ui,
  uiEvents,
  type AuthProviderId,
  type DialogSpec,
  type TumblerColors,
} from '@tumble/ui';
import { ApiError, type ApiAuthResult, type ApiClient } from '../api.ts';
import type { ProfileStore } from '../profile.ts';
import { storageKeyName } from '../storage.ts';
import type { OnlineAccount } from './account.ts';
import {
  PROVIDER_LABELS,
  authErrorMessage,
  cleanReturnUrl,
  outcomeMessage,
  parseBootReturn,
  type BootReturn,
  type LoginProvider,
} from './returnUrl.ts';

/** Colours for a Tumbler adopted from another device until its account loadout loads. */
const ADOPTED_COLORS: TumblerColors = { primary: '#3ec7e6', secondary: '#ffffff', pattern: 'plain' };

/** What {@link AccountAuth} needs from the app. */
export interface AccountAuthDeps {
  api: ApiClient;
  profile: ProfileStore;
  account: OnlineAccount | null;
  /** The local profile changed while offline (push it to the menus). */
  onLocalProfileChanged(): void;
  /** Reloads the page; injected so tests never navigate. */
  reload?: () => void;
  /** Leaves for a provider's sign-in page. */
  navigate?: (url: string) => void;
}

/** Human message for an API error. */
function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.status === 0 ? 'The server could not be reached.' : err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/**
 * Shows a dialog and resolves with the button pressed, or null when another
 * dialog replaced it first.
 */
function choose(spec: DialogSpec): Promise<string | null> {
  return new Promise((resolve) => {
    const subs: (() => void)[] = [];
    let settled = false;
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      for (const off of subs) off();
      resolve(v);
    };
    // The dialog layer emits the result before closing, so a button press wins over the close below.
    subs.push(
      uiEvents.on('dialogResult', ({ dialogId, buttonId }) => {
        if (dialogId === spec.id) finish(buttonId);
      }),
    );
    ui.getState().showDialog(spec);
    subs.push(
      ui.subscribe((s) => {
        if (s.dialog?.id !== spec.id) finish(null);
      }),
    );
  });
}

/** Account sign-in methods and lifecycle. See the module doc. */
export class AccountAuth {
  /** The return this launch was opened on (already removed from the address bar). */
  readonly bootReturn: BootReturn | null;
  private readonly reload: () => void;
  private readonly navigate: (url: string) => void;
  private watchingOtherTab = false;

  constructor(
    private readonly deps: AccountAuthDeps,
    loc: Pick<Location, 'pathname' | 'search'> = window.location,
  ) {
    this.reload = deps.reload ?? (() => window.location.reload());
    this.navigate = deps.navigate ?? ((url) => window.location.assign(url));
    this.bootReturn = parseBootReturn(loc.pathname, loc.search);
    // A one-time code must never be replayed by a reload or a shared link.
    if (this.bootReturn) history.replaceState(null, '', cleanReturnUrl(loc.search));
  }

  private get online(): OnlineAccount | null {
    return this.deps.account?.active ? this.deps.account : null;
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  /**
   * Probes the API, publishes the sign-in methods and finishes an OAuth or
   * email return. Call before the normal account connect, so that connect
   * resumes whichever session this settles on.
   */
  async boot(): Promise<void> {
    const api = this.deps.api;
    const up = await api.probe();
    const ret = this.bootReturn;
    if (!up) {
      accountUi.getState().setProviders(null);
      if (ret && ret.kind !== 'checkout') this.toastError('network', null);
      return;
    }
    await this.refreshProviders();
    if (!ret) return;
    if (ret.kind === 'oauthError') {
      this.toastError(ret.error, ret.provider);
      return;
    }
    if (ret.kind !== 'oauth' && ret.kind !== 'email') return;
    let result: ApiAuthResult;
    try {
      result = ret.kind === 'oauth' ? await api.exchangeCode(ret.code) : await api.verifyEmail(ret.token);
    } catch (err) {
      const code = err instanceof ApiError ? (err.status === 0 ? 'network' : err.code) : 'unknown';
      this.toastError(code, ret.kind === 'email' ? 'email' : ret.provider);
      return;
    }
    await this.adopt(result);
  }

  /** Re-reads `GET /auth/providers` (null while the API is unreachable). */
  async refreshProviders(): Promise<void> {
    try {
      const p = await this.deps.api.authProviders();
      accountUi.getState().setProviders({ discord: !!p.discord, google: !!p.google, email: !!p.email });
    } catch {
      accountUi.getState().setProviders(null);
    }
  }

  /** Publishes where the Tumbler lives and the rename cooldown, after any connect attempt. */
  publishSession(): void {
    const a = this.online;
    const s = accountUi.getState();
    s.setSession(a ? 'online' : this.deps.api.signedIn ? 'unreachable' : 'local');
    const at = a?.me?.nameChangeAvailableAt;
    s.setNameChangeAvailableAt(at ? Date.parse(at) : null);
  }

  /**
   * Moves the device onto a session from a completed sign-in. The same
   * account just takes the fresh tokens; another account replaces the local
   * Tumbler, after a confirmation when that Tumbler has no other way back.
   */
  private async adopt(result: ApiAuthResult): Promise<void> {
    const { api, profile } = this.deps;
    const name = result.user.displayName;
    const current = api.currentUserId();
    if (current === result.user.id) {
      api.adoptSession(result, true);
      this.toastOutcome(result);
      return;
    }
    const here = await this.currentTumbler();
    if (here?.atRisk) {
      const label = PROVIDER_LABELS[result.provider];
      const pick = await choose({
        id: 'auth-switch',
        kind: 'confirm',
        title: `Switch to ${name}?`,
        body:
          `That ${label} login belongs to ${name}#${result.user.tag}. Switching puts ${name} on this device. ` +
          `${here.name}, the Tumbler on this device now, isn't linked to any login, so its items, Crowns and progress will be gone for good.`,
        buttons: [
          { id: 'keep', label: `Keep ${here.name}`, variant: 'secondary', autofocus: true },
          { id: 'switch', label: `Switch to ${name}`, variant: 'danger' },
        ],
      });
      if (pick !== 'switch') {
        void api.revoke(result.refreshToken);
        ui.getState().pushToast({
          kind: 'info',
          title: `Kept ${here.name}`,
          body: `Nothing changed. Link a login in Settings first if you want to keep both.`,
          icon: '🔒',
        });
        return;
      }
    }
    // Revoke the old session rather than leaving a live refresh token behind for a Tumbler this device no longer shows.
    await api.signOut();
    api.adoptSession(result, false);
    profile.clear();
    profile.create(name, ADOPTED_COLORS);
    profile.answerTutorial();
    this.toastOutcome(result);
  }

  /** The Tumbler on this device right now, and whether replacing it would lose it for good. */
  private async currentTumbler(): Promise<{ name: string; atRisk: boolean } | null> {
    const { api, profile } = this.deps;
    if (api.signedIn) {
      try {
        const me = await api.me();
        return { name: me.displayName, atRisk: me.isGuest };
      } catch {
        // Unknown server state: assume the worst and ask.
        return { name: profile.name, atRisk: true };
      }
    }
    return profile.exists ? { name: profile.name, atRisk: true } : null;
  }

  private toastOutcome(result: ApiAuthResult): void {
    const m = outcomeMessage(result.outcome, result.provider, result.user.displayName);
    ui.getState().pushToast({ kind: 'success', title: m.title, body: m.body, icon: '☁️', durationMs: 6000 });
  }

  private toastError(code: string, provider: LoginProvider | null): void {
    const m = authErrorMessage(code, provider);
    const cancelled = code === 'access_denied';
    ui.getState().pushToast({
      kind: cancelled ? 'info' : 'error',
      title: m.title,
      body: m.body,
      icon: cancelled ? '👋' : '🔒',
      durationMs: 7000,
    });
  }

  // ---------------------------------------------------------------------------
  // Intents
  // ---------------------------------------------------------------------------

  /**
   * Handles `accountAction` intents other than sign-out and delete.
   *
   * @param action - The intent's action.
   * @param value - Email address or new name.
   */
  async handle(action: string, value: string | undefined): Promise<void> {
    if (action === 'rename') {
      if (value) await this.rename(value);
      return;
    }
    const m = /^(link|signIn|unlink)-(discord|google|email)$/.exec(action);
    if (!m) return;
    const verb = m[1] as 'link' | 'signIn' | 'unlink';
    const provider = m[2] as AuthProviderId;
    if (verb === 'unlink') await this.unlink(provider);
    else if (provider === 'email') await this.startEmail(verb, value ?? '');
    else await this.startOAuth(verb, provider);
  }

  private needsOnline(): boolean {
    if (this.online) return false;
    ui.getState().pushToast({
      kind: 'info',
      title: 'Accounts are offline right now',
      body: 'Your Tumbler is saved on this device.',
      icon: '🔒',
    });
    return true;
  }

  /**
   * Leaves for Discord/Google. Signed in, the account goes along: a new
   * identity is linked to it, one owned by another Tumbler switches to that
   * Tumbler on return. Signed out (welcome screen) it is a plain sign-in.
   */
  private async startOAuth(verb: 'link' | 'signIn', provider: 'discord' | 'google'): Promise<void> {
    if (verb === 'link' && this.needsOnline()) return;
    const s = accountUi.getState();
    s.setPending(`${verb}-${provider}`);
    try {
      const { url } = await this.deps.api.startOAuth(provider, this.online !== null);
      this.navigate(url);
    } catch (err) {
      s.setPending(null);
      const code = err instanceof ApiError ? (err.status === 0 ? 'network' : err.code) : 'unknown';
      if (code === 'provider_disabled') void this.refreshProviders();
      const msg = authErrorMessage(code, provider);
      ui.getState().pushToast({ kind: 'error', title: msg.title, body: msg.body, icon: '🔒' });
    }
  }

  /** Emails a magic link, then waits for it to be opened (here or in another tab). */
  private async startEmail(verb: 'link' | 'signIn', address: string): Promise<void> {
    const s = accountUi.getState();
    const purpose = verb;
    if (verb === 'link' && !this.online) {
      s.setEmailFlow({ status: 'error', purpose, address, message: 'Accounts are offline right now.' });
      return;
    }
    s.setEmailFlow({ status: 'sending', purpose, address });
    try {
      await this.deps.api.startEmail(address, this.online !== null);
      s.setEmailFlow({ status: 'sent', purpose, address });
      this.watchOtherTab();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'provider_disabled') void this.refreshProviders();
      const message =
        code === 'too_many_emails'
          ? 'Too many emails to that address. Try again in an hour.'
          : code === 'invalid_request'
            ? 'That email address doesn’t look right.'
            : code === 'provider_disabled'
              ? "Email sign-in isn't set up on this server."
              : errorText(err);
      s.setEmailFlow({ status: 'error', purpose, address, message });
    }
  }

  /**
   * The magic link usually opens in a new tab, which finishes the sign-in and
   * stores the new session. Reload this tab when that happens so it shows the
   * same Tumbler instead of a stale one.
   */
  private watchOtherTab(): void {
    if (this.watchingOtherTab) return;
    this.watchingOtherTab = true;
    window.addEventListener('storage', (e) => {
      if (e.key !== storageKeyName('auth') || accountUi.getState().emailFlow.status !== 'sent') return;
      this.reload();
    });
  }

  private async unlink(provider: AuthProviderId): Promise<void> {
    const a = this.online;
    if (!a) {
      this.needsOnline();
      return;
    }
    const s = accountUi.getState();
    s.setPending(`unlink-${provider}`);
    try {
      await this.deps.api.unlinkIdentity(provider);
      await a.refreshProgress();
      ui.getState().pushToast({
        kind: 'success',
        title: `${PROVIDER_LABELS[provider]} unlinked`,
        body: `You can't sign in with ${PROVIDER_LABELS[provider]} any more.`,
        icon: '🔓',
      });
    } catch (err) {
      const last = err instanceof ApiError && err.code === 'last_login_method';
      ui.getState().showDialog({
        id: 'unlink-failed',
        kind: 'error',
        title: last ? 'That’s your only login' : `Couldn't unlink ${PROVIDER_LABELS[provider]}`,
        body: last ? 'Link another login first, so you can still sign in to this Tumbler.' : errorText(err),
      });
    } finally {
      s.setPending(null);
    }
  }

  /** Renames online (server rules and cooldown) or, for a local Tumbler, instantly. */
  async rename(name: string): Promise<void> {
    const s = accountUi.getState();
    const a = this.online;
    if (!a) {
      this.deps.profile.rename(name);
      this.deps.onLocalProfileChanged();
      s.setRename({ status: 'idle' });
      return;
    }
    s.setRename({ status: 'saving' });
    try {
      await a.rename(name);
      this.deps.profile.rename(a.name);
      this.publishSession();
      s.setRename({ status: 'idle' });
      ui.getState().pushToast({ kind: 'success', title: `You're now ${a.name}!`, icon: '✏️' });
    } catch (err) {
      let message = errorText(err);
      if (err instanceof ApiError && err.code === 'name_cooldown') {
        const next = (err.details as { nextAllowedAt?: string } | undefined)?.nextAllowedAt;
        if (next) s.setNameChangeAvailableAt(Date.parse(next));
        message = next
          ? `You renamed recently. Next rename: ${new Date(next).toLocaleDateString()}.`
          : 'You renamed recently. Try again later.';
      } else if (err instanceof ApiError && err.code === 'invalid_name') {
        const reason = (err.details as { reason?: string } | undefined)?.reason;
        message =
          reason === 'profanity' ? "Let's keep names friendly." : 'That name isn’t allowed. Try another.';
      }
      s.setRename({ status: 'error', message });
    }
  }

  /**
   * Deletes the Tumbler. A server account is deleted on the server first and
   * only then wiped from this device; if the server refuses, nothing is lost.
   *
   * @param eraseLocal - Erases a local-only Tumbler (the sign-out path).
   */
  async deleteAccount(eraseLocal: () => Promise<void>): Promise<void> {
    const { api, profile } = this.deps;
    this.publishSession();
    const { session } = accountUi.getState();
    if (session === 'local') {
      await eraseLocal();
      return;
    }
    if (session === 'unreachable') {
      ui.getState().showDialog({
        id: 'delete-failed',
        kind: 'error',
        title: "Couldn't delete your Tumbler",
        body: "The servers can't be reached, so nothing was deleted. Try again when you're online.",
      });
      return;
    }
    accountUi.getState().setPending('deleteAccount');
    try {
      await api.deleteMe();
    } catch (err) {
      accountUi.getState().setPending(null);
      ui.getState().showDialog({
        id: 'delete-failed',
        kind: 'error',
        title: "Couldn't delete your Tumbler",
        body: `Nothing was deleted. ${errorText(err)}`,
        ...(err instanceof ApiError && err.code ? { code: err.code } : {}),
      });
      return;
    }
    api.forget();
    profile.clear();
    this.reload();
  }
}
