/**
 * Phone polish: the portrait rotate hint, the on-screen keyboard inset, and
 * the install / update rows in Settings and the menu.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { shouldHintRotate } from '../src/hud/RotateHint.tsx';
import { keyboardInset } from '../src/hud/keyboardInset.ts';
import { MainMenu } from '../src/screens/menu/MainMenu.tsx';
import { onlineTileSub } from '../src/screens/menu/PlayTab.tsx';
import { AppRows, canInstall } from '../src/screens/overlays/InstallApp.tsx';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

afterEach(() => {
  ui.setState({ screen: 'menu', pwa: { install: 'unavailable', updateReady: false } });
});

describe('rotate hint', () => {
  const base = { touch: true, portrait: true, screen: 'round' as const, dismissed: false };
  it('shows for touch players holding the phone upright during a show', () => {
    expect(shouldHintRotate(base)).toBe(true);
    expect(shouldHintRotate({ ...base, screen: 'preShow' })).toBe(true);
  });
  it('stays away in landscape, on desktop, in menus and once dismissed', () => {
    expect(shouldHintRotate({ ...base, portrait: false })).toBe(false);
    expect(shouldHintRotate({ ...base, touch: false })).toBe(false);
    expect(shouldHintRotate({ ...base, screen: 'menu' })).toBe(false);
    expect(shouldHintRotate({ ...base, dismissed: true })).toBe(false);
  });
});

describe('keyboardInset', () => {
  it('reports the height the keyboard covers', () => {
    expect(keyboardInset(800, 480, 0)).toBe(320);
    // iOS scrolls the visual viewport down while typing; only what is still hidden counts.
    expect(keyboardInset(800, 480, 120)).toBe(200);
  });
  it('ignores collapsing toolbars and rounding', () => {
    expect(keyboardInset(800, 800, 0)).toBe(0);
    expect(keyboardInset(800, 744, 0)).toBe(0);
    expect(keyboardInset(800, 801.4, 0)).toBe(0);
  });
});

describe('install and update rows', () => {
  it('offer Install where the browser can, the steps on iOS, and nothing else', () => {
    expect(canInstall('available')).toBe(true);
    expect(canInstall('ios')).toBe(true);
    expect(canInstall('installed')).toBe(false);
    expect(canInstall('unavailable')).toBe(false);
    ui.setState({ pwa: { install: 'available', updateReady: false } });
    expect(renderToStaticMarkup(<AppRows />)).toContain('data-testid="settings-install"');
    ui.setState({ pwa: { install: 'ios', updateReady: false } });
    expect(renderToStaticMarkup(<AppRows />)).toContain('Add to Home Screen');
    ui.setState({ pwa: { install: 'unavailable', updateReady: false } });
    expect(renderToStaticMarkup(<AppRows />)).not.toContain('settings-install');
  });

  it('show Update ready on the menu only, never during a show', () => {
    ui.setState({ screen: 'menu', pwa: { install: 'unavailable', updateReady: true } });
    expect(renderToStaticMarkup(<AppRows />)).toContain('settings-apply-update');
    ui.setState({ screen: 'round' });
    expect(renderToStaticMarkup(<AppRows />)).not.toContain('settings-apply-update');
  });

  it('put an Install app button in the menu top bar only when it can do something', () => {
    ui.setState({ screen: 'menu', pwa: { install: 'available', updateReady: false } });
    expect(renderToStaticMarkup(<MainMenu />)).toContain('data-testid="btn-install"');
    ui.setState({ pwa: { install: 'installed', updateReady: false } });
    expect(renderToStaticMarkup(<MainMenu />)).not.toContain('data-testid="btn-install"');
  });
});

describe('offline Play Online tile', () => {
  it('says the device is offline rather than blaming the servers', () => {
    expect(onlineTileSub({ state: 'offline', noNetwork: true })).toBe("You're offline");
    expect(onlineTileSub({ state: 'offline' })).toBe('Servers offline');
  });
});
