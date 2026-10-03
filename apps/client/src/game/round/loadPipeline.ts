/**
 * Chunked round loading.
 *
 * Responsibilities:
 * - runs a list of weighted load steps (scene construction, shader
 *   compilation, …) without blocking the main thread for long: generator
 *   steps are time-sliced and every step boundary yields, so the loading
 *   screen keeps painting and the network keeps flowing;
 * - reports real, monotonic progress (0..1) from step weights and the
 *   fractions steps report themselves;
 * - instruments every step with `performance.mark`/`measure` and keeps the
 *   last few builds' timings for `window.__tumble.loadTimings`;
 * - stops between slices when the build was superseded (cancellation).
 *
 * The same steps also run synchronously ({@link runLoadStepsSync}) for flows
 * that need the result in the same call (Practice Island).
 */

/** Hands a step's own progress (0..1 of that step) back to the pipeline. */
export interface LoadStepContext {
  report(fraction: number): void;
}

/**
 * One unit of a load. `run` may:
 * - do its work synchronously (keep those small: they block until done);
 * - return a promise (async GPU work such as pipeline compilation);
 * - return an iterator: each `yield` marks a point where the pipeline may
 *   pause for the next frame; a yielded number is the step's progress (0..1).
 */
export interface LoadStep {
  /** Short id for timings (`level`, `obstacles`, `compile`, …). */
  readonly name: string;
  /** Share of the progress bar relative to the other steps (> 0). */
  readonly weight: number;
  run(ctx: LoadStepContext): void | Promise<void> | Iterator<unknown>;
}

/** Wall time spent in one step. */
export interface LoadStepTiming {
  name: string;
  /** From the step's start to its end, including the pauses between its slices. */
  ms: number;
  /** Main-thread time actually spent in the step's code. */
  busyMs: number;
  /** Slices the step ran in (1 for a synchronous step). */
  slices: number;
  /** Longest uninterrupted main-thread block in this step. */
  longestSliceMs: number;
}

/** One finished (or cancelled) load. */
export interface LoadTimings {
  /** What was loaded (round id). */
  label: string;
  totalMs: number;
  /** Longest main-thread block across every step: the worst frame hitch the build caused. */
  longestSliceMs: number;
  cancelled: boolean;
  steps: LoadStepTiming[];
}

/** Options for {@link runLoadPipeline}. */
export interface LoadPipelineOptions {
  /** Name for marks and the timings log. */
  label?: string;
  /** Called with overall progress 0..1 (non-decreasing) after every slice. */
  onProgress?: (progress: number) => void;
  /** Checked between slices; true stops the build and resolves with `cancelled`. */
  isCancelled?: () => boolean;
  /** Main-thread budget per slice of a generator step (ms). */
  sliceMs?: number;
  /** Lets the browser paint and handle input (default {@link yieldToMain}). */
  yieldToMain?: () => Promise<void>;
  /** Clock in ms (default `performance.now`). */
  now?: () => number;
  /** Where to append the result (default {@link loadTimingsLog}); null to skip. */
  log?: LoadTimings[] | null;
}

/** Default slice budget: half a 60 Hz frame leaves room for the browser's own work. */
export const DEFAULT_SLICE_MS = 8;
/** Builds kept in {@link loadTimingsLog}. */
const LOG_LIMIT = 12;

/** Recent load timings, newest last (exposed as `window.__tumble.loadTimings`). */
export const loadTimingsLog: LoadTimings[] = [];

interface SchedulerLike {
  yield?: () => Promise<void>;
}

let channel: MessageChannel | null = null;
const channelQueue: (() => void)[] = [];

/**
 * Yields to the event loop so the browser can paint, run input handlers and
 * deliver socket messages, then resumes as soon as possible.
 *
 * NOTE: `scheduler.yield()` where available; otherwise a MessageChannel
 * task, because `setTimeout(0)` is clamped to ≥ 1 s in background tabs and
 * would stretch a hundred-slice build into minutes.
 */
export function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (sched?.yield) return sched.yield();
  if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => channelQueue.shift()?.();
  }
  return new Promise((resolve) => {
    channelQueue.push(resolve);
    channel?.port2.postMessage(0);
  });
}

function isIterator(v: unknown): v is Iterator<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as Iterator<unknown>).next === 'function';
}

function isPromise(v: unknown): v is Promise<void> {
  return typeof v === 'object' && v !== null && typeof (v as Promise<void>).then === 'function';
}

const perf = (): Performance | null =>
  typeof performance !== 'undefined' && typeof performance.mark === 'function' ? performance : null;

/**
 * Runs `steps` in order, time-slicing generator steps and yielding between
 * steps.
 *
 * @param steps - The build, in order.
 * @param opts - Progress, cancellation and scheduling hooks.
 * @returns The build's timings (also appended to the log); `cancelled` is set
 *   when {@link LoadPipelineOptions.isCancelled} stopped it.
 *
 * @example
 * const t = await runLoadPipeline(view.loadSteps(), { label: round.id, onProgress: (p) => bar(p) });
 * if (!t.cancelled) send('loaded');
 */
