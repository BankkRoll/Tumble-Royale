/**
 * Entry of the public status page (`/status`, built from `status.html`).
 *
 * A separate Vite entry with no framework and no game code, so it stays a
 * few kilobytes and loads even when the game's own assets would not. It
 * reads `config.json` only to find the API.
 */
import { ENDPOINTS } from '../devTools.ts';
import { loadRuntimeConfig } from '../runtimeConfig.ts';
import { startStatusPage } from './page.ts';
import './status.css';

await loadRuntimeConfig();
const root = document.getElementById('status');
if (root) startStatusPage({ root, api: ENDPOINTS.api });
