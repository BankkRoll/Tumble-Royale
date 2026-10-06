/**
 * Response shapes of the admin API routes the console reads
 * (`apps/api/src/moderation/*`, `staff/routes.ts`, `liveops/routes.ts`).
 */

/** A staff role. */
export type StaffRole = 'moderator' | 'admin';

/** Who the console session acts as. */
export interface StaffActorView {
  userId: string;
  label: string;
  role: StaffRole;
}

/** A player as the report queue names them. */
export interface PersonRef {
  id: string;
  displayName: string | null;
  tag: string | null;
}

/** A sanction summary. */
export interface SanctionRef {
  id: string;
  scope: string;
  expiresAt: string | null;
}

/** A captured chat line. */
export interface EvidenceLine {
  /** `voice` lines are room and time metadata; voice is never recorded. */
  channel: 'global' | 'whisper' | 'club' | 'voice';
  text: string;
  at: number;
}

/** Report reasons. */
export type ReportReason =
  'cheating' | 'harassment' | 'offensive_name' | 'griefing' | 'spam' | 'voice' | 'other';
/** Report statuses. */
export type ReportStatus = 'open' | 'resolved' | 'dismissed' | 'actioned';

/** One row of `GET /internal/reports`. */
export interface ReportRow {
  id: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  matchId: string | null;
  createdAt: string;
  evidence: EvidenceLine[] | null;
  reporter: PersonRef;
  target: PersonRef & { openReports: number; activeSanctions: SanctionRef[] };
}

/** `GET /internal/reports`. */
export interface ReportPage {
  total: number;
  offset: number;
  limit: number;
  reports: ReportRow[];
}

/** Decisions the queue offers. */
export type ReportAction = 'dismiss' | 'resolve' | 'warn' | 'mute' | 'voice_mute' | 'ban';

/** A ban row (`GET /internal/bans`, player page). */
export interface BanRow {
  id: string;
  userId: string;
  scope: 'all' | 'ranked' | 'chat' | string;
  reason: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  displayName?: string | null;
  tag?: string | null;
  active?: boolean;
}

/** One `GET /internal/users/lookup` hit. */
export interface LookupUser {
  id: string;
  isGuest: boolean;
  email: string | null;
  displayName: string;
  tag: string;
  level: number;
  lastSeenAt: string;
  createdAt: string;
  providers: string[];
  bans: BanRow[];
}

/** `GET /internal/users/:id`. */
export interface PlayerSummary {
  account: {
    id: string;
    isGuest: boolean;
    email: string | null;
    region: string;
    createdAt: string;
    lastSeenAt: string;
    displayName: string;
    tag: string;
    nameChangedAt: string | null;
    level: number;
    xp: number;
    crowns: number;
    gumballs: number;
    gems: number;
    crownShards: number;
    gemDebt: number;
    providers: string[];
    staffRole: StaffRole | null;
  };
  stats: { showsPlayed: number; wins: number; finals: number; roundsPlayed: number } | null;
  matches: {
    total: number;
    recent: {
      matchId: string;
      queue: string;
      playlistId: string;
      endedAt: string;
      placement: number;
      crowned: boolean;
    }[];
  };
  purchases: {
    total: number;
    recent: {
      id: string;
      kind: string;
      itemId: string;
      currency: string;
      price: number;
      status: string;
      createdAt: string;
    }[];
  };
  inventory: {
    cosmeticId: string;
    name: string;
    slot: string | null;
    source: string;
    acquiredAt: string;
    starter: boolean;
  }[];
  reportsAgainst: {
    byStatus: Partial<Record<ReportStatus, number>>;
    recent: {
      id: string;
      reason: string;
      status: string;
      details: string | null;
      createdAt: string;
      reporterId: string;
      reporter: string | null;
    }[];
  };
  reportsBy: {
    total: number;
    recent: {
      id: string;
      reason: string;
      status: string;
      createdAt: string;
      targetUserId: string;
      target: string | null;
    }[];
  };
  bans: (BanRow & { active: boolean })[];
  warnings: { id: string; reason: string; issuedBy: string; createdAt: string }[];
  nameHistory: { displayName: string; tag: string; changedBy: string; changedAt: string }[];
  audit: AuditEntry[];
}

