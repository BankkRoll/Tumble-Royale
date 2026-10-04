/**
 * Drizzle schema for the Tumble Royale backend (SPEC §16).
 *
 * Conventions:
 * - Money-like values (currencies, XP, RP) are integers.
 * - `currencies_ledger` is append-only (a trigger in the migrations rejects
 *   UPDATE/DELETE); `profiles` caches balances that must always equal the
 *   ledger sum, which `verifyLedger` checks.
 * - Match ids come from the game server; everything keyed by a match id is
 *   written once, which makes result ingestion idempotent.
 *
 * NOTE: this file must not import project modules: drizzle-kit loads it in
 * isolation to generate migrations.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

// -----------------------------------------------------------------------------
// Accounts & auth
// -----------------------------------------------------------------------------

/** One row per player account (guest or upgraded). */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    isGuest: boolean('is_guest').notNull().default(true),
    email: text('email'),
    /** Matchmaking / leaderboard region (`na`, `eu`, `asia`, `sa`, `oce`). */
    region: text('region').notNull().default('na'),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

/** External identities linked to a user: device token, Discord, Google, email. */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** Provider user id; for `device` the SHA-256 of the device secret. */
    subject: text('subject').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_subject_uq').on(t.provider, t.subject),
    index('auth_identities_user_idx').on(t.userId),
  ],
);

/**
 * Refresh-token sessions. Each refresh rotates to a new row in the same family;
 * presenting a revoked token revokes the whole family (reuse detection).
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    /** SHA-256 of the refresh token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    replacedBy: uuid('replaced_by'),
    userAgent: text('user_agent'),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_family_idx').on(t.familyId)],
);

/** Public profile + cached balances (the ledger is the source of truth). */
export const profiles = pgTable(
  'profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    /** Four-digit discriminator; `name#tag` is unique (case-insensitive on name). */
    tag: text('tag').notNull(),
    nameChangedAt: ts('name_changed_at'),
    level: integer('level').notNull().default(1),
    xp: integer('xp').notNull().default(0),
    crowns: integer('crowns').notNull().default(0),
    crownShards: integer('crown_shards').notNull().default(0),
    gumballs: integer('gumballs').notNull().default(0),
    gems: integer('gems').notNull().default(0),
    /**
     * Gems owed after a refund or chargeback revoked more than the balance
     * held (ledger currency `gem_debt`). While positive, Gem checkout is
     * refused and Gem credits repay it before reaching `gems`.
     */
    gemDebt: integer('gem_debt').notNull().default(0),
    activeLoadout: integer('active_loadout').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('profiles_name_tag_uq').on(sql`lower(${t.displayName})`, t.tag)],
);

// -----------------------------------------------------------------------------
// Stats
// -----------------------------------------------------------------------------

/** Lifetime aggregate stats per player. */
export const playerStats = pgTable('player_stats', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  showsPlayed: integer('shows_played').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  finals: integer('finals').notNull().default(0),
  roundsPlayed: integer('rounds_played').notNull().default(0),
  roundsQualified: integer('rounds_qualified').notNull().default(0),
  currentWinStreak: integer('current_win_streak').notNull().default(0),
  bestWinStreak: integer('best_win_streak').notNull().default(0),
  lastShowDay: text('last_show_day'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Per-round-definition stats per player (favourite round, qualify rate). */
export const playerRoundStats = pgTable(
  'player_round_stats',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roundId: text('round_id').notNull(),
    played: integer('played').notNull().default(0),
    qualified: integer('qualified').notNull().default(0),
    bestTimeMs: integer('best_time_ms'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roundId] })],
);

// -----------------------------------------------------------------------------
// Cosmetics, inventory, loadouts
// -----------------------------------------------------------------------------

/** Server copy of the content cosmetics catalog, synced on boot. */
export const cosmeticsCatalog = pgTable('cosmetics_catalog', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slot: text('slot').notNull(),
  rarity: text('rarity').notNull(),
  source: text('source').notNull(),
  priceCurrency: text('price_currency'),
  priceAmount: integer('price_amount'),
  active: boolean('active').notNull().default(true),
  data: jsonb('data').notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Cosmetics a player owns. */
export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cosmeticId: text('cosmetic_id').notNull(),
    source: text('source').notNull(),
    acquiredAt: ts('acquired_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('inventory_user_item_uq').on(t.userId, t.cosmeticId)],
);

/** Six loadout slots per player; `items` maps slot → cosmetic id. */
export const loadouts = pgTable(
  'loadouts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slotIndex: integer('slot_index').notNull(),
    name: text('name').notNull(),
    items: jsonb('items').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.slotIndex] })],
);

