/**
 * The editor toolbar: undo/redo, gizmo mode, snapping, clipboard, save and
 * Test play, with the status line.
 */
import type { JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { GizmoMode } from '../store.ts';
import { useActions, useEditor, useFieldId } from './kit.tsx';

const SNAPS = [0, 0.25, 0.5, 1, 2, 4];
const MODES: { id: GizmoMode; label: string; key: string }[] = [
  { id: 'move', label: 'Move', key: 'W' },
  { id: 'rotate', label: 'Turn', key: 'E' },
  { id: 'scale', label: 'Size', key: 'R' },
];

/**
 * The toolbar.
 *
 * @param props.onTestPlay - Starts Test play (opens the game).
 * @param props.onFocus - Frames the selection in the view.
 */
export function Toolbar(props: { onTestPlay(): void; onFocus(): void }): JSX.Element {
  const s = useEditor(
    useShallow((x) => ({
      canUndo: x.canUndo,
      canRedo: x.canRedo,
      gizmo: x.gizmo,
      snap: x.snapStep,
      dirty: x.dirty,
      status: x.status,
      hasSelection: x.selection.length > 0,
      readOnly: x.viewing !== null,
      errors: x.validation.issues.filter((i) => i.severity === 'error').length,
      name: x.round.name,
    })),
  );
  const a = useActions();
  const snapId = useFieldId('snap');
  return (
    <header className="ed-toolbar" role="toolbar" aria-label="Editor tools">
      <strong className="ed-title" title={String(s.name)}>
        {String(s.name)}
        {s.dirty ? <span aria-label="unsaved changes"> •</span> : null}
      </strong>
      <div className="ed-group">
        <button
          type="button"
          className="ed-tool"
          disabled={!s.canUndo}
          onClick={a.undo}
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          type="button"
          className="ed-tool"
          disabled={!s.canRedo}
          onClick={a.redo}
          title="Redo (Ctrl+Y)"
        >
          Redo
        </button>
      </div>
      <div className="ed-group" role="radiogroup" aria-label="Gizmo">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={s.gizmo === m.id}
            className={`ed-tool${s.gizmo === m.id ? ' is-on' : ''}`}
            title={`${m.label} (${m.key})`}
            onClick={() => a.setGizmo(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="ed-group">
        <label htmlFor={snapId}>Snap</label>
        <select
          id={snapId}
          className="ed-input ed-input--small"
          value={s.snap}
          onChange={(e) => a.setSnap(Number(e.target.value))}
        >
          {SNAPS.map((v) => (
            <option key={v} value={v}>
              {v === 0 ? 'Off' : `${v} m`}
            </option>
          ))}
        </select>
      </div>
      <div className="ed-group">
        <button
          type="button"
          className="ed-tool"
          disabled={!s.hasSelection}
          onClick={a.copy}
          title="Copy (Ctrl+C)"
        >
          Copy
        </button>
        <button
          type="button"
          className="ed-tool"
          disabled={s.readOnly}
          onClick={a.paste}
          title="Paste (Ctrl+V)"
        >
          Paste
        </button>
        <button
          type="button"
          className="ed-tool"
          disabled={!s.hasSelection || s.readOnly}
          onClick={a.duplicate}
          title="Duplicate (Ctrl+D)"
        >
          Duplicate
        </button>
        <button
          type="button"
          className="ed-tool"
          disabled={!s.hasSelection || s.readOnly}
          onClick={a.deleteSelection}
          title="Delete (Del)"
        >
          Delete
        </button>
        <button type="button" className="ed-tool" onClick={props.onFocus} title="Frame selection (F)">
          Frame
        </button>
      </div>
      <div className="ed-group ed-group--end">
        <button
          type="button"
          className="ed-tool"
          disabled={s.readOnly}
          onClick={() => void a.saveDraft()}
          title="Save on this device (Ctrl+S)"
        >
          Save
        </button>
        <button
          type="button"
          className="ed-btn ed-btn--go"
          disabled={s.errors > 0}
          title={s.errors > 0 ? 'Fix the errors in Checks first' : 'Play it against bots (P)'}
          onClick={props.onTestPlay}
        >
          Test play
        </button>
      </div>
      {s.status ? (
        <p
          className={`ed-status-line ed-status-line--${s.status.tone}`}
          role={s.status.tone === 'error' ? 'alert' : 'status'}
        >
          {s.status.text}
        </p>
      ) : null}
    </header>
  );
}
