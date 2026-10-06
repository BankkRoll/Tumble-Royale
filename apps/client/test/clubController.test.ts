/**
 * The club controller: API answers into the club store, the Club chat tab
 * and history, realtime events (chat, invites, removals), switched-off clubs
 * and the chat transport choice.
 */
import { clubs, social, ui } from '@tumble/ui';
import { DEFAULT_CLUB_EMBLEM } from '@tumble/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, type ApiClient, type ApiMyClub } from '../src/game/api.ts';
import type { TypedMessage } from '../src/game/online/jsonSocket.ts';
import { ClubController, clubFromApi } from '../src/game/social/clubController.ts';

const ME = 'u-me';
const card = {
  id: 'c-1',
  name: 'Wobble Crew',
  tag: 'WOB',
  description: '',
  emblem: DEFAULT_CLUB_EMBLEM,
  joinMode: 'open' as const,
  memberCount: 2,
  maxMembers: 50,
};
const mine: ApiMyClub = {
  club: {
    ...card,
    members: [
      { userId: ME, displayName: 'Me', tag: '0001', level: 3, role: 'owner', presence: 'offline' },
      { userId: 'u-pal', displayName: 'Pal', tag: '0002', level: 4, role: 'member', presence: 'in_match' },
    ],
  },
  role: 'owner',
  joinRequests: [
    { userId: 'u-ask', displayName: 'Asker', tag: '0003', level: 1, at: '2026-10-01T00:00:00.000Z' },
  ],
  invites: [],
  requests: [],
};

function fakeRealtime(connected = true) {
  const handlers = new Map<string, ((m: TypedMessage) => void)[]>();
  const sent: TypedMessage[] = [];
  return {
    connected,
    sent,
    on(type: string, fn: (m: TypedMessage) => void) {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
      return () => undefined;
    },
    send(m: TypedMessage) {
      sent.push(m);
    },
    emit(type: string, m: Record<string, unknown>) {
      for (const fn of handlers.get(type) ?? []) fn({ type, ...m });
    },
  };
}

function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    myClub: async () => mine,
    clubChatHistory: async () => ({
      clubId: 'c-1',
      lines: [
        {
          id: '7',
          clubId: 'c-1',
          from: { userId: 'u-pal', name: 'Pal', tag: '0002' },
          text: 'earlier',
          at: 1,
        },
      ],
    }),
    recommendedClubs: async () => ({ clubs: [card] }),
    ...over,
  } as unknown as ApiClient;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const host = { userId: () => ME, applyParty: () => undefined, notify: () => undefined };

beforeEach(() => {
  clubs.getState().reset();
  social.getState().dispatchChat({ type: 'club', on: false });
  social.getState().dispatchChat({ type: 'clear', target: 'club' });
  ui.getState().setNotifications([]);
});

describe('club mapping', () => {
  it('maps the roster with presence, marks the player and keeps requests', () => {
    const v = clubFromApi(mine, ME);
    expect(v.club!.members.map((m) => [m.userId, m.isSelf, m.presence])).toEqual([
      [ME, true, 'inMenu'],
      ['u-pal', false, 'inShow'],
    ]);
    expect(v.joinRequests[0]).toMatchObject({ userId: 'u-ask', name: 'Asker' });
  });
});