// -----------------------------------------------------------------------------
// Economy
// -----------------------------------------------------------------------------

/**
 * Append-only currency ledger. `(user, currency, reason, ref)` is unique so a
 * grant keyed by an external id (match, purchase, tier) can never apply twice.
 */
export const currenciesLedger = pgTable(
  'currencies_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    currency: text('currency').notNull(),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: text('reason').notNull(),
    ref: text('ref').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_idempotency_uq').on(t.userId, t.currency, t.reason, t.ref),
    index('ledger_user_idx').on(t.userId, t.currency),
  ],
);

/** Purchases (store items, gem packs, premium pass), idempotent per user + key. */
export const purchases = pgTable(
  'purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    kind: text('kind').notNull(),
    itemId: text('item_id').notNull(),
    currency: text('currency').notNull(),
    price: integer('price').notNull(),
    status: text('status').notNull(),
    provider: text('provider'),
    providerRef: text('provider_ref'),
    /**
     * Stripe PaymentIntent id, recorded when the checkout completes. Refund and
     * dispute webhooks only name the charge's PaymentIntent, so this is how
     * they find the purchase.
     */
    paymentIntent: text('payment_intent'),
    /** Response returned to the client, replayed verbatim on a retried request. */
    response: jsonb('response'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    uniqueIndex('purchases_user_key_uq').on(t.userId, t.idempotencyKey),
    uniqueIndex('purchases_provider_ref_uq').on(t.providerRef),
    uniqueIndex('purchases_payment_intent_uq').on(t.paymentIntent),
  ],
);

/**
 * Stripe webhook event ids already applied. Inserted in the same transaction
 * as the event's effects, so a redelivered event is a no-op and a failed one
 * is retried.
 */
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  createdAt: createdAt(),
});

/**
 * What Stripe has told us about refunds and disputes on one PaymentIntent, and
 * how many Gems that has already taken back. Rows may exist before the
 * purchase is known (refund delivered before the checkout completion), and
 * are reconciled once it is.
 */
export const paymentReversals = pgTable(
  'payment_reversals',
  {
    paymentIntent: text('payment_intent').primaryKey(),
    chargeId: text('charge_id'),
    /** Charged amount in minor units, as Stripe reports it. */
    amountCents: integer('amount_cents'),
    /** Highest cumulative refunded amount seen (Stripe's `amount_refunded`). */
    amountRefundedCents: integer('amount_refunded_cents').notNull().default(0),
    disputeId: text('dispute_id'),
    /** `open`, `won` or `lost`; null when never disputed. */
    disputeStatus: text('dispute_status'),
    /** Gems currently taken back for this payment (balance plus debt). */
    gemsReversed: integer('gems_reversed').notNull().default(0),
    /** Ledger adjustments made so far; numbers the next adjustment's ref. */
    adjustments: integer('adjustments').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('payment_reversals_charge_idx').on(t.chargeId)],
);

/** Persisted daily store rotations (deterministic; stored for audit and support). */
export const storeRotations = pgTable('store_rotations', {
  day: text('day').primaryKey(),
  featured: jsonb('featured').notNull(),
  daily: jsonb('daily').notNull(),
  createdAt: createdAt(),
});

// -----------------------------------------------------------------------------
// Season pass & challenges
// -----------------------------------------------------------------------------

/** Season pass progress per player per season. */
export const seasonPassProgress = pgTable(
  'season_pass_progress',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seasonId: text('season_id').notNull(),
    xp: integer('xp').notNull().default(0),
    premium: boolean('premium').notNull().default(false),
    claimedFree: jsonb('claimed_free').$type<number[]>().notNull().default([]),
    claimedPremium: jsonb('claimed_premium').$type<number[]>().notNull().default([]),
    /**
     * Set once the season has ended and its unclaimed unlocked rewards were
     * auto-granted; the row is then history only.
     */
    settledAt: ts('settled_at'),
    /** Rewards auto-granted at settlement (for support and the client's recap). */
    autoGranted: integer('auto_granted').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.seasonId] })],
);

