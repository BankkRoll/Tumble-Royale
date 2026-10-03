/**
 * Cubby grid for the 3D player wall: a pure function so the layout math is
 * testable without a renderer.
 */

/** Cubby width (m). */
export const WALL_CELL_W = 2.3;
/** Cubby height (m). */
export const WALL_CELL_H = 2.7;
/** Frame thickness around the grid (m). */
export const WALL_FRAME = 0.9;
/** Headroom the camera keeps above the wall for the header banner (m). */
export const WALL_HEADER = 4.5;

/** A cubby grid. */
export interface PlayerWallGrid {
  cols: number;
  rows: number;
}

/**
 * Picks the column count that shows the cubbies largest on screen. The
 * camera backs off until the whole wall (plus header) fits, so the best grid
 * is the one whose framed size, compared at the viewport's aspect, is
 * smallest; ties go to the grid with fewer empty cubbies.
 *
 * @param capacity - Cubbies needed (at least 1).
 * @param aspect - Viewport width / height the recap is framed for.
 * @returns Columns and rows with `cols × rows ≥ capacity` and no empty row.
 * @example
 * playerWallGrid(100); // { cols: 17, rows: 6 } at 16:9
 */
export function playerWallGrid(capacity: number, aspect = 16 / 9): PlayerWallGrid {
  const n = Math.max(1, Math.floor(capacity));
  let best = { cols: n, rows: 1, extent: Infinity, empty: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    // Skip grids whose last row would be empty; a narrower grid holds the same cells.
    if ((rows - 1) * cols >= n) continue;
    const w = cols * WALL_CELL_W + WALL_FRAME * 2;
    const h = rows * WALL_CELL_H + WALL_FRAME * 2 + WALL_HEADER;
    const extent = Math.max(w / aspect, h);
    const empty = cols * rows - n;
    if (extent < best.extent - 1e-9 || (Math.abs(extent - best.extent) <= 1e-9 && empty < best.empty))
      best = { cols, rows, extent, empty };
  }
  return { cols: best.cols, rows: best.rows };
}
