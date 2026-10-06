# Decisions

Short log of design choices made under uncertainty. Newest last.

## TypeScript 5.9, not 7

The spec asks for TS 5.x. TS 7 (native port) is out, but typescript-eslint
supports `<6.1`. Revisit when the lint toolchain catches up.

## Source-only internal packages

Workspace packages export `src/*.ts` directly. Vite and `tsx` compile on the
fly, so there is no per-package build step and no stale `dist/` during dev.

## Bare `three` aliased to `three/webgpu`

Addons import `'three'`. Aliasing it to the WebGPU build keeps a single copy of
the core in the bundle, as three's own WebGPU examples do with import maps.

## TSL post-processing instead of pmndrs `postprocessing`

`postprocessing` targets `WebGLRenderer` only. Three's TSL post nodes run on
both WebGPU and the WebGL2 fallback, which the spec requires to look identical.

## `ws` first, uWebSockets.js behind a transport interface

uWS ships as a GitHub-hosted native binary, which complicates Windows dev and
CI. The server talks to a `Transport` interface; `ws` implements it now, and a
uWS adapter can drop in once the tick budget shows the socket layer matters.

## Determinism check compares f32 bit patterns

Rapier stores state as f32. Hashing float32 bits gives an exact equality check
that is immune to f64 formatting, with a separate max-error figure for the
spec's "within tolerance" criterion.

## Canvas-atlas text instead of troika-three-text

troika builds classic GLSL materials and imports `ShaderChunk`/`ShaderLib`
from `three`, which the WebGPU build (and our `three` alias) does not export.
Nameplates and signs draw into canvas atlases rendered by TSL materials, so
they work on both backends.

## Feet positions for spawns and teleports

Controllers take feet positions; the body sits at the capsule centre. Round
data authors floor points, so spawn/respawn only add a few centimetres of
clearance (`SPAWN_LIFT`).

## Bloom only above rim light; no screen-space edge outline

The toon material's rim light is written to the emissive target that feeds
selective bloom, so with a low threshold every silhouette glowed and the
image looked hazy. Themes now bloom above 0.75, which is brighter than any
rim, so only real emissives (telegraphs, lights, VFX) glow. The screen-space
edge outline is off in every preset: it traced blob-shadow decals as squares
under each Tumbler and fringed edges, while characters already carry an
inverted-hull outline.

## Lag compensation as a server hit assist, not a rewind inside the sim

The spec promises ≤ 150 ms rewind for grab and dive hits. Rewinding Rapier
bodies inside `MatchSim.step` would make every step depend on per-client RTTs,
break the prediction contract (client and server stepping the same function)
and cost a world snapshot/restore per check. Instead the room records one pose
per network tick (`LagCompensator`) and, after each authoritative step, checks
each human's fresh grab press or ongoing dive against the other players'
poses rewound to that client's view time (RTT/2 + 100 ms render delay, capped
at 150 ms). When the client's view connected and the target is still within a
small present-day distance, the room calls `assistGrab` / `assistTackle` on
the sim, which run the controller's own grab/tackle path with every normal
eligibility rule. The assist can only add a hit the client saw, never move a
body back in time, so the sim stays a deterministic function of its inputs
plus these explicit, counted commands (`tumble_lagcomp_assists_total`).
Replays that re-simulate from inputs alone must record assists as events.

## The pre-show platform is a live lobby sim

Online, the waiting platform runs as a rule-less match sim (`lobby: true`)
on `PRE_SHOW_LOBBY_ROUND`, streamed through the same snapshot, prediction and
reliable-event pipeline as rounds (at half the snapshot rate). Using the real
Tumbler controller keeps grabs, dives, bumps and emotes identical to rounds;
`addPlayer`/`removePlayer` let people drop in and leave without rebuilding the
world (a rebuild would pop every Tumbler back to a spawn grid). A dropped
connection keeps its Tumbler idling until the resume window ends, so resumes
never flash a despawn. Offline shows keep the local pre-show.

## Self-hosting is one Compose stack on one origin

`deploy/docker-compose.yml` puts every service behind a single Caddy edge on
one domain (`/api`, `/mm`, `/gs/ws`) instead of a hostname per service. One
origin means one certificate, no cross-origin requests between the client and
its services, and one client build that works for any domain (it defaults to
same-origin paths and reads `/config.json`). Caddy was picked for automatic
HTTPS with no extra container or cron job. Game servers are the exception:
players connect to each one directly, so every extra game server gets its own
hostname (`deploy/game-server/`) rather than a path on the main edge, which
would route every show through one host. There is deliberately no monitoring
stack in the bundle: `/health`, `/ready` and token-protected `/metrics` are
there for whatever the operator already runs.

