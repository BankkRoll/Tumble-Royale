/**
 * The admin console shell: sign-in gate, navigation, hash routing, the
 * confirm dialog and toasts. Views live in `views/`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdminApi, AdminSession } from './api.ts';
import {
  ConfirmDialog,
  ConsoleContext,
  errorMessage,
  type ActionRequest,
  type ConsoleContextValue,
} from './components.tsx';
import { isAdmin, parseRoute, relativeTime, type Route } from './format.ts';
import { AuditView } from './views/AuditView.tsx';
import { LiveOpsView } from './views/LiveOpsView.tsx';
import { PlayersView } from './views/PlayerView.tsx';
import { ReportsView } from './views/ReportsView.tsx';
import { SanctionsView } from './views/SanctionsView.tsx';

/** What the shell needs from the page. */
export interface AdminAppProps {
  api: AdminApi;
  /** The game's player access token for the signed-in account, or null. */
  playerToken(): Promise<string | null>;
  /** Clock (ms); injected for tests. */
  now?: () => number;
  /** Initial hash (tests); defaults to `location.hash`. */
  initialHash?: string;
}

const NAV: { view: Route['view']; label: string; adminOnly?: boolean }[] = [
  { view: 'reports', label: 'Reports' },
  { view: 'players', label: 'Players' },
  { view: 'sanctions', label: 'Sanctions' },
  { view: 'liveops', label: 'Live ops', adminOnly: true },
  { view: 'audit', label: 'Audit log' },
];

/**
 * Sign-in screen: trades the game's signed-in staff account for a console session.
 *
 * @param props.onSignIn - Starts sign-in.
 * @param props.busy - A sign-in is running.
 * @param props.error - Last failure.
 */
export function SignIn(props: { onSignIn(): void; busy: boolean; error: string | null }) {
  return (
    <main className="adm-signin">
      <div className="adm-card">
        <h1>Tumble Royale admin</h1>
        <p>
          Sign in to the game with your staff account (email, Discord or Google, not a guest), then open the
          console here. Sessions last 30 minutes and end when you close this tab.
        </p>
        {props.error && (
          <p className="adm-inline-error" role="alert">
            {props.error}
          </p>
        )}
        <div className="adm-actions">
          <button
            type="button"
            className="adm-btn adm-btn--primary"
            onClick={props.onSignIn}
            disabled={props.busy}
          >
            {props.busy ? 'Signing in…' : 'Open the console'}
          </button>
          <a className="adm-btn adm-btn--ghost" href="/">
            Go to the game
          </a>
        </div>
      </div>
    </main>
  );
}

/** The console. */
export function AdminApp(props: AdminAppProps) {
  const { api } = props;
  const now = props.now ?? Date.now;
  const [session, setSession] = useState<AdminSession | null>(() => api.session);
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(props.initialHash ?? (typeof location === 'undefined' ? '' : location.hash)),
  );
  const [pending, setPending] = useState<ActionRequest | null>(null);
  const [toasts, setToasts] = useState<{ id: number; text: string; tone: 'ok' | 'error' }[]>([]);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => api.onSignedOut(() => setSession(null)), [api]);
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const toast = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const ctx = useMemo<ConsoleContextValue | null>(
    () =>
      session
        ? {
            api,
            actor: session.actor,
            confirm: setPending,
            toast,
            now,
            go: (hash) => {
              if (location.hash === hash) setRoute(parseRoute(hash));
              else location.hash = hash;
            },
          }
        : null,
    [api, session, toast, now],
  );

  const signIn = async () => {
    setSigningIn(true);
    setSignInError(null);
    try {
      setSession(await api.signIn(await props.playerToken()));
    } catch (err) {
      setSignInError(errorMessage(err));
    }
    setSigningIn(false);
  };

  if (!session || !ctx) return <SignIn onSignIn={() => void signIn()} busy={signingIn} error={signInError} />;

  return (
    <ConsoleContext.Provider value={ctx}>
      <a className="adm-skip" href="#adm-main">
        Skip to content
      </a>
      <header className="adm-top">
        <strong className="adm-brand">Tumble Royale admin</strong>
        <nav aria-label="Console sections">
          <ul>
            {NAV.filter((n) => !n.adminOnly || isAdmin(session.actor.role)).map((n) => (
              <li key={n.view}>
                <a href={`#/${n.view}`} aria-current={route.view === n.view ? 'page' : undefined}>
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="adm-who">
          <span title={`Session ends ${relativeTime(session.expiresAt, now())}`}>
            {session.actor.label} · {session.actor.role}
          </span>
          <button type="button" className="adm-btn adm-btn--small" onClick={() => void api.signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main id="adm-main" className="adm-main" tabIndex={-1}>
        {route.view === 'reports' && <ReportsView />}
        {route.view === 'players' && (
          <PlayersView key={route.id ?? route.q ?? ''} id={route.id} q={route.q} />
        )}
        {route.view === 'sanctions' && <SanctionsView />}
        {route.view === 'liveops' && <LiveOpsView />}
        {route.view === 'audit' && <AuditView key={route.target ?? ''} target={route.target} />}
      </main>
      {pending && (
        <ConfirmDialog
          action={pending}
          onClose={(result) => {
            if (result === 'done') toast(pending.done ?? 'Done');
            setPending(null);
          }}
        />
      )}
      <div className="adm-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`adm-toast adm-toast--${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ConsoleContext.Provider>
  );
}
