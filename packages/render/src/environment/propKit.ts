import {
  BufferGeometry,
  CapsuleGeometry,
  Color,
  Euler,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Quaternion,
  TorusGeometry,
  Vector2,
  Vector3,
  type MeshToonNodeMaterial,
  type Node,
} from 'three/webgpu';
import { attribute, diffuseColor, float, sin, uniform, vec3, positionLocal } from 'three/tsl';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createToonMaterial } from '../materials/toon.ts';
import { createBeveledCylinderGeometry, createHexPrismGeometry } from '../level/geometry.ts';

/**
 * Instanced primitive kit for set dressing. Decor (islands, trees, lollipops,
 * towers, crystals…) is authored as a list of primitive placements; the kit
 * batches them into one InstancedMesh per primitive with per-instance colour,
 * so an entire sky full of islands costs ~7 draw calls. A per-instance
 * `aBob` attribute (phase, amplitude, glow) gives gentle floating and night glow
 * entirely on the GPU.
 */

/** Primitive shapes available to decor. All are unit-sized and centred. */
export type PrimitiveKind = 'cyl' | 'cone' | 'sphere' | 'box' | 'torus' | 'hex' | 'capsule';

/** Unit primitive geometries. */
function primitiveGeometry(kind: PrimitiveKind): BufferGeometry {
  switch (kind) {
    case 'cyl':
      return createBeveledCylinderGeometry(1, 1, 0.12, 1, 24);
    case 'cone': {
      const pts: Vector2[] = [new Vector2(0, -0.5)];
      pts.push(new Vector2(0.92, -0.5), new Vector2(1, -0.44), new Vector2(0.96, -0.36));
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        pts.push(new Vector2(0.96 * (1 - t) + 0.06 * t, -0.36 + t * 0.82));
      }
      pts.push(new Vector2(0.03, 0.49), new Vector2(0, 0.5));
      return new LatheGeometry(pts, 20);
    }
    case 'sphere':
      return new IcosahedronGeometry(1, 2);
    case 'box':
      return new RoundedBoxGeometry(1, 1, 1, 2, 0.14);
    case 'torus':
      return new TorusGeometry(1, 0.28, 10, 32);
    case 'hex':
      return createHexPrismGeometry(1, 1, 0.08, 0);
    case 'capsule':
      return new CapsuleGeometry(0.5, 1, 4, 12);
  }
}

/** One primitive placement. */
export interface PropInstance {
  kind: PrimitiveKind;
  position: Vector3;
  rotation: Euler;
  scale: Vector3;
  color: Color;
  /** Float phase; instances sharing a phase bob together (one island). */
  bobPhase: number;
  bobAmp: number;
  /** Emissive factor 0..1 (neon signs, lanterns). Scaled by the kit's glow uniform. */
  glow: number;
}

/** Live batched decor. */
export interface PropBatch {
  readonly meshes: InstancedMesh[];
  /** Overall glow multiplier (night). */
  setGlow(amount: number): void;
  update(dt: number): void;
  dispose(): void;
}

/**
 * Collects primitive placements; call {@link PropBuilder.build} once.
 */
export class PropBuilder {
  readonly items: PropInstance[] = [];
  private phase = 0;
  private amp = 0;

  /** Subsequent placements bob with this phase/amplitude (one floating island). */
  group(phase: number, amp: number): this {
    this.phase = phase;
    this.amp = amp;
    return this;
  }

  /**
   * Adds a primitive.
   *
   * @param kind - Primitive.
   * @param x - Position.
   * @param sx - Scale (cyl/cone/hex: radius on X/Z and height on Y; sphere: radii).
   * @param color - Hex colour.
   * @param rot - Optional Euler in radians (x, y, z).
   * @param glow - Emissive factor.
   */
  add(
    kind: PrimitiveKind,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    color: string,
    rot?: [number, number, number],
    glow = 0,
  ): this {
    this.items.push({
      kind,
      position: new Vector3(x, y, z),
      rotation: new Euler(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0, 'YXZ'),
      scale: new Vector3(sx, sy, sz),
      color: new Color(color),
      bobPhase: this.phase,
      bobAmp: this.amp,
      glow,
    });
    return this;
  }

  /**
   * Batches all placements into instanced meshes.
   *
   * @param shadows - Whether decor casts shadows (only worth it for nearby props).
   */
  build(shadows = false): PropBatch {
    const time = uniform(0);
    const glowU = uniform(0.35);
    const mat: MeshToonNodeMaterial = createToonMaterial({ color: '#ffffff', rimStrength: 0.35 });
    const bob = attribute('aBob', 'vec3') as unknown as Node<'vec3'>;
    mat.positionNode = positionLocal.add(vec3(float(0), sin(time.mul(0.45).add(bob.x)).mul(bob.y), float(0)));
    const baseEmissive = (mat as MeshToonNodeMaterial & { emissiveNode: Node<'vec3'> }).emissiveNode;
    (mat as MeshToonNodeMaterial & { emissiveNode: Node }).emissiveNode = baseEmissive.add(
      diffuseColor.rgb.mul(bob.z.mul(glowU)),
    );

    const byKind = new Map<PrimitiveKind, PropInstance[]>();
    for (const it of this.items) {
      const list = byKind.get(it.kind) ?? [];
      list.push(it);
      byKind.set(it.kind, list);
    }

    const meshes: InstancedMesh[] = [];
    const m4 = new Matrix4();
    const q = new Quaternion();
    for (const [kind, list] of byKind) {
      const geo = primitiveGeometry(kind);
      const bobArr = new Float32Array(list.length * 3);
      const mesh = new InstancedMesh(geo, mat, list.length);
      list.forEach((it, i) => {
        q.setFromEuler(it.rotation);
        m4.compose(it.position, q, it.scale);
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, it.color);
        bobArr[i * 3] = it.bobPhase;
        bobArr[i * 3 + 1] = it.bobAmp;
        bobArr[i * 3 + 2] = it.glow;
      });
      geo.setAttribute('aBob', new InstancedBufferAttribute(bobArr, 3));
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      // Bobbing moves instances a little past their static bounds.
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 4;
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      mesh.name = `props:${kind}`;
      meshes.push(mesh);
    }

    return {
      meshes,
      setGlow(amount: number): void {
        glowU.value = amount;
      },
      update(dt: number): void {
        time.value += dt;
      },
      dispose(): void {
        for (const m of meshes) {
          m.geometry.dispose();
          m.dispose();
        }
        mat.dispose();
      },
    };
  }
}
