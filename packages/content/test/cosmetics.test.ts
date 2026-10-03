import { describe, expect, it } from 'vitest';
import { Rng } from '@tumble/shared';
import {
  ACCESSORY_MESH_IDS,
  ANIM_CLIP_IDS,
  COSMETICS,
  CosmeticItemSchema,
  CosmeticSlotSchema,
  DEFAULT_LOADOUT,
  PATTERN_IDS,
  RARITY_INFO,
  RaritySchema,
  cosmeticsInSlot,
  getCosmetic,
  randomLoadout,
  validateLoadout,
} from '../src/cosmetics/index.ts';

const BANNED = /fall\s*guys|\bbeans?\b|mediatonic|\bepic games\b/i;

describe('cosmetics catalog', () => {
  it('has at least 60 items', () => {
    expect(COSMETICS.length).toBeGreaterThanOrEqual(60);
  });

  it('every item passes the schema', () => {
    for (const item of COSMETICS) expect(() => CosmeticItemSchema.parse(item)).not.toThrow();
  });

  it('ids are unique and prefixed by their slot family', () => {
    const ids = COSMETICS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COSMETICS) expect(c.id.split('.')[0]).toBe(c.slot);
  });

  it('every slot and rarity is represented', () => {
    for (const slot of CosmeticSlotSchema.options) expect(cosmeticsInSlot(slot).length).toBeGreaterThan(0);
    for (const r of RaritySchema.options) {
      expect(COSMETICS.some((c) => c.rarity === r)).toBe(true);
      expect(RARITY_INFO[r].frame).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('store items have prices; non-store items do not', () => {
    for (const c of COSMETICS) {
      if (c.source === 'store') expect(c.price).not.toBeNull();
      else expect(c.price).toBeNull();
    }
  });

  it('covers every pattern, clip and accessory mesh the renderer implements', () => {
    const patterns = new Set(COSMETICS.flatMap((c) => (c.slot === 'pattern' ? [c.pattern] : [])));
    for (const p of PATTERN_IDS) expect(patterns.has(p)).toBe(true);
    const clips = new Set(COSMETICS.flatMap((c) => ('clip' in c ? [c.clip] : [])));
    for (const clip of ANIM_CLIP_IDS) expect(clips.has(clip)).toBe(true);
    const meshes = new Set(
      COSMETICS.flatMap((c) => ('mesh' in c ? [c.mesh] : c.slot === 'face' && c.face.accessory ? [c.face.accessory] : [])),
    );
    for (const list of Object.values(ACCESSORY_MESH_IDS)) for (const m of list) expect(meshes.has(m)).toBe(true);
  });

  it('wearables use meshes from their own slot', () => {
    for (const c of COSMETICS) {
      if (c.slot === 'headwear' || c.slot === 'back' || c.slot === 'upper' || c.slot === 'lower') {
        expect((ACCESSORY_MESH_IDS[c.slot] as readonly string[]).includes(c.mesh)).toBe(true);
      }
    }
  });

  it('stocks the season pass with varied pass-only items across every slot', () => {
    const pass = COSMETICS.filter((c) => c.source === 'pass');
    expect(pass.length).toBeGreaterThanOrEqual(120);
    for (const slot of CosmeticSlotSchema.options) expect(pass.some((c) => c.slot === slot), slot).toBe(true);
    expect(pass.some((c) => c.rarity === 'mythic' && c.slot === 'victory')).toBe(true);
    const names = COSMETICS.map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('uses original names only', () => {
    for (const c of COSMETICS) {
      expect(c.name).not.toMatch(BANNED);
      expect(c.description).not.toMatch(BANNED);
    }
  });
});

describe('loadouts', () => {
  it('default loadout is valid and only uses default-source items', () => {
    expect(validateLoadout({ ...DEFAULT_LOADOUT })).toEqual([]);
    for (const id of [DEFAULT_LOADOUT.pattern, DEFAULT_LOADOUT.face, ...DEFAULT_LOADOUT.emotes]) {
      expect(getCosmetic(id)?.source).toBe('default');
    }
  });

  it('randomLoadout is valid and deterministic per seed', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const a = randomLoadout(new Rng(seed));
      expect(validateLoadout(a)).toEqual([]);
      expect(randomLoadout(new Rng(seed))).toEqual(a);
    }
  });

  it('randomLoadout produces variety', () => {
    const faces = new Set<string>();
    const hats = new Set<string | null>();
    for (let seed = 1; seed <= 100; seed++) {
      const l = randomLoadout(new Rng(seed));
      faces.add(l.face);
      hats.add(l.headwear);
    }
    expect(faces.size).toBeGreaterThan(5);
    expect(hats.size).toBeGreaterThan(8);
  });

  it('validateLoadout reports wrong slots and unknown ids', () => {
    const issues = validateLoadout({ ...DEFAULT_LOADOUT, headwear: 'back.cape', face: 'face.nope' });
    expect(issues.map((i) => i.field).sort()).toEqual(['face', 'headwear']);
  });
});
