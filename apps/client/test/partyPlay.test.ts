/**
 * Play inside a party: Vs Bots and Practice are always available (confirmed
 * when they leave others waiting), the online queue is the leader's, and
 * the party is told who went solo and why a queue was refused.
 */
import { describe, expect, it } from 'vitest';
import { queueRefusal, routePlay, soloNotice } from '../src/game/online/partyPlay.ts';

const solo = { inParty: false, isLeader: true };
const leader = { inParty: true, isLeader: true };
const member = { inParty: true, isLeader: false };

describe('routing a Play press', () => {
  it('lets a solo player do anything right away', () => {
    expect(routePlay('online', solo)).toEqual({ action: 'queue' });
    expect(routePlay('offline', solo)).toEqual({ action: 'solo' });
    expect(routePlay('practice', solo)).toEqual({ action: 'solo' });
  });

  it('keeps the online queue for the leader', () => {
    expect(routePlay('online', leader)).toEqual({ action: 'queue' });
    expect(routePlay('online', member)).toEqual({ action: 'waitForLeader' });
  });

  it('lets a member play solo vs bots after a confirm that they stay in the party', () => {
    const r = routePlay('offline', member);
    expect(r.action).toBe('confirmSolo');
    if (r.action !== 'confirmSolo') return;
    expect(r.dialog.title).toBe('Play solo vs bots?');
    expect(r.dialog.body).toBe("You'll stay in the party but won't queue with them until you're back.");
  });

  it('confirms before a leader strands the party in the menu', () => {
    const r = routePlay('offline', leader);
    expect(r.action).toBe('confirmSolo');
    if (r.action === 'confirmSolo') expect(r.dialog.body).toContain("They'll see you're playing solo");
  });

  it('treats Practice Island like Vs Bots', () => {
    const r = routePlay('practice', member);
    expect(r.action).toBe('confirmSolo');
    if (r.action === 'confirmSolo') expect(r.dialog.title).toBe('Visit Practice Island?');
  });
});

describe('party notices', () => {
  it('tells members the leader is playing solo, and when they are back', () => {
    const e = { userId: 'lead', name: 'Ann', leader: true, playing: true };
    expect(soloNotice(e, 'me')?.title).toBe('Leader is playing solo');
    expect(soloNotice({ ...e, playing: false }, 'me')?.title).toBe('Leader is back');
  });

  it('names a member who went solo, and never echoes the player’s own event', () => {
    const e = { userId: 'bob', name: 'Bob', leader: false, playing: true };
    expect(soloNotice(e, 'me')?.title).toBe('Bob is playing solo');
    expect(soloNotice(e, 'bob')).toBeNull();
  });

  it('explains a refused queue, naming who is still in a show', () => {
    expect(queueRefusal('member_busy', 'Bob is still in a show')).toEqual({
      title: 'Someone is still in a show',
      body: "Bob is still in a show. Queue again once they're back in the menu.",
    });
    expect(queueRefusal('not_ready', 'x').title).toBe('Not everyone is ready');
    expect(queueRefusal('in_lobby', 'Leave your private show first')).toEqual({
      title: "Couldn't start matchmaking",
      body: 'Leave your private show first',
    });
  });
});
