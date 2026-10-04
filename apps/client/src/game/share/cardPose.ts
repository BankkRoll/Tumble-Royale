/**
 * The share card's hero image: the player's own Tumbler, in their outfit,
 * striking their equipped victory pose (a celebration when they did not win),
 * rendered once on the game's renderer into an offscreen target with a
 * transparent background and read back into a 2D canvas.
 */
import type { CreateTumblerVisual, TumblerLoadout } from '@tumble/render/scenes';
import { CharacterState } from '@tumble/sim/character';
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
import { readTargetInto } from './readback.ts';

/** Pose render size (px, square); the card scales it to its stage. */
export const POSE_SIZE = 768;
/** Frames of animation before the snapshot, so the pose reaches its readable peak. */
const SETTLE_FRAMES = 70;

/**
 * Renders the posed Tumbler.
 *
 * @param renderer - The game's renderer (shared: no second GPU context).
 * @param createTumbler - The real Tumbler factory.
 * @param loadout - The player's look.
 * @param won - Strike the victory pose (else the celebration).
 * @returns A canvas with the Tumbler on transparency.
 * @throws When the backend cannot read pixels back.
 */
export async function renderPose(
  renderer: WebGPURenderer,
  createTumbler: CreateTumblerVisual,
  loadout: TumblerLoadout,
  won: boolean,
): Promise<HTMLCanvasElement> {
  const scene = new Scene();
  scene.add(new HemisphereLight('#ffffff', '#d9c9ff', 2.4));
  const sun = new DirectionalLight('#fff4e0', 2.6);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const rim = new DirectionalLight('#ffd6f2', 1.6);
  rim.position.set(-3, 2, -2);
  scene.add(rim);
  const camera = new PerspectiveCamera(30, 1, 0.05, 50);
  camera.position.set(1.1, 1.35, 4.1);
  camera.lookAt(new Vector3(0, 0.95, 0));

  const target = new RenderTarget(POSE_SIZE, POSE_SIZE, { samples: 4 });
  target.texture.colorSpace = SRGBColorSpace;
  const visual = createTumbler(loadout);
  scene.add(visual.object);
  visual.object.rotation.y = -0.3;
  const emote = won ? loadout.victoryPose : loadout.celebration;
  const anim = {
    state: emote ? CharacterState.Emote : CharacterState.Idle,
    stateTime: 0,
    speed: 0,
    verticalSpeed: 0,
    facing: 0,
    grounded: true,
    emote: emote || null,
  };
  for (let i = 0; i < SETTLE_FRAMES; i++) {
    anim.stateTime += 1 / 60;
    visual.update(1 / 60, anim);
  }

  const prevTarget = renderer.getRenderTarget();
  const clear = new Color();
  renderer.getClearColor(clear);
  const prevAlpha = renderer.getClearAlpha();
  try {
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(clear, prevAlpha);
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = POSE_SIZE;
    canvas.height = POSE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    await readTargetInto(renderer, target, ctx);
    return canvas;
  } finally {
    scene.remove(visual.object);
    visual.dispose();
    target.dispose();
  }
}
