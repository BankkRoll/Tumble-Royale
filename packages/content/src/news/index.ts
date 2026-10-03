/**
 * News feed: player-facing posts for the menu's News tab (season launch, round
 * guide, controls, patch notes, tips and events), newest first.
 *
 * Hero and inline images are real stills rendered from the level viewer and
 * menu by `apps/client/e2e/capture-news.spec.ts`, served from
 * `apps/client/public/news/`.
 */
import { z } from 'zod';

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/** One block of a post body. Mirrors the UI's `NewsBlock`. */
export const NewsBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: z.string().min(1) }),
  z.object({ type: z.literal('heading'), text: z.string().min(1) }),
  z.object({ type: z.literal('list'), items: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('image'), src: z.string().startsWith('/'), caption: z.string().optional() }),
  z.object({ type: z.literal('tip'), text: z.string().min(1) }),
]);

/** One block of a post body. */
export type NewsBlock = z.output<typeof NewsBlockSchema>;

/** Post category, shown as the card's tag. */
export const NewsTagSchema = z.enum(['SEASON', 'ROUNDS', 'HOW TO PLAY', 'PATCH NOTES', 'TIPS', 'EVENT']);

/** Post category, shown as the card's tag. */
export type NewsTag = z.output<typeof NewsTagSchema>;

const hex = z.string().regex(/^#[0-9a-f]{6}$/i);

/** A news post. */
export const NewsPostSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  /** One or two sentences for the card teaser. */
  summary: z.string().min(1),
  body: z.array(NewsBlockSchema).min(1),
  tag: NewsTagSchema,
  /** Publish date, `yyyy-mm-dd`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Hero image URL (served from the client's public dir). */
  image: z.string().startsWith('/').optional(),
  /** Round the post is about, when it is about one. */
  roundId: z.string().optional(),
  /** Card gradient, top → bottom. */
  art: z.tuple([hex, hex]),
  /** Decorative emoji for the card; never the only carrier of meaning. */
  icon: z.string().min(1),
  /** Pinned to the large carousel slot. */
  featured: z.boolean().optional(),
});

/** A news post. */
export type NewsPost = z.output<typeof NewsPostSchema>;

// -----------------------------------------------------------------------------
// Round guide
// -----------------------------------------------------------------------------

/** Public URL of a round's still. */
const roundImage = (id: string): string => `/news/rounds/${id}.jpg`;

interface RoundBlurb {
  id: string;
  name: string;
  kind: string;
  text: string;
  caption: string;
}

