/**
 * Copying a party invite: the clipboard gets exactly what the player picked,
 * the toast never repeats the code or link, and the game is only told which
 * kind was copied.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyPartyInvite } from '../src/screens/overlays/SocialSheets.tsx';
import { uiEvents } from '../src/store/events.ts';
import { ui } from '../src/store/uiStore.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  ui.setState({ toasts: [] });
});

describe('copyPartyInvite', () => {
  it.each([
    ['code', 'ABC234'],
    ['link', 'https://play.example/join/ABC234'],
  ] as const)('copies the %s and keeps it out of the toast and the event', (what, text) => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const heard: unknown[] = [];
    const off = uiEvents.on('copyInvite', (p) => heard.push(p));
    copyPartyInvite(what, text);
    off();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
    expect(heard).toEqual([{ kind: 'party', what }]);
    const toasts = JSON.stringify(ui.getState().toasts);
    expect(toasts).toContain('copied');
    expect(toasts).not.toContain('ABC234');
  });
});
