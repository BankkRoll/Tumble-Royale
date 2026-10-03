import type { BufferGeometry } from 'three/webgpu';
import {
  AdditiveBlending,
  BufferAttribute,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  TorusGeometry,
  type MeshToonNodeMaterial,
  type Node,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  atan,
  cameraPosition,
  float,
  fract,
  mix,
  normalWorld,
  positionLocal,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import type { ThemeDefinition } from '@tumble/content/themes';
import { createToonMaterial } from '../materials/toon.ts';
import { PropBuilder, type PropBatch } from '../environment/propKit.ts';
import { DecorRandom } from '../level/toolkit.ts';

/**
 * Reusable ceremony/menu props: the floating candy platform, the Crown, light
 * beams, a rotating sunburst backdrop and canvas-text banners.
 */

function painted(geo: BufferGeometry, hex: string): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes))
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  const c = new Color(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new BufferAttribute(arr, 3));
  return g;
}

/** Live floating platform. */
export interface FloatingPlatform {
  readonly object: Group;
  /** Height of the walkable top surface (local). */
  readonly topY: number;
  update(dt: number): void;
  dispose(): void;
}

/**
 * Floating candy platform: layered cake disc with icing drips, a striped rim,
 * sprinkles and themed props around the edge.
 *
 * @param theme - Colours and decor set.
 * @param radius - Top radius in metres.
 * @param seed - Decor seed.
 */
export function createFloatingPlatform(theme: ThemeDefinition, radius: number, seed = 1): FloatingPlatform {
  const rng = new DecorRandom(seed);
  const b = new PropBuilder();
  const p = theme.palette;
  const topY = 0;
  b.add('cyl', 0, -0.35, 0, radius, 0.7, radius, p.neutral);
  b.add('cyl', 0, -0.95, 0, radius * 1.02, 0.6, radius * 1.02, p.primary);
  b.add('cyl', 0, -1.6, 0, radius * 0.94, 0.8, radius * 0.94, p.secondary);
  b.add('cone', 0, -1.95 - radius * 0.55, 0, radius * 0.9, radius * 1.1, radius * 0.9, p.structure, [
    Math.PI,
    0,
    0,
  ]);
  const drips = Math.round(radius * 3.2);
  for (let i = 0; i < drips; i++) {
    const a = (i / drips) * Math.PI * 2 + rng.range(-0.08, 0.08);
    const len = rng.range(0.35, 0.9);
    b.add(
      'capsule',
      Math.cos(a) * radius * 1.0,
      -0.62 - len * 0.35,
      Math.sin(a) * radius * 1.0,
      0.36,
      len,
      0.36,
      p.neutral,
    );
  }
  const sprinkles = Math.round(radius * radius * 1.2);
  for (let i = 0; i < sprinkles; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * radius * 0.92;
    b.add('capsule', Math.cos(a) * r, 0.02, Math.sin(a) * r, 0.07, 0.16, 0.07, rng.pick(theme.decor.colors), [
      Math.PI / 2,
      rng.range(0, Math.PI),
      0,
    ]);
  }
  const posts = Math.max(4, Math.round(radius * 0.8));
  for (let i = 0; i < posts; i++) {
    const a = (i / posts) * Math.PI * 2 + Math.PI / posts;
    const x = Math.cos(a) * radius * 0.93;
    const z = Math.sin(a) * radius * 0.93;
    b.add('cyl', x, 0.35, z, 0.16, 0.7, 0.16, '#ffffff');
    b.add('sphere', x, 0.8, z, 0.24, 0.24, 0.24, rng.pick(theme.decor.colors));
  }
  const batch: PropBatch = b.build(true);
  const object = new Group();
  object.name = 'floating-platform';
  for (const m of batch.meshes) {
    m.receiveShadow = true;
    object.add(m);
  }
  return {
    object,
    topY,
    update(dt: number): void {
      batch.update(dt);
    },
    dispose(): void {
      batch.dispose();
      object.removeFromParent();
    },
  };
}