/** Launch rounds in show order; text is written from each round's objective and tips. */
const ROUND_GUIDE: readonly RoundBlurb[] = [
  {
    id: 'gumdrop-gauntlet',
    name: 'Gumdrop Gauntlet',
    kind: 'Race',
    text: 'Smash through a wall of candy doors (some are fakes!), then weave past spinning wheels, swinging hammers and rolling gumdrops to the finish.',
    caption: 'Follow the crowd: the doors that burst open are the real ones.',
  },
  {
    id: 'conveyor-chaos',
    name: 'Conveyor Chaos',
    kind: 'Race',
    text: 'Belts flip direction mid-run and punch walls wind up to bop you off. Read the chevron lights and ride the flow to the line.',
    caption: 'Chevrons flash right before a belt reverses.',
  },
  {
    id: 'tilt-town',
    name: 'Tilt Town',
    kind: 'Race',
    text: 'A wobbly town of tipping plates and seesaws over the void. Balance is everything, and so is avoiding the crowd.',
    caption: 'Plates tip toward the heaviest side, so go where others aren’t.',
  },
  {
    id: 'slip-n-spiral',
    name: "Slip 'n' Spiral",
    kind: 'Race',
    text: 'Slide down a frozen spiral while giant snowballs chase you. Ice keeps your momentum, so start your turns early.',
    caption: 'Snow islands give grip on the rink.',
  },
  {
    id: 'hammer-highway',
    name: 'Hammer Highway',
    kind: 'Race',
    text: 'Narrow bridges, crumbling stones and hammers swinging on a beat, all the way to the throne at the end.',
    caption: 'Count the beat before you cross.',
  },
  {
    id: 'wind-tunnel-peaks',
    name: 'Wind Tunnel Peaks',
    kind: 'Race',
    text: 'A climb to the top of the sky. Ride glowing updrafts, duck behind rocks when the gusts hit, and float through low-gravity gaps.',
    caption: 'Glowing columns are updrafts: jump in and drift.',
  },
  {
    id: 'cannonball-canyon',
    name: 'Cannonball Canyon',
    kind: 'Race',
    text: 'Sprint the canyon under fire from coconut cannons while giant balls roll down the lanes.',
    caption: 'Red rings on the ground mark where the next shot lands.',
  },
  {
    id: 'spin-cycle',
    name: 'Spin Cycle',
    kind: 'Survival',
    text: 'Two bars sweep the drum. Jump the low yellow bar, dive under the striped red one, and stay off the outer ring when it drops away.',
    caption: 'Yellow = jump. Striped red = dive.',
  },
  {
    id: 'tile-panic',
    name: 'Tile Panic',
    kind: 'Survival',
    text: 'Tiles crumble the moment you touch them, across three layers. Keep moving and save tiles by jumping.',
    caption: 'Airtime doesn’t crack tiles.',
  },
  {
    id: 'rising-goo-tower',
    name: 'Rising Goo Tower',
    kind: 'Survival',
    text: 'The goo is rising! Climb the tower by stairs (slow and safe) or bounce pads (fast, if you aim well) and stay above the surge.',
    caption: 'The goo surges when the drums kick in.',
  },
  {
    id: 'jump-rope-royale',
    name: 'Jump Rope Royale',
    kind: 'Survival',
    text: 'Two rings of spinning ropes turn in opposite directions. Jump the glowing ones, dive under the striped ones, and don’t get caught between.',
    caption: 'Watch the rope that’s coming at you, not the other one.',
  },
  {
    id: 'egg-heist',
    name: 'Egg Heist',
    kind: 'Team',
    text: 'Carry eggs back to your team’s nest, and steal from everyone else’s. Golden eggs show up at 60 seconds and are worth five.',
    caption: 'Hold Grab to pick up an egg.',
  },
  {
    id: 'bounce-ball-blitz',
    name: 'Bounce Ball Blitz',
    kind: 'Team',
    text: 'Two teams, one giant ball, two goals. Dive into the ball for a big kick, and look out for the second ball at 60 seconds.',
    caption: 'Bounce pads launch the ball too.',
  },
  {
    id: 'paint-the-plaza',
    name: 'Paint the Plaza',
    kind: 'Team',
    text: 'Four teams race to cover the plaza in their colour. Dive to splash big blobs and grab buckets for a super-roller.',
    caption: 'Raised stages count double.',
  },
  {
    id: 'tail-chase',
    name: 'Tail Chase',
    kind: 'Hunt',
    text: 'Hold a tail when the clock hits zero. Sneak up from behind to steal one, then run for the bounce pads.',
    caption: 'Just stole a tail? You’re safe for a moment, so run!',
  },
  {
    id: 'pattern-panic',
    name: 'Pattern Panic',
    kind: 'Logic',
    text: 'Memorise the symbols while the tiles are lit, then stand on the one the big screen asks for before time runs out.',
    caption: 'Later rounds bring two targets and tricky NOT rounds.',
  },
  {
    id: 'crown-climb',
    name: 'Crown Climb',
    kind: 'Final',
    text: 'Race up the castle past hammers, sweepers and elevators, then leap for the floating Crown. First to grab it wins the show.',
    caption: 'Jump at the Crown: it floats just out of reach.',
  },
  {
    id: 'last-tumbler-standing',
    name: 'Last Tumbler Standing',
    kind: 'Final',
    text: 'Three layers of ice hexes crack under your feet. Keep moving, break the ice around your rivals, and be the last one up.',
    caption: 'A fall only ends it on the bottom layer.',
  },
  {
    id: 'spin-cycle-finale',
    name: 'Spin Cycle Finale',
    kind: 'Final',
    text: 'The drum returns with three bars and a floor that shrinks every 30 seconds. Last one spinning takes the Crown.',
    caption: 'Low, high… and another low.',
  },
  {
    id: 'goo-peak-final',
    name: 'Goo Peak Final',
    kind: 'Final',
    text: 'Climb a peak of cracking rings while the goo closes in from below. The summit is tiny, and the goo never stops.',
    caption: 'Break the ring above a rival to strand them.',
  },
];

