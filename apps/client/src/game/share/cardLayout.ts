/**
 * Share card layout: what goes on a card and where, for the 1200×630 social
 * card and the 1080×1920 story card.
 *
 * Responsibilities:
 * - the card's words: headline (Crowned / Finalist / placement), the show,
 *   rounds survived with their names, the date;
 * - Streamer Mode: the card never carries anyone else's name, and the
 *   player's own name is opt-in (off by default while Streamer Mode is on);
 * - text fitting with an injected measurer: shrink to a minimum size, then
 *   cut on grapheme boundaries with an ellipsis, so long names, CJK and emoji
 *   never overflow or split a character in half;
 * - font stacks with CJK and colour-emoji fallbacks behind the game faces.
 *
 * Pure: no DOM. Drawing lives in `cardDraw.ts`.
 */

/** Card variants. */
export type CardFormat = 'social' | 'story';

/** Pixel size per variant. */
export const CARD_SIZES: Readonly<Record<CardFormat, { width: number; height: number }>> = {
  social: { width: 1200, height: 630 },
  story: { width: 1080, height: 1920 },
};

// COMPAT: canvas text falls back per glyph only through the listed families on
// some engines, so CJK and colour-emoji faces are named before the generics.
const CJK_FALLBACK =
  "'Noto Sans CJK JP', 'Noto Sans JP', 'Hiragino Sans', 'PingFang SC', 'Microsoft YaHei', 'Malgun Gothic'";
const EMOJI_FALLBACK = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'";

/** Headline face (the game's display font) with CJK and emoji fallbacks. */
export const CARD_DISPLAY_FONT = `'Lilita One', ${CJK_FALLBACK}, ${EMOJI_FALLBACK}, 'Arial Rounded MT Bold', system-ui, sans-serif`;
/** Body face with CJK and emoji fallbacks. */
export const CARD_BODY_FONT = `'Fredoka', ${CJK_FALLBACK}, ${EMOJI_FALLBACK}, 'Nunito', system-ui, sans-serif`;

/** One round on the card. */
export interface CardRound {
  name: string;
  qualified: boolean;
  isFinal: boolean;
}

/** Everything a card shows. */
export interface ShareCardData {
  showName: string;
  /** The player's own name, or null to leave it off. */
  playerName: string | null;
  wonCrown: boolean;
  reachedFinal: boolean;
  /** Final placement (1 = Crown). */
  place: number;
  participants: number;
  /** Rounds the player entered, in order. */
  rounds: CardRound[];
  /** When the show ended (epoch ms). */
  date: number;
}

/** Measures a string's advance width in a CSS font (`ctx.measureText`). */
export type MeasureText = (text: string, font: string) => number;

/** A positioned, fitted line of text. */
export interface TextBox {
  text: string;
  x: number;
  /** Baseline. */
  y: number;
  size: number;
  /** Full CSS font string the text was fitted with. */
  font: string;
  align: 'left' | 'center' | 'right';
  maxWidth: number;
}

/** A round row: its fitted label and fate. */
export interface RoundRow {
  box: TextBox;
  qualified: boolean;
  isFinal: boolean;
  /** Centre of the status pip. */
  pipX: number;
  pipY: number;
  pipR: number;
}

/** A laid-out card. */
export interface CardLayout {
  format: CardFormat;
  width: number;
  height: number;
  /** Where the posed Tumbler image is drawn (square). */
  figure: { x: number; y: number; size: number };
  /** Crown or placement badge. */
  badge: { x: number; y: number; r: number; label: TextBox };
  title: TextBox;
  sub: TextBox;
  name: TextBox | null;
  stats: TextBox;
  rounds: RoundRow[];
  /** "+N more" when the rounds do not all fit. */
  more: TextBox | null;
  date: TextBox;
  /** Wordmark anchor (centre of the two-line sticker) and cap height. */
  logo: { x: number; y: number; size: number };
}

const ELLIPSIS = '…';
// SECURITY: bidi overrides and isolates could make a name read as something else on the card.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * Card-safe text: control and bidi-override characters removed, whitespace
 * collapsed.
 *
 * @param text - Untrusted text (player and show names).
 */
export function cleanCardText(text: string): string {
  return text.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
}

/**
 * Splits text into user-perceived characters (an emoji with modifiers or a
 * flag stays one unit).
 *
 * @param text - Any string.
 */
export function graphemes(text: string): string[] {
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  // COMPAT: Intl.Segmenter is missing on older Firefox; code points keep surrogate pairs intact.
  if (!Seg) return Array.from(text);
  return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
}

/** Options for {@link fitText}. */
export interface FitOptions {
  family: string;
  /** CSS font weight (`400`, `700`…). */
  weight?: string;
  maxSize: number;
  minSize: number;
}

