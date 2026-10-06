/**
 * Building blocks shared by the console views: the console context, data
 * loading, the confirm-with-reason dialog, status blocks, badges and paging.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AdminApiError, type AdminApi } from './api.ts';
import type { DurationOption } from './format.ts';
import type { StaffActorView } from './types.ts';

// -----------------------------------------------------------------------------
// Context
// -----------------------------------------------------------------------------

/** A destructive or audited action waiting for confirmation. */
export interface ActionRequest {
  title: string;
  /** What will happen, in a sentence or two. */
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Whether the reason box is required (default), optional or hidden. */
  reason?: 'required' | 'optional' | 'none';
  /** Offer a length; the first option is preselected. */
  durations?: readonly DurationOption[];
  /** Performs the action; a thrown error is shown in the dialog. */
  run(reason: string, hours: number | null): Promise<void>;
  /** Toast shown after success. */
  done?: string;
}

/** What every view gets from the shell. */
export interface ConsoleContextValue {
  api: AdminApi;
  actor: StaffActorView;
  /** Asks for confirmation (and a reason), then runs the action. */
  confirm(action: ActionRequest): void;
  /** Shows a short status message. */
  toast(text: string, tone?: 'ok' | 'error'): void;
  /** Navigates to a hash route. */
  go(hash: string): void;
  /** Clock (injected for tests). */
  now(): number;
}

/** The console context. */
export const ConsoleContext = createContext<ConsoleContextValue | null>(null);

/**
 * The console context; throws outside the shell.
 *
 * @returns Shared services for views.
 */
export function useConsole(): ConsoleContextValue {
  const c = useContext(ConsoleContext);
  if (!c) throw new Error('useConsole outside ConsoleContext');
  return c;
}

/**
 * Human message for a failed request.
 *
 * @param err - Thrown value.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof AdminApiError) {
    if (err.code === 'invalid_request' && Array.isArray(err.details) && err.details.length) {
      const first = err.details[0] as { path?: string; message?: string };
      return `${err.message}: ${first.path ? `${first.path} ` : ''}${first.message ?? ''}`.trim();
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

// -----------------------------------------------------------------------------
// Data loading
// -----------------------------------------------------------------------------

/** State of a {@link useLoad} request. */
export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/**
 * The state as a load starts. A new key (another filter, another player)
 * drops the old data, so its rows never show under the new filter, nor stay
 * on screen when that load fails; a reload of the same key keeps them up.
 *
 * @param prev - State before the load.
 * @param keyChanged - The load is for a different key.
 * @returns State while loading.
 */
export function loadStarting<T>(
  prev: { data: T | null; error: string | null; loading: boolean },
  keyChanged: boolean,
): { data: T | null; error: string | null; loading: boolean } {
  return keyChanged ? { data: null, error: null, loading: true } : { ...prev, loading: true, error: null };
}

/**
 * Loads data when `key` changes; stale answers from an older key are ignored.
 *
 * @param key - Identity of the request (URL); null skips loading.
 * @param load - Fetches the data.
 */
export function useLoad<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: key !== null,
  });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (key === null) {
      loadedKey.current = null;
      setState({ data: null, error: null, loading: false });
      return;
    }
    let live = true;
    const keyChanged = loadedKey.current !== key;
    loadedKey.current = key;
    setState((s) => loadStarting(s, keyChanged));
    loadRef.current().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (err: unknown) => live && setState((s) => ({ ...s, error: errorMessage(err), loading: false })),
    );
    return () => {
      live = false;
    };
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// -----------------------------------------------------------------------------
// Status blocks
// -----------------------------------------------------------------------------

/**
 * Loading, error and empty states around a view's content.
 *
 * @param props.state - Load state.
 * @param props.empty - Message when `isEmpty` holds.
 * @param props.isEmpty - Whether the loaded data is empty.
 * @param props.children - Rendered once data is present.
 */
