/**
 * Cosmetic catalog schema.
 *
 * Responsibilities:
 * - Enumerates every slot, rarity, currency and unlock source.
 * - Enumerates the render-side ids (pattern, accessory mesh, face pupil, anim
 *   clip, trail, footstep pack) so the renderer can switch on a closed set and a
 *   typo in the catalog fails validation instead of rendering nothing.
 * - Defines one zod schema per slot, unioned on `slot`.
 */
import { z } from 'zod';

// -----------------------------------------------------------------------------
// Enumerations
// -----------------------------------------------------------------------------

/** Every customization slot (SPEC §5). */
export const CosmeticSlotSchema = z.enum([
  'color',
  'pattern',
  'face',
  'upper',
  'lower',
  'headwear',
  'back',
  'emote',
  'celebration',
  'victory',
  'nameplate',
  'banner',
  'trail',
  'footsteps',
]);
/** A customization slot. */
export type CosmeticSlot = z.infer<typeof CosmeticSlotSchema>;

/** Rarity tiers, lowest first. */
export const RaritySchema = z.enum(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']);
/** A rarity tier. */
export type Rarity = z.infer<typeof RaritySchema>;

/** Display data for a rarity tier: frame colours used by the locker, store and unlock reveal. */
export interface RarityInfo {
  /** Sort order, 0 = Common. */
  order: number;
  /** Display label. */
  label: string;
  /** Card frame colour. */
  frame: string;
  /** Secondary glow / gradient end colour. */
  glow: string;
}

/** Rarity display table. Frames get louder (and warmer) as rarity rises. */
export const RARITY_INFO: Readonly<Record<Rarity, RarityInfo>> = {
  common: { order: 0, label: 'Common', frame: '#b8c4d6', glow: '#e4ebf5' },
  uncommon: { order: 1, label: 'Uncommon', frame: '#5fd99a', glow: '#b9f7d6' },
  rare: { order: 2, label: 'Rare', frame: '#3fa9ff', glow: '#a9dcff' },
  epic: { order: 3, label: 'Epic', frame: '#b45cff', glow: '#e2c2ff' },
  legendary: { order: 4, label: 'Legendary', frame: '#ffb02e', glow: '#ffe3a3' },
  mythic: { order: 5, label: 'Mythic', frame: '#ff4fd8', glow: '#7cf2ff' },
};

/** Soft currency (earned) and premium currency. */
export const CurrencySchema = z.enum(['gumballs', 'gems']);
/** A currency id. */
export type Currency = z.infer<typeof CurrencySchema>;

/** How an item is unlocked. */
export const CosmeticSourceSchema = z.enum(['default', 'store', 'pass', 'challenge', 'event']);
/** An unlock source. */
export type CosmeticSource = z.infer<typeof CosmeticSourceSchema>;

/** Procedural body patterns the Tumbler shader implements. Order is the shader index. */
export const PATTERN_IDS = [
  'solid',
  'stripes',
  'dots',
  'camo',
  'gradient',
  'galaxy',
  'checker',
  'zigzag',
  'hearts',
  'spots',
  'swirl',
  'split',
  'sprinkles',
  'plaid',
  'waves',
  'diamonds',
] as const;
/** Pattern id schema. */
export const PatternIdSchema = z.enum(PATTERN_IDS);
/** A procedural pattern id. */
export type PatternId = z.infer<typeof PatternIdSchema>;

/** Procedural accessory meshes the renderer can build, grouped by the slot that uses them. */
export const ACCESSORY_MESH_IDS = {
  headwear: [
    'party-cone',
    'beanie-pom',
    'tiara',
    'chef-hat',
    'horns',
    'propeller-cap',
    'bunny-ears',
    'halo',
    'top-hat',
    'flower',
    'antenna',
    'headphones',
    'sprout',
    'cat-ears',
  ],
  back: ['cape', 'wings', 'jetpack', 'tail', 'backpack', 'shell'],
  upper: ['bow-tie', 'scarf', 'medal'],
  lower: ['belt', 'tutu', 'shorts-stripes', 'floatie'],
  face: ['visor', 'glasses', 'mustache', 'monocle', 'star-shades'],
} as const;

/** Every accessory mesh id. */
export const AccessoryMeshIdSchema = z.enum([
  ...ACCESSORY_MESH_IDS.headwear,
  ...ACCESSORY_MESH_IDS.back,
  ...ACCESSORY_MESH_IDS.upper,
  ...ACCESSORY_MESH_IDS.lower,
  ...ACCESSORY_MESH_IDS.face,
]);
/** An accessory mesh id. */
export type AccessoryMeshId = z.infer<typeof AccessoryMeshIdSchema>;

/** Pupil shapes the face shader draws. */
export const PupilShapeSchema = z.enum(['round', 'star', 'heart', 'cat', 'spiral']);
/** A pupil shape id. */
export type PupilShape = z.infer<typeof PupilShapeSchema>;

/** Procedural animation clips (emotes, celebrations, victory poses). */
export const ANIM_CLIP_IDS = [
  'wave',
  'dance',
  'laugh',
  'flex',
  'facepalm',
  'spin',
  'jumping-jacks',
  'bow',
  'shrug',
  'cheer',
  'fist-pump',
  'backflip',
  'victory-superstar',
  'victory-hero',
  'victory-twirl',
] as const;
/** Clip id schema. */
export const AnimClipIdSchema = z.enum(ANIM_CLIP_IDS);
/** An animation clip id. */
export type AnimClipId = z.infer<typeof AnimClipIdSchema>;

/** Trail VFX kinds (rendered by the VFX system). */
export const TrailKindSchema = z.enum(['sparkle', 'bubbles', 'hearts', 'confetti', 'rainbow', 'stars']);
/** Footstep SFX packs (played by the audio system). */
export const FootstepPackSchema = z.enum(['squeak', 'boing', 'tap', 'jelly', 'bell']);
/** Nameplate frame styles. */
export const NameplateStyleSchema = z.enum(['pill', 'ribbon', 'bubble', 'ticket', 'neon']);
/** Banner motifs. */
export const BannerMotifSchema = z.enum(['confetti', 'clouds', 'stripes', 'stars', 'candy', 'waves']);

// -----------------------------------------------------------------------------
// Items
// -----------------------------------------------------------------------------

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

/** Price; `null` when the item is not sold directly (default, pass, challenge). */
export const PriceSchema = z.object({ currency: CurrencySchema, amount: z.number().int().positive() }).nullable();

const Base = {
  /** Stable id: `<slot-prefix>.<kebab-name>`. Stored in inventories; never rename. */
  id: z.string().regex(/^[a-z]+\.[a-z0-9-]+$/),
  /** Display name. Original IP only. */
  name: z.string().min(2).max(32),
  /** Flavour text for the locker. */
  description: z.string().min(4).max(120),
  rarity: RaritySchema,
  source: CosmeticSourceSchema,
  price: PriceSchema,
};

/** Three body colours (primary, secondary, tertiary). */
export const ColorItemSchema = z.object({ ...Base, slot: z.literal('color'), colors: z.tuple([Hex, Hex, Hex]) });

/** A procedural body pattern with its parameters. */
export const PatternItemSchema = z.object({
  ...Base,
  slot: z.literal('pattern'),
  pattern: PatternIdSchema,
  /** Pattern frequency multiplier (1 = authored default). */
  scale: z.number().positive().default(1),
  /** Pattern rotation in degrees. */
  angle: z.number().default(0),
});

/** Face plate style; optionally carries a face accessory mesh (glasses, mustache…). */
export const FaceItemSchema = z.object({
  ...Base,
  slot: z.literal('face'),
  face: z.object({
    plateColor: Hex.default('#fff7ec'),
    pupil: PupilShapeSchema.default('round'),
    /** Iris ring colour. */
    iris: Hex.default('#3a2a5c'),
    /** Eye size multiplier. */
    eyeScale: z.number().min(0.6).max(1.5).default(1),
    lashes: z.boolean().default(false),
    blush: z.boolean().default(true),
    freckles: z.boolean().default(false),
    /** Resting upper-lid closure 0–0.6 (sleepy looks). */
    lidRest: z.number().min(0).max(0.6).default(0),
    accessory: AccessoryMeshIdSchema.nullable().default(null),
    /** Accessory tint colours (accessory-specific meaning). */
    tint: z.array(Hex).max(3).default([]),
  }),
});

const AccessoryBody = {
  mesh: AccessoryMeshIdSchema,
  /**
   * Accessory colours. `"primary" | "secondary" | "tertiary"` follow the
   * wearer's body colours; hex values are fixed.
   */
  tint: z.array(z.union([Hex, z.enum(['primary', 'secondary', 'tertiary'])])).min(1).max(3),
};

/** Wearable accessory (upper, lower, headwear, back). */
export const AccessoryItemSchema = z.object({
  ...Base,
  slot: z.enum(['upper', 'lower', 'headwear', 'back']),
  ...AccessoryBody,
});

/** Emote, celebration or victory pose. */
export const ClipItemSchema = z.object({
  ...Base,
  slot: z.enum(['emote', 'celebration', 'victory']),
  clip: AnimClipIdSchema,
});

/** Nameplate styling. */
export const NameplateItemSchema = z.object({
  ...Base,
  slot: z.literal('nameplate'),
  plate: z.object({ style: NameplateStyleSchema, bg: Hex, bg2: Hex, text: Hex, border: Hex }),
});

/** Profile banner. */
export const BannerItemSchema = z.object({
  ...Base,
  slot: z.literal('banner'),
  banner: z.object({ motif: BannerMotifSchema, colors: z.tuple([Hex, Hex, Hex]) }),
});

/** Movement trail VFX. */
export const TrailItemSchema = z.object({
  ...Base,
  slot: z.literal('trail'),
  trail: z.object({ kind: TrailKindSchema, colors: z.array(Hex).min(1).max(4) }),
});

/** Footstep SFX pack. */
export const FootstepsItemSchema = z.object({ ...Base, slot: z.literal('footsteps'), pack: FootstepPackSchema });

/** Any cosmetic item. */
export const CosmeticItemSchema = z.union([
  ColorItemSchema,
  PatternItemSchema,
  FaceItemSchema,
  AccessoryItemSchema,
  ClipItemSchema,
  NameplateItemSchema,
  BannerItemSchema,
  TrailItemSchema,
  FootstepsItemSchema,
]);

/** A validated cosmetic item. */
export type CosmeticItem = z.infer<typeof CosmeticItemSchema>;
/** Catalog input (defaults not yet applied). */
export type CosmeticItemInput = z.input<typeof CosmeticItemSchema>;
/** A colour preset. */
export type ColorItem = z.infer<typeof ColorItemSchema>;
/** A pattern item. */
export type PatternItem = z.infer<typeof PatternItemSchema>;
/** A face plate item. */
export type FaceItem = z.infer<typeof FaceItemSchema>;
/** Face plate parameters. */
export type FaceStyle = FaceItem['face'];
/** A wearable accessory item. */
export type AccessoryItem = z.infer<typeof AccessoryItemSchema>;
/** An emote / celebration / victory item. */
export type ClipItem = z.infer<typeof ClipItemSchema>;
/** A nameplate item. */
export type NameplateItem = z.infer<typeof NameplateItemSchema>;
/** A banner item. */
export type BannerItem = z.infer<typeof BannerItemSchema>;
/** A trail item. */
export type TrailItem = z.infer<typeof TrailItemSchema>;
/** A footsteps item. */
export type FootstepsItem = z.infer<typeof FootstepsItemSchema>;

/**
 * What a Tumbler wears. Structurally identical to `TumblerLoadout` in
 * `@tumble/render/character` (content cannot depend on render).
 */
export interface CosmeticLoadout {
  /** Resolved body colours (hex): primary, secondary, tertiary. */
  colors: [string, string, string];
  /** Pattern cosmetic id (`pattern.*`) or a raw {@link PatternId}. */
  pattern: string;
  face: string;
  upper: string | null;
  lower: string | null;
  headwear: string | null;
  back: string | null;
  emotes: [string, string, string, string];
  celebration: string;
  victoryPose: string;
  nameplate: string;
  trail: string | null;
}
