/**
 * The preview's single mock "world": one roster, one locker, one show recap,
 * plus helpers to push meta data into the UI store and reset transient state.
 */
import { hashString, MAX_PLAYERS } from '@tumble/shared';
import { ui, type ShowSummary } from '@tumble/ui';
import { uiCollection } from '../game/cosmetics.ts';
import { uiNews } from '../game/meta.ts';
import {
  NEWS,
  NOTIFICATIONS,
  PLAYLISTS,
  ROUND_CATALOG,
  makeAchievements,
  makeChallenges,
  makeFriends,
  makeHistory,
  makeInventory,
  makeItems,
  makeLeaderboard,
  makeLoginStreak,
  makeParty,
  makePass,
  makePlayers,
  makeProfile,
  makeShowSummary,
  makeStore,
} from './mocks.ts';

/** Mutable mock world shared by presets, the mock game and auto-play. */
export const world = {
  players: makePlayers(MAX_PLAYERS),
  items: makeItems(),
  /** Recap where the local player wins. */
  winSummary: null as unknown as ShowSummary,
  /** Recap where the local player is eliminated in round 2. */
  loseSummary: null as unknown as ShowSummary,
};
world.winSummary = makeShowSummary(world.players, -1);
world.loseSummary = makeShowSummary(world.players, 1);

/** Loads profile, locker, store, pass, social, etc. into the store. */
export function seedMeta(): void {
  const s = ui.getState();
  s.setProfile(makeProfile(world.items));
  s.setInventory(makeInventory(world.items));
  s.setStoreData(makeStore(world.items));
  s.setPass(makePass(world.items));
  s.setChallenges(makeChallenges());
  s.setLoginStreak(makeLoginStreak());
  s.setAchievements(makeAchievements(world.items));
  s.setCollection(uiCollection((id) => (hashString(id) >>> 0) % 3 === 0));
  s.setLeaderboard('crowns', makeLeaderboard(21, 1));
  s.setLeaderboard('ranked', makeLeaderboard(22, 4));
  s.setLeaderboard('weekly', makeLeaderboard(23, 0.2));
  s.setLeaderboard('crowns_all_time', makeLeaderboard(25, 3));
  s.setLeaderboard('win_streak', makeLeaderboard(26, 0.05));
  for (const b of ['crowns', 'ranked', 'weekly', 'crowns_all_time', 'win_streak'] as const)
    ui.setState((st) => ({
      leaderboardInfo: {
        ...st.leaderboardInfo,
        [b]: { scope: 'global', source: 'api', updatedAt: Date.now() },
      },
    }));
  s.setOnlineStatus({ state: 'online', playersOnline: 1284 });
  ui.setState({ playMode: 'online' });
  s.setLeaderboard(
    'friends',
    makeLeaderboard(24, 0.1)
      .slice(0, 8)
      .concat(
        makeLeaderboard(24, 0.1)
          .filter((r) => r.isSelf)
          .map((r) => ({ ...r, rank: 9 })),
      ),
  );
  s.setMatchHistory(makeHistory());
  // The real feed from @tumble/content/news (falls back to the mock list if it is empty).
  const news = uiNews();
  s.setNews(news.length > 0 ? news : NEWS);
  s.setFriends(makeFriends());
  s.setParty(makeParty(world.players));
  s.setPlaylists(PLAYLISTS, 'main');
  s.setNotifications(NOTIFICATIONS);
  s.setRoundCatalog(ROUND_CATALOG);
}

/** Clears stamps, sheets, dialogs and other transient UI between presets. */
export function resetTransient(): void {
  const s = ui.getState();
  s.clearStamps();
  s.setCountdown(null);
  s.setEliminatedSheet(false);
  s.setSpectate(null);
  s.setEmoteWheel(false);
  s.setOverlay('none');
  s.closeDialog();
  s.setConnection({ status: 'online' });
  s.setCaption(null);
  s.setQueue({ status: 'idle', playersFound: 0 });
  for (const t of s.toasts) s.dismissToast(t.id);
}
