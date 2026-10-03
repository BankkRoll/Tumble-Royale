/**
 * Cosmetic thumbnails for every menu card (store, featured, locker, pass,
 * challenge rewards, profile showcase, rewards unlock reveal, lobby emotes).
 *
 * Responsibilities:
 * - wearables, faces, patterns, colours: a real Tumbler (createTumblerVisual)
 *   wearing the item, rendered once into an offscreen render target on the
 *   game's renderer, framed on the part that matters (head for headwear and
 *   faces, a back view for back items, the body for patterns/colours);
 * - emotes, celebrations, victory poses: the Tumbler mid-animation;
 * - nameplates, banners, trails, footsteps (no mesh on the body): a small 2D
 *   illustration in the item's own colours;
 * - a vivid candy body (never a pale base) so patterns and colours read;
 * - lazy + budgeted: one item per menu frame, skipped on slow frames; results
 *   are PNG data URLs in the UI store (`thumbnails`), LRU-capped.
 *
 * @example
 * const thumbs = new ThumbnailRenderer(renderer, tumblers.create);
 * bindUI({ onNeedThumbnails: ({ ids }) => thumbs.request(ids) });
 * // each menu frame, after the main render:
 * thumbs.pump(frameMs);
 */
import { getCosmetic, type CosmeticItem } from '@tumble/content/cosmetics';
import type { CreateTumblerVisual } from '@tumble/render/scenes';
import { CharacterState } from '@tumble/sim/character';
import { ui, type CosmeticSlot as UiSlot, type TumblerColors } from '@tumble/ui';
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  RenderTarget,
  SRGBColorSpace,
  Scene,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import { defaultUiLoadout, uiLoadoutToTumbler } from './cosmetics.ts';
import { loadoutWithItem } from './profile.ts';

const SIZE = 256;
/** Upper bound on cached thumbnails (the whole catalog fits; this guards growth). */
const CACHE_CAP = 400;
/** Frames slower than this skip thumbnail work so menus never hitch. */
const SLOW_FRAME_MS = 24;

const POSED = new Set<UiSlot>(['emote', 'celebration', 'victory']);
const FLAT = new Set<UiSlot>(['nameplate', 'banner', 'trail', 'footsteps']);

/** Candy body colours so the item reads against the card (wearables) or is the point (patterns). */
const WEAR_BODY: TumblerColors = {
  primary: '#7cc4ff',
  secondary: '#ffffff',
  tertiary: '#fff7ea',
  pattern: 'plain',
};
const PATTERN_BODY: TumblerColors = {
  primary: '#ff5fa8',
  secondary: '#ffd23f',
  tertiary: '#fff7ea',
  pattern: 'plain',
};
const POSE_BODY: TumblerColors = {
  primary: '#ffb03b',
  secondary: '#ff5fa8',
  tertiary: '#fff7ea',
  pattern: 'dots',
};

function uiSlot(item: CosmeticItem): UiSlot {
  return item.slot === 'color' ? 'colors' : item.slot;
}

/** Camera position and look target per slot (the Tumbler is ~1.8 m tall, facing +Z). */
function framing(slot: UiSlot): [Vector3, Vector3, number] {
  switch (slot) {
    case 'headwear':
      return [new Vector3(0.75, 1.95, 2.1), new Vector3(0, 1.62, 0), 30];
    case 'face':
      return [new Vector3(0.35, 1.5, 1.9), new Vector3(0, 1.32, 0), 28];
    case 'upper':
      return [new Vector3(0.7, 1.3, 2.3), new Vector3(0, 1.05, 0), 32];
    case 'lower':
      return [new Vector3(0.8, 0.85, 2.4), new Vector3(0, 0.6, 0), 32];
    case 'back':
      return [new Vector3(-1.2, 1.45, -2.3), new Vector3(0, 1.0, 0), 34];
    default:
      return [new Vector3(1.0, 1.25, 3.3), new Vector3(0, 0.9, 0), 32];
  }
}

// -----------------------------------------------------------------------------
// 2D illustrations for items that don't sit on the body
// -----------------------------------------------------------------------------

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const INK = '#2b1a5e';

