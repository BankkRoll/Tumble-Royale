/**
 * The admin console must stay out of the game's bundle: it is its own Vite
 * entry, nothing the game imports reaches `src/admin`, and the console never
 * pulls in the game (renderer, physics, audio).
 *
 * Walks the static and dynamic relative imports from each entry; package
 * imports are leaves.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(ROOT, 'src');
const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g;

const TYPE_IMPORT_RE = /(?:import|export)\s+type\s[^;]*?from\s*['"][^'"]+['"]/g;

function graph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx)$/.test(file)) continue;
    // Type-only imports are erased by the compiler, so they cannot pull code into a chunk.
    const text = readFileSync(file, 'utf8').replace(TYPE_IMPORT_RE, '');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3]!;
      const target = resolve(dirname(file), spec);
      if (existsSync(target)) stack.push(target);
    }
  }
  return seen;
}

const inAdmin = (f: string) => f.startsWith(resolve(SRC, 'admin'));

describe('admin bundle separation', () => {
  it('builds the console as its own production entry', () => {
    const config = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/admin:\s*resolve\(root, 'admin\.html'\)/);
    expect(readFileSync(resolve(ROOT, 'admin.html'), 'utf8')).toContain('/src/admin/main.tsx');
    expect(readFileSync(resolve(ROOT, 'index.html'), 'utf8')).not.toContain('admin');
  });

  it('never reaches the console from the game', () => {
    const game = graph(resolve(SRC, 'main.ts'));
    expect(game.size).toBeGreaterThan(50);
    expect([...game].filter(inAdmin)).toEqual([]);
  });

  it('never loads the game from the console', () => {
    const admin = graph(resolve(SRC, 'admin/main.tsx'));
    expect([...admin].some(inAdmin)).toBe(true);
    const outside = [...admin]
      .filter((f) => !inAdmin(f))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));
    expect(outside.sort()).toEqual(
      [
        'devTools.ts',
        'game/api.ts',
        'game/online/returnUrl.ts',
        'game/storage.ts',
        'runtimeConfig.ts',
      ].sort(),
    );
  });
});
