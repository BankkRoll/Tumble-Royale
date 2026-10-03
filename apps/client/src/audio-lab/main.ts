/**
 * Audio Lab (`/audio.html`): a sound board for every procedural SFX, the
 * adaptive music player (tracks, intensity, final-30, stingers, crossfades),
 * the announcer with live captions, a draggable 2D spatial demo with looping
 * emitters, bus faders, cue tester, sim-event / round-phase simulators and a
 * 40-player voice-stealing stress test.
 */

import {
  ANNOUNCER_LINE_IDS,
  AudioEngine,
  MUSIC_CUE_NAMES,
  OBSTACLE_LOOPS,
  SFX_DEFS,
  SFX_NAMES,
  STEM_IDS,
  STINGER_IDS,
  TRACKS,
  TRACK_IDS,
  UI_CUE_NAMES,
  createGameAudio,
  createStemLevels,
  stemLevels,
} from '@tumble/audio';
import type { AudioSimEvent, BusName, LoopEmitter, MusicTrackId } from '@tumble/audio';
import { RoundPhase, ShowPhase } from '@tumble/shared';
import type { RoundPhaseId, RoundType, ThemeId, Vec3 } from '@tumble/shared';

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

const engine = new AudioEngine();
const audio = createGameAudio(engine);
const LOCAL = 0;
audio.setLocalPlayer(LOCAL);
void engine.sfx.prewarm();

const app = document.getElementById('app') as HTMLElement;
const unlockEl = document.getElementById('unlock') as HTMLElement;

document.getElementById('unlock-btn')?.addEventListener('click', () => {
  void engine.unlock().then((ok) => {
    if (!ok) return;
    unlockEl.classList.add('hidden');
    audio.playCue('music.sting');
    audio.playCue('music.menu');
  });
});

// -----------------------------------------------------------------------------
// DOM helpers
// -----------------------------------------------------------------------------

type Attrs = Record<string, string>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function button(label: string, onClick: (b: HTMLButtonElement) => void, cls = '', title = ''): HTMLButtonElement {
  const b = el('button', { type: 'button', class: cls, title }, label);
  b.addEventListener('click', () => {
    onClick(b);
    b.classList.add('flash');
    setTimeout(() => b.classList.remove('flash'), 120);
  });
  return b;
}

function slider(label: string, value: number, onInput: (v: number) => void, min = 0, max = 1, step = 0.01): HTMLLabelElement {
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = el('span', {}, value.toFixed(2));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = v.toFixed(2);
    onInput(v);
  });
  return el('label', { class: 'slider' }, el('span', {}, label), input, out);
}

function panel(title: string, wide = false): HTMLElement {
  const s = el('section', { class: wide ? 'panel wide' : 'panel' }, el('h2', {}, title));
  app.append(s);
  return s;
}

function stat(label: string): { root: HTMLElement; value: HTMLElement } {
  const value = el('b', {}, '—');
  return { root: el('div', { class: 'stat' }, value, el('small', {}, label)), value };
}

// -----------------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------------

const stState = stat('context');
const stVoices = stat('sfx voices');
const stEmitters = stat('live emitters');
const stBank = stat('rendered');
const stTrack = stat('track');
const voiceMeter = el('div', { class: 'meter' }, el('i'));
const beatDots = el('span', { class: 'beat' }, el('i'), el('i'), el('i'), el('i'));
app.append(
  el(
    'header',
    { class: 'top' },
    el('h1', {}, 'Tumble Royale ', el('span', {}, 'Audio Lab')),
    stState.root,
    el('div', { class: 'stat' }, stVoices.value, voiceMeter, el('small', {}, 'sfx voices (32 max)')),
    stEmitters.root,
    stBank.root,
    stTrack.root,
    el('div', { class: 'stat' }, beatDots, el('small', {}, 'beat')),
  ),
);

// -----------------------------------------------------------------------------
// Mixer
// -----------------------------------------------------------------------------