function drawFlat(ctx: CanvasRenderingContext2D, item: CosmeticItem): void {
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (item.slot === 'nameplate') {
    const p = item.plate;
    const g = ctx.createLinearGradient(0, 96, 0, 160);
    g.addColorStop(0, p.bg2);
    g.addColorStop(1, p.bg);
    const r = p.style === 'pill' || p.style === 'bubble' ? 32 : p.style === 'ticket' ? 12 : 8;
    roundRect(ctx, 22, 96, 212, 64, r);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = p.border;
    if (p.style === 'neon') {
      ctx.shadowColor = p.border;
      ctx.shadowBlur = 16;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    roundRect(ctx, 16, 90, 224, 76, r + 4);
    ctx.stroke();
    ctx.fillStyle = p.text;
    ctx.font = '700 30px "Lilita One", "Fredoka", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Tumbler', 128, 130);
    return;
  }
  if (item.slot === 'banner') {
    const [a, b, c] = item.banner.colors;
    ctx.save();
    roundRect(ctx, 20, 52, 216, 152, 18);
    ctx.clip();
    const g = ctx.createLinearGradient(20, 52, 236, 204);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    ctx.fillStyle = g;
    ctx.fillRect(20, 52, 216, 152);
    ctx.fillStyle = c;
    const m = item.banner.motif;
    for (let i = 0; i < 14; i++) {
      const x = 20 + ((i * 53) % 216);
      const y = 52 + ((i * 37) % 152);
      if (m === 'stripes') {
        ctx.fillRect(20 + i * 34, 52, 14, 152);
      } else if (m === 'waves') {
        ctx.beginPath();
        ctx.arc(128, 260, 40 + i * 14, Math.PI, 0);
        ctx.lineWidth = 6;
        ctx.strokeStyle = c;
        ctx.stroke();
      } else if (m === 'clouds') {
        ctx.beginPath();
        ctx.ellipse(x, y, 26, 14, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, m === 'candy' ? 12 : m === 'stars' ? 4 : 7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK;
    roundRect(ctx, 20, 52, 216, 152, 18);
    ctx.stroke();
    return;
  }
  if (item.slot === 'trail') {
    const cols = item.trail.colors;
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const x = 34 + t * 188;
      const y = 196 - Math.sin(t * Math.PI * 0.9) * 120;
      const rad = 7 + t * 17;
      ctx.fillStyle = cols[i % cols.length] ?? '#fff';
      ctx.beginPath();
      if (item.trail.kind === 'stars' || item.trail.kind === 'sparkle') {
        for (let k = 0; k < 10; k++) {
          const ang = (k * Math.PI) / 5 - Math.PI / 2;
          const rr = k % 2 === 0 ? rad : rad * 0.45;
          ctx.lineTo(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
        }
        ctx.closePath();
      } else ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = INK;
      ctx.stroke();
    }
    return;
  }
  if (item.slot === 'footsteps') {
    for (let i = 0; i < 4; i++) {
      const x = 70 + (i % 2) * 60 + i * 18;
      const y = 200 - i * 46;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-0.3);
      ctx.fillStyle = ['#ff5fa8', '#ffd23f', '#7cc4ff', '#3ee6b4'][i] as string;
      ctx.beginPath();
      ctx.ellipse(0, 0, 18, 26, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.restore();
    }
  }
}

/**
 * Lazy thumbnail renderer (see the module docs).
 */
export class ThumbnailRenderer {
  private readonly queue: string[] = [];
  private readonly seen = new Set<string>();
  /** Insertion order of cached ids, oldest first (LRU by last request). */
  private readonly lru: string[] = [];
  private busy = false;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.05, 50);
  private readonly target: RenderTarget;
  private readonly canvas = document.createElement('canvas');
  private readonly clear = new Color();
  private failed = false;

  /**
   * @param renderer - The game's renderer (shared, so no second GPU context).
   * @param createTumbler - The real Tumbler factory.
   */
  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly createTumbler: CreateTumblerVisual,
  ) {
    this.target = new RenderTarget(SIZE, SIZE, { samples: 4 });
    this.target.texture.colorSpace = SRGBColorSpace;
    this.scene.add(new HemisphereLight('#ffffff', '#d9c9ff', 2.4));
    const sun = new DirectionalLight('#fff4e0', 2.4);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
    const rim = new DirectionalLight('#ffd6f2', 1.4);
    rim.position.set(-3, 2, -2);
    this.scene.add(rim);
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
  }

  /**
   * Queues items for rendering (unknown and already queued ids are ignored).
   *
   * @param ids - Cosmetic ids.
   */
  request(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.seen.has(id)) {
        this.touch(id);
        continue;
      }
      const item = getCosmetic(id);
      if (!item) continue;
      this.seen.add(id);
      // Flat illustrations need no GPU; draw them right away.
      if (FLAT.has(uiSlot(item))) {
        const ctx = this.canvas.getContext('2d');
        if (!ctx) continue;
        drawFlat(ctx, item);
        this.store(id, this.canvas.toDataURL('image/png'));
        continue;
      }
      if (!this.failed) this.queue.push(id);
    }
  }

  /**
   * Renders at most one queued item. Call once per menu frame after the main render.
   *
   * @param frameMs - Duration of the frame just rendered; slow frames skip the work.
   */
  pump(frameMs = 0): void {
    if (this.busy || this.failed || this.queue.length === 0 || frameMs > SLOW_FRAME_MS) return;
    const id = this.queue.shift() as string;
    this.busy = true;
    this.render(id)
      .then((url) => {
        if (url) this.store(id, url);
      })
      .catch((err) => {
        // A backend that can't read back (rare) keeps the rarity silhouettes.
        console.warn('[thumbnails] disabled:', err);
        this.failed = true;
      })
      .finally(() => {
        this.busy = false;
      });
  }

  private touch(id: string): void {
    const i = this.lru.indexOf(id);
    if (i >= 0) {
      this.lru.splice(i, 1);
      this.lru.push(id);
    }
  }

  private store(id: string, url: string): void {
    this.lru.push(id);
    const s = ui.getState();
    if (this.lru.length <= CACHE_CAP) {
      s.setThumbnails({ [id]: url });
      return;
    }
    const evicted = this.lru.splice(0, this.lru.length - CACHE_CAP);
    const next = { ...s.thumbnails, [id]: url };
    for (const e of evicted) {
      delete next[e];
      this.seen.delete(e);
    }
    ui.setState({ thumbnails: next });
  }

  private async render(id: string): Promise<string | null> {
    const item = getCosmetic(id);
    if (!item) return null;
    const slot = uiSlot(item);
    const posed = POSED.has(slot);
    const body = posed ? POSE_BODY : slot === 'pattern' ? PATTERN_BODY : WEAR_BODY;
    const visual = this.createTumbler(
      uiLoadoutToTumbler(loadoutWithItem(defaultUiLoadout('thumb', body), slot, id)),
    );
    this.scene.add(visual.object);
    visual.object.rotation.y = slot === 'back' ? Math.PI * 0.85 : slot === 'face' ? -0.12 : -0.35;
    const anim = {
      state: posed ? CharacterState.Emote : CharacterState.Idle,
      stateTime: 0,
      speed: 0,
      verticalSpeed: 0,
      facing: 0,
      grounded: true,
      emote: posed ? id : null,
    };
    // Let the procedural animation settle (and an emote reach a readable pose).
    for (let i = 0; i < (posed ? 55 : 12); i++) {
      anim.stateTime += 1 / 60;
      visual.update(1 / 60, anim);
    }
    const [pos, look, fov] = framing(slot);
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    r.getClearColor(this.clear);
    const prevAlpha = r.getClearAlpha();
    try {
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(this.target);
      r.clear();
      r.render(this.scene, this.camera);
    } finally {
      r.setRenderTarget(prevTarget);
      r.setClearColor(this.clear, prevAlpha);
      this.scene.remove(visual.object);
    }
    const pixels = (await r.readRenderTargetPixelsAsync(this.target, 0, 0, SIZE, SIZE)) as Uint8Array;
    visual.dispose();
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(SIZE, SIZE);
    // COMPAT: WebGL reads rows bottom-up; WebGPU top-down.
    const flip = (r.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true;
    const row = SIZE * 4;
    for (let y = 0; y < SIZE; y++) {
      const src = (flip ? SIZE - 1 - y : y) * row;
      img.data.set(pixels.subarray(src, src + row), y * row);
    }
    ctx.putImageData(img, 0, 0);
    return this.canvas.toDataURL('image/png');
  }

  /** Frees the render target. */
  dispose(): void {
    this.target.dispose();
  }
}
