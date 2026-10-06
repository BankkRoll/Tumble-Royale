/** Play Online's status: the newest check wins, and a late probe never overrides offline or maintenance. */
import { describe, expect, it } from 'vitest';
import type { OnlineStatus } from '@tumble/ui';
import { OnlineStatusCheck, type OnlineStatusDeps } from '../src/game/online/onlineStatus.ts';

function setup() {
  const published: OnlineStatus[] = [];
  const probes: ((up: boolean) => void)[] = [];
  const env = { network: true, maintenance: null as string | null };
  const deps: OnlineStatusDeps = {
    disabled: () => false,
    networkUp: () => env.network,
    maintenance: () => env.maintenance,
    probe: () => new Promise((resolve) => probes.push((up) => resolve({ up }))),
    publish: (s) => published.push(s),
  };
  return { check: new OnlineStatusCheck(deps), published, probes, env };
}

describe('OnlineStatusCheck', () => {
  it('publishes online when the probe answers', async () => {
    const { check, published, probes } = setup();
    const done = check.refresh();
    probes[0]!(true);
    await done;
    expect(published.map((s) => s.state)).toEqual(['checking', 'online']);
  });

  it('a slow probe that answers after the device went offline does not publish online', async () => {
    const { check, published, probes, env } = setup();
    const slow = check.refresh();
    env.network = false;
    await check.refresh();
    probes[0]!(true);
    expect(await slow).toBeNull();
    expect(published.at(-1)).toMatchObject({ state: 'offline', noNetwork: true });
  });

  it('a probe answering once maintenance began reports maintenance', async () => {
    const { check, published, probes, env } = setup();
    const done = check.refresh();
    env.maintenance = 'Back at 10:00';
    probes[0]!(true);
    await done;
    expect(published.at(-1)).toEqual({ state: 'offline', message: 'Back at 10:00' });
  });

  it('only the newest of overlapping probes publishes', async () => {
    const { check, published, probes } = setup();
    const first = check.refresh();
    const second = check.refresh();
    probes[1]!(false);
    await second;
    probes[0]!(true);
    expect(await first).toBeNull();
    expect(published.at(-1)?.state).toBe('offline');
  });
});
