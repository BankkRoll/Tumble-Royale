/**
 * Round editor layout: toolbar on top, the 3D view in the middle, the tabbed
 * side panel (Build, Round, Share, Files) on the left and the inspector with
 * live checks on the right. On narrow screens (tablets in portrait) both
 * side panels become sheets toggled from the toolbar row.
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { EditorPanel, EditorState } from '../store.ts';
import { FilesPanel } from './FilesPanel.tsx';
import { Inspector } from './Inspector.tsx';
import { Issues } from './Issues.tsx';
import { EditorContext, useActions, useEditor } from './kit.tsx';
import { Palette } from './Palette.tsx';
import { RoundSettings } from './RoundSettings.tsx';
import { SharePanel } from './SharePanel.tsx';
import { Toolbar } from './Toolbar.tsx';

const TABS: { id: EditorPanel; label: string }[] = [
  { id: 'build', label: 'Build' },
  { id: 'round', label: 'Round' },
  { id: 'share', label: 'Share' },
  { id: 'files', label: 'Files' },
];

/** What the shell needs from the page. */
export interface EditorAppProps {
  store: StoreApi<EditorState>;
  /** Whether the player has a stored session (sharing needs one). */
  signedIn: boolean;
  onTestPlay(): void;
  onFocus(): void;
  /** The 3D view (a canvas element owned by the page). */
  viewport: ReactNode;
}

function SidePanel(props: { signedIn: boolean }): JSX.Element {
  const panel = useEditor((s) => s.panel);
  const { setPanel } = useActions();
  return (
    <div className="ed-side">
      <div className="ed-tabs" role="tablist" aria-label="Editor panels">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`ed-tab-${t.id}`}
            aria-selected={panel === t.id}
            aria-controls="ed-tabpanel"
            className={`ed-tab${panel === t.id ? ' is-on' : ''}`}
            onClick={() => setPanel(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ed-tabpanel" id="ed-tabpanel" role="tabpanel" aria-labelledby={`ed-tab-${panel}`}>
        {panel === 'build' ? <Palette /> : null}
        {panel === 'round' ? <RoundSettings /> : null}
        {panel === 'share' ? <SharePanel signedIn={props.signedIn} /> : null}
        {panel === 'files' ? <FilesPanel /> : null}
      </div>
    </div>
  );
}

/** The editor shell. */
export function EditorApp(props: EditorAppProps): JSX.Element {
  const [sheet, setSheet] = useState<'none' | 'side' | 'inspect'>('none');
  return (
    <EditorContext.Provider value={props.store}>
      <div className={`ed-app ed-app--sheet-${sheet}`}>
        <Toolbar onTestPlay={props.onTestPlay} onFocus={props.onFocus} />
        <div className="ed-sheet-toggles">
          <button
            type="button"
            className="ed-chip"
            aria-pressed={sheet === 'side'}
            onClick={() => setSheet((s) => (s === 'side' ? 'none' : 'side'))}
          >
            Panels
          </button>
          <button
            type="button"
            className="ed-chip"
            aria-pressed={sheet === 'inspect'}
            onClick={() => setSheet((s) => (s === 'inspect' ? 'none' : 'inspect'))}
          >
            Inspect
          </button>
        </div>
        <aside className="ed-left" aria-label="Build and settings">
          <SidePanel signedIn={props.signedIn} />
        </aside>
        <main className="ed-view" aria-label="3D view">
          {props.viewport}
        </main>
        <aside className="ed-right" aria-label="Inspector">
          <Inspector />
          <Issues />
        </aside>
      </div>
    </EditorContext.Provider>
  );
}

/**
 * True when a key event belongs to a text field (shortcuts must not fire there).
 *
 * @param target - The event target.
 */
export function typingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/**
 * Editor keyboard shortcuts.
 *
 * @param store - The editor store.
 * @param extra - Page actions (Test play, frame selection).
 */
export function useShortcuts(store: StoreApi<EditorState>, extra: { testPlay(): void; focus(): void }): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingInto(e.target)) return;
      const s = store.getState();
      const mod = e.ctrlKey || e.metaKey;
      const step = s.snapStep > 0 ? s.snapStep : 0.5;
      const k = e.key.toLowerCase();
      let handled = true;
      if (mod && k === 'z' && !e.shiftKey) s.undo();
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) s.redo();
      else if (mod && k === 'c') s.copy();
      else if (mod && k === 'v') s.paste();
      else if (mod && k === 'd') s.duplicate();
      else if (mod && k === 's') void s.saveDraft();
      else if (mod && k === 'a') s.selectAll();
      else if (mod) handled = false;
      else if (k === 'delete' || k === 'backspace') s.deleteSelection();
      else if (k === 'escape') {
        if (s.placing) s.setPlacing(null);
        else s.select([]);
      } else if (k === 'w') s.setGizmo('move');
      else if (k === 'e') s.setGizmo('rotate');
      else if (k === 'r') s.setGizmo('scale');
      else if (k === 'f') extra.focus();
      else if (k === 'p') extra.testPlay();
      else if (k === 'q') s.rotateSelection(-s.rotateStep);
      else if (k === 'arrowleft') s.moveSelection({ x: step, y: 0, z: 0 }, 'nudge');
      else if (k === 'arrowright') s.moveSelection({ x: -step, y: 0, z: 0 }, 'nudge');
      else if (k === 'arrowup') s.moveSelection({ x: 0, y: 0, z: step }, 'nudge');
      else if (k === 'arrowdown') s.moveSelection({ x: 0, y: 0, z: -step }, 'nudge');
      else if (k === 'pageup') s.moveSelection({ x: 0, y: step, z: 0 }, 'nudge');
      else if (k === 'pagedown') s.moveSelection({ x: 0, y: -step, z: 0 }, 'nudge');
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, extra]);
}
