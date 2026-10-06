import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { pwa } from './vite-pwa.ts';

// Every *.html in the client root is an entry: index.html is the game,
// admin.html the admin console, editor.html the round editor, the rest dev
// sandboxes (playground, obstacle gallery, UI screen preview, …). Dev serves
// them all; production builds ship the game, the console and the editor
// (separate entries, so players never download them with the game),
// and `--mode sandbox` builds everything (with dev URL options enabled) for
// e2e and media capture.
const root = import.meta.dirname;
const pages = Object.fromEntries(
  readdirSync(root)
    .filter((f) => f.endsWith('.html') && existsSync(resolve(root, f)))
    .map((f) => [f.replace(/\.html$/, ''), resolve(root, f)]),
);

/** Production entries. */
export const PRODUCTION_INPUT = {
  index: resolve(root, 'index.html'),
  admin: resolve(root, 'admin.html'),
  editor: resolve(root, 'editor.html'),
};

/** Serves the console at `/admin` and the editor at `/editor` in `vite dev` / `vite preview`, as the deploy proxies do. */
const toAdminHtml = (req: { url?: string }, _res: unknown, next: () => void) => {
  if (req.url && /^\/admin\/?(\?|$)/.test(req.url)) req.url = req.url.replace(/^\/admin\/?/, '/admin.html');
  if (req.url && /^\/editor\/?(\?|$)/.test(req.url))
    req.url = req.url.replace(/^\/editor\/?/, '/editor.html');
  next();
};
const adminRoute: Plugin = {
  name: 'tumble-admin-route',
  configureServer: (server) => void server.middlewares.use(toAdminHtml),
  configurePreviewServer: (server) => void server.middlewares.use(toAdminHtml),
};

export default defineConfig(({ mode }) => {
  // An empty prefix also reads non-VITE_ keys; only VITE_* ever reach the bundle.
  const env = loadEnv(mode, root, '');
  return {
    plugins: [react(), tailwind(), adminRoute, pwa()],
    resolve: {
      // three's addons import bare 'three'; point it at the WebGPU build so only one copy of the core loads.
      alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
    },
    server: {
      port: 5173,
      proxy: {
        '/gs': {
          target: env.GAME_SERVER_URL || 'http://localhost:7350',
          ws: true,
          rewrite: (p) => p.replace(/^\/gs/, ''),
        },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      chunkSizeWarningLimit: 2000,
      rollupOptions: { input: mode === 'sandbox' ? pages : PRODUCTION_INPUT },
    },
    // Rapier-compat embeds its WASM; pre-bundling it only slows cold starts.
    optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
  };
});
