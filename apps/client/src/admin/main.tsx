/**
 * Entry of the admin console (`/admin`, built from `admin.html`).
 *
 * A separate Vite entry, so none of this ships in the game's bundle and the
 * console never loads the renderer, physics or audio. It reuses the game's
 * account client only to read the signed-in player's access token.
 */
import { createRoot } from 'react-dom/client';
import { ENDPOINTS } from '../devTools.ts';
import { ApiClient } from '../game/api.ts';
import { loadRuntimeConfig } from '../runtimeConfig.ts';
import { AdminApi, tabSessionStore } from './api.ts';
import { AdminApp } from './App.tsx';
import './admin.css';

await loadRuntimeConfig();

let storage: Storage | undefined;
try {
  storage = window.sessionStorage;
} catch {
  storage = undefined;
}
const api = new AdminApi(ENDPOINTS.api, tabSessionStore(storage));
const player = new ApiClient(ENDPOINTS.api);

createRoot(document.getElementById('admin')!).render(
  <AdminApp api={api} playerToken={() => player.accessToken()} />,
);
