/**
 * The Tumble Wipe only blocks input while it covers the screen: once the new
 * screen is live under the rising bands, clicks must reach it.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ui } from '../src/store/uiStore.ts';
import type { WipePhase } from '../src/store/types.ts';
import { TumbleWipe } from '../src/transitions/TumbleWipe.tsx';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const css = readFileSync(new URL('../src/theme/screens.css', import.meta.url), 'utf8');
const initial = ui.getState().wipe;

function render(phase: WipePhase): string {
  ui.setState({ wipe: { ...initial, phase } });
  return renderToStaticMarkup(<TumbleWipe />);
}

afterEach(() => ui.setState({ wipe: initial }));

describe('TumbleWipe', () => {
  it('exposes its phase so the stylesheet can release the pointer', () => {
    expect(render('covering')).toContain('data-phase="covering"');
    expect(render('revealing')).toContain('data-phase="revealing"');
    expect(render('idle')).toBe('');
  });

  it('lets clicks through while revealing, and only then', () => {
    expect(css).toMatch(/\.tr-wipe\[data-phase='revealing'\]\s*\{\s*pointer-events:\s*none;/);
    expect(css).toMatch(/\.tr-wipe\s*\{[^}]*pointer-events:\s*auto;/);
  });
});
