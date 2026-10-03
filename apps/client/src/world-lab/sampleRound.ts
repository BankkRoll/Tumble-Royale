import { RoundDefinitionSchema, type RoundDefinition, type RoundDefinitionInput } from '@tumble/shared';

/**
 * Hand-made lab course that exercises every `StaticPiece` shape, surface and
 * pattern, grab edges, decorative pieces and every zone-marker trigger kind.
 * Runs along +Z like real races.
 */

type Piece = RoundDefinitionInput['geometry'][number];

const geometry: Piece[] = [];
const add = (p: Piece): void => {
  geometry.push(p);
};

// Start pad: checker so the lab shows world-space patterns lining up across pieces.
add({ shape: 'box', position: { x: 0, y: -0.5, z: 0 }, size: { x: 18, y: 1, z: 12 }, color: 'neutral', pattern: 'checker', bevel: 0.3 });
add({ shape: 'box', position: { x: 0, y: -1.6, z: 0 }, size: { x: 18.6, y: 1.2, z: 12.6 }, color: 'structure', bevel: 0.4, decorative: true });

// Ramp up to the first deck (safe stripes).
add({ shape: 'ramp', position: { x: 0, y: 1, z: 9 }, size: { x: 8, y: 2, z: 6 }, color: 'safe', pattern: 'stripes' });
add({ shape: 'box', position: { x: 0, y: 1.5, z: 16 }, size: { x: 14, y: 1, z: 8 }, color: 'primary', pattern: 'dots' });

// Ice lane with sparkles.
add({ shape: 'box', position: { x: 0, y: 1.5, z: 26 }, size: { x: 10, y: 1, z: 12 }, color: 'accent', surface: 'ice' });

// Hazard-tape walls either side.
add({ shape: 'box', position: { x: -6, y: 3, z: 26 }, size: { x: 0.8, y: 2, z: 10 }, color: 'danger', pattern: 'hazard' });
add({ shape: 'box', position: { x: 6, y: 3, z: 26 }, size: { x: 0.8, y: 2, z: 10 }, color: 'danger', pattern: 'hazard' });

// Conveyor strip (chevrons scroll), sticky patch, slime pool.
add({ shape: 'box', position: { x: -4, y: 1.5, z: 38 }, size: { x: 5, y: 1, z: 12 }, color: 'secondary', surface: 'conveyor' });
add({ shape: 'box', position: { x: 2.5, y: 1.5, z: 38 }, size: { x: 7, y: 1, z: 12 }, color: '#7a5fd1', surface: 'sticky' });
add({ shape: 'box', position: { x: 0, y: 1.2, z: 50 }, size: { x: 14, y: 0.6, z: 10 }, color: '#7cf27c', surface: 'slime', bevel: 0.25 });

// Bouncy jelly drums.
for (let i = 0; i < 3; i++) {
  add({ shape: 'cylinder', position: { x: -4 + i * 4, y: 2, z: 60 }, size: { x: 1.6, y: 1, z: 0 }, color: 'accent', surface: 'bouncy', bevel: 0.3 });
}

// Hex stepping stones over the void.
const hexColors = ['primary', 'secondary', 'safe', 'accent', 'interact'];
for (let i = 0; i < 10; i++) {
  add({
    shape: 'hexPrism',
    position: { x: ((i % 2) * 2 - 1) * 2.4, y: 1.5 + Math.sin(i) * 0.3, z: 68 + i * 3 },
    size: { x: 1.8, y: 1, z: 0 },
    color: hexColors[i % hexColors.length]!,
  });
}

// Grabbable climb wall with yellow trim, then a slide back down.
add({ shape: 'box', position: { x: 0, y: 4.5, z: 102 }, size: { x: 12, y: 7, z: 2 }, color: 'structure', grabbable: true, pattern: 'chevron' });
add({ shape: 'box', position: { x: 0, y: 7.5, z: 108 }, size: { x: 12, y: 1, z: 10 }, color: 'secondary', grabbable: true });
add({ shape: 'ramp', position: { x: 0, y: 4.5, z: 120 }, size: { x: 8, y: 5, z: 14 }, rotation: { yaw: 180 }, color: 'primary', surface: 'slide' });

// Wedge roofs, a torus hoop, an arch doorway, spheres.
add({ shape: 'wedge', position: { x: -9, y: 1, z: 16 }, size: { x: 4, y: 3, z: 6 }, color: 'danger' });
add({ shape: 'wedge', position: { x: 9, y: 1, z: 16 }, size: { x: 4, y: 3, z: 6 }, color: 'accent', pattern: 'stripes' });
add({ shape: 'torus', position: { x: 0, y: 5, z: 60 }, size: { x: 3, y: 0.35, z: 0 }, color: 'interact', decorative: true });
add({ shape: 'arch', position: { x: 0, y: 4, z: 46 }, size: { x: 10, y: 5, z: 1.5 }, color: 'secondary', pattern: 'stripes' });
add({ shape: 'sphere', position: { x: -8, y: 2.5, z: 0 }, size: { x: 1.5, y: 0, z: 0 }, color: 'interact', surface: 'bouncy' });
add({ shape: 'sphere', position: { x: 8, y: 2.5, z: 0 }, size: { x: 1.5, y: 0, z: 0 }, color: 'safe', decorative: true });
add({ shape: 'cylinder', position: { x: 0, y: -4, z: 60 }, size: { x: 1.2, y: 8, z: 0 }, color: 'structure', decorative: true });

// Finish plaza with team goals and a logic zone.
add({ shape: 'box', position: { x: 0, y: 1.5, z: 136 }, size: { x: 22, y: 1, z: 18 }, color: 'neutral', pattern: 'checker', bevel: 0.35 });
add({ shape: 'cylinder', position: { x: 0, y: -1.5, z: 136 }, size: { x: 9, y: 5, z: 0 }, color: 'structure', decorative: true });

const input: RoundDefinitionInput = {
  id: 'world-lab',
  name: 'World Lab',
  type: 'race',
  theme: 'candy',
  objective: 'Look at every surface.',
  players: { min: 1, max: 40, ideal: 20 },
  qualification: { mode: 'finish' },
  duration: { seconds: 120 },
  bounds: { min: { x: -30, y: -30, z: -20 }, max: { x: 30, y: 30, z: 160 } },
  spawn: { origin: { x: 0, y: 0.5, z: 0 } },
  geometry,
  triggers: [
    { id: 'goal-0', kind: 'goal', index: 0, position: { x: -6, y: 2.6, z: 132 }, size: { x: 6, y: 1.2, z: 5 } },
    { id: 'goal-1', kind: 'goal', index: 1, position: { x: 6, y: 2.6, z: 132 }, size: { x: 6, y: 1.2, z: 5 } },
    { id: 'nest-2', kind: 'nest', index: 2, position: { x: -6, y: 2.6, z: 140 }, size: { x: 6, y: 1.2, z: 5 } },
    { id: 'nest-3', kind: 'nest', index: 3, position: { x: 6, y: 2.6, z: 140 }, size: { x: 6, y: 1.2, z: 5 } },
    { id: 'zone-a', kind: 'zone', position: { x: 0, y: 2.6, z: 16 }, size: { x: 5, y: 1, z: 5 } },
  ],
  flyover: { path: [{ x: 0, y: 20, z: -20 }, { x: 0, y: 12, z: 140 }], lookAt: [{ x: 0, y: 0, z: 60 }] },
  music: 'lab',
  fallBehavior: 'respawnCheckpoint',
};

/** Parsed lab round (defaults applied). */
export const SAMPLE_ROUND: RoundDefinition = RoundDefinitionSchema.parse(input);
