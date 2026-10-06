/**
 * Account sign-in methods and lifecycle on the client.
 *
 * Responsibilities:
 * - publish which sign-in methods the server offers (`GET /auth/providers`)
 *   and where this device's Tumbler lives, for the account UI;
 * - finish OAuth (`/auth/complete`), email (`/auth/email`) and staff link
 *   (`/auth/staff`) returns on boot: trade the code/token for a session, clean
 *   the URL, and adopt the session, asking first when that would abandon an
 *   unbacked-up guest Tumbler; a staff link then opens the admin console;
 * - start linking and "sign in to an existing Tumbler" (every OAuth provider
 *   the server enables, email magic links), unlink methods, rename and delete
 *   the account.
 *
 * The guest-only path never needs any of this: with no methods enabled the
 * UI hides them and a Tumbler simply lives on the device.
 */
import {
  AUTH_PROVIDERS,
  accountUi,
  ui,
  uiEvents,
  type AuthProviderId,
  type AuthProviders,
  type DialogSpec,
  type TumblerColors,
} from '@tumble/ui';
import { ApiError, type ApiAuthResult, type ApiClient } from '../api.ts';
import type { ProfileStore } from '../profile.ts';
import { loadJson, storageKeyName } from '../storage.ts';
import { beginBinding, clearBinding, pendingNonce } from './browserBinding.ts';
import type { OnlineAccount } from './account.ts';
import {
  PROVIDER_LABELS,
  authErrorMessage,
  cleanReturnUrl,
  outcomeMessage,
  parseBootReturn,
  tokenSubject,
  type BootReturn,
  type LoginProvider,
  type OAuthProvider,
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
    deps.api.onExpired(() => {
      deps.account?.endExpiredSession();
      this.publishSession();
      ui.getState().pushToast({
        kind: 'error',
        title: 'Your session expired',
        body: 'Sign in again (Settings → Account) to get back to your Tumbler. Nothing on it was lost.',
        icon: '🔒',
        durationMs: 10_000,
      });
    });
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
    if (ret.kind === 'checkout') return;
    // SECURITY: a code or magic link is only redeemed by the browser that
    // asked for it; one that arrives without a pending sign-in here was
    // forwarded (or is stale) and must not sign this device in to anything.
    const nonce = ret.kind === 'staffLink' ? null : pendingNonce();
    if (ret.kind !== 'staffLink' && !nonce) {
      this.toastError('browser_mismatch', ret.kind === 'email' ? 'email' : ret.provider);
      return;
    }
    let result: ApiAuthResult;
    try {
      result =
        ret.kind === 'oauth'
          ? await api.exchangeCode(ret.code, nonce!)
          : ret.kind === 'email'
            ? await api.verifyEmail(ret.token, nonce!)
            : await api.verifyStaffLink(ret.token);
      if (nonce) clearBinding();
    } catch (err) {
      const code = err instanceof ApiError ? (err.status === 0 ? 'network' : err.code) : 'unknown';
      if (ret.kind === 'staffLink') this.toastError(code === 'invalid_token' ? 'invalid_link' : code, null);
      else this.toastError(code, ret.kind === 'email' ? 'email' : ret.provider);
      return;
    }
    const adopted = await this.adopt(result);
    // The console signs in with this browser's game session, which now exists.
    if (adopted && ret.kind === 'staffLink') this.navigate('/admin');
  }

  /** Re-reads `GET /auth/providers` (null while the API is unreachable). */
  async refreshProviders(): Promise<void> {
    try {
      const p = await this.deps.api.authProviders();
      accountUi
        .getState()
        .setProviders(Object.fromEntries(AUTH_PROVIDERS.map((id) => [id, p[id] === true])) as AuthProviders);
    } catch {
      accountUi.getState().setProviders(null);
    }
  }

  /** Publishes where the Tumbler lives and the rename cooldown, after any connect attempt. */
  publishSession(): void {
    const a = this.online;
    const s = accountUi.getState();
    const api = this.deps.api;
    s.setSession(a ? 'online' : api.expired ? 'expired' : api.signedIn ? 'unreachable' : 'local');
    const at = a?.me?.nameChangeAvailableAt;
    s.setNameChangeAvailableAt(at ? Date.parse(at) : null);
  }

  /**
   * Moves the device onto a session from a completed sign-in. The same
   * account just takes the fresh tokens; another account replaces the local
   * Tumbler only after the player confirms, with a stronger warning when that
   * Tumbler has no other way back.
   *
   * @returns False when the player kept the Tumbler already on this device.
   */
  private async adopt(result: ApiAuthResult): Promise<boolean> {
    const { api, profile } = this.deps;
    const name = result.user.displayName;
    const current = api.currentUserId();
    if (current === result.user.id) {
      api.adoptSession(result, true);
      this.toastOutcome(result);
      return true;
    }
    const here = await this.currentTumbler();
    if (here) {
      const whose =
        result.provider === 'link'
          ? 'That sign-in link is for'
          : `That ${PROVIDER_LABELS[result.provider]} login belongs to`;
      const fate = here.atRisk
        ? `${here.name}, the Tumbler on this device now, isn't linked to any login, so its items, Crowns and progress will be gone for good.`
        : `${here.name} stays safe on its own login; sign back in to it any time.`;
      const pick = await choose({
        id: 'auth-switch',
        kind: 'confirm',
        title: `Sign in as ${name}#${result.user.tag}?`,
        body: `${whose} ${name}#${result.user.tag}. Switching puts ${name} on this device. ${fate}`,
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
          body: here.atRisk
            ? 'Nothing changed. Link a login in Settings first if you want to keep both.'
            : 'Nothing changed.',
          icon: '🔒',
        });
        return false;
      }
    }
    // Revoke the old session rather than leaving a live refresh token behind for a Tumbler this device no longer shows.
    await api.signOut();
    api.adoptSession(result, false);
    profile.clear();
    profile.create(name, ADOPTED_COLORS);
    profile.answerTutorial();
    this.toastOutcome(result);
    return true;
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
    const m =
      result.provider === 'link'
        ? { title: `Signed in as ${result.user.displayName}`, body: 'Opening the admin console…' }
        : outcomeMessage(result.outcome, result.provider, result.user.displayName);
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
    const m = /^(link|signIn|unlink)-([a-z]+)$/.exec(action);
    if (!m || !(AUTH_PROVIDERS as readonly string[]).includes(m[2]!)) return;
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
   * Leaves for an OAuth provider. Signed in, the account goes along: a new
   * identity is linked to it; one owned by another Tumbler is refused when
   * linking from Settings, or switched to when signing in to an existing
   * Tumbler. Signed out (welcome screen) it is a plain sign-in.
   */
  private async startOAuth(verb: 'link' | 'signIn', provider: OAuthProvider): Promise<void> {
    if (verb === 'link' && this.needsOnline()) return;
    const s = accountUi.getState();
    s.setPending(`${verb}-${provider}`);
    try {
      const binding = await beginBinding();
      const { url } = await this.deps.api.startOAuth(provider, this.online !== null, verb, binding);
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
      await this.deps.api.startEmail(address, this.online !== null, verb, await beginBinding());
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
   * The magic link usually opens in a new tab, which redeems it and clears
   * the pending binding. Only that event counts (routine token refreshes in
   * other tabs also write the session): a link to this same account just
   * refreshes what this tab shows, a sign-in to another account reloads so
   * the tab shows that Tumbler. The listener is removed after one sign-in.
   */
  private watchOtherTab(): void {
    if (this.watchingOtherTab) return;
    this.watchingOtherTab = true;
    const before = this.deps.api.currentUserId();
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== storageKeyName('authBinding') || e.newValue !== null) return;
      if (accountUi.getState().emailFlow.status !== 'sent') return;
      window.removeEventListener('storage', onStorage);
      this.watchingOtherTab = false;
      const stored = loadJson<{ accessToken?: string }>('auth');
      if (tokenSubject(stored?.accessToken) !== before) {
        this.reload();
        return;
      }
      accountUi.getState().setEmailFlow({ status: 'idle' });
      void this.online?.refreshProgress();
    };
    window.addEventListener('storage', onStorage);
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
    if (session === 'unreachable' || session === 'expired') {
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
