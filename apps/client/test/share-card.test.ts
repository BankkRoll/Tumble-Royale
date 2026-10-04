/**
 * Share card layout: headline and stats from the show, text fitting for long
 * names, CJK and emoji (shrink first, then cut on grapheme boundaries),
 * Streamer Mode name handling, both card sizes staying in bounds, and which
 * results earn a card at all.
 */
import { describe, expect, it } from 'vitest';
import {
  CARD_BODY_FONT,
  CARD_DISPLAY_FONT,
  CARD_SIZES,
  cardHeadline,
  cardPlayerName,
  cleanCardText,
  defaultIncludeName,
  fitText,
  graphemes,
  layoutShareCard,
  ordinal,
  roundsSurvived,
  type CardLayout,
  type MeasureText,
  type ShareCardData,
  type TextBox,
} from '../src/game/share/cardLayout.ts';
import {
  cardDataFromFacts,
  cardFileName,
  clipFileName,
  isShareworthy,
  offerHeadline,
  type ShareShowFacts,
} from '../src/game/share/shareFacts.ts';

/** Wide glyphs (CJK, emoji) take a full em, Latin about half: close enough to real fonts to exercise fitting. */
const measure: MeasureText = (text, font) => {
  const size = Number(/(\d+)px/.exec(font)?.[1] ?? 16);
  let w = 0;
  for (const ch of Array.from(text)) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? size : size * 0.55;
  return w;
};

function facts(over: Partial<ShareShowFacts> = {}): ShareShowFacts {
  return {
    playlistName: 'Main Show',
    rounds: [
      { name: 'Gumdrop Gauntlet', type: 'race', qualified: true },
      { name: 'Tilt Town', type: 'survival', qualified: true },
      { name: 'Crown Climb', type: 'final', qualified: true },
    ],
    reachedFinal: true,
    wonCrown: true,
    place: 1,
    participants: 40,
    ...over,
  };
}

const DATE = Date.UTC(2026, 9, 4, 18, 30);

function data(over: Partial<ShareCardData> = {}): ShareCardData {
  return { ...cardDataFromFacts(facts(), 'Sprinkles', true, DATE), ...over };
}

function boxesOf(l: CardLayout): TextBox[] {
  return [
    l.title,
    l.sub,
    l.stats,
    l.date,
    l.badge.label,
    ...(l.name ? [l.name] : []),
    ...(l.more ? [l.more] : []),
    ...l.rounds.map((r) => r.box),
  ];
}

describe('fitText', () => {
  const opts = { family: CARD_BODY_FONT, maxSize: 40, minSize: 20 };

  it('keeps short text at the largest size', () => {
    const f = fitText('Sprinkles', 400, opts, measure);
    expect(f).toMatchObject({ text: 'Sprinkles', size: 40 });
    expect(f.font).toBe(`400 40px ${CARD_BODY_FONT}`);
  });

  it('shrinks before it cuts', () => {
    const f = fitText('Sir Wobblesworth', 300, opts, measure);
    expect(f.text).toBe('Sir Wobblesworth');
    expect(f.size).toBeLessThan(40);
    expect(f.size).toBeGreaterThanOrEqual(20);
    expect(measure(f.text, f.font)).toBeLessThanOrEqual(300);
  });

  it('cuts long names at the minimum size with an ellipsis', () => {
    const name = 'The Extremely Long Display Name Of A Very Determined Tumbler';
    const f = fitText(name, 300, opts, measure);
    expect(f.size).toBe(20);
    expect(f.text.endsWith('…')).toBe(true);
    expect(measure(f.text, f.font)).toBeLessThanOrEqual(300);
    expect(name.startsWith(f.text.slice(0, -1))).toBe(true);
  });

  it('never splits CJK, emoji sequences or flags', () => {
    const cjk = fitText('転がるチャンピオンの王冠を手にした者', 200, opts, measure);
    expect(cjk.text.endsWith('…')).toBe(true);
    expect(measure(cjk.text, cjk.font)).toBeLessThanOrEqual(200);

    const family = '👨‍👩‍👧‍👦';
    const emoji = fitText(`${family}${family}${family}${family}${family}🇯🇵🇯🇵🇯🇵`, 120, opts, measure);
    const kept = emoji.text.slice(0, -1);
    // Every kept grapheme is a whole one from the source.
    for (const g of graphemes(kept)) expect([family, '🇯🇵']).toContain(g);
    // No lone surrogate halves.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji.text)).toBe(
      false,
    );
  });

  it('degrades to a lone ellipsis when nothing fits', () => {
    expect(fitText('WWWW', 5, opts, measure).text).toBe('…');
  });
});