{
  const p = panel('Mixer');
  const s = engine.getSettings();
  for (const bus of ['master', 'music', 'sfx', 'voice', 'ui'] as BusName[]) {
    p.append(slider(bus, s[bus], (v) => engine.setVolume(bus, v)));
  }
  const row = el('div', { class: 'row' });
  row.append(
    button('Mute', (b) => {
      const m = !engine.getSettings().muted;
      engine.setMuted(m);
      b.classList.toggle('on', m);
    }),
    button('Mono', (b) => {
      const m = !engine.getSettings().monoAudio;
      engine.setMonoAudio(m);
      b.classList.toggle('on', m);
    }),
    button(
      'Mute when hidden',
      (b) => {
        const m = !engine.getSettings().muteWhenHidden;
        engine.applySettings({ muteWhenHidden: m });
        b.classList.toggle('on', m);
      },
      s.muteWhenHidden ? 'on' : '',
    ),
    button('Stop all SFX', () => engine.stopAllVoices()),
  );
  p.append(row, el('p', { class: 'hint' }, `Panning: ${engine.mobile ? 'equal-power (mobile)' : 'HRTF (desktop)'} · limiter on master · music ducks under the announcer.`));
}

// -----------------------------------------------------------------------------
// Music
// -----------------------------------------------------------------------------

const stemBars = new Map<string, HTMLElement>();
let crossfadeTimer: ReturnType<typeof setInterval> | null = null;
{
  const p = panel('Adaptive music');
  const trackGrid = el('div', { class: 'grid' });
  for (const id of TRACK_IDS) {
    const t = TRACKS[id];
    trackGrid.append(button(id, () => audio.music.play(id), '', `${t.title} — ${t.bpm} BPM, ${t.key} ${t.scale}${t.beatsPerBar === 3 ? ', 6/8' : ''}`));
  }
  p.append(el('h3', {}, 'Tracks (crossfade on the next bar)'), trackGrid);

  p.append(el('h3', {}, 'Layers'));
  p.append(slider('intensity', audio.music.currentIntensity, (v) => audio.music.setIntensity(v)));
  const row = el('div', { class: 'row' });
  row.append(
    button('Final 30s', (b) => {
      const on = !audio.music.isFinal30;
      audio.music.setFinal30(on);
      b.classList.toggle('on', on);
    }),
    button('Stop music', () => audio.music.stop()),
    button('Crossfade tour', (b) => {
      if (crossfadeTimer) {
        clearInterval(crossfadeTimer);
        crossfadeTimer = null;
        b.classList.remove('on');
        return;
      }
      b.classList.add('on');
      let i = 0;
      const themes = TRACK_IDS.slice(0, 10);
      const next = (): void => {
        audio.music.play(themes[i % themes.length] as MusicTrackId);
        i++;
      };
      next();
      crossfadeTimer = setInterval(next, 8000);
    }),
  );
  p.append(row);
  const stems = el('div', { class: 'stems' });
  for (const s of STEM_IDS) {
    const bar = el('i');
    stemBars.set(s, bar);
    stems.append(el('div', {}, bar, el('span', {}, s)));
  }
  p.append(stems);

  const st = el('div', { class: 'grid' });
  for (const id of STINGER_IDS) st.append(button(id, () => audio.music.stinger(id)));
  p.append(el('h3', {}, 'Stingers (land on the next beat, in key)'), st);
}

// -----------------------------------------------------------------------------
// Announcer
// -----------------------------------------------------------------------------

const captionBox = el('div', { class: 'captions idle' }, 'Captions appear here');
let captionTimer: ReturnType<typeof setTimeout> | null = null;
audio.announcer.onCaption((text, ms) => {
  captionBox.textContent = text;
  captionBox.classList.remove('idle');
  if (captionTimer) clearTimeout(captionTimer);
  captionTimer = setTimeout(() => {
    captionBox.classList.add('idle');
  }, ms);
});
{
  const p = panel('Announcer');
  const grid = el('div', { class: 'grid' });
  const vars = { n: 2, name: 'Gumdrop Gauntlet', team: 'Pink', count: 26 };
  for (const id of ANNOUNCER_LINE_IDS) grid.append(button(id, () => audio.announcer.say(id, vars)));
  const input = el('input', { type: 'text', value: 'Welcome to the show, Tumblers!', size: '30' });
  const row = el('div', { class: 'row' });
  row.append(
    input,
    button('Say', () => audio.announcer.sayText(input.value, { interrupt: true }), 'primary'),
    button(
      'Speech',
      (b) => {
        const on = !audio.announcer.usesSpeech;
        audio.announcer.setSpeechEnabled(on);
        b.classList.toggle('on', audio.announcer.usesSpeech);
      },
      audio.announcer.usesSpeech ? 'on' : '',
      'Toggle Web Speech vs. the synthesized babble fallback',
    ),
    button('Stop', () => audio.announcer.cancel()),
  );
  p.append(grid, row, captionBox);
  p.append(el('p', { class: 'hint' }, `Voice: ${audio.announcer.voiceName ?? 'babble fallback (no Web Speech voice)'}`));
}

