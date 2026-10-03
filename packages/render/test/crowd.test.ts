import { describe, expect, it } from 'vitest';
import { Scene, type BufferGeometry, type Mesh } from 'three/webgpu';
import { randomLoadout } from '@tumble/content/cosmetics';
import { Rng } from '@tumble/shared';
import { CharacterState } from '@tumble/sim';
import { TumblerCrowd } from '../src/character/crowd.ts';
import { Tumbler } from '../src/character/tumbler.ts';
import { TOTAL_BONE_COUNT } from '../src/character/rig.ts';

const anim = { state: CharacterState.Idle, stateTime: 0, speed: 0, verticalSpeed: 0, facing: 0, grounded: true, emote: null };

function sync(c: TumblerCrowd, frame: number): void {
  (c as unknown as { sync(r: { info: { frame: number } }): void }).sync({ info: { frame } });
}

describe('TumblerCrowd', () => {
  it('packs members per LOD, hides their own meshes and collapses hidden ones', () => {
    const scene = new Scene();
    const crowd = new TumblerCrowd({ capacity: 8 });
    scene.add(crowd.object);
    const rng = new Rng(4);
    const ts = [0, 1, 2].map(() => new Tumbler(randomLoadout(rng)));
    ts.forEach((t, i) => {
      scene.add(t.object);
      t.object.position.x = i * 2;
      t.setLod(i === 2 ? 2 : 1);
      t.update(1 / 60, { ...anim });
      expect(crowd.add(t)).toBe(true);
    });
    scene.updateMatrixWorld(true);
    sync(crowd, 1);

    const body = (lod: number): Mesh => crowd.object.getObjectByName(`crowd-body-lod${lod}`) as Mesh;
    const count = (lod: number): number => (body(lod).geometry as BufferGeometry).drawRange.count;
    expect(count(0)).toBe(0);
    expect(count(1)).toBeGreaterThan(0);
    expect(count(2)).toBeGreaterThan(0);
    // The members' own skinned meshes no longer render.
    let ownVisible = 0;
    for (const t of ts) t.object.traverse((o) => ((o as Mesh).isMesh && o.visible && o.name !== '' ? ownVisible++ : 0));
    expect(ownVisible).toBe(0);

    const bones = (crowd as unknown as { boneData: Float32Array }).boneData;
    const row = (r: number): Float32Array => bones.subarray(r * TOTAL_BONE_COUNT * 16, (r + 1) * TOTAL_BONE_COUNT * 16);
    expect(row(0).some((v) => v !== 0)).toBe(true);
    ts[0]!.object.visible = false;
    sync(crowd, 2);
    expect(row(0).every((v) => v === 0)).toBe(true);

    // Moving a member to LOD 0 moves its triangles between index lists. LOD 0 was empty (its
    // meshes missed this frame's render list), so the member keeps its old LOD for one frame.
    const before1 = count(1);
    ts[1]!.setLod(0);
    sync(crowd, 3);
    expect(count(1)).toBe(before1);
    sync(crowd, 4);
    expect(count(0)).toBeGreaterThan(0);
    expect(count(1)).toBeLessThan(before1);

    for (const t of ts) t.dispose();
    expect(crowd.size).toBe(0);
    crowd.dispose();
  });
});
