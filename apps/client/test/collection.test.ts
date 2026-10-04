/**
 * The offline collection log: content's read model projected onto UI items,
 * counting exactly what the local profile owns.
 */
import { describe, expect, it } from 'vitest';
import { COSMETICS } from '@tumble/content/cosmetics';
import { uiCollection } from '../src/game/cosmetics.ts';

describe('offline collection log', () => {
  it('lists every cosmetic as a UI item with its sources and completion', () => {
    const owned = new Set(COSMETICS.filter((c) => c.source === 'default').map((c) => c.id));
    owned.add('nameplate.mint');
    const log = uiCollection((id) => owned.has(id));
    expect(log.total).toBe(COSMETICS.length);
    expect(log.entries).toHaveLength(COSMETICS.length);
    expect(log.owned).toBe(owned.size);
    expect(log.percent).toBe(Math.floor((owned.size * 1000) / COSMETICS.length) / 10);
    const mint = log.entries.find((e) => e.item.id === 'nameplate.mint')!;
    expect(mint.item.owned).toBe(true);
    expect(mint.sources).toEqual([{ kind: 'tutorial', label: 'Complete Practice Island' }]);
    const color = log.entries.find((e) => e.item.id.startsWith('color.'))!;
    expect(color.item.slot).toBe('colors');
    expect(log.entries.every((e) => e.sources.length > 0)).toBe(true);
  });
});
