import { ACESFilmicToneMapping, PCFSoftShadowMap, SRGBColorSpace, WebGPURenderer } from 'three/webgpu';

/** Which GPU backend to request. `auto` picks WebGPU when available and falls back to WebGL2. */
export type BackendPreference = 'auto' | 'webgpu' | 'webgl';

/** Result of {@link createRenderer}. */
export interface RendererInfo {
  renderer: WebGPURenderer;
  /** The backend that actually initialised. */
  backend: 'webgpu' | 'webgl2';
}

/**
 * Creates and initialises the game renderer.
 *
 * @param canvas - Target canvas element.
 * @param preference - Backend preference; `webgl` forces the WebGL2 path for parity testing.
 * @returns The renderer and the backend in use.
 */
export async function createRenderer(
  canvas: HTMLCanvasElement,
  preference: BackendPreference = 'auto',
): Promise<RendererInfo> {
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const forceWebGL = preference === 'webgl' || !hasWebGPU;

  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL, powerPreference: 'high-performance' });
  await renderer.init();

  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // WebGPURenderer silently falls back to WebGL2 when adapter acquisition fails,
  // so the requested preference is not proof of what we got.
  const backendFlags = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  const backend = backendFlags.isWebGPUBackend === true ? 'webgpu' : 'webgl2';

  return { renderer, backend };
}
