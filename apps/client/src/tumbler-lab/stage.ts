/**
 * Tumbler Lab stage: sky, lights with shadows and a candy showroom platform.
 */
import {
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';
import { createOutlineMaterial, createSkyDome, createToonMaterial } from '@tumble/render';
import { setTumblerLighting } from '@tumble/render/character';

/** Platform top height; the ragdoll ground sits here too. */
export const FLOOR_Y = 0;

/** Lab scene with its key light. */
export interface Stage {
  scene: Scene;
  sun: DirectionalLight;
}

/**
 * Builds the showroom.
 *
 * @returns Scene and sun.
 */
export function createStage(): Stage {
  const scene = new Scene();
  scene.add(createSkyDome());
  scene.fog = new Fog(new Color('#ffd6f2'), 70, 240);

  scene.add(new HemisphereLight('#e4f3ff', '#ffc9e6', 1.5));
  const sun = new DirectionalLight('#fff3dc', 2.7);
  sun.position.set(14, 26, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -20;
  sc.right = 20;
  sc.top = 20;
  sc.bottom = -20;
  sc.near = 1;
  sc.far = 80;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  setTumblerLighting(new Vector3().copy(sun.position).normalize());

  const platform = new Group();
  const top = new Mesh(new CylinderGeometry(18, 18, 1, 96), createToonMaterial({ color: '#fff1f8', rimStrength: 0.2 }));
  top.position.y = FLOOR_Y - 0.5;
  top.receiveShadow = true;
  platform.add(top);

  // Concentric candy rings on the floor read as a turntable / stage.
  const ringColors = ['#ffc4e8', '#bdf3ff', '#fff3a0', '#c9ffe6'];
  for (let i = 0; i < 4; i++) {
    const r = 3 + i * 3.6;
    const ring = new Mesh(new TorusGeometry(r, 0.22, 10, 96), createToonMaterial({ color: ringColors[i]!, rimStrength: 0.2 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = FLOOR_Y - 0.12;
    ring.scale.z = 0.4;
    ring.receiveShadow = true;
    platform.add(ring);
  }
  const turntable = new Mesh(new CylinderGeometry(1.6, 1.7, 0.18, 64), createToonMaterial({ color: '#ff8fc5', rimStrength: 0.3 }));
  turntable.position.y = FLOOR_Y - 0.08;
  turntable.receiveShadow = true;
  platform.add(turntable);

  const skirt = new Mesh(new CylinderGeometry(18, 9, 7, 96), createToonMaterial({ color: '#ff9fd0' }));
  skirt.position.y = FLOOR_Y - 4.5;
  platform.add(skirt);
  const trim = new Mesh(new TorusGeometry(18, 0.45, 12, 128), createToonMaterial({ color: '#ffffff', rimStrength: 0.3 }));
  trim.rotation.x = Math.PI / 2;
  trim.position.y = FLOOR_Y - 0.5;
  platform.add(trim);

  // Lollipop props around the rim.
  const lolliColors = ['#ff4f8b', '#3fa9ff', '#ffd23f', '#6ee7a8', '#b45cff', '#ff8a3d'];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.2;
    const g = new Group();
    const stick = new Mesh(new CylinderGeometry(0.08, 0.08, 3.2, 10), createToonMaterial({ color: '#ffffff' }));
    stick.position.y = 1.6;
    stick.castShadow = true;
    const candyGeo = new SphereGeometry(0.75, 32, 16);
    const candy = new Mesh(candyGeo, createToonMaterial({ color: lolliColors[i % lolliColors.length]!, rimStrength: 0.5 }));
    candy.scale.z = 0.45;
    candy.position.y = 3.5;
    candy.castShadow = true;
    candy.add(new Mesh(candyGeo, createOutlineMaterial(0.03)));
    g.add(stick, candy);
    g.position.set(Math.cos(a) * 16.4, FLOOR_Y, Math.sin(a) * 16.4);
    g.rotation.y = -a + Math.PI / 2;
    platform.add(g);
  }
  scene.add(platform);
  return { scene, sun };
}
