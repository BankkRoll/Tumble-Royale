/**
 * Account management UI shared by Settings > Account, the Profile tab and the
 * welcome screen.
 *
 * Responsibilities:
 * - inline rename with name rules, cooldown and save feedback;
 * - linked sign-in methods: real linked state, only the methods the server
 *   has turned on, unlink only while another method remains;
 * - "Sign in to an existing Tumbler" (every enabled OAuth provider, email magic link),
 *   hidden entirely when the server offers none;
 * - the email magic-link form and its "check your inbox" state.
 *
 * Nothing here talks to the network: every action is an `accountAction`
 * intent and progress comes back through {@link accountUi}.
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { confirmDeleteAccount, confirmSignOut, confirmUnlink } from '../../components/account.ts';
import { Button } from '../../components/controls.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { validateDisplayName } from '../../names.ts';
import {
  AUTH_PROVIDER_LABELS,
  AUTH_PROVIDERS,
  accountUi,
  enabledProviders,
  useAccountUI,
  type EmailPurpose,
} from '../../store/account.ts';
import { uiEvents } from '../../store/events.ts';
import { useUI } from '../../store/uiStore.ts';

/** Loose shape check; the server does the real validation. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Spinner(): JSX.Element {
  return <span className="tr-gumball-spinner tr-gumball-spinner--sm" aria-label="Working" />;
}

function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="tr-settings-row">
      <div className="tr-col" style={{ gap: '0.1em', minWidth: 0 }}>
        <span>{label}</span>
        {hint && <small className="tr-muted">{hint}</small>}
      </div>
      {children}
    </div>
  );
}

/**
 * Date the next rename unlocks, or null when renaming is allowed now.
 *
 * @param availableAt - Epoch ms from the account (null = now).
 * @param now - Current epoch ms.
 */
export function renameLockedUntil(availableAt: number | null, now: number): Date | null {
  return availableAt !== null && availableAt > now ? new Date(availableAt) : null;
}

// -----------------------------------------------------------------------------
// Rename
// -----------------------------------------------------------------------------

/** Props for {@link RenameField}. */
export interface RenameFieldProps {
  /** Prefix for `data-testid`s so two instances on one screen stay distinct. */
  testId?: string;
}

/**
 * The display name with an inline rename editor. Online renames honour the
 * server cooldown; a local-only Tumbler renames instantly.
 */
