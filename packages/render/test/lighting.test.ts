import { describe, expect, it } from 'vitest';
import { DirectionalLight, PerspectiveCamera } from 'three/webgpu';
import { getTheme } from '@tumble/content/themes';
import { resolveAtmosphere } from '../src/environment/atmosphere.ts';
import { createLightingRig } from '../src/environment/lighting.ts';

function rigWithCascades(stride: number) {
  const rig = createLightingRig(resolveAtmosphere(getTheme('candy'), 'clear'), {
    shadows: 'csm',
    cascades: 3,
    farCascadeStride: stride,
  });
  // The CSM node creates its cascade lights on its first shader build; stand in for them.
  const lights = [new DirectionalLight(), new DirectionalLight(), new DirectionalLight()];
  (rig.sun.shadow as unknown as { shadowNode: { lights: DirectionalLight[] } }).shadowNode.lights = lights;
  return { rig, lights };
}

describe('lighting rig', () => {
  it('re-renders the far cascade every Nth frame and the others every frame', () => {
    const { rig, lights } = rigWithCascades(2);
    const camera = new PerspectiveCamera();
    const far: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      rig.update(camera);
      far.push(lights[2]!.shadow.needsUpdate);
    }
    expect(far).toEqual([true, false, true, false, true, false]);
    expect(lights[2]!.shadow.autoUpdate).toBe(false);
    expect(lights[0]!.shadow.autoUpdate).toBe(true);
    expect(lights[1]!.shadow.autoUpdate).toBe(true);
    rig.dispose();
  });

  it('leaves every cascade on auto update by default', () => {
    const { rig, lights } = rigWithCascades(1);
    rig.update(new PerspectiveCamera());
    expect(lights.every((l) => l.shadow.autoUpdate)).toBe(true);
    rig.dispose();
  });
});
