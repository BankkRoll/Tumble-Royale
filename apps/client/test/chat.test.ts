import { describe, expect, it } from 'vitest';
import { Rng, quickChat } from '@tumble/shared';
import {
  BUBBLE_CHARS,
  MAX_MUTES,
  bubbleText,
  muteKey,
  planBotReplies,
  quickChatId,
  toggleMute,
} from '../src/game/social/chatLogic.ts';

describe('quick chat ids', () => {
  it('maps emote-wheel kinds and winner-cam ids to presets', () => {
    expect(quickChatId('go')).toBe('ping:go');
    expect(quickChatId('cam:next')).toBe('cam:next');
    expect(quickChatId('chat:GG!')).toBeNull();
    expect(quickChatId('nope')).toBeNull();
  });
});

describe('bot replies', () => {
  it('are seeded: the same seed gives the same replies', () => {
    const a = planBotReplies(new Rng(42), 'ping:gg', [3, 4, 5, 6]);
    const b = planBotReplies(new Rng(42), 'ping:gg', [3, 4, 5, 6]);
    expect(a).toEqual(b);
  });

  it('only use presets, only known bots, at most two, in delay order', () => {
    for (let seed = 0; seed < 200; seed++) {
      const r = planBotReplies(new Rng(seed), 'cam:wow', [7, 8, 9]);
      expect(r.length).toBeLessThanOrEqual(2);
      for (const x of r) {
        expect([7, 8, 9]).toContain(x.botId);
        expect(quickChat(x.presetId)).toBeDefined();
        expect(x.delayMs).toBeGreaterThanOrEqual(700);
      }
      expect(r.map((x) => x.delayMs)).toEqual([...r.map((x) => x.delayMs)].sort((p, q) => p - q));
      if (r.length === 2) expect(r[0]!.botId).not.toBe(r[1]!.botId);
    }
  });

  it('sometimes answer and sometimes stay quiet', () => {
    const counts = Array.from(
      { length: 300 },
      (_, s) => planBotReplies(new Rng(s), 'ping:nice', [1, 2]).length,
    );
    expect(counts.some((n) => n === 0)).toBe(true);
    expect(counts.some((n) => n > 0)).toBe(true);
  });

  it('ignore unknown triggers and empty lobbies', () => {
    expect(planBotReplies(new Rng(1), 'ping:bogus', [1])).toEqual([]);
    expect(planBotReplies(new Rng(1), 'ping:gg', [])).toEqual([]);
  });
});

describe('bubbles and mutes', () => {
  it('cuts long bubble text with an ellipsis', () => {
    expect(bubbleText('GG!')).toBe('GG!');
    const long = bubbleText('x'.repeat(80));
    expect([...long].length).toBe(BUBBLE_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keys mutes by account, falling back to name', () => {
    expect(muteKey({ userId: 'u1', name: 'A' })).toBe('u1');
    expect(muteKey({ name: 'Bot Bob' })).toBe('name:Bot Bob');
  });

  it('toggles mutes without duplicates and caps the list', () => {
    let list = toggleMute([], 'a', true);
    list = toggleMute(list, 'a', true);
    expect(list).toEqual(['a']);
    expect(toggleMute(list, 'a', false)).toEqual([]);
    const big = Array.from({ length: MAX_MUTES }, (_, i) => `k${i}`);
    const next = toggleMute(big, 'new', true);
    expect(next).toHaveLength(MAX_MUTES);
    expect(next.at(-1)).toBe('new');
    expect(next[0]).toBe('k1');
  });
});
