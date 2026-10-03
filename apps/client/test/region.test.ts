import { describe, expect, it } from 'vitest';
import {
  chooseRegion,
  median,
  probeRegions,
  timezoneRegion,
  type ProbeDeps,
  type RegionProbe,
} from '../src/game/online/region.ts';

const probe = (p: Partial<RegionProbe> = {}): RegionProbe => ({
  pings: {},
  available: [],
  matchmakerMs: null,
  ...p,
});

describe('chooseRegion', () => {
  it('keeps a manual pick', () => {
    expect(chooseRegion('oce', probe({ pings: { eu: 10 } }), 'na')).toBe('oce');
  });

  it('auto picks the lowest measured ping', () => {
    expect(chooseRegion('auto', probe({ pings: { eu: 48, na: 130, asia: 210 } }), 'na')).toBe('eu');
  });

  it('prefers regions that have servers over a faster empty one', () => {
    expect(chooseRegion('auto', probe({ pings: { eu: 20, na: 90 }, available: ['na'] }), 'eu')).toBe('na');
  });

  it('falls back to the only live region, then the time-zone guess', () => {
    expect(chooseRegion('auto', probe({ available: ['asia'] }), 'eu')).toBe('asia');
    expect(chooseRegion('auto', probe(), 'sa')).toBe('sa');
    expect(chooseRegion('auto', probe({ available: ['eu', 'na'] }), 'na')).toBe('na');
    expect(chooseRegion('auto', probe({ available: ['eu', 'na'] }), 'oce')).toBe('eu');
  });

  it('ignores junk pings and unknown setting values', () => {
    const p = probe({ pings: { eu: Number.NaN, na: -5 } as RegionProbe['pings'] });
    expect(chooseRegion('mars', p, 'asia')).toBe('asia');
  });
});

describe('timezoneRegion', () => {
  it.each([
    ['Europe/Berlin', 120, 'eu'],
    ['Africa/Lagos', 60, 'eu'],
    ['America/New_York', -240, 'na'],
    ['America/Sao_Paulo', -180, 'sa'],
    ['America/Argentina/Buenos_Aires', -180, 'sa'],
    ['Asia/Tokyo', 540, 'asia'],
    ['Australia/Sydney', 600, 'oce'],
    ['Pacific/Auckland', 780, 'oce'],
    ['Pacific/Honolulu', -600, 'na'],
  ] as const)('%s → %s', (tz, off, want) => {
    expect(timezoneRegion(tz, off)).toBe(want);
  });

  it('falls back to the UTC offset', () => {
    expect(timezoneRegion(undefined, -300)).toBe('na');
    expect(timezoneRegion('Etc/UTC', 0)).toBe('eu');
    expect(timezoneRegion('', 330)).toBe('asia');
    expect(timezoneRegion('', 600)).toBe('oce');
  });
});

describe('probeRegions', () => {
  /** Fake network: each URL answers after a fixed delay on a virtual clock. */
  function net(routes: Record<string, { ms: number; body?: unknown; fail?: boolean }>): ProbeDeps {
    let clock = 0;
    return {
      now: () => clock,
      samples: 4,
      fetch: async (url) => {
        const r = routes[url];
        if (!r || r.fail) throw new Error('offline');
        clock += r.ms;
        return new Response(JSON.stringify(r.body ?? { ok: true }), { status: 200 });
      },
    };
  }

  it('attributes the matchmaker RTT to its single region', async () => {
    const p = await probeRegions(
      'http://mm.test/',
      net({ 'http://mm.test/ping': { ms: 42, body: { ok: true, regions: ['eu'] } } }),
    );
    expect(p).toEqual({ pings: { eu: 42 }, available: ['eu'], matchmakerMs: 42 });
  });

  it('times per-region URLs when the matchmaker lists them', async () => {
    const p = await probeRegions(
      'http://mm.test',
      net({
        'http://mm.test/ping': {
          ms: 30,
          body: {
            ok: true,
            regions: ['eu', 'na'],
            pingUrls: { eu: 'http://eu.test/ping', na: 'http://na.test/ping', zz: 'http://zz.test' },
          },
        },
        'http://eu.test/ping': { ms: 25 },
        'http://na.test/ping': { ms: 110 },
      }),
    );
    expect(p.pings).toEqual({ eu: 25, na: 110 });
    expect(chooseRegion('auto', p, 'na')).toBe('eu');
  });

  it('measures nothing per region with several regions and no URLs', async () => {
    const p = await probeRegions(
      'http://mm.test',
      net({ 'http://mm.test/ping': { ms: 30, body: { ok: true, regions: ['eu', 'na'] } } }),
    );
    expect(p.pings).toEqual({});
    expect(p.matchmakerMs).toBe(30);
  });

  it('reports nothing when the matchmaker is down', async () => {
    const p = await probeRegions('http://mm.test', net({}));
    expect(p).toEqual(probe());
  });
});

describe('median', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
