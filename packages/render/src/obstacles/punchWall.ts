/**
 * Punch wall visual: a chunky lilac wall with framed sockets and striped
 * boxing pistons. Each piston pulses its own glow during wind-up.
 */
import { CylinderGeometry, Group, SphereGeometry, type MeshToonNodeMaterial } from 'three/webgpu';
import type { ObstacleInstance } from '@tumble/sim';
import {
  PUNCH_PISTON_DEPTH,
  punchPistonTelegraph,
  punchPistonX,
  punchWall,
  punchWallPose,
  punchWallSchema,
  type PunchWallParams,
} from '../../../sim/src/obstacles/punchWall.ts';
import type { ObstacleVisualContext, ObstacleVisualFactory } from './types.ts';
import {
  ObstacleColors as C,
  VisualBase,
  addOutline,
  applyPose,
  createPatternMaterial,
  poseBufferFor,
  roundedBox,
  setGlow,
  shadedMesh,
} from './visual-helpers-a.ts';

class PunchWallVisual extends VisualBase<PunchWallParams> {
  private readonly pistons: Group[] = [];
  private readonly gloveMats: MeshToonNodeMaterial[] = [];
  private readonly poses;

  constructor(instance: ObstacleInstance, private readonly ctx: ObstacleVisualContext) {
    super(instance, punchWallSchema.parse(instance.params));
    const p = this.params;
    this.poses = poseBufferFor(punchWall, p, ctx.speedScale);

    const width = p.pistonCount * p.pistonSpacing + 0.6;
    const wall = this.add(
      shadedMesh(roundedBox(width, p.wallHeight, p.wallThickness, 0.25), createPatternMaterial({ a: C.lilac, b: C.grape, pattern: 'checker', scale: 1.2 })),
    );
    wall.position.set(0, p.wallHeight / 2, -0.05);
    const trim = this.add(shadedMesh(roundedBox(width + 0.3, 0.35, p.wallThickness + 0.3, 0.15), createPatternMaterial({ a: C.interact })));
    trim.position.set(0, p.wallHeight, -0.05);

    const socketGeo = roundedBox(p.pistonSize + 0.35, p.pistonSize + 0.35, 0.2, 0.1);
    const socketMat = createPatternMaterial({ a: C.ink });
    const gloveGeo = roundedBox(p.pistonSize, p.pistonSize, PUNCH_PISTON_DEPTH, 0.28);
    const knuckleGeo = new SphereGeometry(p.pistonSize * 0.42, 24, 12);
    const rodGeo = new CylinderGeometry(p.pistonSize * 0.16, p.pistonSize * 0.16, p.reach + 1.2, 16);
    const rodMat = createPatternMaterial({ a: C.cream, b: C.lilac, pattern: 'bands', scale: 3 });
    for (let i = 0; i < p.pistonCount; i++) {
      const socket = this.add(shadedMesh(socketGeo, socketMat, false));
      socket.position.set(punchPistonX(i, p), p.pistonHeight, p.wallThickness / 2 - 0.05);

      const mat = createPatternMaterial({ a: C.danger, b: C.dangerAlt, pattern: 'stripes', scale: 1.6, emissive: C.glowWarn });
      this.gloveMats.push(mat);
      const g = new Group();
      const glove = shadedMesh(gloveGeo, mat);
      g.add(glove);
      const knuckle = shadedMesh(knuckleGeo, mat);
      knuckle.scale.set(1.05, 0.8, 0.55);
      knuckle.position.z = PUNCH_PISTON_DEPTH * 0.45;
      addOutline(knuckle, 0.03);
      g.add(knuckle);
      const rod = shadedMesh(rodGeo, rodMat);
      rod.rotation.x = Math.PI / 2;
      rod.position.z = -(p.reach + 1.2) / 2;
      g.add(rod);
      this.pistons.push(this.add(g));
    }
  }

  update(t: number): void {
    const s = this.ctx.speedScale;
    punchWallPose(t, this.params, this.poses, s);
    for (let i = 0; i < this.pistons.length; i++) {
      applyPose(this.pistons[i]!, this.poses[i]!);
      setGlow(this.gloveMats[i]!, 0.08 + punchPistonTelegraph(t, i, this.params, s) * 1.2);
    }
  }
}

/** Punch wall visual factory. */
export const punchWallVisual: ObstacleVisualFactory = (instance, ctx) => new PunchWallVisual(instance, ctx);