/**
 * One row per season the API has seen go live. Inserting the row is the
 * cluster-wide "this season started" event: only the instance whose insert
 * wins fires the season-change hooks.
 */
export const seasonRollovers = pgTable('season_rollovers', {
  seasonId: text('season_id').primaryKey(),
  previousSeasonId: text('previous_season_id'),
  rolledAt: ts('rolled_at').notNull().defaultNow(),
});

/**
 * Live news posts published through `POST /internal/news`, merged over the
 * news bundled with content so posts ship without a client release.
 */
export const newsPosts = pgTable(
  'news_posts',
  {
    id: text('id').primaryKey(),
    /** The post (content `NewsPost` shape), validated on write. */
    data: jsonb('data').notNull(),
    /** Hidden posts are withdrawn; a hidden id also hides a bundled post with that id. */
    hidden: boolean('hidden').notNull().default(false),
    publishedAt: ts('published_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('news_published_idx').on(t.publishedAt)],
);

/** Challenge definitions, synced from content. */
export const challenges = pgTable('challenges', {
  id: text('id').primaryKey(),
  /** `daily`, `weekly`, `seasonal` or `milestone`. */
  period: text('period').notNull(),
  title: text('title').notNull(),
  metric: text('metric').notNull(),
  target: integer('target').notNull(),
  rewardXp: integer('reward_xp').notNull(),
  rewardGumballs: integer('reward_gumballs').notNull().default(0),
  rewardGems: integer('reward_gems').notNull().default(0),
  rewardCosmetic: text('reward_cosmetic'),
  active: boolean('active').notNull().default(true),
});

/**
 * A challenge assigned to a player for one period. `period_key` is the UTC
 * day, the ISO week, the season id (`seasonal`) or `all` (`milestone`).
 */
export const challengeProgress = pgTable(
  'challenge_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    challengeId: text('challenge_id').notNull(),
    period: text('period').notNull(),
    periodKey: text('period_key').notNull(),
    slot: integer('slot').notNull(),
    progress: integer('progress').notNull().default(0),
    target: integer('target').notNull(),
    completedAt: ts('completed_at'),
    claimedAt: ts('claimed_at'),
    rerolled: boolean('rerolled').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('challenge_progress_slot_uq').on(t.userId, t.period, t.periodKey, t.slot)],
);

// -----------------------------------------------------------------------------
// Achievements & login streak
// -----------------------------------------------------------------------------

/**
 * Lifetime value of one achievement metric per player: a running total for
 * `sum` metrics, the best ever for `max` metrics. `gauge` metrics (items
 * owned) are recomputed from live state and never stored here. Only the match
 * ingest and the login claim write rows, inside the transaction that also
 * records the match or the claim, so a replayed report cannot count twice.
 */
export const achievementStats = pgTable(
  'achievement_stats',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    metric: text('metric').notNull(),
    value: integer('value').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.metric] })],
);

/**
 * Achievements a player has unlocked. The primary key makes the unlock (and
 * with it the reward grant) happen exactly once.
 */
export const playerAchievements = pgTable(
  'player_achievements',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    achievementId: text('achievement_id').notNull(),
    unlockedAt: ts('unlocked_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.achievementId] })],
);

/** Daily login streak per player. Days are UTC `YYYY-MM-DD` from the server clock. */
export const loginStreaks = pgTable('login_streaks', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Consecutive days claimed, ending on `last_claim_day`. */
  current: integer('current').notNull().default(0),
  best: integer('best').notNull().default(0),
  lastClaimDay: text('last_claim_day'),
  /** Lifetime claims. */
  claims: integer('claims').notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// -----------------------------------------------------------------------------
// Ranked
// -----------------------------------------------------------------------------

/** Hidden OpenSkill rating + visible RP, per season and queue. */
export const ratings = pgTable(
  'ratings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seasonId: text('season_id').notNull(),
    queue: text('queue').notNull(),
    mu: doublePrecision('mu').notNull(),
    sigma: doublePrecision('sigma').notNull(),
    rp: integer('rp').notNull().default(0),
    tier: text('tier').notNull(),
    division: integer('division').notNull(),
    placementsLeft: integer('placements_left').notNull(),
    matches: integer('matches').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.seasonId, t.queue] })],
);

