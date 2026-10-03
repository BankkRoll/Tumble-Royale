/**
 * Tumbler Lab (`/tumbler.html`): the character showroom.
 *
 * Responsibilities: hero Tumbler on a turntable with orbit camera, a lineup of
 * 12 random Tumblers, buttons for every state / emote / celebration / victory
 * pose, run-speed slider, squash impulse, physics ragdolls, loadout editor,
 * LOD toggle and a 40-Tumbler crowd stress test with FPS / draw-call readout.
 */
import GUI from 'lil-gui';
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createRenderer, type BackendPreference } from '@tumble/render';
import {
  NameplateLayer,
  RagdollManager,
  RagdollWorld,
  Tumbler,
  assemblyCacheSize,
  type Nameplate,
  type TumblerLoadout,
} from '@tumble/render/character';
import {
  ANIM_CLIP_IDS,
  cosmeticsInSlot,
  defaultLoadout,
  getCosmeticInSlot,
  randomLoadout,
  type AnimClipId,
  type CosmeticSlot,
} from '@tumble/content/cosmetics';
import { CharacterState, loadRapier } from '@tumble/sim';
import { Rng } from '@tumble/shared';
import { StatsOverlay } from '../debug/stats.ts';
import { Puppet } from './puppet.ts';
import { FLOOR_Y, createStage } from './stage.ts';

type Mode = 'showroom' | 'wardrobe' | 'crowd';

/** Debug hooks for Playwright and the console. */
interface TumbleLabDebug {
  ready: boolean;
  mode: () => Mode;
  setMode: (m: Mode) => void;
  hero: () => Puppet;
  frames: number;
  errors: string[];
  /** Moves the orbit camera (screenshots). */
  view: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => void;
  /** Hides all DOM chrome (screenshots). */
  hideUi: () => void;
  /** Applies a loadout to the hero. */
  dress: (l: Partial<TumblerLoadout>) => void;
  /** Live GUI values (turntable, lookAtCamera, …). */
  ui: Record<string, unknown>;
}

declare global {
  interface Window {
    __tumbleLab?: TumbleLabDebug;
  }
}