export function StateBlock<T>(props: {
  state: Loaded<T>;
  empty: string;
  isEmpty: (data: T) => boolean;
  children: (data: T) => ReactNode;
}): ReactNode {
  const { state } = props;
  if (state.error && !state.data)
    return (
      <div className="adm-state adm-state--error" role="alert">
        <p>{state.error}</p>
        <button type="button" className="adm-btn" onClick={state.reload}>
          Try again
        </button>
      </div>
    );
  if (!state.data)
    return (
      <div className="adm-state" role="status" aria-live="polite">
        <span className="adm-spinner" aria-hidden="true" /> Loading…
      </div>
    );
  return (
    <>
      {state.loading && (
        <p className="adm-inline-status" role="status" aria-live="polite">
          <span className="adm-spinner" aria-hidden="true" /> Refreshing…
        </p>
      )}
      {state.error && (
        <p className="adm-inline-error" role="alert">
          Refresh failed: {state.error}
        </p>
      )}
      {props.isEmpty(state.data) ? (
        <div className="adm-state">{props.empty}</div>
      ) : (
        props.children(state.data)
      )}
    </>
  );
}

/**
 * A small coloured label.
 *
 * @param props.tone - Colour.
 */
export function Badge(props: {
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`adm-badge adm-badge--${props.tone ?? 'neutral'}`} title={props.title}>
      {props.children}
    </span>
  );
}

/**
 * Previous / next paging with a range label.
 *
 * @param props.offset - First row shown.
 * @param props.limit - Page size.
 * @param props.total - Total rows, when known.
 * @param props.count - Rows on this page.
 * @param props.onPage - New offset.
 */
export function Pager(props: {
  offset: number;
  limit: number;
  count: number;
  total?: number;
  onPage(offset: number): void;
}) {
  const { offset, limit, count, total } = props;
  const end = offset + count;
  const hasNext = total === undefined ? count === limit : end < total;
  return (
    <nav className="adm-pager" aria-label="Pages">
      <span>
        {count === 0 ? 'No rows' : `${offset + 1}–${end}`}
        {total !== undefined ? ` of ${total}` : ''}
      </span>
      <button
        type="button"
        className="adm-btn"
        disabled={offset === 0}
        onClick={() => props.onPage(Math.max(0, offset - limit))}
      >
        Previous
      </button>
      <button
        type="button"
        className="adm-btn"
        disabled={!hasNext}
        onClick={() => props.onPage(offset + limit)}
      >
        Next
      </button>
    </nav>
  );
}

// -----------------------------------------------------------------------------
// Confirm dialog
// -----------------------------------------------------------------------------

/**
 * Modal confirmation with an optional reason and length. Uses a native
 * `<dialog>` so focus stays inside and Escape cancels.
 *
 * @param props.action - What to confirm.
 * @param props.onClose - Called after success (with the toast text) or cancel.
 */
export function ConfirmDialog(props: { action: ActionRequest; onClose(result: 'done' | 'cancel'): void }) {
  const { action } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const reasonMode = action.reason ?? 'required';
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState<number | null>(action.durations?.[0]?.hours ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open && typeof d.showModal === 'function') d.showModal();
  }, []);

  const reasonOk = reasonMode !== 'required' || reason.trim().length >= 3;
  const submit = async () => {
    if (!reasonOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      await action.run(reason.trim(), hours);
      props.onClose('done');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className="adm-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) props.onClose('cancel');
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id={`${id}-title`}>{action.title}</h2>
        <div className="adm-dialog__body">{action.body}</div>
        {action.durations && (
          <label className="adm-field">
            <span>Length</span>
            <select
              value={hours === null ? 'permanent' : String(hours)}
              onChange={(e) => setHours(e.target.value === 'permanent' ? null : Number(e.target.value))}
            >
              {action.durations.map((d) => (
                <option key={d.label} value={d.hours === null ? 'permanent' : String(d.hours)}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {reasonMode !== 'none' && (
          <label className="adm-field">
            <span>
              Reason {reasonMode === 'required' ? '(required, kept in the audit log)' : '(optional)'}
            </span>
            <textarea
              rows={3}
              maxLength={500}
              value={reason}
              autoFocus
              required={reasonMode === 'required'}
              minLength={reasonMode === 'required' ? 3 : undefined}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="adm-inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="adm-dialog__actions">
          <button type="button" className="adm-btn" disabled={busy} onClick={() => props.onClose('cancel')}>
            Cancel
          </button>
          <button
            type="submit"
            className={`adm-btn ${action.danger ? 'adm-btn--danger' : 'adm-btn--primary'}`}
            disabled={!reasonOk || busy}
          >
            {busy ? 'Working…' : action.confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * A link to a player's page.
 *
 * @param props.id - Account id.
 * @param props.label - Text.
 */
export function PlayerLink(props: { id: string; label: string }) {
  return (
    <a className="adm-link" href={`#/players/${encodeURIComponent(props.id)}`}>
      {props.label}
    </a>
  );
}