const roundGuideBlocks: NewsBlock[] = ROUND_GUIDE.flatMap((r): NewsBlock[] => [
  { type: 'heading', text: `${r.name} · ${r.kind}` },
  { type: 'paragraph', text: r.text },
  { type: 'image', src: roundImage(r.id), caption: r.caption },
]);

// -----------------------------------------------------------------------------
// Posts
// -----------------------------------------------------------------------------

/** Every news post, newest first. Validated at load. */
export const NEWS_POSTS: readonly NewsPost[] = z.array(NewsPostSchema).parse([
  {
    id: 'season-1-sugar-rush',
    title: 'Season 1: Sugar Rush is live!',
    summary:
      'A brand-new 100-tier Season Pass, fresh challenges every day and a sweet new look for the Store. Grab your Gumballs and dive in.',
    tag: 'SEASON',
    date: '2026-10-01',
    image: '/news/season.jpg',
    art: ['#ff2e93', '#00e0ff'],
    icon: '🍭',
    featured: true,
    body: [
      {
        type: 'paragraph',
        text: 'Season 1: Sugar Rush has arrived! Every show you play now earns Season XP, whether you take the Crown or tumble out in round one.',
      },
      { type: 'heading', text: 'A 100-tier Season Pass' },
      {
        type: 'paragraph',
        text: 'The pass has two tracks. The free track is open to everyone and pays out on almost every tier. The premium track adds a reward on every single tier, and it pays back most of its price in Gems along the way.',
      },
      {
        type: 'list',
        items: [
          'Over a hundred brand-new Sugar Rush cosmetics: colours, patterns, hats, faces, trails, emotes, nameplates, banners and more.',
          'Every 10th tier is a showcase reward on both tracks.',
          'Tiers 25, 50 and 75 hold premium legendaries.',
          'Tier 100 unlocks the Sugar Rush colour on the free track and a mythic victory pose on premium.',
        ],
      },
      { type: 'heading', text: 'Challenges' },
      {
        type: 'paragraph',
        text: 'Three daily and six weekly challenges refresh on their own. Qualify, grab, dive, win rounds or win a Crown to finish them for bonus XP and Gumballs.',
      },
      { type: 'heading', text: 'Store' },
      {
        type: 'paragraph',
        text: 'The Store rotates featured outfits and items regularly. Spend Gumballs earned from shows, or Gems if you’re after something special. Everything is cosmetic: nothing you buy changes how you play.',
      },
      { type: 'heading', text: 'Crowns' },
      {
        type: 'paragraph',
        text: 'Win a show to take home a Crown. Reaching the final earns Crown Shards, and 60 shards combine into a full Crown, so every deep run counts.',
      },
      { type: 'tip', text: 'Your first show of the day earns bonus XP. Hop in for at least one!' },
    ],
  },
  {
    id: 'meet-the-rounds',
    title: 'Meet the rounds',
    summary:
      'Twenty rounds of races, survivals, team games, a hunt, a memory test and four finals. Here’s what to expect in each one.',
    tag: 'ROUNDS',
    date: '2026-09-30',
    image: roundImage('crown-climb'),
    roundId: 'crown-climb',
    art: ['#7c5cff', '#5ce1e6'],
    icon: '🗺️',
    featured: true,
    body: [
      {
        type: 'paragraph',
        text: 'Every show is 3–5 rounds drawn at random, ending in a final where one Tumbler takes the Crown. Races want you over the line, survivals want you on your feet, team rounds need your crew, and finals crown a single winner.',
      },
      {
        type: 'tip',
        text: 'Every round shows its goal and a few tips on the intro card. Give it a read while the camera flies over the course.',
      },
      ...roundGuideBlocks,
    ],
  },
  {
    id: 'team-up-duos-squads-chaos',
    title: 'Team-up time: Duos, Squads & Chaos Mode',
    summary:
      'Bring a buddy, bring your whole crew, or bring your nerves of steel. Three playlists are in the rotation now.',
    tag: 'EVENT',
    date: '2026-09-28',
    image: roundImage('paint-the-plaza'),
    roundId: 'paint-the-plaza',
    art: ['#ff8a3d', '#ff4f8b'],
    icon: '🤝',
    body: [
      { type: 'paragraph', text: 'Pick a playlist next to the big PLAY button in the menu.' },
      { type: 'heading', text: 'Duos' },
      {
        type: 'paragraph',
        text: 'Team up with a buddy. If either of you qualifies, you both go through, and if one of you wins, you share the Crown. Team and hunt rounds show up more often.',
      },
      { type: 'heading', text: 'Squads' },
      {
        type: 'paragraph',
        text: 'Four-player squads with team rounds front and centre. Carry your crew to the final, where up to 12 Tumblers fight it out.',
      },
      { type: 'heading', text: 'Chaos Mode' },
      {
        type: 'paragraph',
        text: 'Everything spins faster, the cuts are brutal and the bots are sharp. Expect more survival rounds, plus extra helpings of Cannonball Canyon, Hammer Highway, Tile Panic and Spin Cycle. Only 8 make the final.',
      },
      {
        type: 'tip',
        text: 'Invite friends with a party link from the menu. Parties hold up to four players.',
      },
    ],
  },
  {
    id: 'patch-1-1',
    title: 'Patch 1.1: Four new rounds and fairer finals',
    summary:
      'Hammer Highway, Wind Tunnel Peaks, Cannonball Canyon and Spin Cycle join the show, plus a round of fixes for finals, bounces and ropes.',
    tag: 'PATCH NOTES',
    date: '2026-09-26',
    image: roundImage('hammer-highway'),
    roundId: 'hammer-highway',
    art: ['#3fa9ff', '#7c5cff'],
    icon: '🛠️',
    body: [
      { type: 'heading', text: 'New rounds' },
      {
        type: 'list',
        items: [
          'Hammer Highway (Race): bridges, falling stones and a whole lot of hammers.',
          'Wind Tunnel Peaks (Race): ride updrafts to the top of the sky.',
          'Cannonball Canyon (Race): dodge coconut cannons and giant rolling balls.',
          'Spin Cycle (Survival): jump the low bar, dive under the high one.',
        ],
      },
      { type: 'image', src: roundImage('wind-tunnel-peaks'), caption: 'Wind Tunnel Peaks' },
      { type: 'heading', text: 'Gameplay fixes' },
      {
        type: 'list',
        items: [
          'Finals now always crown exactly one winner.',
          'Bounce pads only launch you when you land on them from above, not when you brush their sides.',
          'Jump ropes now trip you properly when they catch your feet.',
        ],
      },
      { type: 'heading', text: 'Comfort' },
      {
        type: 'list',
        items: [
          'The screen transition between rounds is now a candy-stripe sweep instead of a bright white flash.',
          'Gem purchases always go through secure checkout.',
        ],
      },
    ],
  },
  {
    id: 'how-to-play',
    title: 'How to play & controls',
    summary:
      'Run, jump, dive and grab your way to the Crown. Here are the controls for keyboard, gamepad and touch.',
    tag: 'HOW TO PLAY',
    date: '2026-09-24',
    image: '/news/howto.jpg',
    art: ['#6ee7a8', '#3fa9ff'],
    icon: '🎮',
    body: [
      {
        type: 'paragraph',
        text: 'Up to 40 Tumblers enter a show. Each round, only some go through: finish the race, survive the longest, or help your team win. Make it through the final and the Crown is yours.',
      },
      { type: 'heading', text: 'Keyboard & mouse' },
      {
        type: 'list',
        items: [
          'Move: W A S D or the arrow keys',
          'Jump: Space',
          'Dive: Left click, C or Ctrl',
          'Grab: hold Right click or Shift',
          'Emotes: 1–4, or hold E for the emote wheel',
          'Camera: move the mouse (click the game to lock the pointer)',
        ],
      },
      { type: 'tip', text: 'Every key can be rebound in Settings.' },
      { type: 'heading', text: 'Gamepad' },
      {
        type: 'list',
        items: [
          'Move: left stick · Camera: right stick',
          'Jump: A',
          'Dive: X or B',
          'Grab: hold RT or RB',
          'Emotes: D-pad, or hold Y for the emote wheel',
        ],
      },
      { type: 'heading', text: 'Touch' },
      {
        type: 'list',
        items: [
          'Move: drag anywhere on the left half of the screen for a floating joystick',
          'Camera: drag on the right half',
          'Jump, Dive, Grab and Emote: on-screen buttons',
        ],
      },
      { type: 'heading', text: 'The basics' },
      {
        type: 'list',
        items: [
          'Fall off in a race and you respawn at the last checkpoint.',
          'Get bonked hard and you’ll tumble for a moment, then pop back up.',
          'You ride moving and spinning platforms, so stand still and let them carry you.',
          'Grab a ledge to hang on, then press Jump to climb up.',
        ],
      },
    ],
  },
  {
    id: 'tips-dive-like-a-pro',
    title: 'Tips: Dive like a pro',
    summary:
      'Diving is the fastest way to cover a gap, duck a bar or steal a finish. Here’s how to make every dive count.',
    tag: 'TIPS',
    date: '2026-09-21',
    image: roundImage('spin-cycle'),
    roundId: 'spin-cycle',
    art: ['#ffd23f', '#ff8a3d'],
    icon: '💨',
    body: [
      {
        type: 'paragraph',
        text: 'A dive throws you forward and slightly up, then into a belly slide. Getting back up takes a moment, so pick your dives.',
      },
      { type: 'heading', text: 'When to dive' },
      {
        type: 'list',
        items: [
          'Jump, then dive at the top of the jump to stretch across gaps you can’t clear on foot.',
          'Dive under striped red bars in Spin Cycle and Jump Rope Royale.',
          'Dive over the finish line to beat someone by a nose.',
          'In Bounce Ball Blitz, diving into the ball gives it a big kick.',
          'In Paint the Plaza, a dive splashes a big blob of your colour.',
        ],
      },
      { type: 'heading', text: 'When not to' },
      {
        type: 'paragraph',
        text: 'On ice and tilting plates, a dive can slide you right off the edge. On a narrow bridge, a mistimed dive is a long way down.',
      },
      {
        type: 'tip',
        text: 'Jump-then-dive chains are faster than running on open ground, but only if you land them cleanly.',
      },
    ],
  },
  {
    id: 'tips-grab-hang-haul',
    title: 'Tips: Grab, hang and haul',
    summary:
      'Grab does a lot more than slow down rivals. Climb ledges, carry eggs and steal tails with one button.',
    tag: 'TIPS',
    date: '2026-09-18',
    image: roundImage('egg-heist'),
    roundId: 'egg-heist',
    art: ['#ff6fb5', '#ffd23f'],
    icon: '✊',
    body: [
      {
        type: 'paragraph',
        text: 'Hold Grab to grab whatever is right in front of you: another Tumbler, a ledge or a prop.',
      },
      { type: 'heading', text: 'Ledges' },
      {
        type: 'paragraph',
        text: 'Missed a jump by a hair? Hold Grab as you reach the edge to hang on, then press Jump to climb up. Crown Climb and Wind Tunnel Peaks are full of ledges like this.',
      },
      { type: 'heading', text: 'Props' },
      {
        type: 'list',
        items: [
          'Egg Heist: hold Grab to carry an egg. You can’t jump as high while carrying, so stick to the flat routes.',
          'Tail Chase: grab a tail from behind to steal it.',
          'Paint the Plaza: grab a paint bucket for a few seconds of super-roller.',
        ],
      },
      { type: 'heading', text: 'Other Tumblers' },
      {
        type: 'paragraph',
        text: 'Grabbing a rival slows you both down. It’s great for holding someone back near a goal, but a bad idea when you’re racing. Grabbed? Mash to break free.',
      },
      { type: 'tip', text: 'Grabbing has stamina. Let go for a moment and your grip comes back.' },
    ],
  },
  {
    id: 'tips-survive-and-team-up',
    title: 'Tips: Survival rounds & team rounds',
    summary:
      'How to stay on your feet when the floor gives way, and how to pull your weight when your team is on the line.',
    tag: 'TIPS',
    date: '2026-09-15',
    image: roundImage('tile-panic'),
    roundId: 'tile-panic',
    art: ['#5ce1e6', '#6ee7a8'],
    icon: '🛡️',
    body: [
      { type: 'heading', text: 'Survival' },
      {
        type: 'list',
        items: [
          'Keep moving. In Tile Panic and Last Tumbler Standing, every tile you stand on is about to drop.',
          'Jump to save floor: airtime doesn’t crack tiles.',
          'There are layers below. A fall isn’t over until you hit the bottom.',
          'Stay away from the edges in Spin Cycle; the outer ring falls away later.',
          'In Rising Goo Tower, climb early. The top is tiny once everyone gets there.',
        ],
      },
      { type: 'heading', text: 'Team rounds' },
      {
        type: 'list',
        items: [
          'Your team’s score is what counts. Defending a lead is as good as scoring.',
          'In Egg Heist, someone should guard the nest while the others raid.',
          'In Paint the Plaza, raised stages count double, and the rinse arms wash paint away.',
          'In Bounce Ball Blitz, don’t all chase the ball. Leave someone near your goal.',
        ],
      },
      {
        type: 'tip',
        text: 'The losing team is knocked out together, so a teammate who stays home is never wasted.',
      },
    ],
  },
  {
    id: 'patch-1-0-opening-night',
    title: 'Patch 1.0: Opening night',
    summary:
      'Tumble Royale is open! 40-player shows, sixteen launch rounds and a whole candy world to fall off. Here’s what’s in the box.',
    tag: 'PATCH NOTES',
    date: '2026-09-10',
    image: roundImage('gumdrop-gauntlet'),
    roundId: 'gumdrop-gauntlet',
    art: ['#ff4f8b', '#7c5cff'],
    icon: '🎉',
    body: [
      {
        type: 'paragraph',
        text: 'Tumble Royale runs right in your browser on laptop, desktop and phone. No download, no install: open the link and you’re in a show.',
      },
      { type: 'heading', text: 'What’s in the show' },
      {
        type: 'list',
        items: [
          'Up to 40 Tumblers per show, with friendly bots filling any empty spots.',
          'Races, survivals, team games, a hunt, a memory round and four finals.',
          'Playlists: Main Show, Duos, Squads, Chaos Mode and Ranked.',
          'A gentler First Show for brand-new players.',
        ],
      },
      { type: 'heading', text: 'Your Tumbler' },
      {
        type: 'list',
        items: [
          'Colours, patterns, hats, faces, back pieces, trails, emotes and victory poses to mix and match in the Locker.',
          'Level up from every show and spend Gumballs in the Store.',
          'Ranked shows with a climbable ladder.',
        ],
      },
      { type: 'heading', text: 'Playing together' },
      {
        type: 'list',
        items: [
          'Parties of up to four with invite links and ready checks.',
          'Custom lobbies with a code: the host picks the rounds.',
          'Emotes and quick pings in every round.',
        ],
      },
      { type: 'heading', text: 'Accessibility' },
      {
        type: 'paragraph',
        text: 'Rebind every key, and switch on spoken round announcements in Settings if you’d like them. They’re off by default, and every announcement is also shown on screen.',
      },
    ],
  },
]);

/**
 * Looks up a post by id.
 *
 * @param id - Post id, e.g. `season-1-sugar-rush`.
 * @returns The post, or undefined if there is none.
 */
export function newsPost(id: string): NewsPost | undefined {
  return NEWS_POSTS.find((p) => p.id === id);
}
