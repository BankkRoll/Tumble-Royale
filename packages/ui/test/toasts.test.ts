/** Toasts: which ones become in-round feed lines, and which survive a full queue. */
import { afterEach, describe, expect, it } from 'vitest';
import { ui } from '../src/store/uiStore.ts';

afterEach(() => {
  for (const t of ui.getState().toasts) ui.getState().dismissToast(t.id);
  ui.getState().setScreen('menu', { transition: 'none' });
});

describe('toast variants in a round', () => {
  it('plain toasts become feed lines; sticky or actionable ones stay cards', () => {
    ui.getState().setScreen('round', { transition: 'none' });
    const s = ui.getState();
    const plain = s.pushToast({ title: 'Mallow qualified' });
    const sticky = s.pushToast({ title: 'Party invite', durationMs: 0 });
    const invite = s.pushToast({ title: 'Party invite', actions: [{ id: 'accept', label: 'Join' }] });
    const variant = (id: number) => ui.getState().toasts.find((t) => t.id === id)?.variant;
    expect(variant(plain)).toBe('feed');
    expect(variant(sticky)).toBe('card');
    expect(variant(invite)).toBe('card');
  });
});

describe('toast queue', () => {
  it('a full queue drops timed toasts before the sticky update toast', () => {
    const s = ui.getState();
    const update = s.pushToast({ title: 'Update available', durationMs: 0 });
    for (let i = 0; i < 6; i++) s.pushToast({ title: 'Hello ' + String(i) });
    expect(ui.getState().toasts.some((t) => t.id === update)).toBe(true);
  });
});
