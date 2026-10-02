import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const GAME_SERVER = process.env.GAME_SERVER_URL ?? 'http://localhost:7350';

// Every *.html in the client root is an entry: index.html is the game, the rest
// are dev sandboxes (playground, obstacle gallery, UI screen preview, …).
const root = import.meta.dirname;
const pages = Object.fromEntries(
  readdirSync(root)
    .filter((f) => f.endsWith('.html') && existsSync(resolve(root, f)))
    .map((f) => [f.replace(/\.html$/, ''), resolve(root, f)]),
);

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    // three's addons import bare 'three'; point it at the WebGPU build so only one copy of the core loads.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: {
    port: 5173,
    proxy: {
      '/gs': {
        target: GAME_SERVER,
        ws: true,
        rewrite: (p) => p.replace(/^\/gs/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: pages },
  },
  // Rapier-compat embeds its WASM; pre-bundling it only slows cold starts.
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
