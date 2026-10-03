/**
 * Pushes the local account's meta data (profile, locker, store, pass,
 * challenges, history, playlists, news, leaderboards, party) into the UI
 * while playing offline; `online/account.ts` does the same from the API.
 */
import { NEWS_POSTS } from '@tumble/content/news';
import { roundCatalog, DEV_ROUND_IDS } from '@tumble/content/rounds';
import { PLAYLISTS, getPlaylist } from '@tumble/content/shows';
import {
  ui,
  type LeaderboardId,
  type LeaderboardRow,
  type NewsItem,
  type Playlist,
  type ProfileData,
} from '@tumble/ui';
import { facedCard } from './facedCard.ts';
import { DEFAULT_PLAYLIST_ID, isNewcomer } from './playlists.ts';
import type { ProfileStore } from './profile.ts';
import { loadJson, saveJson } from './storage.ts';

const PLAYLIST_ART: Readonly<Record<string, { art: [string, string]; icon: string }>> = {
  'main-show': { art: ['#ff6fae', '#ffd23f'], icon: '🎪' },
  duos: { art: ['#5aa9ff', '#3ee6b4'], icon: '👯' },
  squads: { art: ['#8a5cff', '#ff9ad5'], icon: '🐙' },
  'chaos-mode': { art: ['#ff8a3d', '#ff4f9a'], icon: '🌪️' },
  ranked: { art: ['#ffd23f', '#ffb021'], icon: '🏅' },
};

/**
 * Playlists the menu offers. The First Show is never listed on its own: while
 * the player is a newcomer it replaces the Main Show card (same id, so the
 * selection survives), because that is what Play will actually start.
 *
 * @param showsPlayed - Finished shows, or null when unknown.
 */
export function uiPlaylists(showsPlayed: number | null = null): Playlist[] {
  const first = isNewcomer(showsPlayed) ? getPlaylist('first-show') : undefined;
  return PLAYLISTS.filter((p) => p.id !== 'first-show').map((p) => {
    const shown = first && p.id === DEFAULT_PLAYLIST_ID ? first : p;
    return {
      id: p.id,
      name: shown.name,
      description: shown.description,
      players: shown.maxPlayers,
      teamSize: (p.partySize === 2 ? 2 : p.partySize === 4 ? 4 : 1) as 1 | 2 | 4,
      art: PLAYLIST_ART[p.id]?.art ?? ['#ff6fae', '#ffd23f'],
      icon: shown === first ? '🌱' : (PLAYLIST_ART[p.id]?.icon ?? '🎪'),
      ...(p.ranked ? { ranked: true } : {}),
    };
  });
}

/** News post ids the player has opened on this device. */
function readNews(): Set<string> {
  return new Set(loadJson<string[]>('newsRead') ?? []);
}

/**
 * The news feed (`@tumble/content/news`) as UI items, with unread flags.
 *
 * @returns Posts, newest first.
 */
export function uiNews(): NewsItem[] {
  const read = readNews();
  return NEWS_POSTS.map((p) => ({
    id: p.id,
    title: p.title,
    body: p.summary,
    tag: p.tag,
    art: p.art,
    icon: p.icon,
    date: p.date,
    ...(p.image ? { image: p.image } : {}),
    blocks: p.body.map((b) => ({ ...b })),
    ...(p.featured ? { featured: true } : {}),
    ...(read.has(p.id) ? {} : { unread: true }),
  }));
}

/**
 * Marks posts read (persisted) and refreshes the feed and badges.
 *
 * @param ids - Post ids.
 */
export function markNewsRead(ids: readonly string[]): void {
  const read = readNews();
  for (const id of ids) read.add(id);
  saveJson('newsRead', [...read].slice(-300));
  ui.getState().setNews(uiNews());
}

/**
 * Refreshes every menu data slice from the profile.
 *
 * @param profile - Local profile.
 */
