# Tumble Royale — Economy & Seasons (ECONOMY.md)

> Owner: Lead Game Design. Consumers: content (`packages/content/src/progression`),
> API (`apps/api/src/{economy,progression}`), offline profile
> (`apps/client/src/game/profile.ts`), UI (Store, Season Pass, wallet popovers).
> Every number here lives in content data; this page explains why the numbers
> are what they are. Show payouts (XP, Gumballs, shards per show) are in
> [SHOWS.md §6](./SHOWS.md#6-rewards).

## 1. Currencies

| Currency         | How you get it                                    | What it buys                                              | Sold for money?                  |
| ---------------- | ------------------------------------------------- | --------------------------------------------------------- | -------------------------------- |
| **Gumballs**     | Shows, challenges, level-ups, pass free track     | Common–Epic store items                                   | **Never.** Earn-only.            |
| **Gems**         | Free earn paths (§3), pass tracks, and Gem packs  | Premium Pass, Legendary/Mythic store items                | Only via Stripe, only when keyed |
| **Crown Shards** | Reaching a final (1 per show), premium pass tiers | Crown Shard shop exclusives (§4); 60 combine into a Crown | Never                            |

Everything sold is cosmetic. Nothing affects gameplay.

## 2. Seasons

- Schedule: `packages/content/src/progression/seasons.ts`. Authored seasons
  (`AUTHORED_SEASONS`) have an id (`s<n>`), number, name, theme, UTC
  `[startsAt, endsAt)` and a pass track. After the authored list ends, a
  rolling generator keeps going on a **3-month cadence** (boundaries on the 1st
  of a month, 00:00 UTC) with themes from `GENERATED_THEMES`, so there is
  always a current and a next season. Generated seasons cycle through the
  authored pass tracks.
- Season 1 (Sugar Rush): 2026-09-01 → 2026-12-01. Season 2 (Frosting Frenzy):
  2026-12-01 → 2027-03-01. Season 3 onward is generated.

### 2.1 Rollover rule

When the live season changes, for each player:

1. **Unclaimed rewards are auto-granted, not lost.** Every tier the player had
   unlocked but not claimed is granted (free track always; premium track only
   if premium was unlocked that season). Locked tiers are not granted.
2. Season XP and pass progress start at 0 for the new season; premium must be
   unlocked again.
3. History is kept: the API keeps every `season_pass_progress` row (one per
   player per season, marked `settled_at` once rewards are granted); the
   offline profile keeps a `seasonHistory` list (season id, XP, tier, premium,
   auto-granted count).
4. The rollover is idempotent: granting reuses the exact ledger refs a manual
   claim uses (`<season>:tier:<n>:<track>:<i>`), so a reward can never be paid
   twice, and a settled season is never settled again.
5. Pass cosmetics the player already owns (expected when a track repeats) pay
   **100 Gumballs** instead (`PASS_DUPLICATE_GUMBALLS`).

Server-wide, the API records each new season once in `season_rollovers` and
fires `onSeasonChanged` listeners (the ranked soft reset subscribes there).

## 3. Free Gem earn paths

Gems must be reachable without paying. Rules: `GEM_EARN` in
`packages/content/src/progression/gems.ts`, plus the pass tracks.

| Source                                                                    | Gems    | Cap                                         |
| ------------------------------------------------------------------------- | ------- | ------------------------------------------- |
| Weekly challenge claimed                                                  | 10 each | 6 per week → 60/week                        |
| First Crown of the UTC day                                                | 15      | 1 per day → 105/week                        |
| Account level milestone (every 10)                                        | 100     | levels 10, 20, … 100                        |
| Season Pass free track (x5 spotlight tiers 5, 15, 35, 45, 55, 65, 85, 95) | 50 each | 400/season                                  |
| Season Pass premium track                                                 | 100 × 8 | 800/season (premium refunds most of itself) |
| Daily login, day 7 of the ladder                                          | 20      | 1 per 7-day streak → 20/week                |
| Seasonal challenges with a Gem reward (when drawn)                        | 25 each | at most 2 per season → 50/season            |
| Achievements (top tiers) and the 50-Crown milestone                       | 25–100  | once per account: 350 + 100 lifetime        |

Season budget (13 weeks):

| Player  | Weeklies   | First Crowns | Milestones | Free track | **Total** |
| ------- | ---------- | ------------ | ---------- | ---------- | --------- |
| Casual  | 3/wk → 390 | 2/wk → 390   | 1 → 100    | half → 200 | **1,080** |
| Regular | 5/wk → 650 | 4/wk → 780   | 1 → 100    | all → 400  | **1,930** |
| Grinder | 6/wk → 780 | 7/wk → 1,365 | 2 → 200    | all → 400  | **2,745** |

Premium Pass costs **950 Gems**, so a casual player can buy the next season's
pass from one season of play; premium then refunds 800 of it. Legendary store
items (800) and Mythics (1,600) take a regular player roughly one season of
saving. `packages/content/test/economy.test.ts` checks the casual row stays at
or above the premium price.

The budget above leaves out the daily login (up to 260/season for an unbroken
streak), seasonal challenges (up to 50/season) and the one-time achievement
and milestone Gems: they reward showing up rather than grinding, and the
budget should hold without them.

### 3.1 Buying Gems

`GET /gems/packs` reports the payment provider. The client enables checkout:

- `stripe` → real checkout (only when the server has `STRIPE_SECRET_KEY`);
- `fake` (development API only — production never selects it) → instant test
  credit, labelled **"Test purchase (dev)"**;
- `disabled` or offline → packs are shown read-only with **"Coming soon —
  Secure checkout via Stripe"**.

No API key is ever needed to run or play the game.

Only linked accounts may buy Gems: a guest lives in one browser's storage, so
a purchase there could vanish with the device and could never be refunded to
anyone. `POST /gems/checkout` answers guests with **403 `account_required`**
and the client opens the link-account dialog instead.

### 3.2 Refunds and chargebacks

Stripe tells the API about money moving back through signed webhooks
(`charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`,
`charge.dispute.funds_reinstated`). `apps/api/src/economy/reversals.ts` holds
the implementation; the policy is:

- **Reconcile to a target.** Per PaymentIntent the API stores the highest
  refunded amount seen and the dispute status, then moves Gems by the
  difference between the target below and what it already took back.
  Duplicated, late and out-of-order deliveries all converge on the same
  ledger; each Stripe event id is also applied at most once.
- **Target.** An open or lost dispute takes back the whole pack. Otherwise a
  refund takes back `ceil(gems × refunded ÷ charged)`: a partial refund removes
  a proportional share, rounded against the player. A won dispute (also an
  inquiry closed without a chargeback, or reinstated funds) gives the
  dispute's share back; the refund's share, if any, stays reversed.
- **Append-only.** Every change is a new ledger row (`gem_reversal`,
  `gem_restore`, `debt_repayment`, `debt_forgiven`); nothing is edited.
- **Debt.** Gems already spent cannot be taken back, so the shortfall becomes
  Gem debt (ledger account `gem_debt`, shown as `gemDebt` by `GET /wallet`).
  Every later Gem credit (rewards, restores, adjustments) repays the debt
  first, so a player in debt always holds 0 Gems. While the debt is above
  zero, `POST /gems/checkout` answers **402 `payment_debt`**. Support can write
  it off with `POST /internal/payments/debt/:userId/forgive` (admin token).
  Cosmetics bought with reversed Gems are kept.
- **Ordering.** A refund or dispute that arrives before the checkout
  completion is stored and applied the moment the completion credits the
  pack. Events for unknown sessions or charges get a 200 so Stripe stops
  retrying them.
- **Failed refunds** (Stripe lowering `amount_refunded` again) are not
  re-credited automatically; support restores those Gems with an adjustment.
- An expired session (`checkout.session.expired`) or a declined delayed payment
  (`checkout.session.async_payment_failed`) marks the pending purchase
  `expired` / `failed`; no Gems move.
- A `refund.failed` event (or a `refund.updated` to `failed`/`canceled`)
  marks the player's refund request `failed` for staff; it moves no Gems.

### 3.3 Refunds

`GET /purchases` lists a player's completed purchases with each one's refund
and whether it can be refunded now, and why not. `POST
/purchases/:purchaseId/refund` does whichever refund the purchase allows.
`apps/api/src/economy/refunds.ts` holds the policy as one pure function.

| Purchase                             | Refund                                         | Window  |
| ------------------------------------ | ---------------------------------------------- | ------- |
| Store item or bundle (Gumballs/Gems) | Self-service, immediate                        | 7 days  |
| Gem pack (real money)                | Request reviewed by staff, paid out by Stripe  | 14 days |
| Season Pass premium                  | Never: its rewards unlock at once              | —       |
| Crown Shard shop                     | Never: spent shards no longer count to a Crown | —       |

- **Self-service.** The whole purchase is refunded: every item it granted
  leaves the locker (a bundle goes whole), loadouts wearing them fall back to
  the default loadout's choice for that slot, and the full price paid comes
  back as one `store_refund` ledger row with ref `refund:<purchaseId>`. Gems
  coming back repay Gem debt first, like any Gem credit.
- **Limit.** 3 self-service refunds per rolling 365 days. The refusal says
  when the oldest one leaves the window.
- **Wearing is fine.** The game does not record which cosmetics were worn in
  which show, so "used" is not a rule; the short window and the yearly limit
  bound wearing an item for a week and refunding it.
- **Items must still be there.** A purchase whose items were taken away (by
  staff) is refused. An item the player has since also earned another way
  (an event, achievement or pass reward) stays with them on refund: the
  repeated grant re-sources the inventory row, and refunds only remove copies
  still held from the store. The price still comes back in full.
- **Once.** One refund per purchase (`refunds.purchase_id` is unique) under
  the buyer's wallet lock: a double or concurrent submit returns the first
  refund with `replayed: true`. A denied request cannot be filed again.
- **Gem packs.** A request (with the player's reason) waits in the admin
  console's **Refunds** queue and `pnpm admin refunds`. Admins approve
  (Stripe refund of the whole payment, or `manual` without a Stripe key);
  moderators and admins can deny with a reason the player sees. Gems move
  only when Stripe reports the refund, through the reconciliation above, so
  a refunded pack behaves exactly like a refunded chargeback: Gems back,
  shortfall as debt, cosmetics kept.
- Refunds close with the store (`store.enabled` off → `503`) and during
  maintenance. Guests can refund store purchases too. Deleting the account
  deletes its purchases and refunds with it.

## 4. Crown Shard shop

- Stock: only `source: 'shards'` cosmetics (the royal set). They are never sold
  for Gumballs/Gems, never on a pass and never a level-up drop.
- Rotation: 4 offers per ISO week, at most one Legendary, seeded by the week
  key (`shardShopForWeek`), restocking Monday 00:00 UTC. The API and the
  offline client compute the same shelf.
- Prices (Crown Shards): Rare 18 · Epic 30 · Legendary 48. Every price is below
  the 60 shards that make a Crown, because shard balances above 60 convert into
  a Crown when a show is ingested: buying is a choice between a cosmetic now and
  the next Crown sooner.
- Purchase: `POST /shop/shards/buy` with an `Idempotency-Key`; writes a
  `shard_shop` ledger spend and a `purchases` row; `402 insufficient_funds`
  when short; `409 already_owned`; `404 offer_not_available` off-rotation.

## 5. Limited-time events

- Data: `LIVE_EVENTS` in `packages/content/src/progression/events.ts`, event
  cosmetics in `packages/content/src/cosmetics/catalog-events.ts`. Each event
  has a UTC window (at most 45 days, never overlapping another bundled one),
  featured playlists, up to 12 challenges and up to 30 tiers.
- Points per show: 20 for playing, 10 per round qualified, 25 for reaching the
  final, 60 for the Crown, doubled in the featured playlists. Claiming an event
  challenge adds 150–300 points and XP. A steady player (two featured shows a
  day, qualifying twice) plus every challenge reaches the top tier; content
  tests check that for every event.
- Rewards: event-only cosmetics (`source: 'event'`, never sold, each on exactly
  one track; the collection log names the event and tier), currency and XP.
  Currency is paid on the ledger under `event:<eventId>:<tier>` with reason
  `event_reward`, so a tier can never pay twice.
- Settlement: like seasonal challenges (§2.1), completed challenges and reached
  tiers the player never claimed pay out automatically after the event ends,
  through the same guards as a claim.

**Per-event currency budget** (`EVENT_CURRENCY_BUDGET`, enforced by the event
schema; tiers plus challenge XP):

| Currency     | Cap per event | Moonlit Mischief | Frostbite Frolic |
| ------------ | ------------- | ---------------- | ---------------- |
| Gumballs     | 2,500         | 1,700            | 1,700            |
| Gems         | 60            | 60               | 60               |
| Crown Shards | 12            | 7                | 7                |
| XP           | 30,000        | 17,500           | 17,500           |

60 Gems is about one week of weekly challenges (§3) spread over a four-week
event, so events add a little to the Gem budget without moving the premium
pass or a Legendary item noticeably closer. Gumballs stay below a week of
regular play. Events are optional: none of the §3 season budget counts on them.