describe('card text', () => {
  it('names the result', () => {
    expect(cardHeadline(data())).toMatchObject({ title: 'CROWNED!', sub: 'Won Main Show' });
    expect(cardHeadline(data({ wonCrown: false, place: 4 }))).toMatchObject({
      title: 'FINALIST!',
      sub: '4th of 40 · Main Show',
    });
    expect(cardHeadline(data({ wonCrown: false, reachedFinal: false, place: 12 })).title).toBe('12TH PLACE');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '101st',
      '111th',
    ]);
  });

  it('counts rounds survived and keeps their names in order', () => {
    const d = data({
      wonCrown: false,
      rounds: [...data().rounds.slice(0, 2), { ...data().rounds[2]!, qualified: false }],
    });
    expect(roundsSurvived(d)).toBe(2);
    const l = layoutShareCard(d, 'social', measure, 'en-GB');
    expect(l.stats.text).toBe('2 ROUNDS SURVIVED');
    expect(l.rounds.map((r) => r.box.text)).toEqual([
      'R1 · Gumdrop Gauntlet',
      'R2 · Tilt Town',
      'Final · Crown Climb',
    ]);
    expect(l.rounds.map((r) => r.qualified)).toEqual([true, true, false]);
    expect(l.date.text).toBe('4 Oct 2026');
  });

  it('strips control and bidi-override characters', () => {
    expect(cleanCardText('  Evil‮emaN \u0007 x\n y ')).toBe('EvilemaN x y');
  });

  it('collapses long shows into the latest rounds plus a count', () => {
    const rounds = Array.from({ length: 7 }, (_, i) => ({
      name: `Round ${i + 1}`,
      qualified: true,
      isFinal: i === 6,
    }));
    const l = layoutShareCard(data({ rounds }), 'story', measure);
    expect(l.more?.text).toBe('+4 earlier rounds');
    expect(l.rounds.map((r) => r.box.text)).toEqual(['R5 · Round 5', 'R6 · Round 6', 'Final · Round 7']);
  });
});

describe('Streamer Mode', () => {
  it('starts with the player name off and never carries other names', () => {
    expect(defaultIncludeName(true)).toBe(false);
    expect(defaultIncludeName(false)).toBe(true);
    const d = cardDataFromFacts(facts(), 'Sprinkles', defaultIncludeName(true), DATE);
    expect(d.playerName).toBeNull();
    const l = layoutShareCard(d, 'social', measure);
    expect(l.name).toBeNull();
    // Only the show, rounds and result reach the card: no field for anyone else exists.
    expect(Object.keys(d).sort()).toEqual(
      [
        'date',
        'participants',
        'place',
        'playerName',
        'reachedFinal',
        'rounds',
        'showName',
        'wonCrown',
      ].sort(),
    );
    for (const b of boxesOf(l)) expect(b.text).not.toContain('Sprinkles');
  });

  it('shows the name when the player opts in', () => {
    expect(cardPlayerName('Sprinkles', true)).toBe('Sprinkles');
    expect(cardPlayerName('   ', true)).toBeNull();
    expect(cardPlayerName('Sprinkles', false)).toBeNull();
    expect(layoutShareCard(data(), 'story', measure).name?.text).toBe('Sprinkles');
  });
});

