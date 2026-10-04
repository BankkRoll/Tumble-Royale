/**
 * Renders the app icons in `public/icons/` from `public/icons/icon.svg` (the
 * boot screen's Tumbler on the sky gradient). Run after editing the SVG:
 *
 *   node scripts/render-icons.mjs
 *
 * Uses the installed Edge through Playwright (`PW_CHANNEL=chromium` for the
 * bundled Chromium). The maskable and Apple variants fill the whole square:
 * the platform crops its own shape, and the Tumbler sits inside the 80 %
 * safe zone either way.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const dir = resolve(import.meta.dirname, '../public/icons');
const rounded = readFileSync(resolve(dir, 'icon.svg'), 'utf8');
const square = rounded.replace('rx="112"', 'rx="0"');

const targets = [
  { file: 'icon-192.png', svg: rounded, size: 192 },
  { file: 'icon-512.png', svg: rounded, size: 512 },
  { file: 'icon-maskable-512.png', svg: square, size: 512 },
  { file: 'apple-touch-icon.png', svg: square, size: 180 },
  { file: 'favicon-32.png', svg: rounded, size: 32 },
];

const channel = process.env.PW_CHANNEL === 'chromium' ? undefined : (process.env.PW_CHANNEL ?? 'msedge');
const browser = await chromium.launch({ channel });
try {
  const page = await browser.newPage();
  for (const t of targets) {
    await page.setViewportSize({ width: t.size, height: t.size });
    const src = `data:image/svg+xml;base64,${Buffer.from(t.svg).toString('base64')}`;
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}</style><img src="${src}" width="${t.size}" height="${t.size}">`,
    );
    await page.waitForFunction(() => document.images[0]?.complete);
    writeFileSync(resolve(dir, t.file), await page.screenshot({ omitBackground: true }));
    console.log(`wrote icons/${t.file}`);
  }
} finally {
  await browser.close();
}