describe('club controller', () => {
  it('loads the club, turns on the Club tab and replays the history once', async () => {
    const rt = fakeRealtime();
    let historyCalls = 0;
    const c = new ClubController(
      fakeApi({
        clubChatHistory: async () => {
          historyCalls++;
          return {
            clubId: 'c-1',
            lines: [
              {
                id: '7',
                clubId: 'c-1',
                from: { userId: 'u-pal', name: 'Pal', tag: '0002' },
                text: 'earlier',
                at: 1,
              },
            ],
          };
        },
      }),
      rt,
      host,
    );
    c.bind();
    await c.refresh();
    await flush();
    expect(clubs.getState()).toMatchObject({ status: 'ready', role: 'owner' });
    expect(social.getState().chat.club).toBe(true);
    const lines = social.getState().chat.lines.filter((l) => l.channel === 'club');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.from.club).toBe('WOB');
    await c.refresh();
    await flush();
    expect(historyCalls).toBe(1);

    rt.emit('club_chat', {
      id: '8',
      clubId: 'c-1',
      from: { userId: ME, name: 'Me', tag: '0001', club: 'WOB' },
      text: 'hi',
      at: 2,
    });
    rt.emit('club_chat', {
      id: '9',
      clubId: 'other',
      from: { userId: 'x', name: 'X', tag: '0003' },
      text: 'nope',
      at: 3,
    });
    const after = social.getState().chat.lines.filter((l) => l.channel === 'club');
    expect(after.map((l) => l.text)).toEqual(['earlier', 'hi']);
    expect(after[1]!.self).toBe(true);
  });

  it('sends club chat over the gateway when connected, else over HTTP', async () => {
    const rt = fakeRealtime(true);
    const posted: string[] = [];
    const api = fakeApi({
      clubChat: async (text: string) => {
        posted.push(text);
        return {
          message: { id: '1', clubId: 'c-1', from: { userId: ME, name: 'Me', tag: '0001' }, text, at: 1 },
        };
      },
    });
    const c = new ClubController(api, rt, host);
    await c.refresh();
    c.chat('  hello  ');
    expect(rt.sent).toEqual([{ type: 'club_chat', text: 'hello' }]);
    const offline = new ClubController(api, fakeRealtime(false), host);
    offline.chat('via http');
    await flush();
    expect(posted).toEqual(['via http']);
  });

  it('drops club chat history that lands after the player left the club', async () => {
    let release!: () => void;
    let api = mine;
    const line = { id: '7', clubId: 'c-1', from: { userId: 'u-pal', name: 'Pal', tag: '0002' }, text: 'old', at: 1 };
    const c = new ClubController(
      fakeApi({
        myClub: async () => api,
        clubChatHistory: () => new Promise((r) => (release = () => r({ clubId: 'c-1', lines: [line] }))),
      }),
      fakeRealtime(),
      host,
    );
    await c.refresh();
    api = { club: null, role: null, invites: [], requests: [] };
    await c.refresh();
    release();
    await flush();
    expect(social.getState().chat.lines.filter((l) => l.channel === 'club')).toEqual([]);
  });

  it('shows clubs switched off rather than an error', async () => {
    const c = new ClubController(
      fakeApi({
        myClub: async () => {
          throw new ApiError(503, 'feature_disabled', 'Clubs are switched off right now');
        },
      }),
      fakeRealtime(),
      host,
    );
    await c.refresh();
    expect(clubs.getState().status).toBe('disabled');
    expect(social.getState().chat.club).toBe(false);
  });

  it('turns an invite into a notification with Join and a removal into a reset', async () => {
    const rt = fakeRealtime();
    const notes: unknown[] = [];
    let api = mine;
    const c = new ClubController(fakeApi({ myClub: async () => api }), rt, {
      ...host,
      notify: (...a) => void notes.push(a),
    });
    c.bind();
    await c.refresh();
    rt.emit('club_invite', { clubId: 'c-2', name: 'Other Club', tag: 'OTH', from: { name: 'Pal' } });
    expect(notes).toEqual([
      ['invite', 'Pal invited you to Other Club [OTH]', undefined, { kind: 'clubInvite', clubId: 'c-2' }],
    ]);
    api = { club: null, role: null, invites: [], requests: [] };
    rt.emit('club_removed', { clubId: 'c-1', name: 'Wobble Crew', reason: 'kicked' });
    await flush();
    expect(clubs.getState().club).toBeNull();
    expect(social.getState().chat.club).toBe(false);
    expect(ui.getState().toasts.some((t) => t.title === 'You were removed from Wobble Crew')).toBe(true);
  });
});
