/**
 * Resolves a {@link TumblerLoadout} (cosmetic ids) into render parameters.
 * Unknown ids degrade gracefully: the renderer must never crash on stale
 * inventory data, so bad ids fall back to defaults (validation is the API's job).
 */
import {
  ANIM_CLIP_IDS,
  getCosmetic,
  type AnimClipId,
  type FaceStyle,
} from '@tumble/content/cosmetics';
import type { AccessorySpec } from './assembly.ts';
import type { FaceStyleParams } from './face.ts';
import { SHADER_PATTERNS, SHADER_PUPILS } from './material.ts';
import type { TumblerLoadout } from './types.ts';

/** Render-ready loadout. */
export interface ResolvedLoadout {
  colors: [string, string, string];
  patternIndex: number;
  patternScale: number;
  /** Radians. */
  patternAngle: number;
  plate: string;
  iris: string;
  face: FaceStyleParams;
  /** Worn accessories in a stable order (headwear, back, upper, lower, face). */
  accessories: AccessorySpec[];
  /** Stable key of the accessory set (geometry cache key component). */
  accessoryKey: string;
  emotes: (AnimClipId | null)[];
  celebration: AnimClipId | null;
  victory: AnimClipId | null;
}

const DEFAULT_FACE: FaceStyle = {
  plateColor: '#fff7ec',
  pupil: 'round',
  iris: '#3a2a5c',
  eyeScale: 1,
  lashes: false,
  blush: true,
  freckles: false,
  lidRest: 0,
  accessory: null,
  tint: [],
};

const isClip = (id: string): id is AnimClipId => (ANIM_CLIP_IDS as readonly string[]).includes(id);

/**
 * Maps an emote / celebration / victory cosmetic id (or a raw clip id) to a clip.
 *
 * @param id - Cosmetic id or clip id.
 * @returns The clip id, or null when unknown.
 */
export function resolveClip(id: string | null | undefined): AnimClipId | null {
  if (!id) return null;
  if (isClip(id)) return id;
  const item = getCosmetic(id);
  return item && 'clip' in item ? item.clip : null;
}

function accessory(id: string | null): AccessorySpec | null {
  if (!id) return null;
  const item = getCosmetic(id);
  if (item && 'mesh' in item) return { mesh: item.mesh, tint: item.tint };
  return null;
}

/**
 * Resolves a loadout.
 *
 * @param l - Loadout with cosmetic ids.
 * @returns Render parameters.
 */
export function resolveLoadout(l: TumblerLoadout): ResolvedLoadout {
  let patternIndex = 0;
  let patternScale = 1;
  let patternAngle = 0;
  const pat = getCosmetic(l.pattern);
  if (pat?.slot === 'pattern') {
    patternIndex = SHADER_PATTERNS.indexOf(pat.pattern);
    patternScale = pat.scale;
    patternAngle = (pat.angle * Math.PI) / 180;
  } else {
    const raw = SHADER_PATTERNS.indexOf(l.pattern as (typeof SHADER_PATTERNS)[number]);
    if (raw >= 0) patternIndex = raw;
  }

  const faceItem = getCosmetic(l.face);
  const f = faceItem?.slot === 'face' ? faceItem.face : DEFAULT_FACE;

  const accessories: AccessorySpec[] = [];
  for (const id of [l.headwear, l.back, l.upper, l.lower]) {
    const a = accessory(id);
    if (a) accessories.push(a);
  }
  if (f.accessory) accessories.push({ mesh: f.accessory, tint: f.tint.length ? f.tint : ['#2a2238'] });

  return {
    colors: l.colors,
    patternIndex: Math.max(0, patternIndex),
    patternScale,
    patternAngle,
    plate: f.plateColor,
    iris: f.iris,
    face: {
      pupil: Math.max(0, SHADER_PUPILS.indexOf(f.pupil)),
      eyeScale: f.eyeScale,
      lidRest: f.lidRest,
      blush: f.blush ? 1 : 0,
      freckles: f.freckles ? 1 : 0,
      lashes: f.lashes ? 1 : 0,
    },
    accessories,
    accessoryKey: accessories.map((a) => `${a.mesh}:${a.tint.join(',')}`).join(';'),
    emotes: l.emotes.map(resolveClip),
    celebration: resolveClip(l.celebration),
    victory: resolveClip(l.victoryPose),
  };
}
