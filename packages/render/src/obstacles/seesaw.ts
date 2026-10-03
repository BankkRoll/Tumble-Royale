/**
 * Seesaw visual: a yellow-striped plank with mint grip pads on a pink
 * fulcrum wedge; plank angle from the replicated/predicted runtime.
 */
import { BufferGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group } from 'three/webgpu';
import type { ObstacleInstance, ObstacleRuntime } from '@tumble/sim';
import { seesawSchema, type SeesawParams, type SeesawView } from '../../../sim/src/obstacles/seesaw.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  createPatternMaterial,
  roundedBox,
  runtimeView,
  shadedMesh,
} from './visual-helpers-a.ts';

/** Triangular prism matching the sim's fulcrum hull. */
function wedgeGeometry(hw: number, h: number, hz: number): BufferGeometry {
  const v = [
    [-hw, 0, -hz],
    [hw, 0, -hz],
    [0, h, -hz],
    [-hw, 0, hz],
    [hw, 0, hz],
    [0, h, hz],
  ] as const;
  const tris = [
    [0, 2, 1],
    [3, 4, 5],
    [0, 1, 4],
    [0, 4, 3],
    [1, 2, 5],
    [1, 5, 4],
    [2, 0, 3],
    [2, 3, 5],
  ];
  const pos: number[] = [];
  for (const t of tris) for (const i of t) pos.push(...v[i]!);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

class SeesawVisual extends VisualBase<SeesawParams> {
  private readonly plank = new Group();

  constructor(instance: ObstacleInstance, _ctx: ObstacleVisualContext) {
    super(instance, seesawSchema.parse(instance.params));
    const p = this.params;
    if (p.fulcrum) {
      const hw = Math.min(1.1, p.length * 0.12);
      const wedgeMat = createPatternMaterial({ a: C.pink, b: C.danger, pattern: 'bands', scale: 2 });
      wedgeMat.side = DoubleSide;
      this.add(shadedMesh(wedgeGeometry(hw, p.pivotHeight - 0.08, p.width / 2 - 0.1), wedgeMat));
    }
    this.plank.position.y = p.pivotHeight;
    const board = shadedMesh(
      roundedBox(p.length, p.thickness, p.width, 0.14),
      createPatternMaterial({ a: C.interact, b: C.cream, pattern: 'stripes', scale: 1.1 }),
    );
    board.position.y = p.thickness / 2;
    this.plank.add(board);
    const padGeo = roundedBox(p.length * 0.18, 0.08, p.width * 0.85, 0.03);
    const padMat = createPatternMaterial({ a: C.mint, b: C.safe, pattern: 'checker', scale: 3 });
    for (const side of [-1, 1]) {
      const pad = shadedMesh(padGeo, padMat, false, true);
      pad.position.set(side * p.length * 0.38, p.thickness + 0.03, 0);
      this.plank.add(pad);
    }
    const axle = shadedMesh(new CylinderGeometry(0.22, 0.22, p.width + 0.3, 16), createPatternMaterial({ a: C.grape }));
    axle.rotation.x = Math.PI / 2;
    this.plank.add(axle);
    this.add(this.plank);
  }

  update(_t: number, _dt: number, runtime?: ObstacleRuntime): void {
    this.plank.rotation.z = runtimeView<SeesawView>(runtime, 'angle')?.angle ?? 0;
  }
}

/** Seesaw visual factory. */
export const seesawVisual: ObstacleVisualFactory = (instance, ctx) => new SeesawVisual(instance, ctx);