export function RenameField({ testId = 'rename' }: RenameFieldProps): JSX.Element {
  const profile = useUI((s) => s.profile);
  const rename = useAccountUI((s) => s.rename);
  const session = useAccountUI((s) => s.session);
  const availableAt = useAccountUI((s) => s.nameChangeAvailableAt);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // The game reports back through the store: close on success, keep the editor open on failure.
  useEffect(() => {
    if (!submitted || rename.status === 'saving') return;
    setSubmitted(false);
    if (rename.status === 'idle') setEditing(false);
    else setError(rename.message ?? "Couldn't rename");
  }, [rename, submitted]);

  const name = profile?.name ?? 'Guest';
  const lockedUntil = session === 'online' ? renameLockedUntil(availableAt, Date.now()) : null;
  const saving = rename.status === 'saving';

  const save = (): void => {
    const next = draft.trim();
    if (next === name) {
      setEditing(false);
      return;
    }
    const err = validateDisplayName(next);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setSubmitted(true);
    accountUi.getState().setRename({ status: 'saving' });
    uiEvents.emit('accountAction', { action: 'rename', value: next });
  };

  if (!editing) {
    return (
      <div className="tr-account-rename">
        <span className="tr-account-name">
          <b className="tr-ellipsis">{name}</b>
          {profile && <small className="tr-muted">#{profile.tag}</small>}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={!profile || lockedUntil !== null}
          data-testid={`${testId}-edit`}
          title={lockedUntil ? `You can rename again on ${lockedUntil.toLocaleDateString()}` : undefined}
          onClick={() => {
            setDraft(name);
            setError(null);
            setEditing(true);
          }}
        >
          Rename
        </Button>
        {lockedUntil && (
          <small className="tr-muted tr-account-note" data-testid={`${testId}-cooldown`}>
            Next rename {lockedUntil.toLocaleDateString()}
          </small>
        )}
      </div>
    );
  }

  return (
    <div className="tr-account-rename is-editing">
      <input
        className="tr-input"
        maxLength={16}
        value={draft}
        aria-label="New display name"
        aria-invalid={error !== null}
        data-nav=""
        data-autofocus=""
        data-testid={`${testId}-input`}
        disabled={saving}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <span className="tr-row">
        <Button size="sm" variant="go" disabled={saving} data-testid={`${testId}-save`} onClick={save}>
          {saving ? <Spinner /> : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </span>
      {error ? (
        <span className="tr-field-error" role="alert">
          {error}
        </span>
      ) : (
        session === 'online' && (
          <small className="tr-muted tr-account-note">
            {availableAt === null
              ? 'Your first rename is free. After that you can rename once a month.'
              : 'After this you can rename again in a month.'}
          </small>
        )
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Email magic link
// -----------------------------------------------------------------------------

/**
 * Email address form for a magic link, then the "check your inbox" state.
 *
 * @param purpose - Link email to this Tumbler, or sign in to another one.
 */
export function EmailLinkForm({
  purpose,
  onCancel,
}: {
  purpose: EmailPurpose;
  onCancel?: () => void;
}): JSX.Element {
  const flow = useAccountUI((s) => s.emailFlow);
  const [address, setAddress] = useState(flow.status === 'idle' ? '' : flow.address);
  const [error, setError] = useState<string | null>(null);
  const mine = flow.status !== 'idle' && flow.purpose === purpose;

  if (mine && flow.status === 'sent') {
    return (
      <div className="tr-account-email is-sent" role="status" data-testid={`email-${purpose}-sent`}>
        <b>Check your inbox</b>
        <small>
          We sent a link to <b>{flow.address}</b>. Open it in this browser to{' '}
          {purpose === 'link' ? 'add email to this Tumbler' : 'sign in'}. It expires in 15 minutes.
        </small>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => accountUi.getState().setEmailFlow({ status: 'idle' })}
        >
          Use a different address
        </Button>
      </div>
    );
  }

  const sending = mine && flow.status === 'sending';
  const shownError = error ?? (mine && flow.status === 'error' ? flow.message : null);
  const send = (): void => {
    const a = address.trim();
    if (!EMAIL_RE.test(a)) {
      setError('That email address doesn’t look right.');
      return;
    }
    setError(null);
    accountUi.getState().setEmailFlow({ status: 'sending', purpose, address: a });
    uiEvents.emit('accountAction', { action: purpose === 'link' ? 'link-email' : 'signIn-email', value: a });
  };

  return (
    <div className="tr-account-email">
      <span className="tr-row">
        <input
          className="tr-input"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@example.com"
          aria-label="Email address"
          aria-invalid={shownError !== null}
          maxLength={254}
          value={address}
          disabled={sending}
          data-nav=""
          data-testid={`email-${purpose}-input`}
          onChange={(e) => {
            setAddress(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
        />
        <Button size="sm" variant="primary" disabled={sending} onClick={send}>
          {sending ? <Spinner /> : 'Send link'}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" disabled={sending} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </span>
      {shownError && (
        <span className="tr-field-error" role="alert">
          {shownError}
        </span>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Linked sign-in methods
// -----------------------------------------------------------------------------

/**
 * One row per sign-in method the server offers (plus any already linked):
 * a "Linked" chip with Unlink, or a Link button.
 */
export function LinkedAccounts(): JSX.Element {
  const profile = useUI((s) => s.profile);
  const providers = useAccountUI((s) => s.providers);
  const session = useAccountUI((s) => s.session);
  const pending = useAccountUI((s) => s.pending);
  const [emailOpen, setEmailOpen] = useState(false);
  const linked = AUTH_PROVIDERS.filter((p) => profile?.linkedProviders?.includes(p));
  const shown = AUTH_PROVIDERS.filter((p) => linked.includes(p) || providers?.[p]);

  if (session !== 'online') {
    return (
      <p className="tr-small tr-muted" data-testid="linked-offline">
        {session === 'unreachable'
          ? "Can't reach the servers right now, so logins can't be changed. Your Tumbler is safe."
          : "Accounts are offline, so this Tumbler is saved on this device only. Signing out or clearing this browser's data erases it."}
      </p>
    );
  }
  if (shown.length === 0 && providers === null) {
    return (
      <p className="tr-small tr-muted" data-testid="linked-unknown">
        Couldn't check which logins this server offers. Try again in a moment.
      </p>
    );
  }
  if (shown.length === 0) {
    return (
      <p className="tr-small tr-muted" data-testid="linked-none">
        This server doesn't offer any sign-in methods yet, so your Tumbler is saved to this device's guest
        login. Signing out or clearing this browser's data erases it.
      </p>
    );
  }
  return (
    <div className="tr-account-methods" data-testid="linked-accounts">
      {shown.map((p) => {
        const isLinked = linked.includes(p);
        const lastOne = isLinked && linked.length === 1;
        const busy = pending === `unlink-${p}` || pending === `link-${p}`;
        return (
          <div key={p} className="tr-account-method" data-testid={`method-${p}`}>
            <span className="tr-account-method-name">{AUTH_PROVIDER_LABELS[p]}</span>
            {isLinked ? (
              <>
                <span className="tr-chip tr-chip--mint">
                  <Icon name="check" size="0.9em" />
                  Linked
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={lastOne || busy}
                  title={lastOne ? 'Link another login first so you can still sign in' : undefined}
                  onClick={() => confirmUnlink(p)}
                >
                  {busy ? <Spinner /> : 'Unlink'}
                </Button>
              </>
            ) : providers?.[p] ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  p === 'email'
                    ? setEmailOpen((o) => !o)
                    : uiEvents.emit('accountAction', { action: `link-${p}` })
                }
              >
                {busy ? <Spinner /> : 'Link'}
              </Button>
            ) : (
              <small className="tr-muted">Unavailable on this server</small>
            )}
          </div>
        );
      })}
      {emailOpen && !linked.includes('email') && (
        <EmailLinkForm purpose="link" onCancel={() => setEmailOpen(false)} />
      )}
      {linked.length === 1 && (
        <small className="tr-muted">Link a second login before you can unlink this one.</small>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Sign in to an existing Tumbler
// -----------------------------------------------------------------------------

/**
 * Buttons for every enabled sign-in method, to move an existing Tumbler onto
 * this device. Renders nothing when the server offers none.
 */
export function SignInOptions(): JSX.Element | null {
  const providers = useAccountUI((s) => s.providers);
  const pending = useAccountUI((s) => s.pending);
  const [emailOpen, setEmailOpen] = useState(false);
  const enabled = enabledProviders(providers);
  if (enabled.length === 0) return null;
  return (
    <div className="tr-account-signin" data-testid="sign-in-options">
      <div className="tr-row tr-wrap">
        {enabled.map((p) => (
          <Button
            key={p}
            size="sm"
            variant="secondary"
            disabled={pending !== null}
            data-testid={`sign-in-${p}`}
            onClick={() =>
              p === 'email'
                ? setEmailOpen((o) => !o)
                : uiEvents.emit('accountAction', { action: `signIn-${p}` })
            }
          >
            {pending === `signIn-${p}` ? <Spinner /> : AUTH_PROVIDER_LABELS[p]}
          </Button>
        ))}
      </div>
      {emailOpen && <EmailLinkForm purpose="signIn" onCancel={() => setEmailOpen(false)} />}
    </div>
  );
}

/**
 * "Sign in to an existing Tumbler" link for the welcome screen: expands into
 * {@link SignInOptions}. Hidden when the server offers no sign-in methods.
 */
export function WelcomeSignIn(): JSX.Element | null {
  const providers = useAccountUI((s) => s.providers);
  const [open, setOpen] = useState(false);
  if (enabledProviders(providers).length === 0) return null;
  return (
    <div className="tr-welcome-signin">
      <Button
        size="sm"
        variant="ghost"
        block
        aria-expanded={open}
        data-testid="welcome-sign-in"
        onClick={() => setOpen((o) => !o)}
      >
        Sign in to an existing Tumbler
      </Button>
      {open && (
        <div className="tr-col tr-enter-fade" style={{ gap: '0.5em' }}>
          <small className="tr-muted">Playing on another device? Use a login you linked there.</small>
          <SignInOptions />
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Settings > Account
// -----------------------------------------------------------------------------

/** The whole Account section of the Settings sheet. */
export function AccountSection(): JSX.Element {
  const profile = useUI((s) => s.profile);
  const providers = useAccountUI((s) => s.providers);
  const session = useAccountUI((s) => s.session);
  const deleting = useAccountUI((s) => s.pending === 'deleteAccount');
  const signInAvailable = session === 'online' && enabledProviders(providers).length > 0;
  return (
    <>
      <SettingsRow label="Display name">
        <RenameField testId="settings-rename" />
      </SettingsRow>
      <SettingsRow
        label="Logins"
        hint={
          profile?.isGuest && session === 'online' && enabledProviders(providers).length > 0
            ? 'Link one to keep your Tumbler safe and play it on other devices.'
            : undefined
        }
      >
        <LinkedAccounts />
      </SettingsRow>
      {signInAvailable && (
        <SettingsRow
          label="Sign in to an existing Tumbler"
          hint={
            profile?.isGuest
              ? "Replaces this device's guest Tumbler. We'll ask before anything is lost."
              : 'Switches this device to another Tumbler.'
          }
        >
          <SignInOptions />
        </SettingsRow>
      )}
      <SettingsRow label="Sign out">
        <Button size="sm" variant="secondary" data-testid="sign-out" onClick={confirmSignOut}>
          Sign out
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Delete Tumbler"
        hint={
          session === 'local'
            ? 'Erases it from this device. Gone forever, like a Tumbler in the goo.'
            : 'Deletes it from our servers and this device. Gone forever, like a Tumbler in the goo.'
        }
      >
        <Button
          size="sm"
          variant="danger"
          disabled={deleting}
          data-testid="delete-account"
          onClick={confirmDeleteAccount}
        >
          Delete…
        </Button>
      </SettingsRow>
    </>
  );
}