// -----------------------------------------------------------------------------
// Spatial demo
// -----------------------------------------------------------------------------

const RANGE = 40;
const source: Vec3 = { x: 8, y: 0, z: -6 };
let listenerYaw = 0;
let emitter: LoopEmitter | null = null;
const canvas = el('canvas', { class: 'spatial', width: '600', height: '600' });
{
  const p = panel('Spatial (top-down)');
  const emitterSelect = el('select');
  for (const [type, sound] of Object.entries(OBSTACLE_LOOPS)) emitterSelect.append(el('option', { value: sound }, `${type} → ${sound}`));
  const row = el('div', { class: 'row' });
  row.append(
    emitterSelect,
    button('Start loop', () => {
      emitter?.dispose();
      emitter = engine.createEmitter(emitterSelect.value, { pos: source });
      emitter.start();
    }),
    button('Stop loop', () => {
      emitter?.dispose();
      emitter = null;
    }),
  );
  const oneShot = el('select');
  for (const n of SFX_NAMES) if ((SFX_DEFS[n]?.bus ?? 'sfx') === 'sfx' && !SFX_DEFS[n]?.loop) oneShot.append(el('option', { value: n }, n));
  oneShot.value = 'cannon.thump';
  const row2 = el('div', { class: 'row' });
  row2.append(oneShot, button('Play at source', () => engine.play(oneShot.value, { pos: source })));
  p.append(canvas, row, row2, slider('listener yaw', 0, (v) => (listenerYaw = v), -Math.PI, Math.PI, 0.01));
  p.append(el('p', { class: 'hint' }, 'Drag the pink source. Listener (cyan) faces up. Emitters beyond 45 m go virtual and free their nodes.'));

  let dragging = false;
  const toWorld = (ev: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    source.x = ((ev.clientX - r.left) / r.width - 0.5) * 2 * RANGE;
    source.z = ((ev.clientY - r.top) / r.height - 0.5) * 2 * RANGE;
    emitter?.setPosition(source.x, source.y, source.z);
  };
  canvas.addEventListener('pointerdown', (ev) => {
    dragging = true;
    canvas.setPointerCapture(ev.pointerId);
    toWorld(ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (dragging) toWorld(ev);
  });
  canvas.addEventListener('pointerup', () => {
    dragging = false;
  });
}

function drawSpatial(): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const w = canvas.width;
  const h = canvas.height;
  const sx = (x: number): number => (x / RANGE / 2 + 0.5) * w;
  const sz = (z: number): number => (z / RANGE / 2 + 0.5) * h;
  g.clearRect(0, 0, w, h);
  g.strokeStyle = 'rgba(110,231,168,0.25)';
  g.setLineDash([6, 6]);
  g.beginPath();
  g.arc(w / 2, h / 2, (45 / RANGE / 2) * w, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  g.save();
  g.translate(w / 2, h / 2);
  g.rotate(listenerYaw);
  g.fillStyle = '#3fa9ff';
  g.beginPath();
  g.moveTo(0, -18);
  g.lineTo(11, 10);
  g.lineTo(-11, 10);
  g.closePath();
  g.fill();
  g.restore();
  const d = Math.hypot(source.x, source.z);
  g.fillStyle = emitter?.isRealised ? '#ff4f8b' : emitter ? '#7a5a8a' : '#ff8ab4';
  g.beginPath();
  g.arc(sx(source.x), sz(source.z), 12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff7fd';
  g.font = '14px Trebuchet MS';
  g.fillText(`${d.toFixed(1)} m${emitter ? (emitter.isRealised ? ' · live' : ' · virtual') : ''}`, sx(source.x) + 16, sz(source.z) + 5);
}

// -----------------------------------------------------------------------------
// SFX board
// -----------------------------------------------------------------------------

{
  const p = panel('Sound bank', true);
  let variance = true;
  const row = el('div', { class: 'row' });
  row.append(
    button(
      'Random variance',
      (b) => {
        variance = !variance;
        b.classList.toggle('on', variance);
      },
      'on',
    ),
    el('span', { class: 'hint' }, `${SFX_NAMES.length} procedural sounds · dashed = loop (click again to stop)`),
  );
  p.append(row);
  const groups = new Map<string, string[]>();
  for (const n of SFX_NAMES) {
    const g = n.startsWith('ui.rarity') ? 'rarity reveals' : n.startsWith('ui.') ? 'ui' : n.startsWith('crowd') ? 'crowd' : (SFX_DEFS[n]?.loop ? 'loops' : groupOf(n));
    const list = groups.get(g) ?? [];
    list.push(n);
    groups.set(g, list);
  }
  const loops = new Map<string, LoopEmitter>();
  for (const [g, names] of groups) {
    const grid = el('div', { class: 'grid' });
    for (const n of names) {
      const def = SFX_DEFS[n];
      if (def?.loop) {
        grid.append(
          button(
            n,
            (b) => {
              const cur = loops.get(n);
              if (cur) {
                cur.dispose();
                loops.delete(n);
                b.classList.remove('on');
              } else {
                const e = engine.createEmitter(n, { pos: null });
                e.start();
                loops.set(n, e);
                b.classList.add('on');
              }
            },
            'loop',
            def.desc ?? '',
          ),
        );
      } else grid.append(button(n, () => engine.play(n, { noVariance: !variance }), '', def?.desc ?? ''));
    }
    p.append(el('h3', {}, g), grid);
  }
}

function groupOf(n: string): string {
  if (/^(step|jump|land|dive|grab|stun|getUp|fallout|respawn|emote|slide)/.test(n)) return 'tumbler';
  if (/^(countdown|round|finish|qualified|eliminated|confetti|crown|team|show)/.test(n)) return 'show';
  return 'obstacles & props';
}

// -----------------------------------------------------------------------------
// Cues & simulators
// -----------------------------------------------------------------------------

{
  const p = panel('UI & music cues');
  const grid = el('div', { class: 'grid' });
  for (const c of UI_CUE_NAMES) grid.append(button(c.replace(/^ui\./, ''), () => audio.playCue(c), '', c));
  const mgrid = el('div', { class: 'grid' });
  for (const c of MUSIC_CUE_NAMES) mgrid.append(button(c, () => audio.playCue(c)));
  const input = el('input', { type: 'text', value: 'sfx_land_hard', size: '24' });
  const row = el('div', { class: 'row' });
  row.append(input, button('playCue', () => audio.playCue(input.value), 'primary'));
  p.append(grid, el('h3', {}, 'music.*'), mgrid, el('h3', {}, 'Any cue name (aliases, snake_case, fallbacks)'), row);
}

const near = (): Vec3 => ({ x: (Math.random() - 0.5) * 20, y: 0, z: (Math.random() - 0.5) * 20 });

{
  const p = panel('Game simulator');
  const ev = (e: AudioSimEvent): void => audio.handleSimEvent(e, engine.listenerPos);
  const grid = el('div', { class: 'grid' });
  const remote = (): number => 1 + Math.floor(Math.random() * 39);
  const add = (label: string, fn: () => void): void => {
    grid.append(button(label, fn));
  };
  add('jump (you)', () => ev({ type: 'jump', player: LOCAL, pos: near() }));
  add('jump (other)', () => ev({ type: 'jump', player: remote(), pos: near() }));
  add('land hard', () => ev({ type: 'land', player: LOCAL, pos: near(), impact: 0.9 }));
  add('dive', () => ev({ type: 'dive', player: LOCAL, pos: near() }));
  add('stun', () => ev({ type: 'stun', player: LOCAL, pos: near(), strength: 1 }));
  add('bounce pad', () => ev({ type: 'bounce', player: remote(), pos: near(), obstacle: 'pad-1' }));
  add('bumper', () => ev({ type: 'bounce', player: remote(), pos: near(), obstacle: 'bumperPillar-2' }));
  add('fell out (you)', () => ev({ type: 'fellOut', player: LOCAL, pos: near() }));
  add('checkpoint', () => ev({ type: 'checkpoint', player: LOCAL, index: 1 }));
  add('finish (you)', () => ev({ type: 'finish', player: LOCAL, tick: 0, subTick: 0 }));
  add('qualified (you)', () => ev({ type: 'qualified', player: LOCAL, place: 3 }));
  add('eliminated (you)', () => ev({ type: 'eliminated', player: LOCAL, place: 30 }));
  add('cannon.fire', () => ev({ type: 'obstacleCue', obstacle: 'cannon-1', cue: 'cannon.fire', pos: near() }));
  add('punchWall.telegraph', () => ev({ type: 'obstacleCue', obstacle: 'pw-1', cue: 'punchWall.telegraph', pos: near() }));
  add('teleport', () => ev({ type: 'teleport', player: remote(), from: near(), to: near() }));
  add('team score', () => ev({ type: 'score', team: 0, player: remote(), delta: 1, total: 3 }));
  p.append(el('h3', {}, 'SimEvents'), grid);

  const theme = el('select');
  for (const t of TRACK_IDS.slice(0, 10)) theme.append(el('option', { value: t }, t));
  const type = el('select');
  for (const t of ['race', 'survival', 'team', 'hunt', 'logic', 'final']) type.append(el('option', { value: t }, t));
  const phases = el('div', { class: 'grid' });
  const phase = (label: string, id: RoundPhaseId): void => {
    phases.append(
      button(label, () =>
        audio.onRoundPhase(id, type.value as RoundType, { roundNumber: 2, roundName: 'Gumdrop Gauntlet', theme: theme.value as ThemeId, playersRemaining: 26 }),
      ),
    );
  };
  phase('Intro', RoundPhase.IntroFlyover);
  phase('Rules', RoundPhase.RulesCard);
  phase('Countdown', RoundPhase.Countdown);
  phase('GO / Playing', RoundPhase.Playing);
  phase('Overtime', RoundPhase.Overtime);
  phase('Round end', RoundPhase.RoundEnd);
  phase('Results', RoundPhase.Results);
  phase('Transition', RoundPhase.Transition);
  const show = el('div', { class: 'grid' });
  show.append(
    button('Pre-show', () => audio.onShowPhase(ShowPhase.PreShow)),
    button('Victory (you)', () => audio.onShowPhase(ShowPhase.Victory, { localWon: true })),
    button('Victory (other)', () => audio.onShowPhase(ShowPhase.Victory, { winnerName: 'Sprinkles' })),
    button('Show ended', () => audio.onShowPhase(ShowPhase.Ended)),
  );
  p.append(el('h3', {}, 'Round phases'), el('div', { class: 'row' }, theme, type), phases, el('h3', {}, 'Show phases'), show);

  const stress = el('div', { class: 'row' });
  stress.append(
    button('40-player storm (5 s)', () => {
      const end = performance.now() + 5000;
      const kinds = ['jump', 'land', 'dive', 'stun', 'bounce'] as const;
      const tick = (): void => {
        for (let i = 0; i < 12; i++) {
          const k = kinds[Math.floor(Math.random() * kinds.length)] as (typeof kinds)[number];
          const player = Math.floor(Math.random() * 40);
          const pos = { x: (Math.random() - 0.5) * 60, y: 0, z: (Math.random() - 0.5) * 60 };
          if (k === 'land') ev({ type: 'land', player, pos, impact: Math.random() });
          else if (k === 'stun') ev({ type: 'stun', player, pos, strength: Math.random() });
          else if (k === 'bounce') ev({ type: 'bounce', player, pos });
          else ev({ type: k, player, pos });
        }
        if (performance.now() < end) setTimeout(tick, 50);
      };
      tick();
    }),
    el('span', { class: 'hint' }, 'Watch the voice meter cap at 32 while local and critical sounds survive.'),
  );
  p.append(el('h3', {}, 'Stress'), stress);
}

// -----------------------------------------------------------------------------
// Frame loop
// -----------------------------------------------------------------------------

const levels = createStemLevels();
const fwd: Vec3 = { x: 0, y: 0, z: -1 };
const up: Vec3 = { x: 0, y: 1, z: 0 };
const origin: Vec3 = { x: 0, y: 0, z: 0 };

function frame(): void {
  fwd.x = Math.sin(listenerYaw);
  fwd.z = -Math.cos(listenerYaw);
  engine.setListener(origin, fwd, up);
  audio.update();
  stState.value.textContent = engine.ctx?.state ?? 'not created';
  stVoices.value.textContent = `${engine.activeVoices} / ${engine.maxVoices}`;
  (voiceMeter.firstChild as HTMLElement).style.width = `${(engine.activeVoices / engine.maxVoices) * 100}%`;
  stEmitters.value.textContent = String(engine.audibleEmitters);
  stBank.value.textContent = `${engine.sfx.renderedCount} / ${SFX_NAMES.length}`;
  const pos = audio.music.position();
  stTrack.value.textContent = pos.track ? `${pos.track} · bar ${pos.bar + 1} · ${pos.bpm} bpm` : '—';
  beatDots.querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', pos.track !== null && i === pos.beat));
  stemLevels(audio.music.currentIntensity, audio.music.isFinal30, levels);
  for (const s of STEM_IDS) {
    const bar = stemBars.get(s);
    if (bar) bar.style.height = `${levels[s] * 100}%`;
  }
  drawSpatial();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
