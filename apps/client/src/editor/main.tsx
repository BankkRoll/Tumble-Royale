/**
 * Entry of the round editor (`/editor`, built from `editor.html`).
 *
 * Its own Vite entry, so players never download the editor with the game.
 * It shares the origin with the game: the player's stored session signs
 * sharing requests, and Test play hands the round to the game tab through
 * IndexedDB.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultDrafts } from '../customRounds/drafts.ts';
import { ENDPOINTS } from '../devTools.ts';
import { ApiClient } from '../game/api.ts';
import { loadRuntimeConfig } from '../runtimeConfig.ts';
import { editorApi } from './editorApi.ts';
import { createEditorStore } from './store.ts';
import { EditorApp, useShortcuts } from './ui/App.tsx';
import { EditorViewport } from './viewport.ts';
import './editor.css';

await loadRuntimeConfig();

const client = new ApiClient(ENDPOINTS.api);
const store = createEditorStore({ drafts: defaultDrafts(), api: editorApi(client) });
const backend = new URLSearchParams(location.search).get('backend');

function Root() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<EditorViewport | null>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const v = new EditorViewport(canvas.current, store);
    view.current = v;
    void v.init(backend === 'webgl' || backend === 'webgpu' ? backend : 'auto').catch((err: unknown) => {
      store.setState({ status: { tone: 'error', text: `3D view failed to start: ${String(err)}` } });
    });
    return () => v.dispose();
  }, []);
  const testPlay = useCallback(() => {
    if (store.getState().validation.issues.some((i) => i.severity === 'error')) {
      void store.getState().prepareTestPlay();
      return;
    }
    // Opened inside the click so popup blockers allow it; pointed at the game once the draft is stored.
    const tab = window.open('', 'tumble-playtest');
    void store
      .getState()
      .prepareTestPlay()
      .then((ok) => {
        const url = `${import.meta.env.BASE_URL}?playtest=1`;
        if (!ok) tab?.close();
        else if (tab) tab.location.href = url;
        else window.location.href = url;
      });
  }, []);
  const focus = useCallback(() => view.current?.focusSelection(), []);
  const extra = useMemo(() => ({ testPlay, focus }), [testPlay, focus]);
  useShortcuts(store, extra);
  return (
    <EditorApp
      store={store}
      signedIn={client.signedIn}
      onTestPlay={testPlay}
      onFocus={focus}
      viewport={<canvas ref={canvas} className="ed-canvas" aria-label="Round in 3D" />}
    />
  );
}

void store.getState().refreshDrafts();
createRoot(document.getElementById('editor')!).render(<Root />);
