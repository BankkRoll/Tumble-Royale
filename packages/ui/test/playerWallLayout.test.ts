import { MAX_PLAYERS } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import { wallGrid } from '../src/screens/PlayerWall.tsx';

/** Cell height / width and the default gap and frame ratios of `wallGrid` (see wall.css). */
const ASPECT = 1.22;
const GAP = 0.1;
const FRAME = 0.42;

const VIEWPORTS = [
  { name: '1080p', w: 1920 * 0.9, h: 1080 * 0.62 },
  { name: '720p', w: 1280 * 0.9, h: 720 * 0.62 },
  { name: 'phone landscape', w: 844 * 0.9, h: 390 * 0.62 },
  { name: 'phone portrait', w: 390 * 0.9, h: 844 * 0.62 },
];

describe('wallGrid', () => {
  for (const vp of VIEWPORTS) {
    it(`fits every count up to ${MAX_PLAYERS} inside a ${vp.name} wall area`, () => {
      for (let n = 1; n <= MAX_PLAYERS; n++) {
        const g = wallGrid(n, vp.w, vp.h);
        expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
        // No empty trailing row: the column count is the one that maximises the cell.
        expect((g.rows - 1) * g.cols).toBeLessThan(n);
        expect(g.cell * (g.cols + GAP * (g.cols - 1) + FRAME)).toBeLessThanOrEqual(vp.w + 1e-6);
        expect(g.cell * (g.rows * ASPECT + GAP * (g.rows - 1) + FRAME)).toBeLessThanOrEqual(vp.h + 1e-6);
      }
    });
  }

  it(`keeps a full ${MAX_PLAYERS}-player wall legible on desktop and landscape phones`, () => {
    // A face needs ~40 px on a desktop and ~20 px on a phone to read as a Tumbler.
    expect(wallGrid(MAX_PLAYERS, VIEWPORTS[0]!.w, VIEWPORTS[0]!.h).cell).toBeGreaterThan(40);
    expect(wallGrid(MAX_PLAYERS, VIEWPORTS[2]!.w, VIEWPORTS[2]!.h).cell).toBeGreaterThan(18);
  });

  it('never shrinks cells when the field shrinks', () => {
    let prev = 0;
    for (let n = MAX_PLAYERS; n >= 1; n--) {
      const cell = wallGrid(n, 1700, 670).cell;
      expect(cell).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = cell;
    }
  });
});
