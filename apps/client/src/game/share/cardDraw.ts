/**
 * Paints a laid-out share card in the game's sticker-candy style: a
 * sunburst backdrop in the result's colours, confetti, the posed Tumbler,
 * a chunky outlined headline, a round list with qualified / out pips, the
 * date and the TUMBLE ROYALE wordmark.
 *
 * Works on any 2D context (an `OffscreenCanvas` or a DOM canvas).
 */
import type { CardLayout, ShareCardData, TextBox } from './cardLayout.ts';
import { CARD_DISPLAY_FONT } from './cardLayout.ts';

/** Either flavour of 2D context. */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const INK = '#2b1a5e';
const CREAM = '#fff7ea';

interface Theme {
  bg: [string, string];
  ray: string;
  accent: string;
  badge: string;
}

function themeOf(d: ShareCardData): Theme {
  if (d.wonCrown)
    return { bg: ['#ffb84d', '#ff4f9a'], ray: 'rgba(255,255,255,0.16)', accent: '#ffd23f', badge: '#ffd23f' };
  if (d.reachedFinal)
    return { bg: ['#8a5cff', '#ff4f9a'], ray: 'rgba(255,255,255,0.12)', accent: '#3ee6b4', badge: '#3ee6b4' };
  return { bg: ['#5aa9ff', '#8a5cff'], ray: 'rgba(255,255,255,0.12)', accent: '#ffd23f', badge: '#ffffff' };
}

/** Deterministic 0..1 sequence so the same card always gets the same confetti. */
function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function backdrop(ctx: Ctx2D, l: CardLayout, t: Theme, seed: number): void {
  const g = ctx.createLinearGradient(0, 0, l.width, l.height);
  g.addColorStop(0, t.bg[0]);
  g.addColorStop(1, t.bg[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, l.width, l.height);

  const cx = l.figure.x + l.figure.size / 2;
  const cy = l.figure.y + l.figure.size / 2;
  const reach = Math.hypot(l.width, l.height);
  ctx.fillStyle = t.ray;
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * reach, cy + Math.sin(a) * reach);
    ctx.lineTo(cx + Math.cos(a + Math.PI / 18) * reach, cy + Math.sin(a + Math.PI / 18) * reach);
    ctx.closePath();
    ctx.fill();
  }

  const r = rand(seed);
  const colors = ['#ffd23f', '#3ee6b4', '#ff4f9a', '#ffffff', '#5aa9ff'];
  for (let i = 0; i < 46; i++) {
    const x = r() * l.width;
    const y = r() * l.height;
    const s = 6 + r() * 12;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(r() * Math.PI);
    ctx.globalAlpha = 0.55 + r() * 0.35;
    ctx.fillStyle = colors[i % colors.length] as string;
    if (i % 3 === 0) {
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.5, 0, Math.PI * 2);
      ctx.fill();
    } else ctx.fillRect(-s / 2, -s / 5, s, s / 2.5);
    ctx.restore();
  }

  // Stage disc under the Tumbler's feet.
  ctx.save();
  ctx.fillStyle = 'rgba(43,26,94,0.28)';
  ctx.beginPath();
  ctx.ellipse(
    cx,
    l.figure.y + l.figure.size * 0.93,
    l.figure.size * 0.3,
    l.figure.size * 0.05,
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();
}

function stickerText(ctx: Ctx2D, b: TextBox, fill: string, stroke = INK, strokeScale = 0.2): void {
  ctx.font = b.font;
  ctx.textAlign = b.align;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, b.size * strokeScale);
  ctx.strokeStyle = stroke;
  ctx.strokeText(b.text, b.x, b.y, b.maxWidth);
  ctx.fillStyle = fill;
  ctx.fillText(b.text, b.x, b.y, b.maxWidth);
}

function plainText(ctx: Ctx2D, b: TextBox, fill: string): void {
  ctx.font = b.font;
  ctx.textAlign = b.align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = fill;
  ctx.fillText(b.text, b.x, b.y, b.maxWidth);
}

function roundedRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function crown(ctx: Ctx2D, x: number, y: number, s: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(-s, s * 0.5);
  ctx.lineTo(-s, -s * 0.35);
  ctx.lineTo(-s * 0.5, s * 0.05);
  ctx.lineTo(0, -s * 0.6);
  ctx.lineTo(s * 0.5, s * 0.05);
  ctx.lineTo(s, -s * 0.35);
  ctx.lineTo(s, s * 0.5);
  ctx.closePath();
  ctx.fillStyle = '#ffd23f';
  ctx.fill();
  ctx.lineWidth = s * 0.18;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
}

