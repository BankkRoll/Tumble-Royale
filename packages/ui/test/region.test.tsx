import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { RegionRow } from '../src/screens/overlays/SettingsSheet.tsx';
import { ui } from '../src/store/uiStore.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

describe('Settings → Region', () => {
  afterEach(() => ui.getState().setRegionStatus({ pings: {}, auto: null, probing: false }));

  it('shows the measured ping next to each region and what Auto picked', () => {
    ui.getState().setRegionStatus({ pings: { eu: 38, na: 121 }, auto: 'eu' });
    const html = renderToStaticMarkup(<RegionRow />);
    expect(html).toContain('Auto (EU)');
    expect(html).toContain('EU 38 ms');
    expect(html).toContain('NA 121 ms');
    expect(html).toMatch(/>OCE</);
  });

  it('says when it is measuring', () => {
    ui.getState().setRegionStatus({ probing: true });
    expect(renderToStaticMarkup(<RegionRow />)).toContain('Measuring ping');
  });
});