/** One row per ranked match per player. */
export const rankHistory = pgTable(
  'rank_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seasonId: text('season_id').notNull(),
    queue: text('queue').notNull(),
    matchId: text('match_id').notNull(),
    placement: integer('placement').notNull(),
    muBefore: doublePrecision('mu_before').notNull(),
    muAfter: doublePrecision('mu_after').notNull(),
    sigmaBefore: doublePrecision('sigma_before').notNull(),
    sigmaAfter: doublePrecision('sigma_after').notNull(),
    rpBefore: integer('rp_before').notNull(),
    rpAfter: integer('rp_after').notNull(),
    tier: text('tier').notNull(),
    division: integer('division').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('rank_history_match_user_uq').on(t.matchId, t.userId)],
);

// -----------------------------------------------------------------------------
// Matches
// -----------------------------------------------------------------------------

/** A completed show, as reported by the game server. */
export const matches = pgTable(
  'matches',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    playlistId: text('playlist_id').notNull(),
    seasonId: text('season_id').notNull(),
    region: text('region').notNull(),
    playerCount: integer('player_count').notNull(),
    botCount: integer('bot_count').notNull(),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at').notNull(),
    ingestedAt: createdAt(),
    /** Per-player reward summaries returned to the game server; replayed on retries. */
    rewards: jsonb('rewards').notNull(),
  },
  (t) => [index('matches_season_idx').on(t.seasonId)],
);

/** Every participant (human or bot) of a show. */
export const matchParticipants = pgTable(
  'match_participants',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    participantKey: text('participant_key').notNull(),
    userId: uuid('user_id'),
    isBot: boolean('is_bot').notNull(),
    name: text('name').notNull(),
    team: integer('team'),
    placement: integer('placement').notNull(),
    crowned: boolean('crowned').notNull(),
    roundsSurvived: integer('rounds_survived').notNull(),
    xp: integer('xp').notNull().default(0),
    gumballs: integer('gumballs').notNull().default(0),
    crownShards: integer('crown_shards').notNull().default(0),
    rpDelta: integer('rp_delta'),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.participantKey] }),
    index('match_participants_user_idx').on(t.userId),
  ],
);

/** Rounds played in a show, in order. */
export const matchRounds = pgTable(
  'match_rounds',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    roundIndex: integer('round_index').notNull(),
    roundId: text('round_id').notNull(),
    roundType: text('round_type').notNull(),
    durationMs: integer('duration_ms').notNull(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.roundIndex] })],
);

/** Per-participant outcome of each round. */
export const roundResults = pgTable(
  'round_results',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    roundIndex: integer('round_index').notNull(),
    participantKey: text('participant_key').notNull(),
    qualified: boolean('qualified').notNull(),
    position: integer('position'),
    score: integer('score'),
    timeMs: integer('time_ms'),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.roundIndex, t.participantKey] })],
);

// -----------------------------------------------------------------------------
// Social & moderation
// -----------------------------------------------------------------------------

/**
 * Directed relationship rows. `pending`: userId requested friendId. `accepted`:
 * stored once, by the original requester. `blocked`: userId blocked friendId.
 */
export const friendships = pgTable(
  'friendships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    friendId: uuid('friend_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.friendId] }), index('friendships_friend_idx').on(t.friendId)],
);

/** Player reports (moderation queue). */
export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    matchId: text('match_id'),
    reason: text('reason').notNull(),
    details: text('details'),
    status: text('status').notNull().default('open'),
    /**
     * Chat evidence captured when the report was filed: the target's recent
     * public (global) lines, plus whispers they sent the reporter.
     */
    evidence: jsonb('evidence'),
    createdAt: createdAt(),
  },
  (t) => [index('reports_status_idx').on(t.status), index('reports_target_idx').on(t.targetUserId)],
);

