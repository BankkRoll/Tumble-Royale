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

| Source                                                                 | Gems    | Cap                                         |
| ---------------------------------------------------------------------- | ------- | ------------------------------------------- |
| Weekly challenge claimed                                               | 10 each | 6 per week → 60/week                        |
| First Crown of the UTC day                                             | 15      | 1 per day → 105/week                        |
| Account level milestone (every 10)                                     | 100     | levels 10, 20, … 100 → 1,000 lifetime       |
| Season Pass free track (spotlight tiers 5, 15, 35, 45, 55, 65, 85, 95) | 50 each | 400/season                                  |
| Season Pass premium track (tiers 8, 18, 27, 38, 47, 58, 68, 82)        | 100 × 8 | 800/season (premium refunds most of itself) |
| Daily login, day 7 of the ladder                                       | 20      | 1 per 7-day streak → 20/week, 260/season    |
| Seasonal challenges with a Gem reward (when drawn: 8 of 14 per season) | 25 each | at most 2 per season → 50/season            |
| Achievements (top tiers, 9 × 25–50) and the 50-Crown milestone         | 25–100  | once per account: 350 + 100 = 450 lifetime  |
| Limited-time event tiers (§5)                                          | ≤ 60    | per event; one event a season so far        |
| Club goals ([§6](#6-club-goals))                                       | 0       | XP and Gumballs only                        |

**Season budget (13 weeks), recurring sources only:**

| Player  | Weeklies   | First Crowns | Free track | Login streak | Seasonal (if drawn) | **Recurring** | + event | **With event** |
| ------- | ---------- | ------------ | ---------- | ------------ | ------------------- | ------------- | ------- | -------------- |
| Casual  | 3/wk → 390 | 2/wk → 390   | half → 200 | 4 → 80       | Crowns → 25         | **1,085**     | —       | **1,085**      |
| Regular | 5/wk → 650 | 4/wk → 780   | all → 400  | 10 → 200     | both → 50           | **2,080**     | 60      | **2,140**      |
| Grinder | 6/wk → 780 | 7/wk → 1,365 | all → 400  | 13 → 260     | both → 50           | **2,855**     | 60      | **2,915**      |

Club goals add nothing to any row. The seasonal Gem challenges are drawn, not
guaranteed: Season 1 drew neither, Seasons 2 and 4 both, Season 3 the Crowns
one. Events are optional (a casual player is assumed to skip them).

**Lifetime, once per account:** level milestones 1,000 (10 × 100), achievement
top tiers 350, the 50-Crown milestone 100: **1,450**. The level milestones are
front-loaded: level 100 takes 276,680 XP and a full pass is 120,000 XP, so a
regular player collects five or six milestones (500–600 Gems) in their first
season and the rest within about three. Earlier versions of this table counted
"1–2 milestones a season" as recurring income; that overstated every season
after the third and understated the first, so milestones now sit here.

**Does it balance against the prices?**

| Sink                         | Gems    | Casual (1,085)          | Regular (2,140)           | Grinder (2,915)           |
| ---------------------------- | ------- | ----------------------- | ------------------------- | ------------------------- |
| Premium Pass, first purchase | 950     | 1 season                | half a season             | a third of a season       |
| Premium Pass, renewed        | 150 net | yes (950 − 800)         | yes                       | yes                       |
| Legendary item (16 in store) | 800     | ~1 a season (with pass) | ~2.5 a season (with pass) | ~3.5 a season (with pass) |
| Mythic item (1 in store)     | 1,600   | ~1.7 seasons            | under a season            | about half a season       |
| Whole Gem catalog            | 14,400  | ~15 seasons             | ~7 seasons (with pass)    | ~5 seasons (with pass)    |

The design rule still holds: a casual player buys the next season's pass
from one season of play, without counting milestones, events or one-offs
(`packages/content/test/economy.test.ts` checks the casual recurring row,
built from the live data, against the pass price), and nothing Gem-priced is
out of reach of a free player.

**Flagged for design review (not changed):**

- Renewing the pass costs a net 150 Gems, so a regular free player keeps the
  pass every season and still banks about 2,000 Gems: two or three
  Legendaries a season, the whole Gem catalog in under two years. That is
  much faster than the "one season of saving per Legendary" this page used
  to promise. Whether Gem items should be that reachable without paying (and
  what it leaves for Gem packs) is a pricing call, not a correction.
- First Crowns are half of a grinder's budget (1,365 of 2,915), so Gem income
  scales with winning, not just with play; casual players see a third of it.

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

- **What a checkout credits is fixed at checkout.** The purchase row records
  the pack's price and Gems when the session is created; a later catalog
  change never alters what that payment credits or what a refund takes back.
- **Completion is checked against the purchase.** A `checkout.session.completed`
  is credited only when its session id, buyer (`metadata.userId`), amount and
  currency match the stored purchase. Anything else credits nothing, leaves
  the purchase pending and records a `payments.checkout_mismatch` event for
  support.
- **Retrying a failed checkout.** `POST /gems/checkout` is idempotent per
  `Idempotency-Key`. If the provider call failed the first time (no session
  was stored), the same key creates the session again for the same purchase;
  Stripe's own idempotency key (`checkout:<purchaseId>`) makes that safe.
  The client sends one checkout at a time: pack buttons stay disabled, with
  a spinner, until the answer arrives.

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
  pack. Every event of one PaymentIntent runs under a transaction-scoped
  advisory lock on that PaymentIntent, taken before any row lock, so a refund
  racing the completion can never be lost between them. Events for unknown
  sessions or charges get a 200 so Stripe stops retrying them.
- **Disputes close refund requests.** When a payment is disputed or charged
  back, an open (`pending` or `failed`) refund request for it is denied with
  that reason, and approving a request for a disputed payment answers
  **409 `refund_payment_reversed`**: the bank is already returning the money.
- **Failed refunds** (Stripe lowering `amount_refunded` again) are not
  re-credited automatically; support restores those Gems with an adjustment.
- An expired session (`checkout.session.expired`) or a declined delayed payment
  (`checkout.session.async_payment_failed`) marks the pending purchase
  `expired` / `failed`; no Gems move.
- A `refund.failed` event (or a `refund.updated` to `failed`/`canceled`)
  marks the player's refund request `failed` for staff; it moves no Gems.

### 3.3 Refunds

**Buying.** `POST /purchase` charges today's price. The client sends the
price it showed in the confirmation (`expectedPrice: { currency, amount }`);
if the shelves rotated meanwhile, or a bundle got cheaper because the player
came to own part of it, the API answers **409 `price_changed`** with the new
quote in `details.price` and charges nothing, and the client refreshes the
store and explains. The open store refreshes itself when the daily or weekly
shelves rotate. Purchases of one player run under their wallet lock from the
first statement, so two purchases of the same item with different
idempotency keys charge once (the second gets `already_owned`). Every route
that spends, refunds or starts a payment (store, Gem checkout, Crown Shard
shop, pass premium, gifts, refunds) answers **503 `maintenance`** during a
maintenance window and closes with `store.enabled`.

`GET /purchases` lists a player's completed purchases with each one's refund
and whether it can be refunded now, and why not, newest first, 50 at a time
(`?before=<nextCursor>` for older pages). `POST
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
  the purchase row's lock and then the buyer's wallet lock (the order the
  Stripe webhook takes them in): a double or concurrent submit returns the
  first refund with `replayed: true`. A denied request cannot be filed again.
- **Collections wait for the window.** Store purchases still inside their
  7-day refund window do not count toward "cosmetics owned" achievements;
  they count once the window has passed. Otherwise buying a bundle, collecting
  the achievement's rewards and refunding the bundle would keep them for free.
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

### 3.4 Gifts and wish lists

A player can buy any store item or bundle for a friend with their own
Gumballs or Gems, at the price they would pay today (the day's deal or
weekly discount applies; a bundle is priced on the items the **recipient**
still lacks). Crown Shard shop items and the Season Pass can never be
gifted. `apps/api/src/economy/gifts.ts` holds the policy as one pure
function; the API enforces every rule, the client only shows its answers.

| Rule                                          | Value                    | Refusal (status)                    |
| --------------------------------------------- | ------------------------ | ----------------------------------- |
| Sender is a linked account, not a guest       | —                        | `gift_account_required` (403)       |
| Sender's account age                          | ≥ 7 days                 | `gift_account_too_new` (403)        |
| Gifts sent per UTC day (any outcome counts)   | 5                        | `gift_daily_limit` (429)            |
| Mutual friends (a block reads as not friends) | —                        | `gift_not_friends` (403)            |
| Friendship age (since it was accepted)        | ≥ 3 days                 | `gift_friendship_too_new` (403)     |
| Recipient not suspended                       | —                        | `gift_recipient_unavailable` (409)  |
| Recipient does not own any of the items       | checked at send and open | `gift_already_owned` (409)          |
| Item not already waiting in an unopened gift  | —                        | `gift_already_pending` (409)        |
| Unopened gifts per recipient                  | 30                       | `gift_inbox_full` (409)             |
| Optional note                                 | ≤ 80 chars, chat filter  | `gift_message_muted` (403) if muted |
| No open Gem pack refund request (Gem gifts)   | —                        | `gift_refund_pending` (409)         |

Refusals that lift on their own carry `retryAt`. A guest may **receive**
gifts. A chat-muted sender may still gift, without a note. Like a purchase,
`POST /gifts` takes the `expectedPrice` the picker showed and answers **409
`price_changed`** with the new quote if it moved. Gem gifts wait while the
sender has a real-money refund request `pending`, `processing` or `manual`:
Gems spent on a gift survive a chargeback, since the friend keeps the item.

- **Money.** Sending charges the sender with one `gift` ledger row, ref
  `gift:<giftId>`, in the same transaction that files the gift. The recipient
  gets nothing until they open it; opening grants the items with inventory
  source `gift` (no currency moves). Any refund is one `gift_refund` row with
  the same ref, so a gift can be refunded at most once. Gems coming back
  repay Gem debt first, like any Gem credit.
- **Once, even concurrently.** `POST /gifts` takes an `Idempotency-Key`; a
  repeat (even a concurrent one, even after a chat mute) replays the first
  gift, and the same key with a different recipient, offer, currency or note
  is refused as `idempotency_key_reused`. Every gift operation
  locks both players' profiles in id order before deciding, so two friends
  gifting the same item to one player at once get one gift and one
  `gift_already_pending`, and a decline racing a cancel settles once.
- **Opening.** If the recipient owns any item of the gift by the time it is
  opened (bought it, earned it), nothing is granted and the gift is
  **returned**: the sender is refunded in full. Opening takes the items off
  the recipient's wish list.
- **Declining** (recipient) or **cancelling** an unopened gift (sender)
  refunds the sender in full.
- **Auto-accept.** An unopened gift opens by itself 30 days after it was sent
  (on either player's next look at their gifts, or the retention sweep), and
  from then on it can no longer be declined or cancelled.
- **No refunds after opening.** Gifts are not purchases: they never appear in
  `GET /purchases`, so neither side can self-refund one. A store refund only
  ever removes `store` copies, so it never touches a gifted item.
- **Staff.** An admin can reverse a gift from the console: the sender is
  refunded in full and, if it was opened, the items the recipient still holds
  _because of the gift_ are taken back (and off every loadout). An item the
  recipient has since also earned another way is re-sourced by that grant and
  stays, as with store refunds. A plain staff cosmetic revoke on the
  recipient moves no currency. If the sender's Gems came from a pack that is
  later refunded or charged back, the existing rule applies: Gems are taken
  back (shortfall as Gem debt) and cosmetics, gifted ones included, are kept.
- **Kill switches.** Sending, declining and cancelling (the routes that move
  currency) close with the store (`store.enabled` off → `503`); every gift
  action is refused during maintenance.
- **Account deletion.** Deleting the recipient returns their unopened gifts
  to the senders (refunded, note `recipient_deleted`). Deleting the sender
  erases the notes they wrote; their unopened gifts stay with the recipients,
  already paid for, and declining one then refunds nobody. Either side's
  history keeps the gift with the deleted party shown as gone.

**Wish lists.** Up to 50 store items or bundles in the player's own order,
visible to friends (default) or nobody; anyone else, including a blocked
player, gets the same `wishlist_hidden` answer. A friend's profile card shows
their list with a Gift button per entry. When a wished-for item is on the
day's shelves, the player is told once per store rotation (the first time
their client asks for the store, the list or their gifts that UTC day),
unless they switched alerts off. Buying or being gifted an entry removes it,
and a wished-for bundle leaves the list once the player owns every item in
it, however they came by them. `GET /gifts` returns the newest 50 settled
gifts each way with `nextCursor`; `GET /gifts/history?direction=&before=`
pages further back.

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

## 6. Club goals

- Data: `CLUB_GOALS` in `packages/shared/src/social/clubs.ts`; the API counts
  them in the match-ingest transaction (`apps/api/src/clubs/goals.ts`).
- Every club gets three goals per ISO week (Monday 00:00 UTC). A member's
  granting show adds to their club's goals; custom lobbies never count. The
  target is fixed the first time the week counts a show, from the member count
  at that moment, so joins and leaves mid-week never move the finish line.

| Goal    | Counts                | Target per member | Range  | Reward per member      |
| ------- | --------------------- | ----------------- | ------ | ---------------------- |
| Shows   | 1 per member show     | 5                 | 10–150 | 2,000 XP, 100 Gumballs |
| Qualify | rounds qualified from | 8                 | 15–250 | 2,500 XP, 100 Gumballs |
| Crowns  | Crowns won            | 0.4               | 2–20   | 3,000 XP, 150 Gumballs |

- Who is paid: every member who played at least one show for the club that
  week and is still in the club when the reward is claimed or settled.
  Leaving a club forfeits its unclaimed rewards.
- Claims and settlement: a finished goal can be claimed at once; anything left
  unclaimed after the week pays out automatically the next time the member
  opens their club, through the same guard as a claim.
- Idempotency: the ledger ref is `club:<clubId>:<week>:<goalId>` (reason
  `club_reward`), and `club_reward_claims` is keyed by **player, week and
  goal**, not club, so a player who hops clubs mid-week still collects each
  goal at most once that week.

**Budget.** Club goals pay XP and Gumballs only, never Gems or cosmetics, so
the §3 Gem budget and the premium pass price are untouched. The most one
player can earn is 7,500 XP and 350 Gumballs a week (97,500 XP and 4,550
Gumballs over a 13-week season): about half a week of weekly challenges'
XP and a few days of regular play's Gumballs. A one-member club can only
finish a goal at its minimum target, which a solo player reaches no faster
than the weekly challenges they already have.
