import { describe, expect, it } from 'vitest';
import {
  NO_PHOTO_CONTROLS,
  PHOTO_FILTERS,
  PHOTO_LIMITS,
  clampPhotoCamera,
  photoCameraPosition,
  photoFilename,
  photoStateFromCamera,
  stepPhotoCamera,
  type PhotoCameraState,
} from '../src/game/photo/photoCamera.ts';

const origin = { x: 0, y: 0, z: 0 };
const state = (p: Partial<PhotoCameraState> = {}): PhotoCameraState => ({
  target: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0.3,
  distance: 6,
  fov: 50,
  ...p,
});

describe('photo camera clamp', () => {
  it('keeps pitch, distance and FOV in range', () => {
    const s = clampPhotoCamera(state({ pitch: 3, distance: 0.1, fov: 170 }), origin);
    expect(s.pitch).toBe(PHOTO_LIMITS.maxPitch);
    expect(s.distance).toBe(PHOTO_LIMITS.minDistance);
    expect(s.fov).toBe(PHOTO_LIMITS.maxFov);
    clampPhotoCamera(Object.assign(s, { pitch: -3, distance: 900, fov: 1 }), origin);
    expect(s.pitch).toBe(PHOTO_LIMITS.minPitch);
    expect(s.distance).toBe(PHOTO_LIMITS.maxDistance);
    expect(s.fov).toBe(PHOTO_LIMITS.minFov);
  });

  it('keeps the focus within travel range of where it started', () => {
    const s = clampPhotoCamera(state({ target: { x: 300, y: 0, z: 400 } }), origin);
    expect(Math.hypot(s.target.x, s.target.y, s.target.z)).toBeCloseTo(PHOTO_LIMITS.maxTravel);
    expect(s.target.x / s.target.z).toBeCloseTo(0.75);
  });

  it('recovers from NaN input', () => {
    const s = clampPhotoCamera(
      state({ yaw: Number.NaN, pitch: Number.NaN, target: { x: Number.NaN, y: 0, z: 0 } }),
      { x: 1, y: 2, z: 3 },
    );
    expect(s.yaw).toBe(0);
    expect(Number.isFinite(s.pitch)).toBe(true);
    expect(s.target).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('wraps yaw into (-π, π]', () => {
    expect(clampPhotoCamera(state({ yaw: 7 * Math.PI }), origin).yaw).toBeCloseTo(Math.PI);
  });
});

describe('photo camera motion', () => {
  it('orbits at the set distance, looking at the focus', () => {
    const s = state({ yaw: 1.1, pitch: 0.4, distance: 8, target: { x: 2, y: 1, z: -3 } });
    const p = photoCameraPosition(s, { x: 0, y: 0, z: 0 });
    expect(Math.hypot(p.x - 2, p.y - 1, p.z + 3)).toBeCloseTo(8);
    expect(p.y).toBeGreaterThan(1);
  });

  it('round-trips a camera into an equivalent orbit', () => {
    const pos = { x: 4, y: 3, z: 10 };
    const len = Math.hypot(-0.3, -0.4, -1);
    const fwd = { x: -0.3 / len, y: -0.4 / len, z: -1 / len };
    const s = photoStateFromCamera(pos, fwd, 55, 6);
    const back = photoCameraPosition(s, { x: 0, y: 0, z: 0 });
    expect(back.x).toBeCloseTo(pos.x);
    expect(back.y).toBeCloseTo(pos.y);
    expect(back.z).toBeCloseTo(pos.z);
    expect(s.fov).toBe(55);
  });

  it('moves the focus relative to where the camera looks', () => {
    // yaw 0: the camera sits on +Z, so "forward" is -Z and "right" is +X.
    const s = stepPhotoCamera(state(), { ...NO_PHOTO_CONTROLS, moveZ: 2, moveX: 1, moveY: 0.5 }, origin);
    expect(s.target.x).toBeCloseTo(1);
    expect(s.target.z).toBeCloseTo(-2);
    expect(s.target.y).toBeCloseTo(0.5);
  });

  it('zooms in for positive zoom and changes FOV', () => {
    const s = stepPhotoCamera(state(), { ...NO_PHOTO_CONTROLS, zoom: 2, fov: 10 }, origin);
    expect(s.distance).toBeCloseTo(6 * 0.81);
    expect(s.fov).toBe(60);
  });
});

describe('photo output', () => {
  it('names files by local time, sortable', () => {
    expect(photoFilename(new Date(2026, 9, 3, 14, 5, 9))).toBe('tumble-royale-2026-10-03-140509.png');
    expect(photoFilename(new Date(2027, 0, 1, 0, 0, 0))).toBe('tumble-royale-2027-01-01-000000.png');
  });

  it('offers none, warm, mono and vivid filters', () => {
    expect(Object.keys(PHOTO_FILTERS)).toEqual(['none', 'warm', 'mono', 'vivid']);
    expect(PHOTO_FILTERS.none).toBe('none');
  });
});
