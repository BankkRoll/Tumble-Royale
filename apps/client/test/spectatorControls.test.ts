/**
 * Spectator input routing and the roster: which keys and controller buttons
 * do what while watching, that nothing fires under chat, menus, dialogs,
 * photo mode or the replay viewer, that the free camera keeps Q/E for flying,
 * default bindings that never clash, and the roster's order, Streamer Mode
 * masking and masked-only search.
 */
import {
  DEFAULT_KEYBINDS,
  DEFAULT_PAD_BINDS,
  PAD_BIND_CONTEXT,
  padActionsClash,
  searchRoster,
  type PadBindAction,
} from '@tumble/ui';
import { describe, expect, it } from 'vitest';
import { menuOwnsPad } from '../src/game/inputRouting.ts';
import { keymapFromKeybinds } from '../src/game/bindings.ts';
import {
  SpectatorPadEdges,
  flyAxesFromKeys,
  flyAxesFromPad,
  mergeFlyAxes,
  spectatorKeyAction,
  spectatorKeysLive,
  type SpectatorKeyState,
} from '../src/game/spectate/controls.ts';
import { buildRoster, firstToWatch, type RosterPlayer } from '../src/game/spectate/roster.ts';

const roundScreen: SpectatorKeyState = {
  screen: 'round',
  overlay: 'none',
  dialog: null,
  photo: { active: false } as SpectatorKeyState['photo'],
  replay: null,
};