/** Crown mesh with a shiny gold node material. */
export function createCrownMesh(scale = 1): Mesh {
  const parts: BufferGeometry[] = [];
  const band = new CylinderGeometry(0.42, 0.38, 0.32, 28, 1, true);
  parts.push(painted(band, '#ffcf3a'));
  const inner = new CylinderGeometry(0.4, 0.36, 0.3, 28, 1, true);
  inner.scale(-1, 1, 1);
  parts.push(painted(inner, '#d99a1a'));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spike = new ConeGeometry(0.11, 0.34, 10);
    spike.translate(Math.cos(a) * 0.4, 0.31, Math.sin(a) * 0.4);
    parts.push(painted(spike, '#ffcf3a'));
    const ball = new IcosahedronGeometry(0.06, 1);
    ball.translate(Math.cos(a) * 0.4, 0.5, Math.sin(a) * 0.4);
    parts.push(painted(ball, '#fff3b0'));
    const gem = new IcosahedronGeometry(0.075, 0);
    gem.translate(Math.cos(a + Math.PI / 5) * 0.415, 0.0, Math.sin(a + Math.PI / 5) * 0.415);
    parts.push(painted(gem, i % 2 === 0 ? '#ff3d7f' : '#3fc5ff'));
  }
  const rim = new TorusGeometry(0.41, 0.035, 8, 32);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, -0.16, 0);
  parts.push(painted(rim, '#fff0a0'));
  const geo = mergeGeometries(parts)!;
  for (const g of parts) g.dispose();
  geo.scale(scale, scale, scale);

  const mat: MeshToonNodeMaterial = createToonMaterial({
    color: '#ffffff',
    rimColor: '#fff3c0',
    rimStrength: 0.9,
  });
  mat.vertexColors = true;
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const glint = smoothstep(0.75, 0.98, abs(normalWorld.normalize().dot(viewDir)).oneMinus().oneMinus());
  const base = (mat as MeshToonNodeMaterial & { emissiveNode: Node<'vec3'> }).emissiveNode;
  (mat as MeshToonNodeMaterial & { emissiveNode: Node<'vec3'> }).emissiveNode = base.add(
    vec3(1.0, 0.8, 0.3).mul(glint.mul(0.35)),
  );
  const mesh = new Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.name = 'crown';
  return mesh;
}

/** Live light beam. */
export interface LightBeam {
  readonly mesh: Mesh;
  /** Brightness multiplier (0 hides). */
  setIntensity(v: number): void;
  setColor(hex: string): void;
  dispose(): void;
}

/**
 * Soft volumetric-looking light beam (additive cone, fades along length and at
 * grazing angles).
 *
 * @param color - Beam colour.
 * @param length - Beam length.
 * @param radius - End radius.
 */
export function createLightBeam(color: string, length = 12, radius = 2.2): LightBeam {
  const geo = new CylinderGeometry(radius * 0.08, radius, length, 32, 1, true);
  geo.translate(0, -length / 2, 0);
  const intensity = uniform(1);
  const col = uniform(new Color(color));
  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
  const along = positionLocal.y.negate().div(length);
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const facing = abs(normalWorld.normalize().dot(viewDir));
  const alpha = smoothstep(1.0, 0.1, along)
    .mul(smoothstep(0.0, 0.06, along))
    .mul(facing.pow(1.5))
    .mul(0.35)
    .mul(intensity);
  mat.colorNode = col.mul(alpha);
  mat.opacityNode = alpha;
  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 30;
  mesh.name = 'light-beam';
  return {
    mesh,
    setIntensity(v: number): void {
      intensity.value = v;
      mesh.visible = v > 0.001;
    },
    setColor(hex: string): void {
      col.value.set(hex);
    },
    dispose(): void {
      geo.dispose();
      mat.dispose();
      mesh.removeFromParent();
    },
  };
}

/** Live sunburst. */
export interface Sunburst {
  readonly mesh: Mesh;
  setColors(a: string, b: string): void;
  update(dt: number): void;
  dispose(): void;
}

/** Rotating radial-stripe disc used behind ceremonies and results. */
export function createSunburst(colorA: string, colorB: string, radius = 60, rays = 18): Sunburst {
  const geo = new CircleGeometry(radius, 96);
  const time = uniform(0);
  const a = uniform(new Color(colorA));
  const b = uniform(new Color(colorB));
  const mat = new MeshBasicNodeMaterial({ fog: false, depthWrite: false });
  const st = uv().sub(0.5);
  const ang = atan(st.y, st.x)
    .div(Math.PI * 2)
    .add(0.5);
  const stripe = smoothstep(0.48, 0.52, fract(ang.mul(rays).add(time.mul(0.15))));
  const r = st.length().mul(2);
  const center = smoothstep(0.0, 0.35, r);
  mat.colorNode = mix(mix(a, b, stripe), a.mul(1.15), float(1).sub(center));
  const mesh = new Mesh(geo, mat);
  mesh.name = 'sunburst';
  mesh.renderOrder = -500;
  return {
    mesh,
    setColors(ca: string, cb: string): void {
      a.value.set(ca);
      b.value.set(cb);
    },
    update(dt: number): void {
      time.value += dt;
    },
    dispose(): void {
      geo.dispose();
      mat.dispose();
      mesh.removeFromParent();
    },
  };
}

