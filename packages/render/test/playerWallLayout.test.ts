import { MAX_PLAYERS } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import {
  WALL_CELL_H,
  WALL_CELL_W,
  WALL_FRAME,
  WALL_HEADER,
  playerWallGrid,
} from '../src/scenes/playerWallLayout.ts';

/** How far the camera must back off (relative) to frame a grid at `aspect`. */
function extent(cols: number, rows: number, aspect: number): number {
  const w = cols * WALL_CELL_W + WALL_FRAME * 2;
  const h = rows * WALL_CELL_H + WALL_FRAME * 2 + WALL_HEADER;
  return Math.max(w / aspect, h);
}

describe('playerWallGrid', () => {
  for (const aspect of [16 / 9, 4 / 3, 21 / 9, 9 / 16]) {
    it(`holds every field size up to ${MAX_PLAYERS} without an empty row at aspect ${aspect.toFixed(2)}`, () => {
      for (let n = 1; n <= MAX_PLAYERS; n++) {
        const g = playerWallGrid(n, aspect);
        expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
        expect((g.rows - 1) * g.cols).toBeLessThan(n);
        // No other grid frames the cubbies larger.
        for (let cols = 1; cols <= n; cols++) {
          const rows = Math.ceil(n / cols);
          expect(extent(g.cols, g.rows, aspect)).toBeLessThanOrEqual(extent(cols, rows, aspect) + 1e-9);
        }
      }
    });
  }

  it(`lays a full ${MAX_PLAYERS}-player wall out wide on a 16:9 screen`, () => {
    const g = playerWallGrid(MAX_PLAYERS);
    expect(g.cols).toBeGreaterThan(g.rows);
    // The old fixed 10-column wall made a square 10 × 10 block the camera had to back far off from.
    expect(extent(g.cols, g.rows, 16 / 9)).toBeLessThan(extent(10, 10, 16 / 9) * 0.8);
  });

  it('treats nonsense capacities as one cubby', () => {
    expect(playerWallGrid(0)).toEqual({ cols: 1, rows: 1 });
    expect(playerWallGrid(-5)).toEqual({ cols: 1, rows: 1 });
  });
});
