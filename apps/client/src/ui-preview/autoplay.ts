/**
 * "Auto-play show": drives the UI store exactly like the real game would,
 * end-to-end with realistic timings (docs/design/SCREENS.md §15):
 * splash → welcome → menu → matchmaking → pre-show → rounds (intro, rules,
 * countdown, live HUD, stamps, results, between rounds) → final → victory /
 * winner cam → player wall → rewards.
 */
import {
  ui,
  uiEvents,
  type HudState,
  type RoundType,
  type ShowPlayer,
  type ShowSummary,
  type UIIntentName,
} from '@tumble/ui';
import {
  LOCAL_NAME,
  SHOW_COUNTS,
  SHOW_NAME,
  SHOW_ROUNDS,
  aliveAt,
  makeBetween,
  makeResults,
  makeRewards,
  roundIntro,
} from './mocks.ts';
import { resetTransient, world } from './world.ts';

/** Thrown when a run is cancelled. */
class Aborted extends Error {}

let current: AbortController | null = null;

/** Options for `runShow`. */
export interface AutoplayOptions {
  /** Local player wins the Crown (else eliminated in round 2 and spectates). */
  win: boolean;
  /** Start at the splash instead of the menu. */
  fromSplash: boolean;
  /** Time multiplier (<1 = faster). */
  speed: number;
}

function sleep(ms: number, signal: AbortSignal, speed: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Aborted());
    const id = window.setTimeout(resolve, ms * speed);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(id);
        reject(new Aborted());
      },
      { once: true },
    );
  });
}

