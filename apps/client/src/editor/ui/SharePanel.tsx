/**
 * Sharing: publish (or update) the round under a share code, manage "My
 * rounds", open someone's round by code (read-only until copied) and report
 * a shared round.
 */
import { useEffect, useState, type JSX } from 'react';
import type { RoundReportReason, SharedRoundSummary } from '../store.ts';
import { Section, useActions, useEditor, useFieldId } from './kit.tsx';

const REASONS: { id: RoundReportReason; label: string }[] = [
  { id: 'offensive', label: 'Offensive words or shapes' },
  { id: 'broken', label: 'Broken or impossible' },
  { id: 'spam', label: 'Spam' },
  { id: 'copied', label: 'Copied from someone else' },
  { id: 'other', label: 'Something else' },
];

const STATUS: Record<SharedRoundSummary['status'], string> = {
  published: 'Shared',
  unpublished: 'Hidden',
  taken_down: 'Removed by moderators',
};

/** Publish button and the current code. */
export function PublishBox(props: { signedIn: boolean }): JSX.Element {
  const code = useEditor((s) => s.sharedCode);
  const errors = useEditor((s) => s.validation.issues.some((i) => i.severity === 'error'));
  const busy = useEditor((s) => s.busy);
  const { publish } = useActions();
  return (
    <Section title="Share">
      {code ? (
        <p className="ed-code" data-testid="share-code">
          Code <strong>{code}</strong>
          <button type="button" className="ed-chip" onClick={() => void navigator.clipboard?.writeText(code)}>
            Copy
          </button>
        </p>
      ) : (
        <p className="ed-hint">
          Sharing gives your round a code anyone can open here or pick in a private show.
        </p>
      )}
      {!props.signedIn ? (
        <p className="ed-hint">Sign in from the game first. Guest accounts cannot share.</p>
      ) : null}
      <button
        type="button"
        className="ed-btn ed-btn--go"
        disabled={!props.signedIn || errors || busy}
        title={errors ? 'Fix the errors in Checks first' : undefined}
        onClick={() => void publish()}
      >
        {code ? 'Update shared round' : 'Share round'}
      </button>
      {errors ? <p className="ed-field-error">Fix the errors in Checks before sharing.</p> : null}
    </Section>
  );
}

/** The player's shared rounds. */
export function MyRounds(): JSX.Element | null {
  const shared = useEditor((s) => s.shared);
  const { setSharedPublished, deleteShared, loadByCode } = useActions();
  const [confirm, setConfirm] = useState<string | null>(null);
  if (!shared) return null;
  return (
    <Section title="My rounds">
      {shared.length === 0 ? <p className="ed-hint">Nothing shared yet.</p> : null}
      <ul className="ed-list">
        {shared.map((r) => (
          <li key={r.code} className="ed-list-row">
            <div>
              <strong>{r.name}</strong> <code>{r.code}</code>
              <div className={`ed-status ed-status--${r.status}`}>
                {STATUS[r.status]}
                {r.status === 'taken_down' && r.takedownReason ? `: ${r.takedownReason}` : ''}
              </div>
            </div>
            <div className="ed-chips">
              <button type="button" className="ed-chip" onClick={() => void loadByCode(r.code)}>
                Open
              </button>
              {r.status === 'published' ? (
                <button
                  type="button"
                  className="ed-chip"
                  onClick={() => void setSharedPublished(r.code, false)}
                >
                  Hide
                </button>
              ) : null}
              {r.status === 'unpublished' ? (
                <button
                  type="button"
                  className="ed-chip"
                  onClick={() => void setSharedPublished(r.code, true)}
                >
                  Share again
                </button>
              ) : null}
              {r.status !== 'taken_down' ? (
                confirm === r.code ? (
                  <button
                    type="button"
                    className="ed-chip ed-chip--danger"
                    onClick={() => {
                      setConfirm(null);
                      void deleteShared(r.code);
                    }}
                  >
                    Delete for good
                  </button>
                ) : (
                  <button type="button" className="ed-chip" onClick={() => setConfirm(r.code)}>
                    Delete
                  </button>
                )
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Open by code, and the banner while viewing someone's round. */
export function OpenByCode(): JSX.Element {
  const viewing = useEditor((s) => s.viewing);
  const busy = useEditor((s) => s.busy);
  const { loadByCode, makeCopy, reportShared } = useActions();
  const [code, setCode] = useState('');
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState<RoundReportReason>('offensive');
  const [details, setDetails] = useState('');
  const id = useFieldId('open-code');
  const reasonId = useFieldId('report-reason');
  return (
    <Section title="Open a shared round">
      <form
        className="ed-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void loadByCode(code).then((ok) => ok && setCode(''));
        }}
      >
        <label htmlFor={id} className="ed-sr">
          Share code
        </label>
        <input
          id={id}
          className="ed-input"
          value={code}
          maxLength={12}
          placeholder="Share code"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="ed-btn" disabled={busy || code.trim() === ''}>
          Open
        </button>
      </form>
      {viewing ? (
        <div className="ed-viewing" data-testid="viewing-banner">
          <p>
            Viewing <code>{viewing.code}</code>
            {viewing.author ? ` by ${viewing.author}` : ''}. It is read-only.
          </p>
          <div className="ed-chips">
            <button type="button" className="ed-btn ed-btn--go" onClick={makeCopy}>
              Make a copy to edit
            </button>
            <button type="button" className="ed-chip" onClick={() => setReporting((v) => !v)}>
              Report
            </button>
          </div>
          {reporting ? (
            <form
              className="ed-report"
              onSubmit={(e) => {
                e.preventDefault();
                void reportShared(reason, details.trim() || undefined).then(
                  (ok) => ok && setReporting(false),
                );
              }}
            >
              <label htmlFor={reasonId}>Why?</label>
              <select
                id={reasonId}
                className="ed-input"
                value={reason}
                onChange={(e) => setReason(e.target.value as RoundReportReason)}
              >
                {REASONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <input
                className="ed-input"
                value={details}
                maxLength={500}
                placeholder="Details (optional)"
                aria-label="Details"
                onChange={(e) => setDetails(e.target.value)}
              />
              <button type="submit" className="ed-btn ed-btn--danger">
                Send report
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

/** The Share tab. */
export function SharePanel(props: { signedIn: boolean }): JSX.Element {
  const viewing = useEditor((s) => s.viewing !== null);
  const { refreshShared } = useActions();
  useEffect(() => {
    void refreshShared();
  }, [refreshShared]);
  return (
    <div className="ed-share">
      {!viewing ? <PublishBox signedIn={props.signedIn} /> : null}
      <OpenByCode />
      <MyRounds />
    </div>
  );
}