export async function runLoadPipeline(
  steps: readonly LoadStep[],
  opts: LoadPipelineOptions = {},
): Promise<LoadTimings> {
  const now = opts.now ?? (() => performance.now());
  const pause = opts.yieldToMain ?? yieldToMain;
  const sliceMs = opts.sliceMs ?? DEFAULT_SLICE_MS;
  const label = opts.label ?? 'load';
  const p = perf();
  const total = steps.reduce((s, x) => s + Math.max(0, x.weight), 0) || 1;
  const timings: LoadTimings = { label, totalMs: 0, longestSliceMs: 0, cancelled: false, steps: [] };
  const t0 = now();
  let done = 0;
  let reported = 0;
  let stepFraction = 0;
  let stepWeight = 0;
  const emit = (): void => {
    const v = Math.min(1, (done + stepWeight * Math.max(0, Math.min(1, stepFraction))) / total);
    // Monotonic: a step re-reporting a smaller fraction never moves the bar back.
    if (v > reported) {
      reported = v;
      opts.onProgress?.(v);
    }
  };
  const ctx: LoadStepContext = {
    report(f) {
      stepFraction = f;
      emit();
    },
  };
  const cancelled = (): boolean => opts.isCancelled?.() === true;

  for (const step of steps) {
    if (cancelled()) {
      timings.cancelled = true;
      break;
    }
    stepWeight = Math.max(0, step.weight);
    stepFraction = 0;
    const st: LoadStepTiming = { name: step.name, ms: 0, busyMs: 0, slices: 0, longestSliceMs: 0 };
    const startMark = `tumble:load:${step.name}:start`;
    p?.mark(startMark);
    const s0 = now();
    const slice = (ms: number): void => {
      st.slices++;
      st.busyMs += ms;
      if (ms > st.longestSliceMs) st.longestSliceMs = ms;
    };

    let a = now();
    const result = step.run(ctx);
    if (isIterator(result)) {
      for (;;) {
        const r = result.next();
        if (typeof r.value === 'number') stepFraction = r.value;
        if (r.done) {
          slice(now() - a);
          break;
        }
        if (now() - a < sliceMs) continue;
        slice(now() - a);
        emit();
        await pause();
        if (cancelled()) {
          timings.cancelled = true;
          result.return?.(undefined);
          break;
        }
        a = now();
      }
    } else if (isPromise(result)) {
      // Async steps yield inside themselves; only their synchronous prologue counts as a slice.
      slice(now() - a);
      await result;
    } else {
      slice(now() - a);
    }

    st.ms = now() - s0;
    if (st.longestSliceMs > timings.longestSliceMs) timings.longestSliceMs = st.longestSliceMs;
    timings.steps.push(st);
    if (p) {
      try {
        p.measure(`tumble:load:${label}:${step.name}`, startMark);
      } catch {
        // Some environments lack the mark after a timeline clear; timings above still hold.
      }
      p.clearMarks(startMark);
    }
    if (timings.cancelled) break;
    done += stepWeight;
    stepFraction = 0;
    stepWeight = 0;
    emit();
    await pause();
  }

  timings.totalMs = now() - t0;
  const log = opts.log === undefined ? loadTimingsLog : opts.log;
  if (log) {
    log.push(timings);
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  }
  return timings;
}

/**
 * Rate-limits progress updates (each one may re-render UI). The first update
 * and completion (1) always pass.
 *
 * @param intervalMs - Minimum time between forwarded updates.
 * @param fn - Receives the forwarded progress.
 * @param now - Clock in ms (default `performance.now`).
 * @returns The throttled reporter.
 *
 * @example
 * const report = throttleProgress(250, (p) => ui.getState().setRoundLoading({ progress: p }));
 */
export function throttleProgress(
  intervalMs: number,
  fn: (progress: number) => void,
  now: () => number = () => performance.now(),
): (progress: number) => void {
  let last = -Infinity;
  return (progress) => {
    const t = now();
    if (progress < 1 && t - last < intervalMs) return;
    last = t;
    fn(progress);
  };
}

/**
 * Runs the synchronous parts of `steps` to completion in one go (generators
 * are drained; promise-returning steps are rejected because nothing can wait
 * for them here).
 *
 * @param steps - Steps without async work.
 */
export function runLoadStepsSync(steps: readonly LoadStep[]): void {
  const ctx: LoadStepContext = { report: () => {} };
  for (const step of steps) {
    const result = step.run(ctx);
    if (isIterator(result)) {
      while (!result.next().done) {
        // Drain.
      }
    } else if (isPromise(result)) {
      throw new Error(`load step "${step.name}" is async and cannot run synchronously`);
    }
  }
}