describe('layout bounds', () => {
  const nasty = data({
    playerName: '転がるチャンピオン👑👑👑 with an absurdly long suffix that never ends',
    showName: 'The Grand Seasonal Jellybean Spectacular Championship Invitational',
    rounds: [
      { name: 'Unbelievably Long Round Name For Testing The Layout Engine', qualified: true, isFinal: false },
      { name: '超長いラウンド名前のテストケースです', qualified: true, isFinal: false },
      { name: '🎉🎉🎉 Party Round 🎉🎉🎉', qualified: true, isFinal: true },
    ],
  });

  for (const format of ['social', 'story'] as const) {
    it(`keeps every line of the ${format} card inside its width and the canvas`, () => {
      const l = layoutShareCard(nasty, format, measure);
      expect({ width: l.width, height: l.height }).toEqual(CARD_SIZES[format]);
      for (const b of boxesOf(l)) {
        expect(measure(b.text, b.font)).toBeLessThanOrEqual(b.maxWidth + 0.001);
        const left =
          b.align === 'left' ? b.x : b.align === 'center' ? b.x - b.maxWidth / 2 : b.x - b.maxWidth;
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left + b.maxWidth).toBeLessThanOrEqual(l.width);
        expect(b.y).toBeGreaterThan(0);
        expect(b.y).toBeLessThanOrEqual(l.height);
      }
      expect(l.figure.x + l.figure.size).toBeLessThanOrEqual(l.width);
      expect(l.figure.y + l.figure.size).toBeLessThanOrEqual(l.height);
      expect(l.title.font).toContain(CARD_DISPLAY_FONT);
    });
  }

  it('names CJK and colour-emoji fallbacks before the generic families', () => {
    for (const stack of [CARD_DISPLAY_FONT, CARD_BODY_FONT]) {
      const generic = stack.indexOf('sans-serif');
      for (const face of [
        'Noto Sans CJK JP',
        'PingFang SC',
        'Microsoft YaHei',
        'Apple Color Emoji',
        'Segoe UI Emoji',
      ])
        expect(stack.indexOf(face)).toBeGreaterThan(-1);
      expect(stack.indexOf('Segoe UI Emoji')).toBeLessThan(generic);
    }
  });
});

describe('what earns a card', () => {
  it('offers a card for a Crown, a final or a top-quarter finish', () => {
    expect(isShareworthy(facts())).toBe(true);
    expect(isShareworthy(facts({ wonCrown: false }))).toBe(true);
    expect(isShareworthy(facts({ wonCrown: false, reachedFinal: false, place: 10 }))).toBe(true);
    expect(isShareworthy(facts({ wonCrown: false, reachedFinal: false, place: 11 }))).toBe(false);
    expect(isShareworthy(facts({ wonCrown: false, reachedFinal: false, place: 3, participants: 4 }))).toBe(
      true,
    );
    expect(isShareworthy(facts({ wonCrown: false, reachedFinal: false, place: 0 }))).toBe(false);
    expect(offerHeadline(facts())).toBe('Crowned!');
    expect(offerHeadline(facts({ wonCrown: false }))).toBe('Finalist!');
    expect(offerHeadline(facts({ wonCrown: false, reachedFinal: false, place: 2 }))).toBe('2nd place');
  });

  it('names files after the show or round and the day', () => {
    expect(cardFileName('Main Show', 'story', DATE)).toBe('tumble-royale-main-show-2026-10-04-story.png');
    expect(clipFileName('Gumdrop Gauntlet!', 'webm', DATE)).toBe(
      'tumble-royale-gumdrop-gauntlet-2026-10-04.webm',
    );
    expect(clipFileName('転がる', 'mp4', DATE)).toBe('tumble-royale-round-2026-10-04.mp4');
  });
});