## Achievements count inside the match ingest transaction

Achievement totals are written in the same transaction that inserts the
`matches` row, so they inherit its idempotency: a replayed report replays the
stored summary, and a concurrent duplicate fails on the primary key and
replays too. A separate per-match log would only duplicate that guarantee.
Unlocks are rows keyed by (player, achievement), so each reward is granted
once, and their currency is also keyed `achievement:<id>` on the ledger. XP
from unlocks is folded into the show's own XP so the rewards screen and the
level bar stay truthful. Metrics the history can rebuild (shows, Crowns,
qualifies by round type, finals, best win streak) are backfilled by the
migration; the rest start at zero.

## The login streak is keyed by the server's UTC day

The client sends nothing when it claims: the day is `dayKey(now)` on the API
clock, so time zones, DST and a wrong device clock cannot move it. The claim
locks the streak row and advances it with an update that only matches when
today is unclaimed, so racing claims pay once (`login:<day>` on the ledger is
a second guard). A claim recorded for a later day than today, which can only
mean the clock stepped back, counts as already claimed rather than rewinding
the streak.

## Seasonal challenges settle like the pass

Seasonal challenges are keyed by season id and stop counting when the season
ends. Completed but unclaimed ones are paid out automatically on the next
challenges read, the same rule as unclaimed pass tiers: nothing earned is
lost. Milestones are one append-only list whose index is the stored slot, so
new ones can be added without disturbing anyone's progress.

## The admin console is a second Vite entry, signed in through staff accounts

The console lives at `/admin`, built from `apps/client/admin.html` as its own
entry rather than a route inside the game. The game's entry eagerly imports
the renderer, physics and audio, so a lazily loaded route would still make a
moderator download the whole game, and a shared entry risks the console's
code leaking into the players' bundle. A separate entry shares only React and
the small account client with the game, and a test walks both import graphs
to keep it that way. Plain CSS with a few copied palette colours keeps it from
pulling `@tumble/shared` in for theming.

Browsers never see `ADMIN_TOKEN`. It stays with the CLI, which grants the
`admin` or `moderator` role to a non-guest account (`staff_members`). The
console trades that account's normal access token for a 30-minute bearer
token stored only in `sessionStorage`; the API keeps the session in the KV
under the token's hash and re-reads the staff row and ban state on every
request, so revocation is immediate and every audit row names a real person.
Bearer headers instead of cookies make the console immune to CSRF without a
token dance. Moderators get reports, sanctions and player pages; currency,
cosmetics, live ops and staff management need `admin`.

Every admin action, from the CLI or the console, writes one row to an
append-only `admin_audit_log` (instead of the old `audit.admin.*` analytics
events) inside the action's transaction, so an action without its audit row
cannot commit. The table has no foreign keys: deleting a staff or player
account must not delete the record of what was done to or by it.

## Refunds: self-service for currency, staff review for money

Store purchases paid in Gumballs or Gems are refunded by the player at once
(7 days, 3 a year), while Gem packs only ever become a request an admin
approves. Currency refunds are cheap to undo and abuse is bounded by the
limit; real money involves the payment provider, fraud and chargeback
history, so a person decides. "Unused" was dropped as a rule because the
game does not record what was worn in which show; the window and the yearly
limit bound "wear it, then refund" instead.

A Gem pack refund does not move Gems by itself. Approval asks Stripe to
refund, and the existing `charge.refunded` reconciliation takes the Gems back
(debt for any already spent, cosmetics kept), so a refund we issue and one
issued from the Stripe dashboard or forced by a dispute follow one rule. The
Stripe call runs after the transaction that records the decision and its
audit row, never inside it: a slow provider cannot hold row locks, a second
approval sees the request already `processing`, and a webhook that lands
before Stripe answers is not overwritten. A failure goes back to staff as
`failed`, and a retry uses a new idempotency key because Stripe would replay
the failed refund for the old one.

## Share cards and clips are made and kept on the device

Cards and clips are rendered, encoded and handed over entirely in the
browser: Web Share with files where it can, else a download, else (cards)
the clipboard. Nothing is uploaded and there is no share link, so there is
no storage, moderation queue or retention policy to run, and a card can never
leak other players' names: it carries none, and the player's own is opt-in
(off by default in Streamer Mode). A hosted share page can come later as an
explicit opt-in.

