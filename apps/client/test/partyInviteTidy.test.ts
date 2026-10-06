/** A party invite answered in one place (toast or notifications) is answered everywhere. */
import { beforeEach, describe, expect, it } from 'vitest';
import { ui } from '@tumble/ui';
import type { ApiClient } from '../src/game/api.ts';
import { OnlineAccount, type AccountHooks } from '../src/game/online/account.ts';

function account(): OnlineAccount {
  const api = {
    joinPartyByCode: () => new Promise(() => undefined),
    joinParty: () => new Promise(() => undefined),
  } as unknown as ApiClient;
  return new OnlineAccount(api, {} as AccountHooks);
}

const invite = (a: OnlineAccount) =>
  (a as unknown as { onPartyInvite(m: unknown): void }).onPartyInvite({
    type: 'party_invite',
    code: 'PARTY123',
    from: { userId: 'u-pal', name: 'Pal', tag: '0002' },
  });

const partyToasts = () => ui.getState().toasts.filter((t) => t.actions?.some((x) => x.id.startsWith('party-')));
const openInvites = () =>
  ui.getState().notifications.filter((n) => n.action?.kind === 'partyInvite' && !n.resolved);

beforeEach(() => {
  for (const t of ui.getState().toasts) ui.getState().dismissToast(t.id);
  ui.getState().setNotifications([]);
});

describe('party invite tidy-up', () => {
  it('answering from the notifications panel takes the toast down', async () => {
    const a = account();
    invite(a);
    expect(partyToasts()).toHaveLength(1);
    await a.answerPartyInvite('u-pal', 'PARTY123', 'decline').catch(() => undefined);
    expect(partyToasts()).toHaveLength(0);
    expect(openInvites()).toHaveLength(0);
  });

  it('joining from the toast answers the notification', () => {
    const a = account();
    invite(a);
    expect(openInvites()).toHaveLength(1);
    a.handleToastAction('party-join:PARTY123');
    expect(openInvites()).toHaveLength(0);
  });
});