export function pushMeta(profile: ProfileStore): void {
  const s = ui.getState();
  s.setProfile(profile.uiProfile());
  s.setInventory(profile.uiInventory());
  s.setStoreData(profile.uiStore());
  s.setPass(profile.uiPass());
  s.setChallenges(profile.uiChallenges());
  s.setMatchHistory(profile.uiHistory());
  pushStaticMeta(profile.showsPlayed);
  const p = s.profile;
  if (p) {
    s.setParty({
      code: '',
      maxSize: 4,
      members: [{ id: p.id, name: p.name, colors: p.colors, ready: true, isLeader: true, isSelf: true }],
    });
  }
}

/**
 * News, playlists and the custom-lobby round catalog (the same online and offline).
 *
 * @param showsPlayed - Finished shows, for the First Show card; null when unknown.
 */
export function pushStaticMeta(showsPlayed: number | null = null): void {
  const s = ui.getState();
  s.setNews(uiNews());
  const cards = uiPlaylists(showsPlayed);
  if (s.playlists.length === 0) s.setPlaylists(cards, DEFAULT_PLAYLIST_ID);
  else if (JSON.stringify(cards) !== JSON.stringify(s.playlists)) s.setPlaylists(cards);
  if (s.roundCatalog.length === 0) {
    s.setRoundCatalog(
      [...roundCatalog().values()]
        .filter((r) => !DEV_ROUND_IDS.has(r.id))
        .map((r) => ({ id: r.id, name: r.name, type: r.type })),
    );
  }
}

/**
 * Answers a leaderboard query offline with the local Hall of Fame: you plus
 * every Tumbler you actually shared a show with on this device, ranked by
 * real results. Ranked boards stay empty offline (no invented rows).
 *
 * @param profile - Local profile.
 * @param board - Requested board.
 */
export function pushLeaderboard(profile: ProfileStore, board: LeaderboardId): void {
  const info = { scope: 'global' as const, source: 'local' as const, updatedAt: Date.now() };
  if (board === 'ranked') {
    ui.getState().setLeaderboard(board, [], info);
    return;
  }
  const me = profile.uiProfile();
  const history = profile.uiHistory();
  const weekAgo = Date.now() - 7 * 86400_000;
  const myValue =
    board === 'win_streak'
      ? me.stats.bestStreak
      : board === 'weekly'
        ? history.filter((h) => h.time >= weekAgo && h.result === 'crown').length
        : me.crowns;
  const rows: Omit<LeaderboardRow, 'rank'>[] = [
    {
      playerId: me.id,
      name: me.name,
      value: myValue,
      colors: me.colors,
      isSelf: true,
      detail: `${me.stats.shows} shows · ${me.stats.finals} finals`,
    },
  ];
  if (board !== 'win_streak') {
    for (const [name, o] of Object.entries(profile.opponents())) {
      if (board === 'weekly' && o.lastSeen < weekAgo) continue;
      rows.push({
        playerId: `faced:${name}`,
        name,
        value: o.crowns,
        colors: o.colors,
        ...(o.isBot ? { isBot: true } : {}),
        detail: `Faced ${o.faced}× · best finish #${o.best}`,
      });
    }
  }
  rows.sort((a, b) => b.value - a.value || (a.isSelf ? -1 : b.isSelf ? 1 : a.name.localeCompare(b.name)));
  ui.getState().setLeaderboard(
    board,
    rows.slice(0, 100).map((r, i) => ({ ...r, rank: i + 1 })),
    info,
  );
}

/**
 * Profile card for a Hall of Fame row (yourself or a Tumbler you faced).
 *
 * @param profile - Local profile.
 * @param playerId - Row id.
 * @returns The card, or null when unknown.
 */
export function localPlayerCard(profile: ProfileStore, playerId: string): ProfileData | null {
  const me = profile.uiProfile();
  if (playerId === me.id) return me;
  const name = playerId.replace(/^faced:/, '');
  const o = profile.opponents()[name];
  return o ? facedCard(playerId, name, o) : null;
}