Clips re-render the recorded round offscreen rather than capturing the
screen: the recording already holds everything, the result does not depend
on what was on screen or how fast the device ran, and the menu stays usable
while it renders. The live post pipeline is bound to the canvas size, so
clips use a small output pass of their own (tone mapping and the round's
grade, no bloom). Rendering needs the main thread's GPU context, so there is
no worker: WebCodecs already encodes off the main thread, and the loop
renders one frame per animation frame with encoder back-pressure. The MP4 and
WebM muxers are written in-house (one video track, laid out once the samples
are known) because the small npm muxers are either deprecated or not
MIT/Apache.

## Gifts are their own ledger records, not purchases

A gift is a `gifts` row plus at most two ledger rows on the sender (`gift`
and `gift_refund`, both ref `gift:<id>`), not a `purchases` row on either
side. Reusing purchases would have put gifts into `GET /purchases` and the
self-service refund path, letting a recipient refund something they never
paid for, or a sender refund an item someone else already wears. Keeping
them apart makes "no refund after opening" structural instead of a special
case in the refund policy.

The recipient's copy has inventory source `gift`, which store refunds never
touch and a staff reversal removes; an earned grant re-sources it, as it
already did for `store` copies, so a reversal never takes an item the player
earned another way. Every gift operation locks both profiles in id order
before deciding, which serialises double submits, two friends gifting the
same item, and decline/cancel races without a lock table of its own.
Overdue gifts are auto-accepted lazily on read and by the retention sweep,
so the 30-day rule needs no new background process.

## Voice chat is a peer-to-peer mesh, not an SFU

Voice rooms are small: a party is at most 4 players, and team voice splits a
team into squads of at most 8. In a full mesh each player uploads one Opus
stream per peer, about 30 kbit/s each, so even a full squad costs ~210 kbit/s
up, which any connection that can play the game already has. An SFU would
cut that to one upload but adds a media server to run, scale and secure, and
puts every conversation's audio through infrastructure the operator then has
to explain. Self-hosters already run a TURN relay for players behind strict
NATs; a mesh needs nothing else.

The cost of the mesh is that peers who connect directly see each other's IP
addresses. Players can choose "Relay only", which forces TURN and hides it;
the first-use dialog says so before the microphone is ever requested.

Squads are fixed when a team round starts (parties first, largest first, then
solo players) rather than "the 8 nearest teammates", because proximity
changes every second and every regrouping would tear down and renegotiate
connections mid-round. Signalling rides the existing authenticated realtime
socket instead of a new endpoint, so origin checks, bans and cross-instance
delivery come for free; the API decides room membership from server state
and re-checks it on every relayed message.

## Custom rounds: one validator, no physics, the server ships the definition

Player-made rounds are untrusted data that run on the same game servers as
built-in rounds, so one validator (`@tumble/content/custom`) runs unchanged in
the editor, in the API on every publish and update, and on the game server
before a show plays the round, and again on each client before it builds
what the server sent. The editor's verdict is never trusted.

The playability checks (spawn on solid ground, reachable finish) use a
physics-free model of walkable surfaces rather than Rapier: the API does not
ship the physics engine, and the same answer everywhere matters more than a
precise one. The model errs toward "reachable"; a false "unreachable" would
block a fair round, while a false "reachable" is caught by Test play.

Shared rounds are not in any client build. The game server fetches the
stored definition over the signed internal channel when a private show
starts, holds the show in its lobby until it has it, and sends the exact
definition in `joinRound`, so the authoritative sim and every prediction sim
build the same round. Codes that are gone or fail validation drop out and the
show falls back to its base playlist instead of stalling. A takedown stops a
code for the editor, lobbies and every show created afterwards; a show
already running finishes with its copy.

Publishing needs a full (non-guest) account: shared rounds reach other
players and must be attributable, and a guest account is one cookie clear
away from gone. Guests still build, save locally and test play. Bots on
custom races follow generated straight legs between checkpoints with jumps at
gaps, and the editor says when a leg crosses a gap they cannot jump; we chose
honest and simple over a navmesh.

The editor is its own Vite entry (`/editor`): players never download it with
the game, and it shares the origin so it can reuse the player's session and
hand Test play rounds to the game tab through IndexedDB.
