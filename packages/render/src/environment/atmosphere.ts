import { Color, Vector3 } from 'three/webgpu';
import type { ThemeDefinition, Weather } from '@tumble/content/themes';

/**
 * Resolves a theme + weather into the concrete lighting/sky/fog numbers the
 * environment uses. Weather is a set of modifiers on top of the theme, so every
 * theme gets a believable night, sunset or storm without per-theme authoring.
 */

/** Fully resolved atmosphere. All colours are linear `Color`s. */
export interface Atmosphere {
  skyTop: Color;
  skyHorizon: Color;
  skyBottom: Color;
  sunDisc: Color;
  sunSize: number;
  /** 0..1 starfield visibility. */
  stars: number;
  fogColor: Color;
  fogNear: number;
  fogFar: number;
  sunColor: Color;
  sunIntensity: number;
  /** Normalised direction towards the sun. */
  sunDirection: Vector3;
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  cloudTint: Color;
  cloudShade: Color;
  /** Relative cloud count. */
  cloudDensity: number;
  /** 0..1 wind strength. */
  wind: number;
  /** 0..1: emissive boost for level trims, fairy lights, windows. */
  night: number;
  /** Lightning flashes. */
  storm: boolean;
  snow: boolean;
  /** Visible horizontal streaks. */
  windStreaks: boolean;
  weather: Weather;
}

const tmp = new Color();

function c(hex: string): Color {
  return new Color(hex);
}

/** Pulls a colour towards a grey of the same luminance. */
function desaturate(col: Color, amount: number): Color {
  const l = col.r * 0.2126 + col.g * 0.7152 + col.b * 0.0722;
  return col.lerp(tmp.setRGB(l, l, l), amount);
}

/**
 * Resolves the atmosphere for a theme under a weather.
 *
 * @param theme - Theme definition.
 * @param weather - Requested weather; anything outside `theme.weather.allowed`
 *   still works (modifiers are generic) but designers should prefer allowed ones.
 * @returns A fresh {@link Atmosphere}.
 */
export function resolveAtmosphere(
  theme: ThemeDefinition,
  weather: Weather = theme.weather.default,
): Atmosphere {
  const a: Atmosphere = {
    skyTop: c(theme.sky.top),
    skyHorizon: c(theme.sky.horizon),
    skyBottom: c(theme.sky.bottom),
    sunDisc: c(theme.sky.sunDisc),
    sunSize: theme.sky.sunSize,
    stars: theme.sky.stars,
    fogColor: c(theme.fog.color),
    fogNear: theme.fog.near,
    fogFar: theme.fog.far,
    sunColor: c(theme.sun.color),
    sunIntensity: theme.sun.intensity,
    sunDirection: new Vector3(
      theme.sun.direction.x,
      theme.sun.direction.y,
      theme.sun.direction.z,
    ).normalize(),
    hemiSky: c(theme.hemisphere.sky),
    hemiGround: c(theme.hemisphere.ground),
    hemiIntensity: theme.hemisphere.intensity,
    cloudTint: c(theme.clouds.tint),
    cloudShade: c(theme.clouds.shade),
    cloudDensity: theme.clouds.density,
    wind: theme.weather.wind,
    night: theme.sky.stars > 0.6 ? 0.6 : 0,
    storm: false,
    snow: false,
    windStreaks: false,
    weather,
  };

  switch (weather) {
    case 'clear':
      break;
    case 'windy':
      a.wind = Math.max(a.wind, 0.85);
      a.windStreaks = true;
      a.cloudDensity *= 1.2;
      break;
    case 'sunset': {
      if (theme.id === 'sunset') break;
      a.skyTop.lerp(c('#5b5bd6'), 0.6);
      a.skyHorizon.lerp(c('#ffab7a'), 0.7);
      a.skyBottom.lerp(c('#ffd2b0'), 0.5);
      a.fogColor.lerp(c('#ffc2a0'), 0.6);
      a.sunColor.lerp(c('#ffb27a'), 0.7);
      a.sunDisc.lerp(c('#ffe0a0'), 0.7);
      a.sunSize *= 1.5;
      a.sunIntensity *= 0.85;
      a.sunDirection.set(a.sunDirection.x * 1.6, 0.28, a.sunDirection.z * 1.6).normalize();
      a.hemiSky.lerp(c('#ffd0c0'), 0.5);
      a.hemiGround.lerp(c('#b07ac0'), 0.4);
      a.cloudTint.lerp(c('#ffd6c2'), 0.6);
      a.cloudShade.lerp(c('#d08ab8'), 0.6);
      break;
    }
    case 'night': {
      const keepNeon = theme.id === 'neon' || theme.id === 'space';
      if (!keepNeon) {
        a.skyTop.set('#0c0e3a');
        a.skyHorizon.lerp(c('#3a2a78'), 0.85);
        a.skyBottom.set('#1a1650');
        a.fogColor.lerp(c('#2a2366'), 0.8);
        a.sunColor.set('#b9c8ff');
        a.sunDisc.set('#eef2ff');
        a.sunSize *= 0.8;
        a.sunIntensity = Math.min(a.sunIntensity, 1.1);
        a.hemiSky.lerp(c('#6b78d6'), 0.7);
        a.hemiGround.lerp(c('#3c2a6a'), 0.7);
        a.hemiIntensity *= 0.7;
        a.cloudTint.lerp(c('#6a6fc0'), 0.7);
        a.cloudShade.lerp(c('#2a2660'), 0.7);
      }
      a.stars = 1;
      a.night = 1;
      break;
    }
    case 'snow':
      a.snow = true;
      desaturate(a.skyTop, 0.35).lerp(c('#dfeeff'), 0.25);
      a.skyHorizon.lerp(c('#f2f7ff'), 0.5);
      a.fogColor.lerp(c('#eef4ff'), 0.6);
      a.fogNear *= 0.7;
      a.fogFar *= 0.75;
      a.sunIntensity *= 0.8;
      a.hemiIntensity *= 1.1;
      a.cloudDensity *= 1.3;
      break;
    case 'stormy':
      a.storm = true;
      a.windStreaks = true;
      a.wind = Math.max(a.wind, 0.7);
      desaturate(a.skyTop, 0.55).lerp(c('#3d3f6e'), 0.55);
      desaturate(a.skyHorizon, 0.5).lerp(c('#8a86ad'), 0.5);
      desaturate(a.skyBottom, 0.5);
      desaturate(a.fogColor, 0.5).lerp(c('#7d7aa0'), 0.4);
      a.fogNear *= 0.6;
      a.fogFar *= 0.7;
      a.sunIntensity *= 0.45;
      a.hemiIntensity *= 0.85;
      a.sunDisc.multiplyScalar(0.35);
      desaturate(a.cloudTint, 0.6).lerp(c('#9a98b8'), 0.5);
      desaturate(a.cloudShade, 0.6).lerp(c('#4a4870'), 0.6);
      a.cloudDensity *= 1.6;
      a.night = Math.max(a.night, 0.35);
      break;
  }
  return a;
}