/** A plane showing canvas-drawn text, redrawable (round titles, wall header). */
export interface TextBanner {
  readonly mesh: Mesh;
  /** Redraw the banner. */
  draw(title: string, subtitle?: string): void;
  dispose(): void;
}

/**
 * Creates a candy-styled text banner.
 *
 * @param width - World width.
 * @param height - World height.
 * @param colors - Fill, stripe and text colours.
 */
export function createTextBanner(
  width: number,
  height: number,
  colors: { fill: string; stripe: string; text: string; outline: string },
): TextBanner {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = Math.round((1024 * height) / width);
  const ctx = canvas.getContext('2d')!;
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  const mat = new MeshBasicNodeMaterial({ transparent: true, side: DoubleSide });
  const sample = texture(tex, uv());
  mat.colorNode = sample.rgb.mul(1.08);
  mat.opacityNode = sample.a;
  const mesh = new Mesh(new PlaneGeometry(width, height), mat);
  mesh.name = 'text-banner';

  const draw = (title: string, subtitle?: string): void => {
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const r = H * 0.22;
    ctx.beginPath();
    ctx.roundRect(8, 8, W - 16, H - 16, r);
    ctx.fillStyle = colors.fill;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = colors.stripe;
    for (let x = -H; x < W + H; x += 56) {
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.lineTo(x + 28, H);
      ctx.lineTo(x + 28 + H * 0.12, H - H * 0.12);
      ctx.lineTo(x + H * 0.12, H - H * 0.12);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, H * 0.12);
      ctx.lineTo(x + 28, H * 0.12);
      ctx.lineTo(x + 28 + H * 0.12, 0);
      ctx.lineTo(x + H * 0.12, 0);
      ctx.fill();
    }
    ctx.restore();
    ctx.lineWidth = 10;
    ctx.strokeStyle = colors.outline;
    ctx.beginPath();
    ctx.roundRect(8, 8, W - 16, H - 16, r);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const titleY = subtitle ? H * 0.44 : H * 0.52;
    let size = Math.round(H * (subtitle ? 0.36 : 0.46));
    ctx.font = `900 ${size}px 'Trebuchet MS', system-ui, sans-serif`;
    while (ctx.measureText(title).width > W * 0.86 && size > 12) {
      size -= 4;
      ctx.font = `900 ${size}px 'Trebuchet MS', system-ui, sans-serif`;
    }
    ctx.lineWidth = Math.max(6, size * 0.16);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colors.outline;
    ctx.strokeText(title, W / 2, titleY);
    ctx.fillStyle = colors.text;
    ctx.fillText(title, W / 2, titleY);
    if (subtitle) {
      const s2 = Math.round(H * 0.17);
      ctx.font = `800 ${s2}px 'Trebuchet MS', system-ui, sans-serif`;
      ctx.lineWidth = Math.max(4, s2 * 0.18);
      ctx.strokeText(subtitle, W / 2, H * 0.76);
      ctx.fillStyle = colors.text;
      ctx.fillText(subtitle, W / 2, H * 0.76);
    }
    tex.needsUpdate = true;
  };

  return {
    mesh,
    draw,
    dispose(): void {
      tex.dispose();
      mat.dispose();
      mesh.geometry.dispose();
      mesh.removeFromParent();
    },
  };
}

/**
 * Camera trauma shake (squared trauma → offset), frame-rate independent.
 */
export class CameraShake {
  private trauma = 0;
  private t = 0;

  /** Adds trauma 0..1. */
  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * @param dt - Seconds.
   * @param out - Receives the offset to add to the camera position.
   * @param scale - Max offset in metres.
   */
  update(dt: number, out: { x: number; y: number; z: number }, scale = 0.35): void {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const s = this.trauma * this.trauma * scale;
    out.x = (Math.sin(this.t * 37.1) + Math.sin(this.t * 23.7) * 0.5) * s;
    out.y = (Math.sin(this.t * 41.3 + 1.7) + Math.sin(this.t * 19.1) * 0.5) * s;
    out.z = Math.sin(this.t * 29.9 + 3.1) * s * 0.5;
  }
}
