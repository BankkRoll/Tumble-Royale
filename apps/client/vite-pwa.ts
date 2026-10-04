/**
 * Build plugin for the installable app: bundles `src/pwa/sw.ts` into `sw.js`
 * with this build's precache list and version baked in.
 *
 * Responsibilities:
 * - list every file the game page can load (build output and `public/`,
 *   filtered by `shouldPrecache`);
 * - derive the version from the files' contents, so an unchanged build ships
 *   a byte-identical worker and browsers see no update;
 * - emit `sw.js` at the output root, where its scope covers the whole game.
 *
 * Hand-written rather than vite-plugin-pwa: the worker is ~100 lines, its
 * routing rules are unit-tested here, and the game needs nothing from Workbox.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import type { Plugin } from 'vite';
import { shouldPrecache } from './src/pwa/swRules.ts';

function walk(dir: string, root = dir, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

/**
 * The PWA build plugin.
 *
 * @returns A build-only Vite plugin that emits `sw.js`.
 * @example
 * export default defineConfig({ plugins: [react(), pwa()] });
 */
export function pwa(): Plugin {
  let publicDir = '';
  return {
    name: 'tumble:pwa',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle: {
      // After Vite's HTML plugin, so `index.html` is in the bundle.
      order: 'post',
      async handler(_options, bundle) {
        const hash = createHash('sha256');
        const files: string[] = [];
        for (const [name, out] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
          if (!shouldPrecache(name)) continue;
          files.push(name);
          hash.update(name);
          hash.update(out.type === 'chunk' ? out.code : out.source);
        }
        for (const name of walk(publicDir).sort()) {
          if (!shouldPrecache(name) || files.includes(name)) continue;
          files.push(name);
          hash.update(name);
          hash.update(readFileSync(resolve(publicDir, name)));
        }
        const version = hash.digest('hex').slice(0, 12);
        const result = await build({
          entryPoints: [resolve(import.meta.dirname, 'src/pwa/sw.ts')],
          bundle: true,
          write: false,
          format: 'iife',
          target: 'es2020',
          minify: true,
          legalComments: 'none',
          define: {
            __SW_VERSION__: JSON.stringify(version),
            __SW_PRECACHE__: JSON.stringify(files),
          },
        });
        const code = result.outputFiles[0]?.text;
        if (!code) throw new Error('[pwa] service worker bundle is empty');
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: `/* tumble ${version} */\n${code}` });
      },
    },
  };
}
