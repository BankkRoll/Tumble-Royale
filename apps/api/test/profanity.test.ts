import { describe, expect, it } from 'vitest';
import { checkDisplayName, parseNameTag } from '../src/names/display-name.ts';
import { containsProfanity, maskProfanity, normalizeForFilter } from '../src/names/profanity.ts';

describe('profanity filter', () => {
  it.each(['fuck', 'FuCk', 'f.u.c.k', 'fuuuuuck', 'xXfuckXx', 'sh1t', '$h!t', 'b1tch', 'a$$', 'ass', 'asssss', 'b00b', 'n1gg3r', 'KYS'])(
    'blocks %s',
    (word) => {
      expect(containsProfanity(word)).toBe(true);
    },
  );

  it.each(['Classy', 'Scunthorpe', 'Bouncy Bob', 'assassin', 'cocktail', 'grapefruit', 'therapist', 'Niger', 'as', 'Passion', 'Pebble', 'skyscraper', 'accumulate', 'torpedo'])(
    'allows %s',
    (word) => {
      expect(containsProfanity(word)).toBe(false);
    },
  );

  it('normalises leetspeak and separators', () => {
    expect(normalizeForFilter('H3ll0_W0rld!!')).toBe('hello worldii');
  });

  it('masks offending tokens only', () => {
    expect(maskProfanity('what the fuck mate')).toBe('what the **** mate');
  });
});

describe('display names', () => {
  it('accepts valid names', () => {
    expect(checkDisplayName('  Zippy Noodle ')).toEqual({ ok: true, name: 'Zippy Noodle' });
  });
  it('rejects bad names with a reason', () => {
    expect(checkDisplayName('ab')).toEqual({ ok: false, reason: 'length' });
    expect(checkDisplayName('bad--name')).toEqual({ ok: false, reason: 'characters' });
    expect(checkDisplayName('Admin')).toEqual({ ok: false, reason: 'reserved' });
    expect(checkDisplayName('Moderator_77')).toEqual({ ok: false, reason: 'reserved' });
    expect(checkDisplayName('Sh1t_Lord')).toEqual({ ok: false, reason: 'profanity' });
  });
  it('parses name#tag', () => {
    expect(parseNameTag('Zippy Noodle#0420')).toEqual({ name: 'Zippy Noodle', tag: '0420' });
    expect(parseNameTag('nope')).toBeNull();
  });
});
