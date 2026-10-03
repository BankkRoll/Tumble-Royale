/**
 * The notification bell while offline. Online, the account's realtime
 * gateway feeds it; offline nothing did, so the bell was always empty. This
 * derives notices from the local profile (pass tier reached with rewards to
 * claim, challenge completed, level up, new season, first-Crown Gem bonus,
 * new Crown Shard shelf), dedupes them by stable id and persists them with
 * their read flags per device.
 *
 * Every local id starts with `local:` so online notifications in the same
 * list are never written to this device's inbox.
 */
import { GEM_EARN, levelMilestoneGems, utcWeekKey } from '@tumble/content/progression';
import { ui, type NotificationItem } from '@tumble/ui';
import type { ProfileStore } from './profile.ts';
import { loadJson, saveJson } from './storage.ts';

/** Most local notifications kept. */
const MAX_LOCAL = 30;

const PREFIX = 'local:';

/** A notice derived from profile state; `time` is used only the first time it is seen. */
type Notice = Omit<NotificationItem, 'read'>;

/**
 * Everything the profile currently has to say. Ids are stable for the event
 * they describe, so deriving again never duplicates.
 *
 * @param profile - Local profile.
 * @returns Notices, in no particular order.
 */
export function deriveNotices(profile: ProfileStore): Notice[] {
  if (!profile.exists) return [];
  const now = profile.now();
  const out: Notice[] = [];
  const me = profile.uiProfile();
  const pass = profile.uiPass();

  const last = profile.seasonHistory().at(-1);
  if (last) {
    out.push({
      id: `${PREFIX}season:${last.seasonId}:ended`,
      kind: 'news',
      title: `${pass.seasonName} has begun`,
      body:
        last.autoGranted > 0
          ? `${last.autoGranted} unclaimed ${last.name} rewards were added to your locker.`
          : 'A fresh Season Pass is waiting.',
      time: last.endedAt,
    });
  }

  const claimable = pass.tiers.filter(
    (t) =>
      t.tier <= pass.currentTier &&
      ((t.free && !t.free.claimed) || (pass.premium && t.premium && !t.premium.claimed)),
  ).length;
  if (claimable > 0 && pass.currentTier > 0) {
    out.push({
      id: `${PREFIX}pass:s${pass.seasonNumber}:tier:${pass.currentTier}`,
      kind: 'reward',
      title: `Season Pass tier ${pass.currentTier} reached`,
      body: `${claimable} ${claimable === 1 ? 'reward' : 'rewards'} ready to claim.`,
      time: now,
    });
  }

  const board = profile.uiChallenges();
  for (const c of board.list) {
    if (c.claimed || c.progress < c.goal) continue;
    const period = c.cadence === 'daily' ? board.dailyResetsAt : board.weeklyResetsAt;
    out.push({
      id: `${PREFIX}challenge:${c.cadence}:${period}:${c.id}`,
      kind: 'reward',
      title: 'Challenge complete!',
      body: `${c.title} — claim it on the Challenges tab.`,
      time: now,
    });
  }

  if (me.level >= 2) {
    const gems = levelMilestoneGems(me.level);
    out.push({
      id: `${PREFIX}level:${me.level}`,
      kind: 'reward',
      title: `Level ${me.level}!`,
      ...(gems > 0 ? { body: `Milestone bonus: +${gems} Gems.` } : {}),
      time: now,
    });
  }

  const crownDay = profile.lastCrownDay;
  if (crownDay && GEM_EARN.firstCrownOfDay > 0) {
    out.push({
      id: `${PREFIX}crown-gems:${crownDay}`,
      kind: 'reward',
      title: `+${GEM_EARN.firstCrownOfDay} Gems`,
      body: 'First Crown of the day bonus.',
      time: now,
    });
  }

  // Only once the player has played: a brand-new Tumbler has enough to read.
  if (me.stats.shows > 0) {
    const shelf = profile.uiShardShop();
    if (shelf.offers.length > 0) {
      out.push({
        id: `${PREFIX}shards:${utcWeekKey(new Date(now))}`,
        kind: 'news',
        title: 'New Crown Shard shelf',
        body: shelf.offers.map((o) => o.item.name).join(', '),
        time: now,
      });
    }
  }
  return out;
}

function savedInbox(): NotificationItem[] {
  const s = loadJson<{ items?: NotificationItem[] }>('notifications');
  return Array.isArray(s?.items)
    ? s.items.filter((n) => typeof n?.id === 'string' && n.id.startsWith(PREFIX))
    : [];
}

function persist(list: readonly NotificationItem[]): void {
  saveJson('notifications', { items: list.filter((n) => n.id.startsWith(PREFIX)).slice(0, MAX_LOCAL) });
}

let watching = false;

/** Persists read flags when the bell marks local notifications read. */
function watchReadFlags(): void {
  if (watching) return;
  watching = true;
  ui.subscribe((s, prev) => {
    if (s.notifications !== prev.notifications && s.notifications.some((n) => n.id.startsWith(PREFIX)))
      persist(s.notifications);
  });
}

/**
 * Merges the profile's notices into the bell: new ones arrive unread, known
 * ones keep their first-seen time and read flag, online items already in the
 * list are left alone.
 *
 * @param profile - Local profile.
 * @returns The bell's new list.
 */
export function syncLocalNotifications(profile: ProfileStore): NotificationItem[] {
  watchReadFlags();
  const current = ui.getState().notifications;
  const known = new Map<string, NotificationItem>();
  for (const n of savedInbox()) known.set(n.id, n);
  for (const n of current) if (n.id.startsWith(PREFIX)) known.set(n.id, { ...known.get(n.id), ...n });
  for (const n of deriveNotices(profile)) if (!known.has(n.id)) known.set(n.id, { ...n, read: false });
  const local = [...known.values()].sort((a, b) => b.time - a.time).slice(0, MAX_LOCAL);
  const online = current.filter((n) => !n.id.startsWith(PREFIX));
  const list = [...online, ...local].sort((a, b) => b.time - a.time);
  persist(local);
  ui.getState().setNotifications(list);
  return list;
}
