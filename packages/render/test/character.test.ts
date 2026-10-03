import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_MESH_IDS,
  ANIM_CLIP_IDS,
  COSMETICS,
  PATTERN_IDS,
  randomLoadout,
} from '@tumble/content/cosmetics';
import { CharacterState } from '@tumble/sim';
import { Rng } from '@tumble/shared';
import { BUILT_ACCESSORIES } from '../src/character/accessories.ts';
import { Animator } from '../src/character/animator.ts';
import { acquireAssembly, releaseAssembly, assemblyCacheSize } from '../src/character/assembly.ts';
import { CLIPS, kf } from '../src/character/clips.ts';
import { SecondOrder } from '../src/character/dynamics.ts';
import { Kind, buildBaseGeometry } from '../src/character/geometry.ts';
import { SHADER_PATTERNS, SHADER_PUPILS } from '../src/character/material.ts';
import { CH, Pose, channelIndex } from '../src/character/pose.ts';
import { resolveLoadout } from '../src/character/resolve.ts';
import { CORE_BONE_COUNT, POOL_BONE_COUNT, TOTAL_BONE_COUNT } from '../src/character/rig.ts';
import type { TumblerAnimInput } from '../src/character/types.ts';

describe('character data coverage', () => {
  it('shader patterns mirror the content pattern ids in order', () => {
    expect([...SHADER_PATTERNS]).toEqual([...PATTERN_IDS]);
    expect(SHADER_PATTERNS.length).toBeGreaterThanOrEqual(14);
    expect(SHADER_PUPILS).toContain('round');
  });

  it('every accessory mesh id has a builder', () => {
    for (const list of Object.values(ACCESSORY_MESH_IDS))
      for (const id of list) expect(BUILT_ACCESSORIES).toContain(id);
  });

  it('every clip id has a clip', () => {
    for (const id of ANIM_CLIP_IDS) expect(CLIPS[id].duration).toBeGreaterThan(0);
  });

  it('resolves every catalog item without falling back', () => {
    for (const item of COSMETICS) {
      const l = randomLoadout(new Rng(1));
      if (item.slot === 'pattern') {
        const r = resolveLoadout({ ...l, pattern: item.id });
        expect(r.patternIndex).toBe(SHADER_PATTERNS.indexOf(item.pattern));
      } else if (
        item.slot === 'headwear' ||
        item.slot === 'back' ||
        item.slot === 'upper' ||
        item.slot === 'lower'
      ) {
        const r = resolveLoadout({
          ...l,
          headwear: null,
          back: null,
          upper: null,
          lower: null,
          [item.slot]: item.id,
        });
        expect(r.accessories.map((a) => a.mesh)).toContain(item.mesh);
      } else if (item.slot === 'emote') {
        const r = resolveLoadout({ ...l, emotes: [item.id, item.id, item.id, item.id] });
        expect(r.emotes[0]).toBe(item.clip);
      }
    }
  });

  it('tolerates unknown ids', () => {
    const r = resolveLoadout({
      ...randomLoadout(new Rng(3)),
      pattern: 'nope',
      face: 'nope',
      headwear: 'nope',
    });
    expect(r.patternIndex).toBe(0);
    expect(r.face.eyeScale).toBe(1);
  });
});