/** Bans; `scope` = `all` blocks every authenticated call, `ranked` only ranked queueing. */
export const bans = pgTable(
  'bans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().default('all'),
    reason: text('reason').notNull(),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    /**
     * For a ban re-applied because the player came back after deleting a
     * banned account: the `ban_evasion_marks.ban_id` it was copied from.
     */
    evasionOf: uuid('evasion_of'),
    createdAt: createdAt(),
  },
  (t) => [index('bans_user_idx').on(t.userId), uniqueIndex('bans_user_evasion_uq').on(t.userId, t.evasionOf)],
);

/**
 * Bans that outlive account deletion. When a banned account is erased, each
 * active ban is stored once per stable identifier of the account (OAuth
 * subject, email address, guest device secret), as a keyed hash only; a later
 * account that presents a matching identifier gets the ban re-applied.
 * No user id is kept, so the row identifies nobody on its own.
 */
export const banEvasionMarks = pgTable(
  'ban_evasion_marks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Id of the ban that was active at deletion; groups the identifier rows. */
    banId: uuid('ban_id').notNull(),
    /** Hex HMAC-SHA256 of the identifier, keyed with `INTERNAL_HMAC_SECRET`. */
    identifierHash: text('identifier_hash').notNull(),
    scope: text('scope').notNull(),
    reason: text('reason').notNull(),
    expiresAt: ts('expires_at'),
    /** Set when an admin lifts a ban re-applied from this mark (a pardon). */
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ban_evasion_marks_ban_identifier_uq').on(t.banId, t.identifierHash),
    index('ban_evasion_marks_identifier_idx').on(t.identifierHash),
  ],
);

/** Moderator warnings: a recorded strike with no restriction attached. */
export const playerWarnings = pgTable(
  'player_warnings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    /** Report that prompted the warning, if any. */
    reportId: uuid('report_id'),
    /** Staff label at the time (`name#tag`, or `operator token`). */
    issuedBy: text('issued_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('player_warnings_user_idx').on(t.userId)],
);

/** Previous display names, one row per change, so moderators can trace renames. */
export const nameHistory = pgTable(
  'name_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The name the player had before this change. */
    displayName: text('display_name').notNull(),
    tag: text('tag').notNull(),
    /** `player` or `staff`. */
    changedBy: text('changed_by').notNull(),
    changedAt: ts('changed_at').notNull().defaultNow(),
  },
  (t) => [index('name_history_user_idx').on(t.userId, t.changedAt)],
);

/**
 * Accounts allowed into the admin console. `admin` may do everything the
 * `ADMIN_TOKEN` can; `moderator` handles reports, sanctions and player lookups.
 */
export const staffMembers = pgTable('staff_members', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  grantedBy: text('granted_by').notNull(),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * Every admin action, from the CLI or the console. The actor is kept as a
 * label as well as an id so the history survives the staff account's deletion.
 */
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Staff account, or null for the static `ADMIN_TOKEN`. */
    actorUserId: uuid('actor_user_id'),
    actorLabel: text('actor_label').notNull(),
    actorRole: text('actor_role').notNull(),
    /** Dotted action name, e.g. `player.ban`, `report.dismiss`, `flag.set`. */
    action: text('action').notNull(),
    /** `user`, `report`, `ban`, `flag`, `playlist`, `news`, `maintenance`, `staff`, `session`. */
    targetType: text('target_type'),
    targetId: text('target_id'),
    reason: text('reason'),
    details: jsonb('details'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('admin_audit_created_idx').on(t.createdAt),
    index('admin_audit_target_idx').on(t.targetType, t.targetId),
    index('admin_audit_actor_idx').on(t.actorUserId),
  ],
);

/** Feature flags with percentage rollout. */
export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  rolloutPercent: integer('rollout_percent').notNull().default(100),
  payload: jsonb('payload'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * Operator overrides for bundled playlists (`PUT /internal/playlists/:id`).
 * A row replaces the bundled schedule wholesale, so null times mean "no
 * bound", not "inherit".
 */
export const playlistOverrides = pgTable('playlist_overrides', {
  id: text('id').primaryKey(),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  featured: boolean('featured').notNull().default(false),
  hidden: boolean('hidden').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Analytics events. */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id'),
    name: text('name').notNull(),
    props: jsonb('props'),
    createdAt: createdAt(),
  },
  (t) => [index('events_name_idx').on(t.name, t.createdAt)],
);