describe('spectator hotkeys', () => {
  it('map the default keys to spectator actions', () => {
    const b = DEFAULT_KEYBINDS;
    expect(spectatorKeyAction('KeyV', b, 'follow')).toBe('camera');
    expect(spectatorKeyAction('KeyL', b, 'follow')).toBe('leader');
    expect(spectatorKeyAction('Tab', b, 'follow')).toBe('roster');
    expect(spectatorKeyAction('KeyP', b, 'follow')).toBe('pin');
    expect(spectatorKeyAction('KeyB', b, 'follow')).toBe('broadcast');
    expect(spectatorKeyAction('KeyH', b, 'follow')).toBe('help');
    expect(spectatorKeyAction('KeyK', b, 'follow')).toBe('chroma');
    expect(spectatorKeyAction('KeyQ', b, 'follow')).toBe('prev');
    expect(spectatorKeyAction('KeyE', b, 'director')).toBe('next');
    expect(spectatorKeyAction('KeyW', b, 'follow')).toBeNull();
    expect(spectatorKeyAction('', b, 'follow')).toBeNull();
  });

  it('leave Q/E to the free camera for flying', () => {
    expect(spectatorKeyAction('KeyQ', DEFAULT_KEYBINDS, 'free')).toBeNull();
    expect(spectatorKeyAction('KeyE', DEFAULT_KEYBINDS, 'free')).toBeNull();
    expect(spectatorKeyAction('KeyV', DEFAULT_KEYBINDS, 'free')).toBe('camera');
  });

  it('follow rebinding', () => {
    const binds = { ...DEFAULT_KEYBINDS, spectateCamera: ['KeyC', ''] as [string, string] };
    expect(spectatorKeyAction('KeyC', binds, 'follow')).toBe('camera');
    expect(spectatorKeyAction('KeyV', binds, 'follow')).toBeNull();
  });

  it('only fire on the round screen while watching, with nothing else open', () => {
    expect(spectatorKeysLive(roundScreen, true)).toBe(true);
    expect(spectatorKeysLive(roundScreen, false)).toBe(false);
    expect(spectatorKeysLive({ ...roundScreen, screen: 'roundResults' }, true)).toBe(false);
    expect(spectatorKeysLive({ ...roundScreen, overlay: 'inGameMenu' }, true)).toBe(false);
    expect(spectatorKeysLive({ ...roundScreen, overlay: 'spectatorRoster' }, true)).toBe(false);
    expect(
      spectatorKeysLive({ ...roundScreen, dialog: { id: 'x' } as SpectatorKeyState['dialog'] }, true),
    ).toBe(false);
    expect(
      spectatorKeysLive({ ...roundScreen, photo: { active: true } as SpectatorKeyState['photo'] }, true),
    ).toBe(false);
    expect(spectatorKeysLive({ ...roundScreen, replay: {} as SpectatorKeyState['replay'] }, true)).toBe(
      false,
    );
  });

  it('never share a default key with gameplay or each other', () => {
    const spectatorBinds = [
      'spectateCamera',
      'spectateLeader',
      'spectateRoster',
      'spectatePin',
      'broadcastOverlay',
      'broadcastHelp',
      'broadcastChroma',
    ] as const;
    const others = new Map<string, string>();
    for (const [action, pair] of Object.entries(DEFAULT_KEYBINDS))
      if (!(spectatorBinds as readonly string[]).includes(action))
        for (const c of pair) if (c) others.set(c, action);
    // The input layer's extra default keys (C dive, Right Shift grab) too.
    for (const [action, codes] of Object.entries(keymapFromKeybinds(DEFAULT_KEYBINDS)))
      for (const c of codes) others.set(c, action);
    const seen = new Set<string>();
    for (const a of spectatorBinds) {
      const code = DEFAULT_KEYBINDS[a][0];
      expect(others.has(code), `${a} on ${code}`).toBe(false);
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
  });
});

describe('spectator controller buttons', () => {
  it('only exist while spectating, so they may reuse gameplay buttons but never clash with each other', () => {
    const spectate = (Object.keys(DEFAULT_PAD_BINDS) as PadBindAction[]).filter(
      (a) => PAD_BIND_CONTEXT[a] === 'spectate',
    );
    expect(spectate.length).toBeGreaterThanOrEqual(8);
    const used = new Set<number>();
    for (const a of spectate) {
      const b = DEFAULT_PAD_BINDS[a][0];
      expect(used.has(b), `${a} on ${b}`).toBe(false);
      used.add(b);
      expect(padActionsClash(a, 'jump')).toBe(false);
    }
    // View is quick chat; Start is the menu.
    expect(used.has(8)).toBe(false);
    expect(used.has(9)).toBe(false);
  });

  it('fire once per press, never for a button already held when they start', () => {
    const pad = new SpectatorPadEdges();
    const held = new Set<number>([3]);
    const down = (i: number): boolean => held.has(i);
    expect(pad.update(down, DEFAULT_PAD_BINDS)).toEqual([]);
    expect(pad.update(down, DEFAULT_PAD_BINDS)).toEqual([]);
    held.clear();
    pad.update(down, DEFAULT_PAD_BINDS);
    held.add(3);
    expect(pad.update(down, DEFAULT_PAD_BINDS)).toEqual(['camera']);
    expect(pad.update(down, DEFAULT_PAD_BINDS)).toEqual([]);
    held.add(5);
    expect(pad.update(down, DEFAULT_PAD_BINDS)).toEqual(['next']);
  });

  it('stand down while menus own the pad (the eliminated sheet, the player list)', () => {
    const base = {
      inputMode: 'game',
      dialog: null,
      overlay: 'none',
      screen: 'round',
      eliminatedSheet: false,
      watchChoice: null,
      photo: { active: false },
      replay: null,
    } as unknown as Parameters<typeof menuOwnsPad>[0];
    expect(menuOwnsPad(base, false)).toBe(false);
    expect(menuOwnsPad({ ...base, eliminatedSheet: true }, false)).toBe(true);
    expect(menuOwnsPad({ ...base, overlay: 'spectatorRoster' }, false)).toBe(true);
  });
});

describe('free camera axes', () => {
  it('read the movement bindings, rise on E/Space, sink on Q and boost on Shift', () => {
    const axes = flyAxesFromKeys(new Set(['KeyW', 'KeyD', 'KeyE', 'ShiftLeft']), DEFAULT_KEYBINDS);
    expect(axes).toEqual({ x: 1, z: 1, y: 1, boost: true });
    expect(flyAxesFromKeys(new Set(['KeyQ', 'KeyS']), DEFAULT_KEYBINDS)).toMatchObject({ y: -1, z: -1 });
    expect(flyAxesFromKeys(new Set(['Space']), DEFAULT_KEYBINDS).y).toBe(1);
  });

  it('read the left stick with a deadzone and the triggers for height', () => {
    const value = (b: number): number => (b === 7 ? 0.6 : b === 6 ? 0.2 : b === 10 ? 1 : 0);
    const a = flyAxesFromPad([0.05, -0.05, 0, 0], value);
    expect(a.x).toBe(0);
    expect(a.z).toBe(0);
    expect(a.y).toBeCloseTo(0.4);
    expect(a.boost).toBe(true);
    expect(flyAxesFromPad([0, -1, 0, 0], () => 0).z).toBeCloseTo(1);
  });

  it('let the stronger device win so a resting stick never cancels a key', () => {
    const keys = { x: 0, y: 0, z: 1, boost: false };
    const pad = { x: 0.3, y: 0, z: 0, boost: true };
    expect(mergeFlyAxes(keys, pad)).toEqual({ x: 0.3, y: 0, z: 1, boost: true });
  });
});

describe('spectator roster', () => {
  const p = (id: number, over: Partial<RosterPlayer> = {}): RosterPlayer => ({
    id,
    name: `Player${id}`,
    color: '#ff4f9a',
    isBot: false,
    isLocal: false,
    isParty: false,
    isClub: false,
    team: -1,
    status: 'playing',
    place: id,
    ...over,
  });
  const players = [
    p(1, { name: 'Zoë' }),
    p(2, { status: 'eliminated' }),
    p(3, { isClub: true }),
    p(4, { isParty: true, name: 'Pal' }),
    p(5, { isLocal: true }),
    p(6, { status: 'qualified', isBot: true, name: 'Botty' }),
    p(7, { place: 0 }),
  ];
  const ctx = { streamerMode: false, pinnedId: null, followingId: 1 };

  it('orders pinned, party, club, then playing by place, qualified, eliminated; without the local player', () => {
    const rows = buildRoster(players, { ...ctx, pinnedId: 7 });
    expect(rows.map((r) => r.id)).toEqual([7, 4, 3, 1, 6, 2]);
    expect(rows.find((r) => r.id === 7)!.pinned).toBe(true);
    expect(rows.find((r) => r.id === 1)!.following).toBe(true);
  });

  it('searches by name without case or accents, or by place', () => {
    const rows = buildRoster(players, ctx);
    expect(searchRoster(rows, 'zoe').map((r) => r.id)).toEqual([1]);
    expect(
      searchRoster(rows, 'PLAYER')
        .map((r) => r.id)
        .sort(),
    ).toEqual([2, 3, 7]);
    expect(searchRoster(rows, '#2').map((r) => r.id)).toEqual([2]);
    expect(searchRoster(rows, '  ').length).toBe(rows.length);
  });

  it('masks strangers in Streamer Mode, and search never finds the hidden name', () => {
    const rows = buildRoster(players, { ...ctx, streamerMode: true });
    const zoe = rows.find((r) => r.id === 1)!;
    expect(zoe.name).not.toContain('Zo');
    expect(searchRoster(rows, 'zoe')).toEqual([]);
    // Party members and bots keep their names, as everywhere else in Streamer Mode.
    expect(rows.find((r) => r.id === 4)!.name).toBe('Pal');
    expect(rows.find((r) => r.id === 6)!.name).toBe('Botty');
  });

  it('starts on a party member, else a club member, else the leader', () => {
    const party = new Set([4]);
    const club = new Set([3]);
    expect(
      firstToWatch(
        [1, 3, 4],
        (id) => party.has(id),
        (id) => club.has(id),
      ),
    ).toBe(4);
    expect(
      firstToWatch(
        [1, 3],
        (id) => party.has(id),
        (id) => club.has(id),
      ),
    ).toBe(3);
    expect(
      firstToWatch(
        [1, 2],
        () => false,
        () => false,
      ),
    ).toBe(1);
    expect(
      firstToWatch(
        [],
        () => false,
        () => false,
      ),
    ).toBeUndefined();
  });
});
