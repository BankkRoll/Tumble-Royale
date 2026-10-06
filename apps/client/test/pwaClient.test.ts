import { afterEach, describe, expect, it, vi } from 'vitest';
import { ui, uiEvents } from '@tumble/ui';
import { canOfferRestart, detectInstall, installPwa } from '../src/pwa/client.ts';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_MODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

describe('detectInstall', () => {
  it('reports a running installed app first', () => {
    expect(detectInstall({ standalone: true, userAgent: IPHONE_SAFARI, maxTouchPoints: 5 })).toBe(
      'installed',
    );
  });

  it('offers Add to Home Screen steps on iOS Safari, including iPadOS desktop mode', () => {
    expect(detectInstall({ standalone: false, userAgent: IPHONE_SAFARI, maxTouchPoints: 5 })).toBe('ios');
    expect(detectInstall({ standalone: false, userAgent: IPAD_DESKTOP_MODE, maxTouchPoints: 5 })).toBe('ios');
  });

  it('offers nothing where it cannot install by hand (Mac Safari, other iOS browsers)', () => {
    expect(detectInstall({ standalone: false, userAgent: IPAD_DESKTOP_MODE, maxTouchPoints: 0 })).toBe(
      'unavailable',
    );
    expect(detectInstall({ standalone: false, userAgent: IPHONE_CHROME, maxTouchPoints: 5 })).toBe(
      'unavailable',
    );
  });

  it('waits for the browser prompt on Android (beforeinstallprompt)', () => {
    expect(detectInstall({ standalone: false, userAgent: ANDROID_CHROME, maxTouchPoints: 5 })).toBe(
      'unavailable',
    );
  });
});

describe('canOfferRestart', () => {
  it('only offers a restart on the menu or splash', () => {
    expect(canOfferRestart('menu', 'none')).toBe(true);
    expect(canOfferRestart('menu', 'settings')).toBe(true);
    expect(canOfferRestart('splash', 'none')).toBe(true);
    for (const s of ['round', 'preShow', 'matchmaking', 'roundResults', 'victory', 'rewards'] as const)
      expect(canOfferRestart(s, 'none'), s).toBe(false);
  });

  it('never while the in-game menu is open', () => {
    expect(canOfferRestart('menu', 'inGameMenu')).toBe(false);
  });
});

describe('Restart after another tab applied the update', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reloads into the new version when no worker is waiting any more', async () => {
    const win = Object.assign(new EventTarget(), {
      setInterval: () => 1,
      clearInterval: () => undefined,
      matchMedia: () => ({ matches: false }),
    });
    const reg = Object.assign(new EventTarget(), {
      waiting: { postMessage: vi.fn() } as { postMessage: ReturnType<typeof vi.fn> } | null,
      installing: null,
      update: () => Promise.resolve(),
    });
    const sw = Object.assign(new EventTarget(), {
      controller: {},
      register: () => Promise.resolve(reg),
    });
    const reload = vi.fn();
    vi.stubGlobal('window', win);
    vi.stubGlobal('navigator', { serviceWorker: sw, userAgent: '', maxTouchPoints: 0, onLine: true });
    vi.stubGlobal('location', { reload });
    ui.getState().setScreen('menu', { transition: 'none' });
    const stop = installPwa({ register: true, base: '/' });
    try {
      await vi.waitFor(() => expect(ui.getState().pwa.updateReady).toBe(true));
      // The other tab sent SKIP_WAITING: the worker activated and took this page over too.
      reg.waiting = null;
      sw.dispatchEvent(new Event('controllerchange'));
      expect(reload).not.toHaveBeenCalled();
      uiEvents.emit('applyUpdate');
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });
});
