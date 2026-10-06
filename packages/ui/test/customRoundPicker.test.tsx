/**
 * The private show round picker's "Custom round by code" field: its states
 * (idle, looking up, found, error), the Custom group for shared rounds, and
 * how picked shared rounds are named when the player never looked them up.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { RoundPicker, lookupMessage, roundName } from '../src/screens/overlays/RoundPicker.tsx';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

beforeEach(() => {
  ui.getState().setRoundCatalog([
    { id: 'gumdrop-gauntlet', name: 'Gumdrop Gauntlet', type: 'race' },
    { id: 'tile-panic', name: 'Tile Panic', type: 'survival' },
  ]);
  ui.getState().setCustomRoundLookup({ status: 'idle' });
});

const render = (picked: string[] = []) =>
  renderToStaticMarkup(<RoundPicker picked={picked} onChange={() => {}} />);

describe('custom round by code', () => {
  it('offers the code field with nothing to report yet', () => {
    const html = render();
    expect(html).toContain('Custom round by code');
    expect(html).toContain('id="tr-custom-round-code"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('custom-round-group');
  });

  it('shows lookups in progress, failures and finds', () => {
    ui.getState().setCustomRoundLookup({ status: 'loading', code: 'K7MQ2X9A' });
    expect(render()).toContain('Looking up K7MQ2X9A');
    ui.getState().setCustomRoundLookup({
      status: 'error',
      code: 'K7MQ2X9A',
      message: 'This round was removed by moderators',
    });
    const err = render();
    expect(err).toContain('role="alert"');
    expect(err).toContain('This round was removed by moderators');
    ui.getState().addCustomRoundEntry({
      id: 'custom:K7MQ2X9A',
      name: 'Hop Hop',
      type: 'race',
      custom: true,
      author: 'Maker#1234',
    });
    ui.getState().setCustomRoundLookup({ status: 'ok', code: 'K7MQ2X9A', id: 'custom:K7MQ2X9A' });
    const ok = render(['custom:K7MQ2X9A']);
    expect(ok).toContain('Added Hop Hop');
    expect(ok).toContain('custom-round-group');
    expect(ok).toContain('title="by Maker#1234"');
    expect(ok).toMatch(/aria-pressed="true"[^>]*>.*Hop Hop/);
  });

  it('keeps one entry per shared round', () => {
    const entry = { id: 'custom:K7MQ2X9A', name: 'Hop', type: 'race' as const, custom: true };
    ui.getState().addCustomRoundEntry(entry);
    ui.getState().addCustomRoundEntry({ ...entry, name: 'Hop v2' });
    expect(
      ui
        .getState()
        .roundCatalog.filter((r) => r.id === entry.id)
        .map((r) => r.name),
    ).toEqual(['Hop v2']);
  });

  it('names picked rounds', () => {
    const catalog = ui.getState().roundCatalog;
    expect(roundName('tile-panic', catalog)).toBe('Tile Panic');
    expect(roundName('custom:ZZZZZZZZ', catalog)).toBe('Custom round ZZZZZZZZ');
    expect(lookupMessage({ status: 'idle' })).toBeNull();
  });
});
