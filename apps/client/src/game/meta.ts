/**
 * Pushes the local account's meta data (profile, locker, store, pass,
 * challenges, history, playlists, news, leaderboards, party) into the UI.
 */
import { roundCatalog, DEV_ROUND_IDS } from '@tumble/content/rounds';
import { PLAYLISTS, getPlaylist } from '@tumble/content/shows';
import type { ShowPlaylist } from '@tumble/sim/show';
import { ui, type LeaderboardId, type NewsItem, type Playlist } from '@tumble/ui';
import type { ProfileStore } from './profile.ts';

const PLAYLIST_ART: Readonly<Record<string, { art: [string, string]; icon: string }>> = {
  'main-show': { art: ['#ff6fae', '#ffd23f'], icon: '🎪' },
  duos: { art: ['#5aa9ff', '#3ee6b4'], icon: '👯' },
  squads: { art: ['#8a5cff', '#ff9ad5'], icon: '🐙' },
  'chaos-mode': { art: ['#ff8a3d', '#ff4f9a'], icon: '🌪️' },
  ranked: { art: ['#ffd23f', '#ffb021'], icon: '🏅' },
};

/** Playlists the menu offers (the gentle first show is picked automatically). */
export function uiPlaylists(): Playlist[] {
  return PLAYLISTS.filter((p) => p.id !== 'first-show').map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    players: p.maxPlayers,
    teamSize: (p.partySize === 2 ? 2 : p.partySize === 4 ? 4 : 1) as 1 | 2 | 4,
    art: PLAYLIST_ART[p.id]?.art ?? ['#ff6fae', '#ffd23f'],
    icon: PLAYLIST_ART[p.id]?.icon ?? '🎪',
    ...(p.ranked ? { ranked: true } : {}),
  }));
}

/**
 * Resolves the playlist for an offline show.
 *
 * @param requested - Menu selection or `?playlist=`.
 * @param firstShow - The player has never finished a show.
 */
export function resolvePlaylist(requested: string | null, firstShow: boolean): ShowPlaylist {
  if (firstShow && !requested) return getPlaylist('first-show') ?? (getPlaylist('main-show') as ShowPlaylist);
  const p = requested ? getPlaylist(requested) : undefined;
  // Ranked needs real opponents; offline it plays as the Main Show.
  if (!p || p.ranked) return getPlaylist('main-show') as ShowPlaylist;
  return p;
}

const NEWS: NewsItem[] = [
  {
    id: 'season-1',
    title: 'Season 1: Sugar Rush',
    body: '100 tiers of sweet loot, a Crown with your name on it and a sky full of wobbly obstacles.',
    tag: 'SEASON',
    art: ['#ff9ad5', '#ffd23f'],
    icon: '🍭',
  },
  {
    id: 'tips',
    title: 'Pro tip: dive!',
    body: 'Jump, then dive at the top of the arc to cover the most ground. Chain it and you will fly.',
    tag: 'TIPS',
    art: ['#8cc6ff', '#c7b8ff'],
    icon: '🤿',
  },
];

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
  s.setNews(NEWS);
  if (s.playlists.length === 0) s.setPlaylists(uiPlaylists(), 'main-show');
  const p = s.profile;
  if (p) {
    s.setParty({ code: 'SOLO', maxSize: 4, members: [{ id: p.id, name: p.name, colors: p.colors, ready: true, isLeader: true, isSelf: true }] });
  }
  s.setRoundCatalog([...roundCatalog().values()].filter((r) => !DEV_ROUND_IDS.has(r.id)).map((r) => ({ id: r.id, name: r.name, type: r.type })));
}

/**
 * Answers a leaderboard query offline: only your own row is known locally.
 *
 * @param profile - Local profile.
 * @param board - Requested board.
 */
export function pushLeaderboard(profile: ProfileStore, board: LeaderboardId): void {
  const p = profile.uiProfile();
  const value = board === 'ranked' ? 0 : p.crowns;
  ui.getState().setLeaderboard(board, [{ rank: 1, playerId: p.id, name: p.name, value, colors: p.colors, isSelf: true }]);
}
