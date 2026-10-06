import { describe, expect, it } from 'vitest';
import {
  CLUB_GOALS,
  CLUB_PERMISSIONS,
  CLUB_ROLES,
  checkClubDescription,
  checkClubName,
  checkClubTag,
  clubCan,
  clubGoalTarget,
  clubGoalTitle,
  clubOutranks,
  clubTagLabel,
  parseClubEmblem,
  type ClubAction,
} from '../src/social/clubs.ts';
import { FLAG_DEFAULTS, FLAG_KEYS } from '../src/liveops.ts';

describe('club permissions', () => {
  const expected: Record<ClubAction, [boolean, boolean, boolean]> = {
    chat: [true, true, true],
    partyUp: [true, true, true],
    invite: [false, true, true],
    acceptRequest: [false, true, true],
    kick: [false, true, true],
    edit: [false, true, true],
    setRole: [false, false, true],
    rename: [false, false, true],
    transfer: [false, false, true],
    disband: [false, false, true],
  };

  it.each(Object.keys(CLUB_PERMISSIONS) as ClubAction[])('%s follows the matrix', (action) => {
    expect(CLUB_ROLES.map((r) => clubCan(r, action))).toEqual(expected[action]);
  });

  it('refuses unknown roles everything', () => {
    expect(clubCan('guest', 'chat')).toBe(false);
  });

  it('only lets a higher role act on a lower one', () => {
    expect(clubOutranks('owner', 'officer')).toBe(true);
    expect(clubOutranks('officer', 'member')).toBe(true);
    expect(clubOutranks('officer', 'officer')).toBe(false);
    expect(clubOutranks('member', 'owner')).toBe(false);
  });
});

describe('club text', () => {
  it('accepts tidy names and collapses spaces', () => {
    expect(checkClubName('  Wobble   Squad ')).toEqual({ ok: true, value: 'Wobble Squad' });
  });

  it.each([
    ['ab', 'length'],
    ['x'.repeat(25), 'length'],
    ['Bad!Name', 'characters'],
    ['Official Club', 'reserved'],
    ['Moderators', 'reserved'],
    ['Fuck Squad', 'profanity'],
    ['Sh1t Heads', 'profanity'],
  ])('refuses %s (%s)', (name, reason) => {
    expect(checkClubName(name)).toEqual({ ok: false, reason });
  });

  it('upper-cases tags and checks them', () => {
    expect(checkClubTag(' wob ')).toEqual({ ok: true, value: 'WOB' });
    expect(checkClubTag('A')).toEqual({ ok: false, reason: 'length' });
    expect(checkClubTag('ABCDEF')).toEqual({ ok: false, reason: 'length' });
    expect(checkClubTag('A-B')).toEqual({ ok: false, reason: 'characters' });
    expect(checkClubTag('mod')).toEqual({ ok: false, reason: 'reserved' });
    expect(checkClubTag('FUCK')).toEqual({ ok: false, reason: 'profanity' });
  });

  it('cleans descriptions and refuses profanity', () => {
    expect(checkClubDescription('  we   tumble\u0000 daily ')).toEqual({
      ok: true,
      value: 'we tumble daily',
    });
    expect(checkClubDescription('')).toEqual({ ok: true, value: '' });
    expect(checkClubDescription('a'.repeat(201))).toEqual({ ok: false, reason: 'length' });
    expect(checkClubDescription('what the fuck')).toEqual({ ok: false, reason: 'profanity' });
  });

  it('labels tags', () => {
    expect(clubTagLabel('WOB')).toBe('[WOB]');
    expect(clubTagLabel(null)).toBe('');
  });
});

describe('club emblems', () => {
  it('accepts palette colours in any case', () => {
    expect(parseClubEmblem({ motif: 'waves', primary: '#FF4F9A', secondary: '#ffffff' })).toEqual({
      motif: 'waves',
      primary: '#ff4f9a',
      secondary: '#ffffff',
    });
  });

  it('refuses anything off-palette', () => {
    expect(parseClubEmblem({ motif: 'waves', primary: '#123456', secondary: '#ffffff' })).toBeNull();
    expect(parseClubEmblem({ motif: 'skulls', primary: '#ff4f9a', secondary: '#ffffff' })).toBeNull();
    expect(parseClubEmblem('stars')).toBeNull();
  });
});

describe('club goals', () => {
  it('scales targets with members inside each range', () => {
    const shows = CLUB_GOALS.find((g) => g.id === 'shows')!;
    expect(clubGoalTarget(shows, 1)).toBe(shows.min);
    expect(clubGoalTarget(shows, 4)).toBe(20);
    expect(clubGoalTarget(shows, 50)).toBe(shows.max);
    expect(clubGoalTitle(shows, 20)).toBe('Play 20 shows');
  });

  it('never pays Gems', () => {
    for (const g of CLUB_GOALS) expect(Object.keys(g)).not.toContain('rewardGems');
  });
});

describe('clubs flag', () => {
  it('is a known kill switch that defaults on', () => {
    expect(FLAG_KEYS).toContain('clubs.enabled');
    expect(FLAG_DEFAULTS['clubs.enabled'].enabled).toBe(true);
  });
});