const STATE_NAMES = Object.keys(CharacterState) as (keyof typeof CharacterState)[];
const NAME_BITS_A = ['Sprinkle', 'Gummy', 'Bouncy', 'Wobble', 'Jelly', 'Fizzy', 'Toffee', 'Puddle', 'Noodle', 'Biscuit', 'Marsh', 'Zippy'];
const NAME_BITS_B = ['Bop', 'Paws', 'Dash', 'Tumble', 'Socks', 'Pop', 'Muffin', 'Wiggle', 'Boots', 'Sprout'];

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const preference = (params.get('backend') ?? 'auto') as BackendPreference;
  const R = await loadRapier();
  const canvas = document.getElementById('lab') as HTMLCanvasElement;
  const { renderer, backend } = await createRenderer(canvas, preference);

  const { scene } = createStage();
  const camera = new PerspectiveCamera(40, 1, 0.1, 700);
  camera.position.set(0.6, 2.1, 6.6);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.0, 0);
  controls.enableDamping = true;
  controls.minDistance = 2.2;
  controls.maxDistance = 45;
  controls.maxPolarAngle = Math.PI * 0.49;

  const ragWorld = new RagdollWorld(R);
  ragWorld.addGround(FLOOR_Y);
  const ragdolls = new RagdollManager(ragWorld, 8);

  const plates = new NameplateLayer();
  scene.add(plates.mesh);

  const stats = new StatsOverlay(document.body);
  stats.set('gpu', backend);

  // ---------------------------------------------------------------------------
  // Actors
  // ---------------------------------------------------------------------------

  const loadout: TumblerLoadout = defaultLoadout();
  loadout.headwear = 'headwear.party-cone';
  const hero = new Puppet(new Tumbler(loadout));
  scene.add(hero.visual.object);
  const heroPlate = plates.create('You', { style: loadout.nameplate });
  if (heroPlate) heroPlate.target = hero.visual.object;

  /** A secondary Tumbler owned by the current mode. */
  interface Actor {
    p: Puppet;
    plate: Nameplate | null;
    tick?: (dt: number) => void;
  }
  const actors: Actor[] = [];
  const nameRng = new Rng(7);
  const funName = (): string => `${nameRng.pick(NAME_BITS_A)}${nameRng.pick(NAME_BITS_B)}#${nameRng.int(10, 99)}`;
  const emoteClips = ANIM_CLIP_IDS.filter((c) => !c.startsWith('victory'));

  function addActor(l: TumblerLoadout, name: string, x: number, z: number, teamColor: string | null = null): Actor {
    const p = new Puppet(new Tumbler(l));
    p.x = x;
    p.z = z;
    scene.add(p.visual.object);
    const plate = plates.create(name, { style: l.nameplate, teamColor });
    if (plate) plate.target = p.visual.object;
    const a: Actor = { p, plate };
    actors.push(a);
    return a;
  }

  /** Idle actor that emotes, jumps or gets stunned now and then. */
  function fidget(a: Actor, i: number): void {
    let timer = 1 + i * 0.37;
    a.tick = (dt) => {
      timer -= dt;
      if (timer > 0 || a.p.busy) return;
      timer = 3 + ((i * 7919) % 5);
      const roll = (performance.now() / 1000 + i * 1.7) % 1;
      if (roll < 0.15) a.p.jump();
      else if (roll < 0.22) a.p.stun(1.4);
      else a.p.emote(emoteClips[(i + Math.floor(performance.now() / 3000)) % emoteClips.length] as AnimClipId);
    };
  }

  function buildLineup(): void {
    for (let i = 0; i < 12; i++) {
      const ang = Math.PI * (0.18 + (0.64 * i) / 11);
      const a = addActor(randomLoadout(new Rng(100 + i)), funName(), Math.cos(ang) * 8, -Math.sin(ang) * 8 + 1.5);
      a.p.anim.facing = Math.atan2(-a.p.x, 6 - a.p.z);
      fidget(a, i);
    }
  }

  /** Every wearable, face and pattern on its own Tumbler, labelled with the item name. */
  function buildWardrobe(): void {
    const items = [
      ...cosmeticsInSlot('headwear'),
      ...cosmeticsInSlot('back'),
      ...cosmeticsInSlot('upper'),
      ...cosmeticsInSlot('lower'),
      ...cosmeticsInSlot('face'),
      ...cosmeticsInSlot('pattern'),
    ];
    const cols = 10;
    items.forEach((item, i) => {
      const l = defaultLoadout();
      const preset = cosmeticsInSlot('color')[i % cosmeticsInSlot('color').length]!;
      l.colors = [...preset.colors];
      if (item.slot === 'face') l.face = item.id;
      else if (item.slot === 'pattern') l.pattern = item.id;
      else l[item.slot] = item.id;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const a = addActor(l, item.name, (col - (cols - 1) / 2) * 2.1, 6 - row * 2.6);
      a.p.anim.facing = item.slot === 'back' ? Math.PI * 0.8 : 0;
      fidget(a, i);
    });
  }

  function buildCrowd(): void {
    const rng = new Rng(4242);
    for (let i = 0; i < 40; i++) {
      const a = addActor(randomLoadout(new Rng(1000 + i)), funName(), 0, 0, i % 5 === 0 ? '#3fa9ff' : null);
      const r = 3 + (i % 8) * 1.6 + rng.range(-0.3, 0.3);
      const speed = rng.range(3.5, 8.5);
      const w = (speed / r) * (i % 2 ? 1 : -1);
      let ang = rng.range(0, Math.PI * 2);
      a.p.baseState = CharacterState.Run;
      a.p.speed = speed;
      a.tick = (dt) => {
        ang += w * dt;
        a.p.x = Math.cos(ang) * r;
        a.p.z = Math.sin(ang) * r;
        // Tangent of the circle in the direction of travel.
        a.p.anim.facing = Math.atan2(-Math.sin(ang) * Math.sign(w), Math.cos(ang) * Math.sign(w));
        if (!a.p.busy && rng.next() < dt * 0.08) a.p.jump(8);
      };
    }
  }

  function clearActors(): void {
    for (const a of actors) {
      a.plate?.dispose();
      a.p.visual.dispose();
    }
    actors.length = 0;
  }

  let mode: Mode = 'showroom';
  buildLineup();

  function setMode(m: Mode): void {
    if (m === mode) return;
    mode = m;
    clearActors();
    hero.visual.object.visible = m === 'showroom';
    if (heroPlate) heroPlate.visible = m === 'showroom';
    if (m === 'crowd') {
      buildCrowd();
      camera.position.set(0, 13, 22);
      controls.target.set(0, 0.5, 0);
    } else if (m === 'wardrobe') {
      buildWardrobe();
      camera.position.set(0, 7, 17);
      controls.target.set(0, 1, 0);
    } else {
      buildLineup();
      camera.position.set(0.6, 2.1, 6.6);
      controls.target.set(0, 1.0, 0);
    }
    updateModeButtons();
  }

  // ---------------------------------------------------------------------------
  // GUI
  // ---------------------------------------------------------------------------

  const ui = {
    state: 'Idle' as string,
    speed: 5,
    turntable: true,
    lookAtCamera: true,
    lod: 0,
    ghost: false,
    physicsRagdolls: true,
    forceRagdoll: false,
    autoLod: true,
    nameplates: true,
    streamer: false,
    backend: preference as string,
    primary: loadout.colors[0],
    secondary: loadout.colors[1],
    tertiary: loadout.colors[2],
    colorPreset: 'color.bubblegum',
    pattern: loadout.pattern,
    face: loadout.face,
    headwear: loadout.headwear ?? 'none',
    back: loadout.back ?? 'none',
    upper: loadout.upper ?? 'none',
    lower: loadout.lower ?? 'none',
    celebration: loadout.celebration,
    victoryPose: loadout.victoryPose,
    nameplate: loadout.nameplate,
    impulse: () => (hero.anim.impulse = 1),
    randomize: () => applyLoadout(randomLoadout(new Rng((Math.random() * 1e9) | 0))),
    copyJson: () => void navigator.clipboard?.writeText(JSON.stringify(loadout, null, 2)),
  };
  ragdolls.install();

  const gui = new GUI({ title: 'Tumbler Lab' });
  const fHero = gui.addFolder('Hero');
  fHero
    .add(ui, 'state', STATE_NAMES)
    .name('State')
    .onChange((v: string) => {
      hero.stop();
      hero.baseState = CharacterState[v as keyof typeof CharacterState];
    });
  fHero.add(ui, 'speed', 0, 10, 0.1).name('Run speed (m/s)');
  fHero.add(ui, 'turntable').name('Turntable');
  fHero.add(ui, 'lookAtCamera').name('Eyes follow camera');
  fHero.add(ui, 'lod', { 'LOD 0 (full)': 0, 'LOD 1': 1, 'LOD 2 (baked)': 2 }).name('LOD').onChange((v: number) => hero.visual.setLod(v as 0 | 1 | 2));
  fHero.add(ui, 'ghost').name('Ghost (respawn grace)');
  fHero.add(ui, 'impulse').name('Squash impulse!');

  const fRag = gui.addFolder('Ragdoll');
  fRag
    .add(ui, 'physicsRagdolls')
    .name('Physics ragdolls')
    .onChange((v: boolean) => (v ? ragdolls.install() : ragdolls.uninstall()));
  fRag.add(ui, 'forceRagdoll').name('Ragdoll hero now').onChange((v: boolean) => hero.visual.setRagdoll(v));

  const fLook = gui.addFolder('Loadout');
  const opts = (slot: CosmeticSlot, none = false): Record<string, string> => {
    const o: Record<string, string> = none ? { '— none —': 'none' } : {};
    for (const c of cosmeticsInSlot(slot)) o[`${c.name} (${c.rarity})`] = c.id;
    return o;
  };
  const colorCtrls = [
    fLook.addColor(ui, 'primary').name('Primary'),
    fLook.addColor(ui, 'secondary').name('Secondary'),
    fLook.addColor(ui, 'tertiary').name('Tertiary'),
  ];
  fLook.add(ui, 'colorPreset', opts('color')).name('Colour preset').onChange((id: string) => {
    const c = getCosmeticInSlot(id, 'color');
    if (!c) return;
    [ui.primary, ui.secondary, ui.tertiary] = c.colors;
    colorCtrls.forEach((cc) => cc.updateDisplay());
    syncLoadout();
  });
  for (const c of colorCtrls) c.onChange(() => syncLoadout());
  fLook.add(ui, 'pattern', opts('pattern')).name('Pattern').onChange(() => syncLoadout());
  fLook.add(ui, 'face', opts('face')).name('Face').onChange(() => syncLoadout());
  fLook.add(ui, 'headwear', opts('headwear', true)).name('Headwear').onChange(() => syncLoadout());
  fLook.add(ui, 'back', opts('back', true)).name('Back').onChange(() => syncLoadout());
  fLook.add(ui, 'upper', opts('upper', true)).name('Upper').onChange(() => syncLoadout());
  fLook.add(ui, 'lower', opts('lower', true)).name('Lower').onChange(() => syncLoadout());
  fLook.add(ui, 'celebration', opts('celebration')).name('Celebration').onChange(() => syncLoadout());
  fLook.add(ui, 'victoryPose', opts('victory')).name('Victory pose').onChange(() => syncLoadout());
  fLook.add(ui, 'nameplate', opts('nameplate')).name('Nameplate').onChange(() => {
    syncLoadout();
    heroPlate?.setStyle(ui.nameplate);
  });
  fLook.add(ui, 'randomize').name('🎲 Randomize');
  fLook.add(ui, 'copyJson').name('Copy loadout JSON');

  const fCrowd = gui.addFolder('Crowd / perf');
  fCrowd.add(ui, 'autoLod').name('Auto LOD by distance');
  fCrowd.add(ui, 'nameplates').name('Nameplates');
  fCrowd.add(ui, 'streamer').name('Streamer mode').onChange((v: boolean) => plates.setStreamerMode(v));
  fCrowd
    .add(ui, 'backend', ['auto', 'webgpu', 'webgl'])
    .name(`GPU backend (${backend})`)
    .onChange((v: string) => {
      params.set('backend', v);
      location.search = params.toString();
    });
  if (innerWidth < 700) gui.close();

  function syncLoadout(): void {
    loadout.colors = [ui.primary, ui.secondary, ui.tertiary];
    loadout.pattern = ui.pattern;
    loadout.face = ui.face;
    loadout.headwear = ui.headwear === 'none' ? null : ui.headwear;
    loadout.back = ui.back === 'none' ? null : ui.back;
    loadout.upper = ui.upper === 'none' ? null : ui.upper;
    loadout.lower = ui.lower === 'none' ? null : ui.lower;
    loadout.celebration = ui.celebration;
    loadout.victoryPose = ui.victoryPose;
    loadout.nameplate = ui.nameplate;
    hero.visual.setLoadout(loadout);
  }

  function applyLoadout(l: TumblerLoadout): void {
    Object.assign(loadout, l);
    [ui.primary, ui.secondary, ui.tertiary] = l.colors;
    ui.pattern = l.pattern;
    ui.face = l.face;
    ui.headwear = l.headwear ?? 'none';
    ui.back = l.back ?? 'none';
    ui.upper = l.upper ?? 'none';
    ui.lower = l.lower ?? 'none';
    ui.celebration = l.celebration;
    ui.victoryPose = l.victoryPose;
    ui.nameplate = l.nameplate;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    hero.visual.setLoadout(loadout);
    heroPlate?.setStyle(l.nameplate);
  }

  // Action chips.
  const actions = document.getElementById('actions')!;
  const chip = (label: string, cls: string, fn: () => void): void => {
    const b = document.createElement('button');
    b.className = `chip ${cls}`;
    b.textContent = label;
    b.onclick = fn;
    actions.appendChild(b);
  };
  chip('Jump', '', () => hero.jump());
  chip('Dive', '', () => hero.dive());
  chip('Stun', '', () => hero.stun());
  chip('Bounce', '', () => hero.bounce());
  chip('Squash', '', () => (hero.anim.impulse = 1));
  chip('Fall', '', () => {
    hero.stop();
    hero.baseState = CharacterState.Fall;
    ui.state = 'Fall';
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  });
  for (const e of cosmeticsInSlot('emote')) chip(e.name, 'emote', () => hero.emote(e.clip));
  for (const e of [...cosmeticsInSlot('celebration'), ...cosmeticsInSlot('victory')]) {
    chip(e.name, 'victory', () => hero.emote(e.clip, 6));
  }

  const modesEl = document.getElementById('modes')!;
  const modeButtons: Record<Mode, HTMLButtonElement> = {
    showroom: document.createElement('button'),
    wardrobe: document.createElement('button'),
    crowd: document.createElement('button'),
  };
  modeButtons.showroom.textContent = 'Showroom + lineup';
  modeButtons.wardrobe.textContent = 'Wardrobe';
  modeButtons.crowd.textContent = '40 crowd stress test';
  for (const [m, b] of Object.entries(modeButtons) as [Mode, HTMLButtonElement][]) {
    b.onclick = () => setMode(m);
    modesEl.appendChild(b);
  }
  function updateModeButtons(): void {
    for (const [m, b] of Object.entries(modeButtons)) b.classList.toggle('on', m === mode);
    actions.style.display = mode === 'showroom' ? 'grid' : 'none';
  }
  updateModeButtons();

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  const resize = (): void => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  resize();
  addEventListener('resize', resize);

  const debug: TumbleLabDebug = {
    ready: false,
    mode: () => mode,
    setMode,
    hero: () => hero,
    frames: 0,
    errors,
    view: (px, py, pz, tx, ty, tz) => {
      camera.position.set(px, py, pz);
      controls.target.set(tx, ty, tz);
    },
    hideUi: () => {
      gui.hide();
      stats.setVisible(false);
      for (const id of ['actions', 'modes', 'title']) document.getElementById(id)?.style.setProperty('display', 'none');
    },
    dress: (l) => applyLoadout({ ...loadout, ...l }),
    ui,
  };
  window.__tumbleLab = debug;

  const camLook = { x: 0, y: 0, z: 0 };
  const camPos = new Vector3();
  let last = performance.now();
  let turn = 0;
  const lodCount = [0, 0, 0];
  let cpuMs = 0;
  const autoLod = (d: number): 0 | 1 | 2 => (d < 14 ? 0 : d < 28 ? 1 : 2);

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    controls.update();
    camera.getWorldPosition(camPos);
    camLook.x = camPos.x;
    camLook.y = camPos.y;
    camLook.z = camPos.z;
    lodCount.fill(0);

    const cpu0 = performance.now();
    if (mode === 'showroom') {
      if (ui.turntable && !hero.busy && hero.baseState !== CharacterState.Run) turn += dt * 0.35;
      hero.anim.facing = ui.turntable ? Math.sin(turn) * 0.9 : 0;
      hero.anim.lookAt = ui.lookAtCamera ? camLook : undefined;
      hero.anim.ghost = ui.ghost;
      hero.speed = ui.speed;
      hero.update(dt);
      lodCount[ui.lod]!++;
    }
    for (const a of actors) {
      a.tick?.(dt);
      if (mode !== 'crowd') a.p.anim.lookAt = camLook;
      const lod = ui.autoLod ? autoLod(camPos.distanceTo(a.p.visual.object.position)) : 0;
      a.p.visual.setLod(lod);
      lodCount[lod]!++;
      a.p.update(dt);
    }
    cpuMs += (performance.now() - cpu0 - cpuMs) * 0.05;

    plates.mesh.visible = ui.nameplates;
    plates.update(camera);
    ragdolls.update(dt, camPos);
    renderer.render(scene, camera);

    stats.set('mode', mode);
    stats.set('tumb', actors.length + (mode === 'showroom' ? 1 : 0));
    stats.set('anim', `${cpuMs.toFixed(2)} ms cpu`);
    stats.set('lod', lodCount.join(' / '));
    stats.set('rag', `${ragdolls.activeCount}/${ragdolls.maxActive}`);
    stats.set('geo', `${assemblyCacheSize()} cached`);
    stats.update(dt, renderer);
    debug.frames++;
  });

  const bootEl = document.getElementById('boot');
  if (bootEl) {
    bootEl.style.opacity = '0';
    setTimeout(() => bootEl.remove(), 450);
  }
  debug.ready = true;
}

boot().catch((err: unknown) => {
  console.error(err);
  errors.push(err instanceof Error ? err.message : String(err));
  const el = document.getElementById('boot');
  if (el) el.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
