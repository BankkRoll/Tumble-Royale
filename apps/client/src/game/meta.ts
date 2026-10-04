/**
 * Pushes the local account's meta data (profile, locker, store, pass,
 * challenges, collection log, history, playlists, news, leaderboards, party) into the UI
 * while playing offline; `online/account.ts` does the same from the API.
 */
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
import { uiCollection } from './cosmetics.ts';
import { facedCard } from './facedCard.ts';
import { offlineEvents } from './liveEvents.ts';
import { DEFAULT_PLAYLIST_ID, isNewcomer } from './playlists.ts';
import { currentNews, refreshLiveNews } from './liveNews.ts';
import { activeSchedule, scheduledCard, type ScheduleCache } from './liveOps/schedule.ts';
import { syncLocalNotifications } from './localNotifications.ts';
import type { ProfileStore } from './profile.ts';
import { loadJson, saveJson } from './storage.ts';

/**
 * Fetches the live news feed and refreshes the News tab when it arrives.
 *
 * @param fetchNews - `ApiClient.news`.
 */
export async function pushLiveNews(
  fetchNews: () => Promise<{ posts: unknown[]; withdrawn?: unknown[] }>,
): Promise<void> {
  if (await refreshLiveNews(fetchNews)) ui.getState().setNews(uiNews());
}

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
 * Scheduled playlists appear only while live (with an "Ends in" time when
 * they close), or ahead of time as "Coming soon" when featured; ended and
 * withdrawn ones are left out (see `liveOps/schedule.ts`).
 *
 * @param showsPlayed - Finished shows, or null when unknown.
 * @param schedule - The API's schedules (null: the bundled ones).
 * @param now - Device clock.
 */
export function uiPlaylists(
  showsPlayed: number | null = null,
  schedule: ScheduleCache | null = activeSchedule(),
  now: number = Date.now(),
): Playlist[] {
  const first = isNewcomer(showsPlayed) ? getPlaylist('first-show') : undefined;
  return PLAYLISTS.filter((p) => p.id !== 'first-show').flatMap((p): Playlist[] => {
    const when = scheduledCard(p, p.id, schedule, now);
    const comingSoon = when.phase === 'upcoming' && when.featured;
    if (when.phase !== 'live' && !comingSoon) return [];
    const shown = first && p.id === DEFAULT_PLAYLIST_ID ? first : p;
    return [
      {
        id: p.id,
        name: shown.name,
        description: shown.description,
        players: shown.maxPlayers,
        teamSize: (p.partySize === 2 ? 2 : p.partySize === 4 ? 4 : 1) as 1 | 2 | 4,
        art: PLAYLIST_ART[p.id]?.art ?? ['#ff6fae', '#ffd23f'],
        icon: shown === first ? '🌱' : (PLAYLIST_ART[p.id]?.icon ?? '🎪'),
        ...(p.ranked ? { ranked: true } : {}),
        ...(comingSoon
          ? { comingSoon: true, ...(when.startsAt !== null ? { startsAt: when.startsAt } : {}) }
          : {}),
        ...(!comingSoon && when.endsAt !== null ? { endsAt: when.endsAt } : {}),
      },
    ];
  });
}

/** News post ids the player has opened on this device. */
function readNews(): Set<string> {
  return new Set(loadJson<string[]>('newsRead') ?? []);
}

/**
 * The news feed as UI items, with unread flags: the bundled posts
 * (`@tumble/content/news`) with the last live feed from the API merged over
 * them (see `liveNews.ts`).
 *
 * @returns Posts, newest first.
 */
export function uiNews(): NewsItem[] {
  const read = readNews();
  return currentNews().map((p) => ({
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
  // Achievements and the login streak are server-authoritative: offline has neither.
  s.setAchievements(null);
  s.setLoginStreak(null);
  s.setCollection(uiCollection((id) => profile.owns(id)));
  s.setEvents(offlineEvents((id) => profile.owns(id), Date.now()));
  s.setMatchHistory(profile.uiHistory());
  syncLocalNotifications(profile);
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
 * Re-offers the playlists (a schedule changed or a window opened or closed).
 * Only touches the store when the cards differ, so it is cheap to call often.
 *
 * @param showsPlayed - Finished shows, for the First Show card; null when unknown.
 */
export function pushPlaylists(showsPlayed: number | null = null): void {
  const s = ui.getState();
  const cards = uiPlaylists(showsPlayed);
  if (s.playlists.length === 0) s.setPlaylists(cards, DEFAULT_PLAYLIST_ID);
  else if (JSON.stringify(cards) !== JSON.stringify(s.playlists)) s.setPlaylists(cards);
}

/**
 * News, playlists and the custom-lobby round catalog (the same online and offline).
 *
 * @param showsPlayed - Finished shows, for the First Show card; null when unknown.
 */
export function pushStaticMeta(showsPlayed: number | null = null): void {
  const s = ui.getState();
  s.setNews(uiNews());
  pushPlaylists(showsPlayed);
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
