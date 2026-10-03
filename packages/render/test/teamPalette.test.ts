import { afterEach, describe, expect, it } from 'vitest';
import { TEAM_COLORS, TEAM_COLORS_BY_VISION, type ColorVisionMode } from '@tumble/shared';
import { traceTeamShape } from '../src/character/nameplate.ts';
import {
  remapTeamColor,
  setTeamColorMode,
  teamColor,
  teamColorMode,
  teamColors,
  teamShape,
} from '../src/teamPalette.ts';

const MODES: ColorVisionMode[] = ['off', 'protanopia', 'deuteranopia', 'tritanopia'];

/** Machado et al. (2009) full-severity simulation matrices, linear RGB. */
const SIM: Record<Exclude<ColorVisionMode, 'off'>, number[][]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number): number => {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};

/** Smallest distance between any two teams as someone with that deficiency would see them. */
function closestPair(palette: readonly string[], mode: Exclude<ColorVisionMode, 'off'>): number {
  const seen = palette.map((hex) => {
    const c = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
    return SIM[mode].map((row) => toGamma(row[0]! * c[0]! + row[1]! * c[1]! + row[2]! * c[2]!));
  });
  let min = Infinity;
  for (let i = 0; i < seen.length; i++)
    for (let j = i + 1; j < seen.length; j++)
      min = Math.min(min, Math.hypot(...seen[i]!.map((v, k) => v - seen[j]![k]!)));
  return min;
}

describe('team palette', () => {
  afterEach(() => setTeamColorMode('off'));

  it('defaults to the standard team colours', () => {
    expect(teamColorMode()).toBe('off');
    expect(teamColors()).toEqual(TEAM_COLORS);
    expect(teamColor(1)).toBe(TEAM_COLORS[1]);
  });

  it.each(MODES)('%s matches the UI palette and keeps four distinct teams', (mode) => {
    setTeamColorMode(mode);
    const list = teamColors();
    expect(list).toEqual(TEAM_COLORS_BY_VISION[mode]);
    expect(new Set(list).size).toBe(4);
    for (const c of list) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each(['protanopia', 'deuteranopia', 'tritanopia'] as const)(
    '%s keeps every pair of teams apart better than the default palette does',
    (mode) => {
      setTeamColorMode(mode);
      const ours = closestPair(teamColors(), mode);
      expect(ours).toBeGreaterThan(0.45);
      expect(ours).toBeGreaterThan(closestPair(TEAM_COLORS, mode));
    },
  );

  it('wraps team indices', () => {
    setTeamColorMode('deuteranopia');
    expect(teamColor(5)).toBe(teamColor(1));
    expect(teamColor(-1)).toBe(teamColor(3));
  });

  it('remaps colours authored as default team colours and leaves others alone', () => {
    setTeamColorMode('protanopia');
    expect(remapTeamColor(TEAM_COLORS[0].toUpperCase())).toBe(TEAM_COLORS_BY_VISION.protanopia[0]);
    expect(remapTeamColor('#123456')).toBe('#123456');
    setTeamColorMode('off');
    expect(remapTeamColor(TEAM_COLORS[0])).toBe(TEAM_COLORS[0]);
  });

  it('falls back to off for an unknown mode', () => {
    setTeamColorMode('nope' as ColorVisionMode);
    expect(teamColorMode()).toBe('off');
  });

  it('gives every team its own shape', () => {
    expect(new Set([0, 1, 2, 3].map(teamShape)).size).toBe(4);
    expect(teamShape(4)).toBe(teamShape(0));
  });
});

describe('traceTeamShape', () => {
  it('draws a different path per shape', () => {
    const calls = (shape: Parameters<typeof traceTeamShape>[1]): string[] => {
      const log: string[] = [];
      const ctx = {
        arc: () => log.push('arc'),
        rect: () => log.push('rect'),
        moveTo: () => log.push('move'),
        lineTo: () => log.push('line'),
        closePath: () => log.push('close'),
      };
      traceTeamShape(ctx, shape, 0, 0, 10);
      return log;
    };
    expect(calls('circle')).toEqual(['arc']);
    expect(calls('square')).toEqual(['rect']);
    expect(calls('triangle')).toEqual(['move', 'line', 'line', 'close']);
    expect(calls('diamond')).toEqual(['move', 'line', 'line', 'line', 'close']);
  });
});
