/**
 * Guards player-facing copy and the docs players and operators read against
 * stale show sizes. Shows are 100 players (`MAX_PLAYERS` in
 * packages/shared/src/constants.ts); copy that still says 40 or 60 players
 * drifted. Historical measurements ("measured at 40 bots") live in test
 * names and design notes outside this list on purpose.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Files and directories (scanned recursively for .ts/.tsx/.md/.json) that must quote the current size. */
const SCOPE = [
  'README.md',
  'package.json',
  'docs/SPEC.md',
  'docs/design/SCREENS.md',
  'apps/client/README.md',
  'apps/client/e2e',
  'apps/game-server/README.md',
  'apps/game-server/.env.example',
  'apps/matchmaker/README.md',
  'tools/bot-swarm',
  'packages/content/src/news',
  'packages/ui/src',
];

const STALE = /\b(?:40|60)[- ](?:players?|tumblers?)\b|--clients 40\b|ROOM_CAPACITY=40\b|TARGET_SIZE=40\b/i;

function* files(path) {
  const st = statSync(path);
  if (st.isFile()) {
    yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const child = join(path, name);
    if (statSync(child).isDirectory()) yield* files(child);
    else if (/\.(ts|tsx|md|json|example)$/.test(name)) yield child;
  }
}

describe('player-count copy', () => {
  it('quotes the current show size everywhere players and operators read it', () => {
    const MAX = readFileSync(join(repo, 'packages/shared/src/constants.ts'), 'utf8').match(
      /export const MAX_PLAYERS = (\d+);/,
    );
    assert.ok(MAX, 'MAX_PLAYERS is a literal in packages/shared/src/constants.ts');
    const stale = [];
    for (const entry of SCOPE)
      for (const file of files(join(repo, entry))) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (STALE.test(line)) stale.push(`${relative(repo, file)}:${i + 1}: ${line.trim()}`);
          });
      }
    assert.deepEqual(stale, [], `stale player counts (shows are ${MAX[1]} players):\n${stale.join('\n')}`);
  });

  it('catches the phrasings it is meant to', () => {
    for (const s of ['40 players', '40-player', '60 Tumblers', '--clients 40', 'ROOM_CAPACITY=40'])
      assert.ok(STALE.test(s), s);
    for (const s of ['100 players', '140 players', '40 m', '40 ms']) assert.ok(!STALE.test(s), s);
  });
});
