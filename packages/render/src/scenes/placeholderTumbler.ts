import { Group, Mesh, SphereGeometry, type BufferGeometry, type MeshToonNodeMaterial } from 'three/webgpu';
import type { CreateTumblerVisual, TumblerAnimInput, TumblerLoadout, TumblerVisual } from '../character/types.ts';
import { createToonMaterial } from '../materials/toon.ts';
import { createOutlineMaterial } from '../materials/outline.ts';
import { createGumdropGeometry } from '../environment/crowd.ts';

/**
 * Fallback Tumbler used by menu/ceremony scenes when no `CreateTumblerVisual`
 * factory is injected (or while the real character module is still loading).
 * Gumdrop body, face visor, two eyes, little feet, outline; a light procedural
 * idle/emote/fall animation so scenes are reviewable on their own.
 */

let sharedBody: BufferGeometry | null = null;
let sharedSphere: BufferGeometry | null = null;

function bodyGeometry(): BufferGeometry {
  sharedBody ??= createGumdropGeometry(1.3, 0.5, 24);
  return sharedBody;
}

function sphereGeometry(): BufferGeometry {
  sharedSphere ??= new SphereGeometry(1, 16, 12);
  return sharedSphere;
}

/** A neutral default loadout for mock players and lab scenes. */
export function defaultLoadout(primary = '#ff6fb5', secondary = '#ffd23f', tertiary = '#ffffff'): TumblerLoadout {
  return {
    colors: [primary, secondary, tertiary],
    pattern: 'none',
    face: 'default',
    upper: null,
    lower: null,
    headwear: null,
    back: null,
    emotes: ['wave', 'dance', 'cheer', 'shrug'],
    celebration: 'jump',
    victoryPose: 'arms-up',
    nameplate: 'default',
    trail: null,
  };
}

/**
 * Creates the placeholder Tumbler.
 *
 * @param loadout - Colours are honoured; cosmetics are ignored.
 * @returns A {@link TumblerVisual}.
 */
export const createPlaceholderTumbler: CreateTumblerVisual = (loadout: TumblerLoadout): TumblerVisual => {
  const root = new Group();
  root.name = 'placeholder-tumbler';
  const rig = new Group();
  root.add(rig);

  const bodyMat: MeshToonNodeMaterial = createToonMaterial({ color: loadout.colors[0], rimStrength: 0.55 });
  const visorMat = createToonMaterial({ color: '#ffffff', rimStrength: 0.2 });
  const eyeMat = createToonMaterial({ color: '#1d1430', rimStrength: 0 });
  const footMat = createToonMaterial({ color: loadout.colors[1] });
  const outlineMat = createOutlineMaterial(0.025);

  const body = new Mesh(bodyGeometry(), bodyMat);
  body.castShadow = true;
  rig.add(body);
  const outline = new Mesh(bodyGeometry(), outlineMat);
  rig.add(outline);

  const visor = new Mesh(sphereGeometry(), visorMat);
  visor.scale.set(0.36, 0.26, 0.18);
  visor.position.set(0, 0.86, 0.36);
  rig.add(visor);
  const eyes: Mesh[] = [];
  for (const sx of [-1, 1]) {
    const eye = new Mesh(sphereGeometry(), eyeMat);
    eye.scale.set(0.055, 0.085, 0.04);
    eye.position.set(sx * 0.12, 0.88, 0.52);
    rig.add(eye);
    eyes.push(eye);
  }
  const feet: Mesh[] = [];
  for (const sx of [-1, 1]) {
    const foot = new Mesh(sphereGeometry(), footMat);
    foot.scale.set(0.15, 0.09, 0.2);
    foot.position.set(sx * 0.2, 0.06, 0.05);
    foot.castShadow = true;
    root.add(foot);
    feet.push(foot);
  }
  const hands: Mesh[] = [];
  for (const sx of [-1, 1]) {
    const hand = new Mesh(sphereGeometry(), bodyMat);
    hand.scale.setScalar(0.12);
    hand.position.set(sx * 0.52, 0.55, 0.05);
    hand.castShadow = true;
    rig.add(hand);
    hands.push(hand);
  }

  let t = Math.random() * 10;
  let blink = 2 + Math.random() * 3;
  let squash = 0;
  let squashVel = 0;

  return {
    object: root,
    setLoadout(l: TumblerLoadout): void {
      bodyMat.color.set(l.colors[0]);
      footMat.color.set(l.colors[1]);
    },
    update(dt: number, anim: TumblerAnimInput): void {
      t += dt;
      blink -= dt;
      const closing = blink < 0.12;
      if (blink < 0) blink = 2 + Math.random() * 3;
      for (const e of eyes) e.scale.y = closing ? 0.012 : 0.085;

      if (anim.impulse) {
        squashVel -= anim.impulse * 6;
        anim.impulse = 0;
      }
      // Damped spring for squash & stretch.
      squashVel += (-squash * 180 - squashVel * 14) * dt;
      squash += squashVel * dt;

      const emoting = anim.emote !== null;
      const falling = anim.state === 3 || anim.state === 10;
      let bob = Math.sin(t * 2.4) * 0.025;
      let armL = 0;
      let armR = 0;
      if (emoting) {
        const e = anim.emote;
        if (e === 'wave') armR = 1.2 + Math.sin(t * 10) * 0.4;
        else if (e === 'cheer' || e === 'victory') {
          armL = armR = 1.4 + Math.sin(t * 12) * 0.2;
          bob = Math.abs(Math.sin(t * 6)) * 0.35;
        } else if (e === 'dance') {
          bob = Math.abs(Math.sin(t * 5)) * 0.18;
          rig.rotation.z = Math.sin(t * 5) * 0.18;
          armL = 0.6 + Math.sin(t * 5) * 0.6;
          armR = 0.6 - Math.sin(t * 5) * 0.6;
        } else {
          armL = armR = 0.5;
        }
      } else {
        rig.rotation.z *= 0.9;
      }
      if (falling) {
        armL = armR = 2.4 + Math.sin(t * 20) * 0.3;
      }
      const s = 1 + squash;
      rig.scale.set(1 / Math.sqrt(Math.max(s, 0.3)), s, 1 / Math.sqrt(Math.max(s, 0.3)));
      rig.position.y = bob;
      hands[0]!.position.set(-0.52 - Math.sin(armL) * 0.05, 0.55 + Math.sin(armL) * 0.42, 0.05);
      hands[1]!.position.set(0.52 + Math.sin(armR) * 0.05, 0.55 + Math.sin(armR) * 0.42, 0.05);
      root.rotation.y = anim.facing;
    },
    setLod(): void {},
    dispose(): void {
      bodyMat.dispose();
      visorMat.dispose();
      eyeMat.dispose();
      footMat.dispose();
      outlineMat.dispose();
      root.removeFromParent();
    },
  };
};