function badge(ctx: Ctx2D, l: CardLayout, d: ShareCardData, t: Theme): void {
  const { x, y, r } = l.badge;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(0.12);
  ctx.beginPath();
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.86;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = t.badge;
  ctx.fill();
  ctx.lineWidth = r * 0.09;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
  if (d.wonCrown) crown(ctx, x, y - r * 0.05, r * 0.5);
  else stickerText(ctx, l.badge.label, INK, CREAM, 0.12);
}

function pip(ctx: Ctx2D, row: CardLayout['rounds'][number]): void {
  const { pipX: x, pipY: y, pipR: r } = row;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = row.qualified ? '#3ee6b4' : '#ff4f6b';
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.25);
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.beginPath();
  ctx.lineWidth = Math.max(2, r * 0.28);
  ctx.lineCap = 'round';
  if (row.qualified) {
    ctx.moveTo(x - r * 0.45, y);
    ctx.lineTo(x - r * 0.1, y + r * 0.35);
    ctx.lineTo(x + r * 0.5, y - r * 0.35);
  } else {
    ctx.moveTo(x - r * 0.35, y - r * 0.35);
    ctx.lineTo(x + r * 0.35, y + r * 0.35);
    ctx.moveTo(x + r * 0.35, y - r * 0.35);
    ctx.lineTo(x - r * 0.35, y + r * 0.35);
  }
  ctx.stroke();
}

/**
 * The two-line TUMBLE / ROYALE sticker wordmark.
 *
 * @param ctx - Target.
 * @param x - Centre x.
 * @param y - Centre y.
 * @param size - Cap height of each line (px).
 * @param align - Horizontal anchor of both lines.
 */
export function drawWordmark(
  ctx: Ctx2D,
  x: number,
  y: number,
  size: number,
  align: CanvasTextAlign = 'center',
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.05);
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.font = `400 ${size}px ${CARD_DISPLAY_FONT}`;
  const line = (text: string, dy: number, fill: string): void => {
    ctx.lineWidth = size * 0.3;
    ctx.strokeStyle = INK;
    ctx.strokeText(text, 0, dy);
    ctx.fillStyle = fill;
    ctx.fillText(text, 0, dy);
  };
  line('TUMBLE', -size * 0.5, '#ffffff');
  line('ROYALE', size * 0.5, '#ffd23f');
  ctx.restore();
}

/**
 * Paints a whole card.
 *
 * @param ctx - 2D context sized `layout.width × layout.height`.
 * @param l - Layout from `layoutShareCard`.
 * @param d - The data it was laid out from (colours, crown).
 * @param figure - The posed Tumbler (transparent background), or null to leave the stage empty.
 */
export function drawShareCard(
  ctx: Ctx2D,
  l: CardLayout,
  d: ShareCardData,
  figure: CanvasImageSource | null,
): void {
  const t = themeOf(d);
  backdrop(ctx, l, t, d.date ^ (d.place * 7919));
  if (figure) ctx.drawImage(figure, l.figure.x, l.figure.y, l.figure.size, l.figure.size);
  badge(ctx, l, d, t);

  // Text panel: a soft ink card behind the words keeps them readable over any colours.
  const left = l.format === 'social' ? l.title.x - 26 : 40;
  const top = l.title.y - l.title.size - 30;
  const right = l.format === 'social' ? l.width - 24 : l.width - 40;
  const bottom = l.date.y + 26;
  ctx.save();
  ctx.globalAlpha = 0.82;
  roundedRect(ctx, left, top, right - left, bottom - top, 34);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.restore();

  stickerText(ctx, l.title, t.accent, INK, 0.16);
  plainText(ctx, l.sub, CREAM);
  if (l.name) stickerText(ctx, l.name, '#ffffff', '#ff4f9a', 0.14);
  stickerText(ctx, l.stats, t.accent, INK, 0.12);
  if (l.more) plainText(ctx, l.more, 'rgba(255,247,234,0.7)');
  for (const row of l.rounds) {
    pip(ctx, row);
    plainText(ctx, row.box, row.qualified ? CREAM : 'rgba(255,247,234,0.72)');
  }
  plainText(ctx, l.date, 'rgba(255,247,234,0.8)');
  drawWordmark(ctx, l.logo.x, l.logo.y, l.logo.size, l.format === 'social' ? 'right' : 'center');
}
