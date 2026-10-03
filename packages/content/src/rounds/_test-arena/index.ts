/**
 * Test Arena — a small but complete race used by tests, bot smoke runs and
 * the level page before the real rounds land. ~62 m: start pad, a jump gap,
 * a forked run past a bounce pad, a ramp, a sweeper deck with a checkpoint,
 * a second gap and the finish.
 *
 * Obstacles use their library defaults (`params: {}`) so the arena stays
 * valid however the obstacle modules evolve.
 */
import { defineRound } from '@tumble/shared';

export default defineRound({
  id: 'test-arena',
  name: 'Test Arena',
  type: 'race',
  theme: 'candy',
  objective: 'Race to the finish line!',
  tips: ['Jump the gaps', 'Hop over the spinning sweeper', 'Bounce pads launch you high'],
  players: { min: 1, max: 100, ideal: 100 },
  qualification: { mode: 'finish', ratio: 0.65 },
  duration: { seconds: 120, overtimeSeconds: 0 },
  killY: -12,
  bounds: { min: { x: -40, y: -20, z: -20 }, max: { x: 40, y: 30, z: 90 } },
  spawn: { origin: { x: 0, y: 0, z: -2 }, yaw: 0, cols: 8, spacing: 1.4 },
  geometry: [
    { shape: 'box', position: { x: 0, y: -0.5, z: 0 }, size: { x: 14, y: 1, z: 12 }, color: 'safe' },
    { shape: 'box', position: { x: 0, y: -0.5, z: 14 }, size: { x: 10, y: 1, z: 12 }, color: 'primary' },
    {
      shape: 'ramp',
      position: { x: 0, y: 1, z: 24 },
      size: { x: 8, y: 2, z: 8 },
      color: 'secondary',
      pattern: 'chevron',
    },
    { shape: 'box', position: { x: 0, y: 1.5, z: 36 }, size: { x: 10, y: 1, z: 16 }, color: 'primary' },
    { shape: 'box', position: { x: 0, y: 1.5, z: 53 }, size: { x: 10, y: 1, z: 14 }, color: 'safe' },
    { shape: 'arch', position: { x: 0, y: 5, z: 58 }, size: { x: 11, y: 5, z: 1 }, color: 'accent' },
    {
      shape: 'cylinder',
      position: { x: -6.5, y: 0, z: 14 },
      size: { x: 0.6, y: 3, z: 0 },
      decorative: true,
      color: 'accent',
    },
    {
      shape: 'sphere',
      position: { x: 7, y: 3, z: 36 },
      size: { x: 1, y: 1, z: 1 },
      decorative: true,
      color: 'accent',
    },
  ],
  obstacles: [
    { id: 'sweep-1', type: 'sweeperArm', position: { x: 0, y: 2, z: 36 }, params: {} },
    { id: 'pad-1', type: 'bouncePad', position: { x: 3.5, y: 0, z: 16 }, params: {} },
  ],
  triggers: [
    {
      id: 'cp-1',
      kind: 'checkpoint',
      index: 1,
      position: { x: 0, y: 3.5, z: 30 },
      size: { x: 10, y: 3, z: 2 },
      respawn: [
        { x: -2.5, y: 2, z: 30 },
        { x: 0, y: 2, z: 30 },
        { x: 2.5, y: 2, z: 30 },
      ],
      respawnYaw: 0,
    },
    { id: 'finish', kind: 'finish', position: { x: 0, y: 3.5, z: 57 }, size: { x: 10, y: 3, z: 2 } },
    { id: 'void', kind: 'void', position: { x: 0, y: -8, z: 30 }, size: { x: 80, y: 2, z: 120 } },
  ],
  flyover: {
    path: [
      { x: 0, y: 14, z: 72 },
      { x: 10, y: 10, z: 36 },
      { x: 0, y: 8, z: -12 },
    ],
    lookAt: [{ x: 0, y: 1, z: 28 }],
    duration: 6,
  },
  music: 'candy-race',
  speedScaleByStage: [1, 1.1, 1.2, 1.3, 1.4],
  fallBehavior: 'respawnCheckpoint',
  botNav: [
    { id: 0, position: { x: 0, y: 0, z: 4.5 }, radius: 1.2, next: [1, 2], action: 'jump' },
    { id: 1, position: { x: 1.5, y: 0, z: 12 }, next: [3] },
    { id: 2, position: { x: -1.5, y: 0, z: 12 }, next: [3] },
    { id: 3, position: { x: 0, y: 0, z: 19 }, next: [4] },
    { id: 4, position: { x: 0, y: 2, z: 29.5 }, next: [5] },
    { id: 5, position: { x: 0, y: 2, z: 43 }, radius: 1, next: [6], action: 'jump' },
    { id: 6, position: { x: 0, y: 2, z: 51 }, next: [7] },
    { id: 7, position: { x: 0, y: 2, z: 58 }, next: [] },
  ],
  variations: [
    { id: 'standard', weight: 3, description: 'The usual.' },
    {
      id: 'no-pad',
      weight: 1,
      description: 'Bounce pad removed, a second sweeper guards the finish deck.',
      removeObstacles: ['pad-1'],
      addObstacles: [{ id: 'sweep-2', type: 'sweeperArm', position: { x: 0, y: 2, z: 52 }, params: {} }],
    },
  ],
  designNotes: 'Engineering fixture: every system touched once. Not in any playlist pool.',
});