/**
 * Fits one line into a width: the largest size from `maxSize` down to
 * `minSize` that fits, and at `minSize` the longest grapheme prefix plus an
 * ellipsis.
 *
 * @param text - Line to fit.
 * @param maxWidth - Available width (px).
 * @param opts - Font family and size range.
 * @param measure - Width measurer.
 * @returns The (possibly shortened) text, its size and font string.
 * @example
 * fitText('Sir Wobblesworth the Third', 300, { family: CARD_BODY_FONT, maxSize: 40, minSize: 20 }, measure);
 */
export function fitText(
  text: string,
  maxWidth: number,
  opts: FitOptions,
  measure: MeasureText,
): { text: string; size: number; font: string } {
  const weight = opts.weight ?? '400';
  const fontAt = (size: number): string => `${weight} ${size}px ${opts.family}`;
  for (let size = opts.maxSize; size > opts.minSize; size -= 2) {
    if (measure(text, fontAt(size)) <= maxWidth) return { text, size, font: fontAt(size) };
  }
  const font = fontAt(opts.minSize);
  if (measure(text, font) <= maxWidth) return { text, size: opts.minSize, font };
  const g = graphemes(text);
  let lo = 0;
  let hi = g.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(g.slice(0, mid).join('').trimEnd() + ELLIPSIS, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return { text: lo > 0 ? g.slice(0, lo).join('').trimEnd() + ELLIPSIS : ELLIPSIS, size: opts.minSize, font };
}

/**
 * English ordinal ("1st", "22nd", "113th").
 *
 * @param n - Positive integer.
 */
export function ordinal(n: number): string {
  const v = n % 100;
  const s = v >= 11 && v <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

/**
 * The card's two headline lines.
 *
 * @param d - Card data.
 */
export function cardHeadline(d: ShareCardData): { title: string; sub: string; badge: string } {
  const show = cleanCardText(d.showName) || 'Tumble Royale';
  if (d.wonCrown) return { title: 'CROWNED!', sub: `Won ${show}`, badge: '1st' };
  const of = `${ordinal(d.place)} of ${d.participants}`;
  if (d.reachedFinal) return { title: 'FINALIST!', sub: `${of} · ${show}`, badge: ordinal(d.place) };
  return {
    title: `${ordinal(d.place).toUpperCase()} PLACE`,
    sub: `of ${d.participants} · ${show}`,
    badge: ordinal(d.place),
  };
}

/** Rounds the player came through (qualified, or won the final). */
export function roundsSurvived(d: ShareCardData): number {
  return d.rounds.filter((r) => r.qualified).length;
}

/**
 * The date line.
 *
 * @param epochMs - When the show ended.
 * @param locale - BCP 47 locale (default: the browser's).
 */
export function formatCardDate(epochMs: number, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(
      epochMs,
    );
  } catch {
    return new Date(epochMs).toISOString().slice(0, 10);
  }
}

/**
 * The player's name as the card may show it.
 *
 * @param name - The player's display name.
 * @param include - The "show my name" toggle.
 * @returns The cleaned name, or null when it is off or empty.
 */
export function cardPlayerName(name: string | null | undefined, include: boolean): string | null {
  if (!include || !name) return null;
  return cleanCardText(name) || null;
}

/**
 * Whether the "show my name" toggle starts on: off in Streamer Mode, so a
 * card shared on stream never carries the player's name unless they ask.
 *
 * @param streamerMode - Settings → Gameplay → Streamer Mode.
 */
export function defaultIncludeName(streamerMode: boolean): boolean {
  return !streamerMode;
}

/**
 * The label of a round row.
 *
 * @param r - Round.
 * @param index - 0-based position in the show.
 */
export function roundLabel(r: CardRound, index: number): string {
  return `${r.isFinal ? 'Final' : `R${index + 1}`} · ${cleanCardText(r.name)}`;
}

interface Frame {
  align: 'left' | 'center';
  textX: number;
  textW: number;
  figure: CardLayout['figure'];
  badge: { x: number; y: number; r: number };
  titleY: number;
  title: [number, number];
  subY: number;
  sub: [number, number];
  nameY: number;
  name: [number, number];
  statsY: number;
  stats: number;
  rowsY: number;
  rowH: number;
  rowSize: [number, number];
  maxRows: number;
  dateY: number;
  dateSize: number;
  logo: CardLayout['logo'];
}

const FRAMES: Record<CardFormat, Frame> = {
  social: {
    align: 'left',
    textX: 590,
    textW: 560,
    figure: { x: 20, y: 50, size: 560 },
    badge: { x: 470, y: 120, r: 62 },
    titleY: 190,
    title: [92, 48],
    subY: 240,
    sub: [34, 22],
    nameY: 292,
    name: [36, 22],
    statsY: 350,
    stats: 26,
    rowsY: 396,
    rowH: 40,
    rowSize: [28, 18],
    maxRows: 4,
    dateY: 600,
    dateSize: 22,
    logo: { x: 1100, y: 74, size: 34 },
  },
  story: {
    align: 'center',
    textX: 540,
    textW: 940,
    figure: { x: 90, y: 250, size: 900 },
    badge: { x: 880, y: 340, r: 96 },
    titleY: 1290,
    title: [150, 64],
    subY: 1370,
    sub: [52, 30],
    nameY: 1450,
    name: [56, 30],
    statsY: 1540,
    stats: 40,
    rowsY: 1610,
    rowH: 56,
    rowSize: [40, 24],
    maxRows: 4,
    dateY: 1860,
    dateSize: 34,
    logo: { x: 540, y: 170, size: 64 },
  },
};

/**
 * Lays out a card.
 *
 * @param d - Card data (names already cleaned or not; they are cleaned here).
 * @param format - Variant.
 * @param measure - Width measurer for the target canvas.
 * @param locale - Date locale (default: the browser's).
 * @returns Every element's text, font and position.
 */
export function layoutShareCard(
  d: ShareCardData,
  format: CardFormat,
  measure: MeasureText,
  locale?: string,
): CardLayout {
  const f = FRAMES[format];
  const { width, height } = CARD_SIZES[format];
  const head = cardHeadline(d);
  const box = (
    text: string,
    y: number,
    family: string,
    [maxSize, minSize]: [number, number],
    weight = '400',
    x = f.textX,
    maxWidth = f.textW,
    align: TextBox['align'] = f.align,
  ): TextBox => {
    const fit = fitText(text, maxWidth, { family, weight, maxSize, minSize }, measure);
    return { ...fit, x, y, align, maxWidth };
  };

  const name = d.playerName ? cleanCardText(d.playerName) : '';
  const survived = roundsSurvived(d);
  const shown = d.rounds.length > f.maxRows ? d.rounds.slice(-(f.maxRows - 1)) : d.rounds;
  const hidden = d.rounds.length - shown.length;
  const firstShown = d.rounds.length - shown.length;
  const pipR = Math.round(f.rowH * 0.28);
  const rowTextW = f.textW - pipR * 3;
  const rowX = f.align === 'left' ? f.textX + pipR * 3 : f.textX + pipR * 1.5;
  const rows: RoundRow[] = shown.map((r, i) => {
    const y = f.rowsY + (i + (hidden > 0 ? 1 : 0)) * f.rowH;
    const b = box(roundLabel(r, firstShown + i), y, CARD_BODY_FONT, f.rowSize, '600', rowX, rowTextW);
    const textW = Math.min(rowTextW, measure(b.text, b.font));
    const pipX = f.align === 'left' ? f.textX + pipR : rowX - textW / 2 - pipR * 1.6;
    return { box: b, qualified: r.qualified, isFinal: r.isFinal, pipX, pipY: y - b.size * 0.35, pipR };
  });

  return {
    format,
    width,
    height,
    figure: { ...f.figure },
    badge: {
      ...f.badge,
      label: box(
        head.badge,
        f.badge.y + f.badge.r * 0.22,
        CARD_DISPLAY_FONT,
        [Math.round(f.badge.r * 0.62), Math.round(f.badge.r * 0.4)],
        '400',
        f.badge.x,
        f.badge.r * 1.5,
        'center',
      ),
    },
    title: box(head.title, f.titleY, CARD_DISPLAY_FONT, f.title),
    sub: box(head.sub, f.subY, CARD_BODY_FONT, f.sub, '600'),
    name: name ? box(name, f.nameY, CARD_DISPLAY_FONT, f.name) : null,
    stats: box(`${survived} ROUND${survived === 1 ? '' : 'S'} SURVIVED`, f.statsY, CARD_DISPLAY_FONT, [
      f.stats,
      Math.round(f.stats * 0.7),
    ]),
    rounds: rows,
    more:
      hidden > 0
        ? box(
            `+${hidden} earlier round${hidden === 1 ? '' : 's'}`,
            f.rowsY,
            CARD_BODY_FONT,
            f.rowSize,
            '500',
            rowX,
            rowTextW,
          )
        : null,
    date: box(formatCardDate(d.date, locale), f.dateY, CARD_BODY_FONT, [f.dateSize, f.dateSize - 6], '500'),
    logo: { ...f.logo },
  };
}