describe('geometry', () => {
  it('base mesh has the shared attribute layout at every LOD, with decreasing cost', () => {
    const counts = ([0, 1, 2] as const).map((lod) => {
      const g = buildBaseGeometry(lod);
      for (const a of ['position', 'normal', 'skinIndex', 'skinWeight', 'color', 'aKind', 'aFace']) {
        expect(g.getAttribute(a), a).toBeTruthy();
      }
      const si = g.getAttribute('skinIndex');
      const sw = g.getAttribute('skinWeight');
      for (let i = 0; i < si.count; i++) {
        expect(si.getX(i)).toBeLessThan(CORE_BONE_COUNT);
        expect(sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i)).toBeCloseTo(1, 4);
      }
      const n = g.getAttribute('position').count;
      g.dispose();
      return n;
    });
    expect(counts[0]).toBeGreaterThan(counts[1]!);
    expect(counts[1]).toBeGreaterThan(counts[2]!);
  });

  it('assembles every accessory into one geometry, skinned within the skeleton', () => {
    const all = BUILT_ACCESSORIES.map((mesh) => ({ mesh, tint: ['primary', '#ffffff', '#ff0000'] }));
    for (const spec of all) {
      const a = acquireAssembly(0, [spec]);
      const si = a.geometry.getAttribute('skinIndex');
      const kind = a.geometry.getAttribute('aKind');
      let maxBone = 0;
      for (let i = 0; i < si.count; i++) maxBone = Math.max(maxBone, si.getX(i), si.getY(i));
      expect(maxBone, spec.mesh).toBeLessThan(TOTAL_BONE_COUNT);
      let accessoryVerts = 0;
      for (let i = 0; i < kind.count; i++)
        if (kind.getX(i) !== Kind.Pattern && kind.getX(i) !== Kind.Secondary) accessoryVerts++;
      expect(accessoryVerts, spec.mesh).toBeGreaterThan(0);
      for (const c of a.chains) expect(c.firstBone).toBeGreaterThanOrEqual(CORE_BONE_COUNT);
      releaseAssembly(a);
    }
    expect(assemblyCacheSize()).toBe(0);
  });

  it('shares assemblies between identical loadouts and stays inside the bone pool', () => {
    const heavy = [
      { mesh: 'bunny-ears', tint: ['#ffffff'] },
      { mesh: 'cape', tint: ['#ff0000'] },
      { mesh: 'scarf', tint: ['#00ff00'] },
      { mesh: 'tail', tint: ['primary'] },
    ];
    const a = acquireAssembly(0, heavy);
    const b = acquireAssembly(0, heavy);
    expect(b).toBe(a);
    expect(a.refs).toBe(2);
    let used = 0;
    for (const c of a.chains) used += c.type === 'verlet' ? c.points.length : 1;
    expect(used).toBeLessThanOrEqual(POOL_BONE_COUNT);
    releaseAssembly(a);
    releaseAssembly(b);
  });
});

describe('animation primitives', () => {
  it('SecondOrder converges to its target', () => {
    const s = new SecondOrder(2, 0.5, 0, 0);
    for (let i = 0; i < 600; i++) s.update(1 / 60, 1);
    expect(s.y).toBeCloseTo(1, 3);
  });

  it('SecondOrder overshoots when under-damped', () => {
    const s = new SecondOrder(2, 0.2, 0, 0);
    let peak = 0;
    for (let i = 0; i < 120; i++) peak = Math.max(peak, s.update(1 / 60, 1));
    expect(peak).toBeGreaterThan(1.1);
  });

  it('kf interpolates and clamps', () => {
    const keys = [0, 0, 1, 10, 2, 0];
    expect(kf(-1, keys)).toBe(0);
    expect(kf(1, keys)).toBe(10);
    expect(kf(0.5, keys)).toBeCloseTo(5);
    expect(kf(5, keys)).toBe(0);
  });

  it('resolves pose channels', () => {
    expect(channelIndex('uArmL.z')).toBe(5 * 3 + 2);
    expect(channelIndex('pos.y')).toBe(CH.pos + 1);
    expect(channelIndex('stretch')).toBe(CH.stretch);
    expect(channelIndex('nope.x')).toBe(-1);
    const p = new Pose().sym(5, 8, 0.1, 0.2, 0.3);
    expect(p.v[5 * 3 + 2]).toBeCloseTo(0.3);
    expect(p.v[8 * 3 + 2]).toBeCloseTo(-0.3);
  });

  it('produces finite poses for every state and clip', () => {
    const anim: TumblerAnimInput = {
      state: 0,
      stateTime: 0,
      speed: 6,
      verticalSpeed: -3,
      facing: 0,
      grounded: false,
      emote: null,
    };
    const animator = new Animator(1);
    const states = Object.values(CharacterState);
    for (const state of states) {
      anim.state = state;
      for (let f = 0; f < 40; f++) {
        anim.stateTime = f / 60;
        anim.facing += 0.05;
        animator.update(1 / 60, anim, f % 2 ? null : ANIM_CLIP_IDS[(state + f) % ANIM_CLIP_IDS.length]!);
        for (const v of animator.out.v) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});
