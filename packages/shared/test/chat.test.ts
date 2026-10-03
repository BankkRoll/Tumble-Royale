import { describe, expect, it } from 'vitest';
import {
  QUICK_CHAT,
  chatTextFor,
  containsAbuse,
  containsProfanity,
  filterChat,
  maskAbuse,
  maskProfanity,
  quickChat,
  sanitizeChatText,
} from '../src/index.ts';

describe('chat filter', () => {
  it('masks swearing only in the filtered variant', () => {
    expect(filterChat('what the fuck mate')).toEqual({
      text: 'what the fuck mate',
      masked: 'what the **** mate',
    });
  });

  it('always masks slurs, even with the filter off', () => {
    const r = filterChat('you n1gg3r')!;
    expect(r.text).toBe('you ******');
    expect(chatTextFor(r, false)).toBe('you ******');
  });

  it('catches leetspeak and spaced-out letters', () => {
    expect(maskProfanity('sh1t happens')).toBe('**** happens');
    expect(maskProfanity('lol f u c k this')).toBe('lol * * * * this');
    expect(maskAbuse('ok K Y S')).toBe('ok * * *');
    expect(containsAbuse('kys')).toBe(true);
  });

  it('does not join whole words across spaces', () => {
    expect(maskProfanity('this hit me')).toBe('this hit me');
    expect(containsProfanity('Classy cocktail')).toBe(false);
  });

  it('clean messages carry no masked copy', () => {
    expect(filterChat('gg everyone')).toEqual({ text: 'gg everyone' });
  });

  it('sanitises control characters, bidi overrides and length', () => {
    expect(sanitizeChatText('hi\u0000\u202e there\n')).toBe('hi there');
    expect(sanitizeChatText('   ')).toBeNull();
    expect(sanitizeChatText(42)).toBeNull();
    expect(sanitizeChatText('x'.repeat(500))!.length).toBe(120);
  });

  it('chatTextFor honours the filter setting', () => {
    const r = filterChat('oh shit')!;
    expect(chatTextFor(r, true)).toBe('oh ****');
    expect(chatTextFor(r, false)).toBe('oh shit');
  });
});

describe('quick chat', () => {
  it('only knows the presets', () => {
    expect(quickChat('ping:go')?.text).toBe('Go here!');
    expect(quickChat('cam:next')?.text).toBe('Next time…');
    expect(quickChat('ping:anything')).toBeUndefined();
    expect(quickChat(7)).toBeUndefined();
    expect(new Set(QUICK_CHAT.map((p) => p.id)).size).toBe(QUICK_CHAT.length);
  });
});
