/**
 * Files: drafts saved on this device, new rounds by type, and JSON import /
 * export of the round file format.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { CUSTOM_ROUND_TYPES } from '@tumble/content/custom';
import { Section, useActions, useEditor } from './kit.tsx';

/**
 * Saves text as a file download.
 *
 * @param name - File name.
 * @param text - Contents.
 */
export function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from a round name. */
export function fileNameFor(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'round';
  return `${slug.slice(0, 40)}.round.json`;
}

/** The Files tab. */
export function FilesPanel(): JSX.Element {
  const drafts = useEditor((s) => s.drafts);
  const current = useEditor((s) => s.draftId);
  const dirty = useEditor((s) => s.dirty);
  const name = useEditor((s) => s.round.name);
  // Sharing or loading a code applies to the open round when it lands: keep it open until then.
  const busy = useEditor((s) => s.busy);
  const { refreshDrafts, openDraft, deleteDraft, newRound, importFile, exportFile } = useActions();
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);
  return (
    <div className="ed-files">
      <Section title="New round">
        <div className="ed-chips">
          {CUSTOM_ROUND_TYPES.map((t) => (
            <button key={t} type="button" className="ed-chip" disabled={busy} onClick={() => newRound(t)}>
              New {t}
            </button>
          ))}
        </div>
        {dirty ? (
          <p className="ed-hint">Unsaved changes are lost when you start a new round. Save first.</p>
        ) : null}
      </Section>
      <Section title="Saved on this device">
        {drafts.length === 0 ? <p className="ed-hint">No saved rounds yet. Press Save (Ctrl+S).</p> : null}
        <ul className="ed-list">
          {drafts.map((d) => (
            <li key={d.id} className={`ed-list-row${d.id === current ? ' is-current' : ''}`}>
              <div>
                <strong>{d.name}</strong> <span className="ed-muted">{d.type}</span>
                {d.sharedCode ? <code className="ed-id">{d.sharedCode}</code> : null}
                <div className="ed-muted">{new Date(d.updatedAt).toLocaleString()}</div>
              </div>
              <div className="ed-chips">
                <button type="button" className="ed-chip" disabled={busy} onClick={() => void openDraft(d.id)}>
                  Open
                </button>
                {confirm === d.id ? (
                  <button
                    type="button"
                    className="ed-chip ed-chip--danger"
                    onClick={() => {
                      setConfirm(null);
                      void deleteDraft(d.id);
                    }}
                  >
                    Delete for good
                  </button>
                ) : (
                  <button type="button" className="ed-chip" onClick={() => setConfirm(d.id)}>
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Round files">
        <div className="ed-chips">
          <button
            type="button"
            className="ed-chip"
            onClick={() => download(fileNameFor(String(name)), exportFile())}
          >
            Export JSON
          </button>
          <button
            type="button"
            className="ed-chip"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            Import JSON
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="Import a round file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void file.text().then(importFile);
          }}
        />
      </Section>
    </div>
  );
}
