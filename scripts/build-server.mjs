#!/usr/bin/env node
/**
 * Production build for the Node services (API, matchmaker, game server).
 *
 * Run from a service's package directory (`pnpm --filter @tumble/api build`):
 * bundles `src/main.ts` (plus any extra entries given as arguments) into
 * `dist/` as ESM.
 *
 * - Workspace packages (`@tumble/*`) ship TypeScript sources, so they are
 *   bundled in; production never needs a TypeScript loader.
 * - Every other package stays an external `import`. Several carry native or
 *   WASM payloads they locate relative to their own files (PGlite, Rapier,
 *   pg's optional native binding), which breaks when inlined.
 * - Each external must be a direct dependency of the service: a production
 *   install (`pnpm deploy --prod`) only links those next to `dist/`, so an
 *   import that only resolves through a workspace package would crash at boot.
 *   The build fails instead of shipping that.
 *
 * Usage: `node ../../scripts/build-server.mjs [src/other-entry.ts …]`
 */
import { readFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { build } from 'esbuild';

const appDir = process.cwd();
const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const builtins = new Set(builtinModules);

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
const packageName = (spec) =>
  spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/');

const entryPoints = ['src/main.ts', ...process.argv.slice(2)];
const outdir = join(appDir, 'dist');
rmSync(outdir, { recursive: true, force: true });

const result = await build({
  absWorkingDir: appDir,
  entryPoints,
  outdir,
  outbase: 'src',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // Keeps stack traces and pino `err.type` readable; the bundle is not shipped to browsers.
  keepNames: true,
  metafile: true,
  logLevel: 'warning',
  plugins: [
    {
      name: 'externalize-npm',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.kind === 'entry-point' || args.path.startsWith('@tumble/')) return undefined;
          return { path: args.path, external: true };
        });
      },
    },
  ],
});

const undeclared = new Map();
for (const [file, out] of Object.entries(result.metafile.outputs)) {
  for (const imp of out.imports) {
    if (!imp.external) continue;
    const spec = imp.path.replace(/^node:/, '');
    if (imp.path.startsWith('node:') || builtins.has(spec) || builtins.has(packageName(spec))) continue;
    const name = packageName(imp.path);
    if (!declared.has(name)) undeclared.set(name, relative(appDir, file));
  }
}
if (undeclared.size > 0) {
  console.error(
    `[build] ${pkg.name}: bundled code imports packages that are not in its dependencies:\n` +
      [...undeclared].map(([n, f]) => `  - ${n} (from ${f})`).join('\n') +
      '\nAdd them to this package.json so a production install links them.',
  );
  process.exit(1);
}

const bytes = Object.values(result.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
console.log(`[build] ${pkg.name}: ${entryPoints.join(', ')} → dist/ (${(bytes / 1024).toFixed(0)} KiB)`);
