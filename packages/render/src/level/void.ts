import {
  CircleGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type UniformNode,
} from 'three/webgpu';
import {
  float,
  floor,
  fract,
  hash,
  length,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { ThemeDefinition } from '@tumble/content/themes';

/**
 * The "void" under every course: what you see when you look down or fall off.
 * Cloud sea, slime lake, water, starfield or lava depending on theme. One draw.
 */

/** Live handle for the void surface. */
export interface VoidVisual {
  readonly object: Mesh;
  /** @param t - Seconds, drives flow. */
  update(t: number): void;
  dispose(): void;
}

/**
 * Builds the void surface.
 *
 * @param theme - Active theme (style + colours).
 * @param center - World XZ centre of the course.
 * @param y - Surface height.
 * @param radius - Disc radius; keep beyond the fog far distance so the edge never shows.
 */
export function createVoidSurface(
  theme: ThemeDefinition,
  center: { x: number; z: number },
  y: number,
  radius = 700,
): VoidVisual {
  const time: UniformNode<'float', number> = uniform(0);
  const cA = uniform(new Color(theme.void.color));
  const cB = uniform(new Color(theme.void.color2));
  const fogCol = uniform(new Color(theme.fog.color));
  const segs = theme.void.style === 'slime' || theme.void.style === 'water' ? 96 : 8;
  const geo = new CircleGeometry(radius, segs, 0, Math.PI * 2);
  geo.rotateX(-Math.PI / 2);

  const mat = new MeshBasicNodeMaterial({ side: DoubleSide, fog: false, depthWrite: true });
  const p = positionWorld;
  const t = time;
  let col: Node<'vec3'>;

  switch (theme.void.style) {
    case 'clouds': {
      const n = mx_fractal_noise_float(vec3(p.x.mul(0.018), p.z.mul(0.018), t.mul(0.03)), 4, 2.0, 0.5);
      const puff = smoothstep(-0.25, 0.45, n);
      col = mix(cB, cA, puff) as Node<'vec3'>;
      const glint = smoothstep(0.35, 0.7, n).mul(0.18);
      col = col.add(vec3(glint, glint, glint)) as Node<'vec3'>;
      break;
    }
    case 'slime': {
      const n = mx_fractal_noise_float(
        vec3(p.x.mul(0.045), p.z.mul(0.045).sub(t.mul(0.1)), t.mul(0.12)),
        3,
        2.0,
        0.5,
      );
      const ripple = mx_noise_float(vec3(p.x.mul(0.3), p.z.mul(0.3), t.mul(0.6)));
      const foam = smoothstep(0.18, 0.26, n).sub(smoothstep(0.26, 0.4, n));
      col = mix(cA.mul(0.62), cA.mul(1.18), smoothstep(-0.45, 0.35, n.add(ripple.mul(0.12)))) as Node<'vec3'>;
      col = mix(col, cB, foam.clamp(0, 1).mul(0.85)) as Node<'vec3'>;
      col = col.add(cB.mul(smoothstep(0.55, 0.8, ripple).mul(0.18))) as Node<'vec3'>;
      const wave = sin(positionLocal.x.mul(0.25).add(t.mul(1.4)))
        .mul(sin(positionLocal.z.mul(0.2).sub(t.mul(1.1))))
        .mul(0.6);
      mat.positionNode = positionLocal.add(vec3(0, wave, 0));
      break;
    }
    case 'water': {
      const n = mx_noise_float(vec3(p.x.mul(0.08), p.z.mul(0.08), t.mul(0.25)));
      const caustic = smoothstep(0.3, 0.42, n).sub(smoothstep(0.42, 0.6, n));
      col = mix(cA.mul(0.85), cA, smoothstep(-0.5, 0.5, n)) as Node<'vec3'>;
      col = mix(col, cB, caustic.clamp(0, 1).mul(0.7)) as Node<'vec3'>;
      const wave = sin(positionLocal.x.mul(0.18).add(t.mul(0.9))).mul(0.35);
      mat.positionNode = positionLocal.add(vec3(0, wave, 0));
      break;
    }
    case 'stars': {
      const cell = floor(p.xz.mul(0.25));
      const h = hash(cell.x.add(cell.y.mul(173.0)));
      const local = fract(p.xz.mul(0.25)).sub(0.5);
      const star = step(0.93, h).mul(smoothstep(0.12, 0.0, length(local)));
      const twinkle = sin(t.mul(2.0).add(h.mul(50.0)))
        .mul(0.35)
        .add(0.65);
      const neb = mx_fractal_noise_float(vec3(p.x.mul(0.01), p.z.mul(0.01), float(3.1)), 3, 2.0, 0.5);
      col = mix(cA, cB.mul(0.5), smoothstep(-0.1, 0.6, neb)) as Node<'vec3'>;
      col = col.add(vec3(1, 1, 1).mul(star.mul(twinkle).mul(1.6))) as Node<'vec3'>;
      break;
    }
    case 'lava': {
      const n = mx_fractal_noise_float(vec3(p.x.mul(0.04), p.z.mul(0.04), t.mul(0.1)), 3, 2.0, 0.5);
      col = mix(cA, cB.mul(2.0), smoothstep(0.1, 0.6, n)) as Node<'vec3'>;
      break;
    }
  }

  // Blend to fog colour with distance so the disc dissolves into the horizon haze.
  const dist = length(p.xz.sub(vec2(center.x, center.z)));
  const haze = smoothstep(theme.fog.far * 0.35, radius * 0.9, dist);
  mat.colorNode = mix(col, fogCol, haze);

  const mesh = new Mesh(geo, mat);
  mesh.position.set(center.x, y, center.z);
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.name = 'level-void';
  mesh.userData.uniforms = { time, cA, cB, fogCol };

  return {
    object: mesh,
    update(tt: number): void {
      time.value = tt;
    },
    dispose(): void {
      geo.dispose();
      mat.dispose();
    },
  };
}
