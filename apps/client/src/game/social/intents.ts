/**
 * UI social intents → the online account (friends, requests, blocking,
 * reports, party chat, joins) and local mutes.
 *
 * Offline, mutes still work (they are local); every account action tells the
 * player once that it needs the online servers instead of failing silently.
 */
import { social, ui, type UIHandlers } from '@tumble/ui';
import type { OnlineAccount } from '../online/account.ts';
import { loadJson, saveJson } from '../storage.ts';
import { toggleMute } from './chatLogic.ts';

/** Loads the persisted mute list into the social store. */
export function loadMutes(): void {
  const saved = loadJson<unknown>('mutes');
  social
    .getState()
    .setMuted(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string') : []);
}

/**
 * Tells the friends sheet whether the account servers are reachable.
 *
 * @param online - Account loaded and realtime started.
 */
export function publishSocialAvailability(online: boolean): void {
  social.getState().setAvailability(online ? 'online' : 'offline');
}

function needsOnline(): void {
  ui.getState().pushToast({
    kind: 'info',
    title: 'That needs the online servers',
    body: 'Open Friends to retry the connection.',
    icon: '👥',
  });
}

/**
 * Intent handlers for `bindUI`.
 *
 * @param account - The signed-in account, or null while offline.
 * @example
 * bindUI({ ...socialIntents(() => account), onPlay });
 */
export function socialIntents(account: () => OnlineAccount | null): UIHandlers {
  const withAccount =
    <T>(fn: (a: OnlineAccount, p: T) => void) =>
    (p: T): void => {
      const a = account();
      if (a) fn(a, p);
      else needsOnline();
    };
  return {
    onMutePlayer: ({ key, name, muted }) => {
      const next = toggleMute(social.getState().muted, key, muted);
      social.getState().setMuted(next);
      saveJson('mutes', next);
      ui.getState().pushToast({
        kind: 'info',
        title: muted ? `${name} muted` : `${name} unmuted`,
        ...(muted ? { body: 'Their chat and pings are hidden.' } : {}),
      });
    },
    onRequestFriend: withAccount((a, { userId }) => void a.social.request({ userId })),
    onFriendRequestAction: withAccount((a, { userId, action }) => void a.answerFriendRequest(userId, action)),
    onSearchPlayers: withAccount((a, { query }) => void a.social.search(query)),
    onRemoveFriend: withAccount((a, { userId }) => void a.social.remove(userId)),
    onBlockPlayer: withAccount((a, { userId, name }) => void a.social.block(userId, name)),
    onUnblockPlayer: withAccount((a, { userId }) => void a.social.unblock(userId)),
    onReportPlayer: withAccount(
      (a, { userId, reason, details }) => void a.social.report(userId, reason, details),
    ),
    onJoinFriend: withAccount((a, { userId }) => void a.joinFriend(userId)),
    onPartyInviteAction: withAccount(
      (a, { userId, code, action }) => void a.answerPartyInvite(userId, code, action),
    ),
  };
}
