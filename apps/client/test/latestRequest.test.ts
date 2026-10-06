/** A slow profile card never replaces the newer one the player asked for after it. */
import { describe, expect, it } from 'vitest';
import { LatestRequest } from '../src/game/latest.ts';

describe('LatestRequest', () => {
  it('only the newest request stays current', () => {
    const cards = new LatestRequest();
    const first = cards.begin();
    const second = cards.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('cancel makes every request in flight stale', () => {
    const cards = new LatestRequest();
    const pending = cards.begin();
    cards.cancel();
    expect(pending()).toBe(false);
    expect(cards.begin()()).toBe(true);
  });
});
