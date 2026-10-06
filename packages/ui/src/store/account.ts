/**
 * Account management state (sign-in methods, email links, rename, deletion),
 * kept out of the main UI store so the account screens can evolve on their own.
 *
 * Responsibilities:
 * - which sign-in methods the server has turned on (`GET /auth/providers`);
 * - whether this device has a server account and whether it is reachable;
 * - progress of the email magic-link flow, renames and other pending actions.
 *
 * The game writes it with `accountUi.getState().set…()`; components read it
 * with {@link useAccountUI}. Intents still go out through `accountAction`.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

/** Sign-in methods a server can offer besides the device guest. */
export type AuthProviderId = 'discord' | 'google' | 'github' | 'twitch' | 'apple' | 'email';

/** Every portable sign-in method, in display order. */
export const AUTH_PROVIDERS: readonly AuthProviderId[] = [
  'discord',
  'google',
  'github',
  'twitch',
  'apple',
  'email',
];

/** Display names for sign-in methods. */
export const AUTH_PROVIDER_LABELS: Record<AuthProviderId, string> = {
  discord: 'Discord',
  google: 'Google',
  github: 'GitHub',
  twitch: 'Twitch',
  apple: 'Apple',
  email: 'Email',
};

/** Which methods `GET /auth/providers` reports as configured. */
export type AuthProviders = Record<AuthProviderId, boolean>;

/**
 * Where this device's Tumbler lives:
 * - `local`: only on this device (no server account, or accounts are off);
 * - `online`: a server account that is signed in and reachable;
 * - `unreachable`: a server account exists but the server can't be reached;
 * - `expired`: a server account exists but this browser must sign in to it again.
 */
export type AccountSession = 'local' | 'online' | 'unreachable' | 'expired';

/** What an email link is for: adding email to this Tumbler, or signing in to another. */
export type EmailPurpose = 'link' | 'signIn';

/** Progress of the email magic-link flow. */
export type EmailFlow =
  | { status: 'idle' }
  | { status: 'sending' | 'sent'; purpose: EmailPurpose; address: string }
  | { status: 'error'; purpose: EmailPurpose; address: string; message: string };

/** Progress of a rename. */
export interface RenameState {
  status: 'idle' | 'saving' | 'error';
  /** Why the last rename failed. */
  message?: string;
}

/** An account action waiting on the server (buttons show a spinner and disable). */
export type PendingAccountAction =
  `link-${AuthProviderId}` | `signIn-${AuthProviderId}` | `unlink-${AuthProviderId}` | 'deleteAccount';

/** Account management state. */
export interface AccountUIState {
  /** Enabled sign-in methods; null while unknown (offline or not asked yet). */
  providers: AuthProviders | null;
  session: AccountSession;
  emailFlow: EmailFlow;
  rename: RenameState;
  /** Epoch ms when the next online rename is allowed; null = now. */
  nameChangeAvailableAt: number | null;
  pending: PendingAccountAction | null;

  setProviders: (providers: AuthProviders | null) => void;
  setSession: (session: AccountSession) => void;
  setEmailFlow: (flow: EmailFlow) => void;
  setRename: (rename: RenameState) => void;
  setNameChangeAvailableAt: (at: number | null) => void;
  setPending: (pending: PendingAccountAction | null) => void;
}

/** The account management store. */
export const accountUi = createStore<AccountUIState>()((set) => ({
  providers: null,
  session: 'local',
  emailFlow: { status: 'idle' },
  rename: { status: 'idle' },
  nameChangeAvailableAt: null,
  pending: null,
  setProviders: (providers) => set({ providers }),
  setSession: (session) => set({ session }),
  setEmailFlow: (emailFlow) => set({ emailFlow }),
  setRename: (rename) => set({ rename }),
  setNameChangeAvailableAt: (nameChangeAvailableAt) => set({ nameChangeAvailableAt }),
  setPending: (pending) => set({ pending }),
}));

/**
 * React hook over {@link accountUi}.
 *
 * @param selector - Picks the slice the component renders.
 * @example
 * const providers = useAccountUI((s) => s.providers);
 */
export function useAccountUI<T>(selector: (s: AccountUIState) => T): T {
  return useStore(accountUi, selector);
}

/**
 * The sign-in methods the server has turned on, in display order.
 *
 * @param providers - `GET /auth/providers` result, or null when unknown.
 * @returns Enabled methods; empty when none are (or the server is unknown).
 */
export function enabledProviders(providers: AuthProviders | null): AuthProviderId[] {
  return providers ? AUTH_PROVIDERS.filter((p) => providers[p]) : [];
}
