/**
 * Page side of the installable app.
 *
 * Responsibilities:
 * - register `sw.js` (production builds; sandbox builds only with `?sw=1`,
 *   so e2e runs never test a cached bundle);
 * - publish the install state (`ui.pwa.install`): the browser's deferred
 *   install prompt on Chromium, hand-made Add to Home Screen on iOS Safari,
 *   or already running installed;
 * - notice a downloaded update and offer "Update available, Restart" only
 *   on the main menu, never during a show; restarting hands control to the
 *   new worker and reloads once it took over.
 */
import { ui, uiEvents, type PwaState, type ScreenId } from '@tumble/ui';

/** Screens where a restart loses nothing (no show, no queue). */
const RESTART_SAFE: ReadonlySet<ScreenId> = new Set(['menu', 'splash']);

/** Toast action id of the update toast's Restart button. */
const RESTART_ACTION = 'pwa-restart';

/** How often a long session checks for a new deploy. */
const UPDATE_CHECK_MS = 30 * 60 * 1000;

/** What {@link detectInstall} reads from the browser. */
export interface InstallEnv {
  /** `display-mode: standalone` or `fullscreen` matches, or iOS `navigator.standalone`. */
  standalone: boolean;
  userAgent: string;
  /** `navigator.maxTouchPoints` (iPadOS reports a Mac user agent). */
  maxTouchPoints: number;
}

/**
 * Install state before any `beforeinstallprompt`: installed, iOS (manual
 * Add to Home Screen, Safari only: other iOS browsers cannot install), or
 * nothing to offer yet.
 *
 * @param env - Browser facts.
 * @returns The starting install state.
 * @example
 * detectInstall({ standalone: false, userAgent: 'Mozilla/5.0 (iPhone; ...) Version/18.0 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 });
 * // 'ios'
 */
export function detectInstall(env: InstallEnv): PwaState['install'] {
  if (env.standalone) return 'installed';
  const ua = env.userAgent;
  const iosDevice = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1);
  // Chrome, Firefox and Edge on iOS say CriOS/FxiOS/EdgiOS; only Safari has Add to Home Screen everywhere.
  const safari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return iosDevice && safari ? 'ios' : 'unavailable';
}

/**
 * Whether the update toast may show now.
 *
 * @param screen - Current UI screen.
 * @param overlay - Current overlay (`none` when nothing covers the menu).
 */
export function canOfferRestart(screen: ScreenId, overlay: string): boolean {
  return RESTART_SAFE.has(screen) && overlay !== 'inGameMenu';
}

interface DeferredPrompt extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  const mq = (q: string): boolean => window.matchMedia?.(q).matches ?? false;
  return (
    mq('(display-mode: standalone)') ||
    mq('(display-mode: fullscreen)') ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Options for {@link installPwa}. */
export interface InstallPwaOptions {
  /** Register the service worker (false in dev, and in sandbox builds without `?sw=1`). */
  register: boolean;
  /** Vite `base` (the worker's scope). */
  base: string;
  /** Register only once this settles successfully (boot finished). */
  after?: Promise<unknown>;
}

/**
 * Wires install prompts, the service worker and the update flow into the UI store.
 *
 * @returns Stops listening (tests); the worker stays registered.
 */
export function installPwa(opts: InstallPwaOptions): () => void {
  const s = ui.getState;
  const offs: (() => void)[] = [];
  // `beforeinstallprompt` and `appinstalled` are Chromium-only and not in the DOM lib's event map.
  const on = (type: string, fn: (e: Event) => void): void => {
    window.addEventListener(type, fn);
    offs.push(() => window.removeEventListener(type, fn));
  };

  s().setPwa({
    install: detectInstall({
      standalone: isStandalone(),
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
    }),
  });

  let deferred: DeferredPrompt | null = null;
  on('beforeinstallprompt', (e) => {
    // Keep the browser's mini-infobar away; Settings and the menu offer it at a calm moment instead.
    e.preventDefault();
    deferred = e as DeferredPrompt;
    if (s().pwa.install !== 'installed') s().setPwa({ install: 'available' });
  });
  on('appinstalled', () => {
    deferred = null;
    s().setPwa({ install: 'installed' });
  });
  offs.push(
    uiEvents.on('installApp', () => {
      const prompt = deferred;
      if (!prompt) return;
      deferred = null;
      void prompt
        .prompt()
        .then(() => prompt.userChoice)
        .then(({ outcome }) => s().setPwa({ install: outcome === 'accepted' ? 'installed' : 'unavailable' }))
        .catch(() => s().setPwa({ install: 'unavailable' }));
    }),
  );

  if (!opts.register || !('serviceWorker' in navigator)) return () => offs.forEach((f) => f());

  let reg: ServiceWorkerRegistration | null = null;
  let restarting = false;
  /** The update toast already went up (dismissing it leaves Settings → Update ready). */
  let toastId: number | null = null;

  const restart = (): void => {
    const waiting = reg?.waiting;
    if (!waiting || restarting) return;
    const st = s();
    if (!canOfferRestart(st.screen, st.overlay)) return;
    restarting = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
  };
  const offer = (): void => {
    const st = s();
    if (!st.pwa.updateReady || toastId !== null || !canOfferRestart(st.screen, st.overlay)) return;
    toastId = st.pushToast({
      kind: 'info',
      title: 'Update available',
      body: 'A new version of Tumble Royale is ready.',
      durationMs: 0,
      actions: [{ id: RESTART_ACTION, label: 'Restart' }],
    });
  };
  const markReady = (): void => {
    if (s().pwa.updateReady) return;
    s().setPwa({ updateReady: true });
    offer();
  };
  const track = (r: ServiceWorkerRegistration): void => {
    // A waiting worker with a controller is an update; without one it is the first install (it activates itself).
    if (r.waiting && navigator.serviceWorker.controller) markReady();
    r.addEventListener('updatefound', () => {
      const next = r.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) markReady();
      });
    });
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only the Restart the player asked for reloads; the first install's claim must not.
    if (restarting) location.reload();
  });
  offs.push(
    ui.subscribe((st, prev) => {
      if (st.screen === prev.screen && st.overlay === prev.overlay) return;
      if (canOfferRestart(st.screen, st.overlay)) {
        offer();
        return;
      }
      // Leaving for a show: take the toast down (a Restart there would be refused) and offer it again after.
      if (toastId !== null && st.toasts.some((t) => t.id === toastId)) {
        st.dismissToast(toastId);
        toastId = null;
      }
    }),
  );
  offs.push(uiEvents.on('applyUpdate', restart));
  offs.push(
    uiEvents.on('toastAction', ({ actionId }) => {
      if (actionId === RESTART_ACTION) restart();
    }),
  );
  const check = (): void => {
    if (reg && canOfferRestart(s().screen, s().overlay) && navigator.onLine)
      void reg.update().catch(() => {});
  };
  const timer = window.setInterval(check, UPDATE_CHECK_MS);
  offs.push(() => window.clearInterval(timer));
  on('online', check);

  void (opts.after ?? Promise.resolve())
    .then(() => navigator.serviceWorker.register(`${opts.base}sw.js`, { scope: opts.base }))
    .then((r) => {
      reg = r;
      track(r);
    })
    .catch((err: unknown) => console.warn('[pwa] service worker registration failed', err));

  return () => offs.forEach((f) => f());
}
