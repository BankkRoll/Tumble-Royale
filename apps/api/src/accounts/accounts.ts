/**
 * Account lifecycle: creation with starter items, identity lookup/linking,
 * display name changes and the public profile card.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { starterItems, type Catalog } from '../catalog.ts';
import type { DbOrTx } from '../db/client.ts';
import {
  authIdentities,
  inventoryItems,
  loadouts,
  nameHistory,
  playerStats,
  profiles,
  ratings,
  users,
} from '../db/schema.ts';
import { ApiError, badRequest, notFound } from '../http/errors.ts';
import type { TierInfo } from '../ranked/tiers.ts';
import { checkDisplayName, generateGuestName, randomTag } from '../names/display-name.ts';

/** Identity providers. `device` is the guest device secret. */
export type IdentityProvider = 'device' | 'discord' | 'google' | 'github' | 'twitch' | 'apple' | 'email';

/** Regions accepted for accounts and matchmaking. */
export const REGIONS = ['na', 'eu', 'asia', 'sa', 'oce'] as const;
/** A region id. */
export type Region = (typeof REGIONS)[number];

/** A region from untrusted input: trimmed, case-insensitive, one of {@link REGIONS}. */
export const RegionSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.enum(REGIONS),
);

/**
 * The account's current region. Access tokens carry the region they were
 * minted with, which goes stale after `PATCH /me` until the next refresh.
 *
 * @throws {ApiError} 404 when the user does not exist.
 */
export async function accountRegion(db: DbOrTx, userId: string): Promise<Region> {
  const [row] = await db.select({ region: users.region }).from(users).where(eq(users.id, userId));
  if (!row) throw notFound('User');
  return row.region as Region;
}

/** Minimal account identity used to mint tokens. */
export interface AccountRef {
  userId: string;
  displayName: string;
  tag: string;
  region: string;
  isGuest: boolean;
}

async function pickFreeTag(tx: DbOrTx, name: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const tag = randomTag();
    const [taken] = await tx
      .select({ id: profiles.userId })
      .from(profiles)
      .where(and(sql`lower(${profiles.displayName}) = lower(${name})`, eq(profiles.tag, tag)));
    if (!taken) return tag;
  }
  throw new ApiError(409, 'name_exhausted', 'That name is too popular right now; try another');
}

/**
 * Creates a user with profile, stats, starter cosmetics and a default loadout.
 *
 * @param tx - Open transaction.
 * @param catalog - Content catalog (starter items).
 * @param opts - Guest flag, optional email/region/name and the first identity.
 */
export async function createAccount(
  tx: DbOrTx,
  catalog: Catalog,
  opts: {
    isGuest: boolean;
    email?: string | null;
    region?: string;
    displayName?: string;
    identity: { provider: IdentityProvider; subject: string };
  },
): Promise<AccountRef> {
  const region = REGIONS.includes(opts.region as Region) ? (opts.region as Region) : 'na';
  const [user] = await tx
    .insert(users)
    .values({ isGuest: opts.isGuest, email: opts.email ?? null, region })
    .returning({ id: users.id });
  if (!user) throw new Error('user insert returned nothing');
  let name = generateGuestName();
  if (opts.displayName) {
    const check = checkDisplayName(opts.displayName);
    if (check.ok) name = check.name;
  }
  const tag = await pickFreeTag(tx, name);
  await tx.insert(profiles).values({ userId: user.id, displayName: name, tag });
  await tx.insert(playerStats).values({ userId: user.id });
  await tx.insert(authIdentities).values({ userId: user.id, ...opts.identity });
  const starters = starterItems(catalog);
  if (starters.length) {
    await tx
      .insert(inventoryItems)
      .values(starters.map((id) => ({ userId: user.id, cosmeticId: id, source: 'default' })));
  }
  await tx
    .insert(loadouts)
    .values({ userId: user.id, slotIndex: 0, name: 'Loadout 1', items: catalog.defaultLoadout() });
  return { userId: user.id, displayName: name, tag, region, isGuest: opts.isGuest };
}

/**
 * Loads the token-minting view of an account.
 *
 * @throws {ApiError} 404 when the user does not exist.
 */
export async function getAccountRef(db: DbOrTx, userId: string): Promise<AccountRef> {
  const [row] = await db
    .select({
      userId: users.id,
      displayName: profiles.displayName,
      tag: profiles.tag,
      region: users.region,
      isGuest: users.isGuest,
    })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(eq(users.id, userId));
  if (!row) throw notFound('User');
  return row;
}

/** Finds the user owning an external identity, if any. */
export async function findIdentity(
  db: DbOrTx,
  provider: IdentityProvider,
  subject: string,
): Promise<string | null> {
  const [row] = await db
    .select({ userId: authIdentities.userId })
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, provider), eq(authIdentities.subject, subject)));
  return row?.userId ?? null;
}

/**
 * Links an identity to an existing user (guest upgrade). A guest that gains a
 * non-device identity stops being a guest.
 *
 * @throws {ApiError} 409 `identity_in_use` when another account owns it.
 */