/** Resolves when the UI emits `name` (or after `timeoutMs`). */
function waitIntent(
  name: UIIntentName,
  timeoutMs: number,
  signal: AbortSignal,
  speed: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Aborted());
    const off = uiEvents.on(name, () => done());
    const id = window.setTimeout(() => done(), timeoutMs * speed);
    const onAbort = (): void => {
      off();
      window.clearTimeout(id);
      reject(new Aborted());
    };
    function done(): void {
      off();
      window.clearTimeout(id);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Stops any running auto-play. */
export function stopAutoplay(): void {
  current?.abort();
  current = null;
}

/** True while auto-play runs. */
export function autoplayRunning(): boolean {
  return current !== null;
}

/** Initial HUD state for a round. */
export function hudForRound(
  type: RoundType,
  players: number,
  target: number,
  duration: number,
  local: ShowPlayer | undefined,
  objective: string,
): Partial<HudState> {
  return {
    roundType: type,
    timeLeft: duration,
    timeTotal: duration,
    overtime: false,
    qualified: 0,
    qualifyTarget: target,
    eliminated: 0,
    alive: players,
    objective,
    localStatus: 'playing',
    progress: 0,
    leaders: [],
    teams: [],
    ping: 42,
    fps: 60,
    localColor: local?.colors.primary ?? '#ff4f9a',
    controlsHint: true,
    device: ui.getState().isTouch ? 'touch' : 'keyboard',
  };
}

async function playRound(
  index: number,
  summary: ShowSummary,
  signal: AbortSignal,
  k: number,
  spectating: { on: boolean },
): Promise<void> {
  const s = ui.getState();
  const intro = roundIntro(index);
  const alive = aliveAt(summary, index);
  const local = alive.find((p) => p.isLocal);
  const outIds = new Set(summary.rounds[index]?.eliminatedIds);
  const localOut = local ? outIds.has(local.id) : false;
  const isFinal = intro.isFinal;
  const target = isFinal ? 1 : (SHOW_COUNTS[index + 1] ?? 1);

  s.setRoundIntro({ ...intro, playerCount: alive.length });
  s.setScreen('roundLoading', { transition: 'wipe' });
  await sleep(1400, signal, k);
  s.setScreen('roundIntro', { transition: 'wipe' });
  await sleep(4200, signal, k);
  s.setScreen('rules', { transition: 'fade' });
  await sleep(2600, signal, k);

  const duration = intro.type === 'survival' ? 90 : 120;
  s.resetHud(hudForRound(intro.type, alive.length, target, duration, local, intro.objective));
  if (spectating.on) {
    s.setHud({ localStatus: 'spectating', controlsHint: false });
  }
  s.setScreen('round', { transition: 'fade' });
  for (const n of [3, 2, 1]) {
    s.setCountdown(n);
    await sleep(1000, signal, k);
  }
  s.setCountdown(null);
  s.showStamp('go');

  // Simulated play: 14 s compressed round at 10 Hz.
  const ticks = 140;
  const qualifiers = alive.filter((p) => !outIds.has(p.id));
  const finishOrder = qualifiers;
  const localFinishTick = local && !localOut ? Math.round(ticks * (isFinal ? 0.85 : 0.55)) : -1;
  const localOutTick = localOut ? Math.round(ticks * 0.7) : -1;
  let qualified = 0;
  let spectateIndex = 0;
  for (let t = 0; t < ticks; t++) {
    await sleep(100, signal, k);
    const frac = t / ticks;
    const patch: Partial<HudState> = {
      timeLeft: Math.max(0, duration * (1 - frac) - 0.01),
      ping: 38 + Math.round(Math.sin(t / 9) * 6 + Math.random() * 6),
      fps: 58 + Math.round(Math.random() * 3),
    };
    if (t === 25) patch.controlsHint = false;
    if (intro.type === 'race' || intro.type === 'final') {
      const want = isFinal
        ? t >= localFinishTick && localFinishTick > 0
          ? 1
          : 0
        : Math.min(target, Math.floor(Math.pow(Math.max(0, frac - 0.2) / 0.75, 1.3) * target));
      if (want > qualified) {
        const p = finishOrder[qualified];
        if (p && !p.isLocal && !isFinal)
          s.pushToast({
            title: `${p.name} qualified!`,
            icon: '🏁',
            variant: 'feed',
            color: p.colors.primary,
          });
        qualified = want;
      }
      patch.qualified = qualified;
      patch.progress = Math.min(1, frac * 1.6);
      patch.leaders = finishOrder.slice(0, 3).map((p, i) => ({
        id: p.id,
        name: p.name,
        color: p.colors.primary,
        progress: Math.min(1, frac * (1.9 - i * 0.12)),
      }));
    } else {
      const left = Math.round(alive.length - (alive.length - target) * Math.pow(frac, 1.2));
      if (left < (ui.getState().hud.alive || alive.length) && Math.random() < 0.5) {
        const p = alive[Math.floor(Math.random() * alive.length)];
        if (p && !p.isLocal)
          s.pushToast({
            title: `${p.name} got swept!`,
            icon: '🌀',
            variant: 'feed',
            color: p.colors.primary,
          });
      }
      patch.alive = left;
    }
    s.setHud(patch);

    if (t === localFinishTick && !spectating.on) {
      s.setHud({ localStatus: 'qualified' });
      if (!isFinal) {
        s.showStamp('qualified');
        await sleep(2600, signal, k);
        const watch = alive.filter((p) => !p.isLocal);
        s.setSpectate({
          player: watch[0] as ShowPlayer,
          detail: 'Racing',
          qualified: false,
          index: 0,
          count: watch.length,
        });
      }
    }
    if (t === localOutTick && !spectating.on) {
      s.setHud({ localStatus: 'eliminated' });
      s.showStamp('eliminated');
      await sleep(2000, signal, k);
      s.setEliminatedSheet(true);
      // Pretend the player chose Spectate after a moment.
      await waitIntent('spectate', 2600, signal, k);
      s.setEliminatedSheet(false);
      spectating.on = true;
      s.setHud({ localStatus: 'spectating' });
    }
    if (spectating.on && t % 30 === 0) {
      const watch = alive.filter((p) => !p.isLocal);
      spectateIndex = (spectateIndex + 1) % Math.max(1, watch.length);
      const p = watch[spectateIndex];
      if (p)
        s.setSpectate({
          player: p,
          detail: outIds.has(p.id)
            ? 'Falling behind'
            : `${['1st', '2nd', '3rd', '4th', '5th'][spectateIndex % 5]}`,
          qualified: !outIds.has(p.id) && frac > 0.5,
          index: spectateIndex,
          count: watch.length,
        });
    }
  }

  s.setSpectate(null);
  s.showStamp(intro.type === 'survival' ? 'timeUp' : 'roundOver');
  await sleep(2000, signal, k);
  s.setResults(makeResults(summary, index));
  s.setScreen('roundResults', { transition: 'wipe' });
  await sleep(5200, signal, k);
}

/**
 * Runs the full show flow.
 * @returns Promise that settles when the run ends or is cancelled.
 */
export async function runShow(opts: Partial<AutoplayOptions> = {}): Promise<void> {
  stopAutoplay();
  const ctrl = new AbortController();
  current = ctrl;
  const { signal } = ctrl;
  const k = opts.speed ?? 1;
  const win = opts.win ?? true;
  const summary = win ? world.winSummary : world.loseSummary;
  const s = ui.getState();
  resetTransient();

  try {
    if (opts.fromSplash) {
      s.setScreen('splash', { transition: 'wipe' });
      await waitIntent('start', 2400, signal, k);
      s.setScreen('welcome', { transition: 'wipe' });
      await waitIntent('welcomeDone', 3500, signal, k);
      s.setScreen('menu', { transition: 'wipe' });
      await sleep(2200, signal, k);
    } else if (s.screen !== 'menu') {
      s.setScreen('menu', { transition: 'wipe' });
      await sleep(1600, signal, k);
    }

    s.setMenuTab('play');
    s.setQueue({
      status: 'searching',
      startedAt: Date.now(),
      playersFound: 3,
      playersNeeded: 40,
      etaSec: 20,
      region: 'EU West',
    });
    s.setScreen('matchmaking');
    for (let found = 3; found < 40; found += 3 + Math.floor(Math.random() * 4)) {
      s.setQueue({ playersFound: found, etaSec: Math.max(0, Math.round((40 - found) / 2)) });
      await sleep(380, signal, k);
    }
    s.setQueue({ status: 'found', playersFound: 40 });
    s.setScreen('matchFound');
    await sleep(1500, signal, k);

    const joinNames = summary.players.map((p) => (p.isLocal ? LOCAL_NAME : p.name));
    s.setPreShow({
      showName: SHOW_NAME,
      roundCount: SHOW_ROUNDS.length,
      playersJoined: 12,
      maxPlayers: 40,
      startsAt: Date.now() + 7000 * k,
      joinFeed: joinNames.slice(0, 12),
    });
    s.setScreen('preShow', { transition: 'wipe' });
    for (let n = 12; n <= 40; n += 2) {
      await sleep(220, signal, k);
      const info = ui.getState().preShow;
      if (info) s.setPreShow({ ...info, playersJoined: n, joinFeed: joinNames.slice(0, n) });
    }
    await sleep(Math.max(0, 7000 - 15 * 220), signal, k);

    s.setShowIntro({ showName: SHOW_NAME, roundIndex: 0, roundCount: SHOW_ROUNDS.length });
    s.setScreen('showIntro', { transition: 'wipe' });
    await sleep(2600, signal, k);

    const spectating = { on: false };
    for (let i = 0; i < SHOW_ROUNDS.length; i++) {
      const intro = roundIntro(i);
      if (intro.isFinal) {
        s.setFinalHype({ roundName: intro.name, finalists: aliveAt(summary, i) });
        s.setScreen('finalHype', { transition: 'wipe' });
        await sleep(3600, signal, k);
      }
      await playRound(i, summary, signal, k, spectating);
      if (!intro.isFinal) {
        s.setBetweenRounds(makeBetween(i));
        s.setScreen('betweenRounds', { transition: 'fade' });
        await sleep(3800, signal, k);
      }
    }

    const winner = summary.players.find((p) => p.id === summary.winnerId) as ShowPlayer;
    s.setVictory({
      winner,
      isLocalWinner: Boolean(winner.isLocal),
      crownsBefore: 4,
      crownsAfter: winner.isLocal ? 5 : 4,
      showName: SHOW_NAME,
    });
    s.setScreen(winner.isLocal ? 'victory' : 'winnerCam', { transition: 'fade' });
    await waitIntent('continue', 7000, signal, k);

    s.setPlayerWall(summary, { render3D: false, autoContinueMs: 5000 });
    s.setRewards(makeRewards(world.items, win, win ? SHOW_ROUNDS.length : 1));
    s.setScreen('playerWall', { transition: 'wipe' });
    await waitIntent('continue', 60000, signal, k);
    if (ui.getState().screen === 'playerWall') s.setScreen('rewards', { transition: 'wipe' });
  } catch (err) {
    if (!(err instanceof Aborted)) throw err;
  } finally {
    if (current === ctrl) current = null;
  }
}