/** One `admin_audit_log` row. */
export interface AuditEntry {
  id: number;
  actorUserId: string | null;
  actorLabel: string;
  actorRole: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

/** `GET /internal/audit`. */
export interface AuditPage {
  entries: AuditEntry[];
  nextBefore: number | null;
}

/** A stored feature flag. */
export interface FlagRow {
  key: string;
  enabled: boolean;
  rolloutPercent: number;
  payload: unknown;
  updatedAt: string;
}

/** Maintenance as `GET /status` reports it. */
export interface MaintenanceView {
  enabled: boolean;
  message: string;
  startsAt: string | null;
  endsAt: string | null;
  phase: 'off' | 'scheduled' | 'active';
}

/** A playlist with its effective schedule (`GET /internal/playlists`). */
export interface PlaylistRow {
  id: string;
  name?: string;
  startsAt: string | null;
  endsAt: string | null;
  featured: boolean;
  hidden: boolean;
  phase: string;
  overridden?: boolean;
}

/** One grouped error (`GET /internal/errors/top`). */
export interface ErrorGroup {
  type: string;
  message: string;
  occurrences: number;
  reports: number;
  players: number;
  services: string | null;
  releases: string | null;
  firstSeen: string;
  lastSeen: string;
  sampleStack: string | null;
  samplePath: string | null;
}

/** Refund kinds: a store purchase refunded by the player, or a Gem pack request for staff. */
export type RefundKind = 'self_service' | 'real_money';

/** Refund statuses (`apps/api/src/economy/refunds.ts`). */
export type RefundStatus =
  'completed' | 'pending' | 'processing' | 'manual' | 'refunded' | 'partially_refunded' | 'denied' | 'failed';

/** One row of `GET /internal/refunds`. */
export interface RefundRow {
  id: string;
  userId: string;
  purchaseId: string;
  kind: RefundKind;
  status: RefundStatus;
  /** `gumballs`, `gems`, or the Gem pack's money currency (`usd`). */
  currency: string;
  /** Currency units, or minor units for money. */
  amount: number;
  items: string[];
  playerReason: string | null;
  decisionReason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  lastError: string | null;
  createdAt: string;
  offerId: string;
  purchasedAt: string | null;
  displayName: string | null;
  tag: string | null;
}

/** `GET /internal/refunds`. */
export interface RefundPage {
  total: number;
  offset: number;
  limit: number;
  refunds: RefundRow[];
}

/** `GET /internal/refunds/:id`. */
export interface RefundDetail {
  refund: Omit<RefundRow, 'offerId' | 'purchasedAt' | 'displayName' | 'tag'> & {
    providerRefundId: string | null;
    attempts: number;
  };
  purchase: {
    id: string;
    kind: string;
    offerId: string;
    currency: string;
    price: number;
    status: string;
    provider: string | null;
    paymentIntent: string | null;
    createdAt: string;
    completedAt: string | null;
  } | null;
  player: {
    id: string;
    isGuest: boolean;
    createdAt: string;
    gumballs: number;
    gems: number;
    gemDebt: number;
    displayName: string | null;
    tag: string | null;
    purchases: number;
  } | null;
  history: {
    id: string;
    purchaseId: string;
    kind: RefundKind;
    status: RefundStatus;
    currency: string;
    amount: number;
    createdAt: string;
  }[];
  ledger: {
    currency: string;
    delta: number;
    balanceAfter: number;
    reason: string;
    ref: string;
    createdAt: string;
  }[];
  /** Payment provider the API runs with; `stripe` means approval refunds through Stripe. */
  provider: 'stripe' | 'fake' | 'disabled';
}

/** A club in the console's list. */
export interface ClubListRow {
  id: string;
  name: string;
  tag: string;
  description: string;
  joinMode: string;
  memberCount: number;
  maxMembers: number;
  lastActivityAt: string;
  createdAt: string;
  disbandedAt: string | null;
  openReports: number;
}

/** A club chat line kept as evidence. */
export interface ClubChatEvidence {
  id: string;
  from: { userId: string; name: string; tag: string };
  text: string;
  masked?: string;
  at: number;
}

/** A report against a club. */
export interface ClubReportRow {
  id: string;
  reason: string;
  details: string | null;
  status: string;
  snapshot: { name: string; tag: string; description: string };
  evidence: ClubChatEvidence[] | null;
  createdAt: string;
  reporterId: string;
  reporterName: string | null;
  reporterTag: string | null;
}

/** `GET /internal/clubs/:id`. */
export interface ClubDetail {
  club: Omit<ClubListRow, 'openReports'> & { disbandReason: string | null };
  members: {
    userId: string;
    displayName: string;
    tag: string;
    role: string;
    presence: string;
    joinedAt: string;
  }[];
  chat: ClubChatEvidence[];
  reports: ClubReportRow[];
  audit: AuditEntry[];
}

/** Gift statuses (`apps/api/src/economy/gifts.ts`). */
export type GiftStatus = 'pending' | 'opened' | 'declined' | 'cancelled' | 'returned' | 'reversed';

/** One gift on a player's page (`GET /internal/users/:id/gifts`). */
export interface AdminGift {
  giftId: string;
  offerId: string;
  title: string;
  items: { id: string; name: string; slot: string | null; rarity: string | null }[];
  price: { currency: string; amount: number };
  message: { text: string; masked?: string } | null;
  status: GiftStatus;
  refunded: boolean;
  autoAccepted: boolean;
  note: 'recipient_owns' | 'recipient_deleted' | 'staff' | null;
  sentAt: string;
  opensAutomaticallyAt: string;
  resolvedAt: string | null;
  from: { userId: string; name: string; tag: string } | null;
  to: { userId: string; name: string; tag: string } | null;
  /** The gift's ledger rows: the sender's charge and any refund. */
  ledger: {
    userId: string;
    currency: string;
    delta: number;
    reason: string;
    ref: string;
    createdAt: string;
  }[];
}

/** `GET /internal/users/:id/gifts`. */
export interface PlayerGifts {
  userId: string;
  sent: AdminGift[];
  received: AdminGift[];
}