export async function linkIdentity(
  tx: DbOrTx,
  userId: string,
  provider: IdentityProvider,
  subject: string,
  email?: string | null,
): Promise<void> {
  const owner = await findIdentity(tx, provider, subject);
  if (owner && owner !== userId)
    throw new ApiError(409, 'identity_in_use', `That ${provider} account is linked to another player`);
  if (!owner) await tx.insert(authIdentities).values({ userId, provider, subject });
  if (provider !== 'device') {
    const patch: { isGuest: boolean; email?: string } = { isGuest: false };
    email = email?.toLowerCase();
    if (email) {
      const [clash] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (!clash || clash.id === userId) patch.email = email;
    }
    await tx.update(users).set(patch).where(eq(users.id, userId));
  }
}

/**
 * Renames a player, enforcing name rules and the change cooldown. A guest's
 * first rename (from the generated name) is free. The previous name goes to
 * `name_history`.
 *
 * @param changedBy - Who asked: the player, or staff (who pass a 0 cooldown).
 * @throws {ApiError} 400 `invalid_name`, 429 `name_cooldown`.
 */
export async function changeDisplayName(
  tx: DbOrTx,
  userId: string,
  requested: string,
  now: Date,
  cooldownDays: number,
  changedBy: 'player' | 'staff' = 'player',
): Promise<{ displayName: string; tag: string }> {
  const check = checkDisplayName(requested);
  if (!check.ok) throw badRequest('invalid_name', `Name rejected: ${check.reason}`, { reason: check.reason });
  const [p] = await tx
    .select({ name: profiles.displayName, tag: profiles.tag, changedAt: profiles.nameChangedAt })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .for('update');
  if (!p) throw notFound('Profile');
  if (p.name === check.name) return { displayName: p.name, tag: p.tag };
  if (p.changedAt) {
    const nextAllowed = new Date(p.changedAt.getTime() + cooldownDays * 86_400_000);
    if (nextAllowed > now) {
      throw new ApiError(429, 'name_cooldown', 'You changed your name recently', {
        nextAllowedAt: nextAllowed.toISOString(),
      });
    }
  }
  const sameNameDifferentCase = p.name.toLowerCase() === check.name.toLowerCase();
  const tag = sameNameDifferentCase ? p.tag : await pickFreeTag(tx, check.name);
  await tx
    .update(profiles)
    .set({ displayName: check.name, tag, nameChangedAt: now, updatedAt: now })
    .where(eq(profiles.userId, userId));
  await tx.insert(nameHistory).values({ userId, displayName: p.name, tag: p.tag, changedBy, changedAt: now });
  return { displayName: check.name, tag };
}

/** Public profile card (SCREENS §5.5). */
export interface ProfileCard {
  userId: string;
  displayName: string;
  tag: string;
  region: string;
  level: number;
  xp: { total: number; intoLevel: number; toNext: number };
  crowns: number;
  stats: {
    showsPlayed: number;
    wins: number;
    finals: number;
    roundsPlayed: number;
    roundsQualified: number;
    winRate: number;
    currentWinStreak: number;
    bestWinStreak: number;
  };
  ranked: {
    queue: string;
    seasonId: string;
    tier: string;
    division: number;
    rp: number;
    placementsLeft: number;
  }[];
  loadout: unknown;
  createdAt: string;
}

/**
 * Builds a profile card.
 *
 * @param resolveTier - The displayed tier of a rating (Crown League depends on
 *   the live regional board); the stored ladder tier when absent.
 * @throws {ApiError} 404 when the user does not exist.
 */
export async function getProfileCard(
  db: DbOrTx,
  catalog: Catalog,
  userId: string,
  resolveTier?: (r: { region: string; rp: number; placementsLeft: number }) => Promise<TierInfo>,
): Promise<ProfileCard> {
  const [row] = await db
    .select({ u: users, p: profiles, s: playerStats })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .leftJoin(playerStats, eq(playerStats.userId, users.id))
    .where(eq(users.id, userId));
  if (!row) throw notFound('Profile');
  const rank = await db
    .select()
    .from(ratings)
    .where(and(eq(ratings.userId, userId), eq(ratings.seasonId, catalog.season.id)));
  const [lo] = await db
    .select({ items: loadouts.items })
    .from(loadouts)
    .where(and(eq(loadouts.userId, userId), eq(loadouts.slotIndex, row.p.activeLoadout)));
  const lv = catalog.levelForXp(row.p.xp);
  const s = row.s;
  return {
    userId,
    displayName: row.p.displayName,
    tag: row.p.tag,
    region: row.u.region,
    level: lv.level,
    xp: { total: row.p.xp, intoLevel: lv.into, toNext: lv.next },
    crowns: row.p.crowns,
    stats: {
      showsPlayed: s?.showsPlayed ?? 0,
      wins: s?.wins ?? 0,
      finals: s?.finals ?? 0,
      roundsPlayed: s?.roundsPlayed ?? 0,
      roundsQualified: s?.roundsQualified ?? 0,
      winRate: s && s.showsPlayed ? s.wins / s.showsPlayed : 0,
      currentWinStreak: s?.currentWinStreak ?? 0,
      bestWinStreak: s?.bestWinStreak ?? 0,
    },
    ranked: await Promise.all(
      rank.map(async (r) => {
        const shown = resolveTier
          ? await resolveTier({ region: row.u.region, rp: r.rp, placementsLeft: r.placementsLeft })
          : { tier: r.tier, division: r.division };
        return {
          queue: r.queue,
          seasonId: r.seasonId,
          tier: shown.tier,
          division: shown.division,
          rp: r.rp,
          placementsLeft: r.placementsLeft,
        };
      }),
    ),
    loadout: lo?.items ?? null,
    createdAt: row.u.createdAt.toISOString(),
  };
}
