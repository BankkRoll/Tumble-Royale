import { z } from 'zod';

/**
 * Theme schema: everything the renderer needs to dress a round — palette,
 * sky, fog, lighting rig, clouds, decor set, void style, colour grade, bloom and
 * weather defaults. Pure data; `@tumble/render` turns it into lights, materials
 * and post-processing parameters.
 */

/** `#rrggbb` hex colour. */
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

/** RGB triple, used for lift/gamma/gain. 1 = neutral for gamma/gain, 0 = neutral for lift. */
export const Rgb3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** Weather variants a round variation can request. Mirrors `VariationSchema.weather`. */
export const WeatherSchema = z.enum(['clear', 'windy', 'night', 'sunset', 'snow', 'stormy']);

/** Decor sets for background islands and props. One per theme today, but rounds may borrow. */
export const DecorSetSchema = z.enum([
  'candy',
  'factory',
  'frosty',
  'jungle',
  'sunset',
  'space',
  'beach',
  'neon',
  'castle',
  'goo',
]);

/** What fills the space under the course. */
export const VoidStyleSchema = z.enum(['clouds', 'slime', 'stars', 'water', 'lava']);

/**
 * Level palette. The six keys round pieces may reference by name are required;
 * extras give the level builder and decor coherent trim colours.
 */
export const ThemePaletteSchema = z.object({
  primary: HexColorSchema,
  secondary: HexColorSchema,
  accent: HexColorSchema,
  /** Hazards. Art direction: always in the magenta/orange family. */
  danger: HexColorSchema,
  /** Safe zones/landings. Art direction: cyan/mint family. */
  safe: HexColorSchema,
  neutral: HexColorSchema,
  /** Interactables and grab edges. Art direction: yellow. */
  interact: HexColorSchema,
  /** Secondary colour for stripes/dots/checker overlays. */
  pattern: HexColorSchema,
  /** Undersides, pillars and other "structure" surfaces. */
  structure: HexColorSchema,
  /** Small trim and bevel highlights. */
  trim: HexColorSchema,
  /** Deep shade used for outlines and edge pass. */
  ink: HexColorSchema,
});

/** Full theme definition. */
export const ThemeDefinitionSchema = z.object({
  id: DecorSetSchema,
  /** Display name for debug UIs. */
  name: z.string(),
  palette: ThemePaletteSchema,
  sky: z.object({
    top: HexColorSchema,
    horizon: HexColorSchema,
    bottom: HexColorSchema,
    /** Sun disc colour; the glow halo is derived from it. */
    sunDisc: HexColorSchema,
    /** Angular size multiplier of the sun disc (1 = default). */
    sunSize: z.number().min(0).default(1),
    /** Starfield visibility 0..1 (space/neon always, others at night). */
    stars: z.number().min(0).max(1).default(0),
  }),
  fog: z.object({ color: HexColorSchema, near: z.number(), far: z.number() }),
  sun: z.object({
    color: HexColorSchema,
    intensity: z.number(),
    /** Direction pointing TOWARDS the sun (normalised by the renderer). */
    direction: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  }),
  hemisphere: z.object({ sky: HexColorSchema, ground: HexColorSchema, intensity: z.number() }),
  clouds: z.object({
    tint: HexColorSchema,
    /** Underside shade colour of cloud puffs. */
    shade: HexColorSchema,
    /** Relative cloud count, 0 disables. */
    density: z.number().min(0).max(2).default(1),
  }),
  decor: z.object({
    set: DecorSetSchema,
    /** Colours sampled for background islands, props and balloons. */
    colors: z.array(HexColorSchema).min(3),
    /** Whether blimps/balloons drift through the sky. */
    balloons: z.boolean().default(true),
    /** Whether spectator stands are placed near the course. */
    crowd: z.boolean().default(true),
  }),
  void: z.object({
    style: VoidStyleSchema,
    color: HexColorSchema,
    /** Secondary colour: slime foam, cloud highlight, star tint. */
    color2: HexColorSchema,
    /** Height of the void surface below the course origin. */
    depth: z.number().default(-26),
  }),
  grade: z.object({
    exposure: z.number().default(1),
    saturation: z.number().default(1),
    contrast: z.number().default(1),
    lift: Rgb3Schema.default([0, 0, 0]),
    gamma: Rgb3Schema.default([1, 1, 1]),
    gain: Rgb3Schema.default([1, 1, 1]),
    /** Vignette darkness 0..1. */
    vignette: z.number().min(0).max(1).default(0.25),
  }),
  bloom: z.object({
    strength: z.number().min(0),
    /** Linear-HDR luminance where bloom starts; emissives push past it. */
    threshold: z.number().min(0),
    radius: z.number().min(0).max(1).default(0.45),
  }),
  weather: z.object({
    default: WeatherSchema,
    /** Weathers this theme looks good in (variations outside this list fall back to default). */
    allowed: z.array(WeatherSchema).min(1),
    /** Ambient wind strength 0..1 for clouds, streaks and flags. */
    wind: z.number().min(0).max(1).default(0.2),
  }),
});

/** Validated theme (defaults applied). */
export type ThemeDefinition = z.output<typeof ThemeDefinitionSchema>;
/** Theme as authored. */
export type ThemeDefinitionInput = z.input<typeof ThemeDefinitionSchema>;
/** Palette key a `StaticPiece.color` may reference. */
export type ThemePaletteKey = keyof ThemeDefinition['palette'];
/** Weather id. */
export type Weather = z.output<typeof WeatherSchema>;
/** Decor set id. */
export type DecorSet = z.output<typeof DecorSetSchema>;
/** Void style id. */
export type VoidStyle = z.output<typeof VoidStyleSchema>;
