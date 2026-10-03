/** Cards for Tumblers met offline carry only what this device saw. */
import { describe, expect, it } from 'vitest';
import { facedCard } from '../src/game/facedCard.ts';

const colors = { primary: '#ff4f9a', secondary: '#ffd23f', pattern: 'dots' as const };

describe('met-offline profile cards', () => {
  it('reports shows together, best finish and crowns, flagged as met offline', () => {
    const card = facedCard('faced:Gizmo', 'Gizmo', {
      colors,
      isBot: true,
      faced: 6,
      crowns: 1,
      best: 1,
      lastSeen: 1234,
      ahead: 4,
    });
    expect(card.metOffline).toEqual({
      isBot: true,
      showsTogether: 6,
      bestPlace: 1,
      crownsTogether: 1,
      aheadOfYou: 4,
      lastSeen: 1234,
    });
    expect(card.name).toBe('Gizmo');
    expect(card.colors).toEqual(colors);
  });

  it('never invents a level, tag or lifetime stats', () => {
    const card = facedCard('faced:Pat', 'Pat', {
      colors,
      isBot: false,
      faced: 2,
      crowns: 0,
      best: 7,
      lastSeen: 0,
    });
    expect(card.tag).toBe('');
    expect(card.level).toBe(0);
    expect(card.stats.shows).toBe(0);
    expect(card.metOffline?.isBot).toBe(false);
    expect(card.metOffline?.aheadOfYou).toBeUndefined();
  });
});
