/**
 * Launch cosmetics catalog. Every name and design here is original.
 *
 * Responsibilities:
 * - Declares every launch item, validated once at module load.
 * - Provides id lookup and per-slot listings.
 *
 * Prices follow one curve per rarity so the store stays coherent; premium
 * (Gems) pricing is reserved for Legendary/Mythic store items.
 */
import {
  CosmeticItemSchema,
  type CosmeticItem,
  type CosmeticItemInput,
  type CosmeticSlot,
  type Currency,
  type Rarity,
} from './schema.ts';

type Price = { currency: Currency; amount: number } | null;

/** Store price per rarity. */
const STORE_PRICE: Readonly<Record<Rarity, Price>> = {
  common: { currency: 'gumballs', amount: 400 },
  uncommon: { currency: 'gumballs', amount: 800 },
  rare: { currency: 'gumballs', amount: 1500 },
  epic: { currency: 'gumballs', amount: 3000 },
  legendary: { currency: 'gems', amount: 800 },
  mythic: { currency: 'gems', amount: 1600 },
};

type Src = 'default' | 'store' | 'pass' | 'challenge' | 'event';
const meta = (rarity: Rarity, source: Src): { rarity: Rarity; source: Src; price: Price } => ({
  rarity,
  source,
  price: source === 'store' ? STORE_PRICE[rarity] : null,
});

// -----------------------------------------------------------------------------
// Colours
// -----------------------------------------------------------------------------

const colors: CosmeticItemInput[] = [
  { id: 'color.bubblegum', slot: 'color', name: 'Bubblegum', description: 'The classic. Chewy, pink and ready to tumble.', colors: ['#ff6fb5', '#ffd23f', '#7c5cff'], ...meta('common', 'default') },
  { id: 'color.mint-chip', slot: 'color', name: 'Mint Chip', description: 'Cool mint with chocolate chunks.', colors: ['#7ff0c8', '#5a3b2e', '#fff7ec'], ...meta('common', 'default') },
  { id: 'color.lemon-drop', slot: 'color', name: 'Lemon Drop', description: 'Sour, sunny, a little bit zesty.', colors: ['#ffe14d', '#ff8a3d', '#ffffff'], ...meta('common', 'default') },
  { id: 'color.blueberry', slot: 'color', name: 'Blueberry Burst', description: 'Fresh from the bush, extra juicy.', colors: ['#4d8dff', '#a8e1ff', '#2b1d6a'], ...meta('common', 'store') },
  { id: 'color.grape-fizz', slot: 'color', name: 'Grape Fizz', description: 'Bubbly purple with a sparkling finish.', colors: ['#9b5cff', '#ff9ef0', '#40e0d0'], ...meta('uncommon', 'store') },
  { id: 'color.tangerine', slot: 'color', name: 'Tangerine Twist', description: 'Peel-fresh orange with a cream swirl.', colors: ['#ff8a3d', '#fff1c9', '#ff4f8b'], ...meta('uncommon', 'challenge') },
  { id: 'color.cotton-cloud', slot: 'color', name: 'Cotton Cloud', description: 'Spun-sugar pastels, light as air.', colors: ['#ffc4e8', '#b8e7ff', '#fff3b0'], ...meta('rare', 'store') },
  { id: 'color.licorice', slot: 'color', name: 'Licorice Night', description: 'Dark, glossy and a little mysterious.', colors: ['#2a2238', '#ff4f8b', '#7cf2ff'], ...meta('rare', 'pass') },
  { id: 'color.sea-salt', slot: 'color', name: 'Sea Salt Taffy', description: 'Beach-boardwalk teal with a sandy trim.', colors: ['#3fd0c9', '#ffe5b4', '#ff7a7a'], ...meta('uncommon', 'store') },
  { id: 'color.watermelon', slot: 'color', name: 'Watermelon Slice', description: 'Summer in squishy form. Seeds not included.', colors: ['#ff5a6e', '#5fd16b', '#2b2b2b'], ...meta('rare', 'store') },
  { id: 'color.toasted', slot: 'color', name: 'Toasted Mallow', description: 'Golden on the outside, gooey inside.', colors: ['#f2b880', '#fff8ee', '#8a5a3c'], ...meta('epic', 'challenge') },
  { id: 'color.neon-lime', slot: 'color', name: 'Neon Lime', description: 'Visible from three islands away.', colors: ['#b6ff3b', '#1e1e2e', '#ff3bd4'], ...meta('epic', 'store') },
  { id: 'color.sherbet', slot: 'color', name: 'Rainbow Sherbet', description: 'All the flavours, none of the brain freeze.', colors: ['#ff8fb1', '#ffd36e', '#7fe3ff'], ...meta('legendary', 'store') },
];

// -----------------------------------------------------------------------------
// Patterns
// -----------------------------------------------------------------------------

const patterns: CosmeticItemInput[] = [
  { id: 'pattern.solid', slot: 'pattern', name: 'Plain & Proud', description: 'No frills. Maximum squish.', pattern: 'solid', ...meta('common', 'default') },
  { id: 'pattern.stripes', slot: 'pattern', name: 'Candy Stripes', description: 'Peppermint-pole stripes, tilted for speed.', pattern: 'stripes', angle: 20, ...meta('common', 'default') },
  { id: 'pattern.dots', slot: 'pattern', name: 'Polka Party', description: 'Dots on dots on dots.', pattern: 'dots', ...meta('common', 'default') },
  { id: 'pattern.camo', slot: 'pattern', name: 'Gumdrop Camo', description: 'Blend into any candy shop.', pattern: 'camo', ...meta('uncommon', 'store') },
  { id: 'pattern.gradient', slot: 'pattern', name: 'Sunset Fade', description: 'A smooth melt from head to toe.', pattern: 'gradient', ...meta('uncommon', 'store') },
  { id: 'pattern.galaxy', slot: 'pattern', name: 'Cosmic Swirl', description: 'Stars, nebulae and a hint of stardust.', pattern: 'galaxy', ...meta('legendary', 'store') },
  { id: 'pattern.checker', slot: 'pattern', name: 'Finish Flag', description: 'Always looks like you just won.', pattern: 'checker', ...meta('rare', 'pass') },
  { id: 'pattern.zigzag', slot: 'pattern', name: 'Zig Zag Zoom', description: 'Lightning-fast zigzags.', pattern: 'zigzag', ...meta('uncommon', 'store') },
  { id: 'pattern.hearts', slot: 'pattern', name: 'Sweetheart', description: 'Covered head to toe in love.', pattern: 'hearts', ...meta('rare', 'store') },
  { id: 'pattern.spots', slot: 'pattern', name: 'Cookie Spots', description: 'Chocolate-chip blotches, freshly baked.', pattern: 'spots', ...meta('uncommon', 'challenge') },
  { id: 'pattern.swirl', slot: 'pattern', name: 'Lollipop Swirl', description: 'Hypnotic spirals. Do not stare.', pattern: 'swirl', ...meta('epic', 'store') },
  { id: 'pattern.split', slot: 'pattern', name: 'Two Tone', description: 'Half one thing, half another.', pattern: 'split', ...meta('rare', 'store') },
  { id: 'pattern.sprinkles', slot: 'pattern', name: 'Sprinkle Shower', description: 'Freshly dunked in rainbow sprinkles.', pattern: 'sprinkles', ...meta('epic', 'pass') },
  { id: 'pattern.plaid', slot: 'pattern', name: 'Picnic Plaid', description: 'Cosy enough for a lakeside lunch.', pattern: 'plaid', ...meta('rare', 'store') },
  { id: 'pattern.waves', slot: 'pattern', name: 'Ripple Pop', description: 'Wobbly bands like a fizzy drink.', pattern: 'waves', ...meta('uncommon', 'store') },
  { id: 'pattern.diamonds', slot: 'pattern', name: 'Harlequin', description: 'Jester diamonds for the show-off.', pattern: 'diamonds', ...meta('epic', 'challenge') },
];

// -----------------------------------------------------------------------------
// Faces
// -----------------------------------------------------------------------------

const faces: CosmeticItemInput[] = [
  { id: 'face.classic', slot: 'face', name: 'Bright Eyes', description: 'Wide-eyed and always up for it.', face: {}, ...meta('common', 'default') },
  { id: 'face.sleepy', slot: 'face', name: 'Five More Minutes', description: 'Permanently half-awake.', face: { lidRest: 0.4, iris: '#5a7bd8' }, ...meta('common', 'store') },
  { id: 'face.starry', slot: 'face', name: 'Starstruck', description: 'Sees stars even when not stunned.', face: { pupil: 'star', iris: '#ffb02e', eyeScale: 1.08 }, ...meta('rare', 'store') },
  { id: 'face.lovestruck', slot: 'face', name: 'Lovestruck', description: 'Heart-shaped pupils, heart-shaped dreams.', face: { pupil: 'heart', iris: '#ff4f8b', lashes: true }, ...meta('rare', 'pass') },
  { id: 'face.kitty', slot: 'face', name: 'Kitty Gaze', description: 'Slit pupils. Judging you, politely.', face: { pupil: 'cat', iris: '#6ee06e' }, ...meta('uncommon', 'store') },
  { id: 'face.freckles', slot: 'face', name: 'Sun Kissed', description: 'Freckles from a summer on the beach islands.', face: { freckles: true, iris: '#8a5a3c' }, ...meta('uncommon', 'challenge') },
  { id: 'face.hypno', slot: 'face', name: 'Dizzy Dazzle', description: 'Spiral eyes. Still somehow runs straight.', face: { pupil: 'spiral', iris: '#7c5cff', eyeScale: 1.1 }, ...meta('epic', 'store') },
  { id: 'face.visor', slot: 'face', name: 'Speed Visor', description: 'Aerodynamic shades for serious racers.', face: { accessory: 'visor', tint: ['#2bd0ff'] }, ...meta('epic', 'store') },
  { id: 'face.specs', slot: 'face', name: 'Smarty Specs', description: 'Round glasses. Reads the course in advance.', face: { accessory: 'glasses', tint: ['#2a2238'] }, ...meta('uncommon', 'store') },
  { id: 'face.mustache', slot: 'face', name: 'Dapper Lip', description: 'A magnificent curly mustache.', face: { accessory: 'mustache', tint: ['#4a2f22'] }, ...meta('rare', 'store') },
  { id: 'face.monocle', slot: 'face', name: 'Fancy Monocle', description: 'Distinguished. Possibly a tumbling aristocrat.', face: { accessory: 'monocle', tint: ['#ffcf4a'], lashes: true }, ...meta('epic', 'pass') },
  { id: 'face.star-shades', slot: 'face', name: 'Superstar Shades', description: 'Star-shaped sunglasses for main characters.', face: { accessory: 'star-shades', tint: ['#ff3bd4'] }, ...meta('legendary', 'store') },
];

// -----------------------------------------------------------------------------
// Wearables
// -----------------------------------------------------------------------------

const headwear: CosmeticItemInput[] = [
  { id: 'headwear.party-cone', slot: 'headwear', name: 'Party Starter', description: 'A striped cone hat with a fluffy tip.', mesh: 'party-cone', tint: ['#ff4f8b', '#ffd23f', '#ffffff'], ...meta('common', 'default') },
  { id: 'headwear.beanie', slot: 'headwear', name: 'Bobble Beanie', description: 'Knitted warmth with a bouncy pom.', mesh: 'beanie-pom', tint: ['secondary', '#ffffff'], ...meta('common', 'store') },
  { id: 'headwear.tiara', slot: 'headwear', name: 'Sugar Tiara', description: 'Glittering, sparkling, totally regal.', mesh: 'tiara', tint: ['#ffd23f', '#7cf2ff'], ...meta('epic', 'store') },
  { id: 'headwear.chef', slot: 'headwear', name: 'Head Baker', description: 'For Tumblers who are cooking.', mesh: 'chef-hat', tint: ['#ffffff'], ...meta('uncommon', 'challenge') },
  { id: 'headwear.horns', slot: 'headwear', name: 'Brave Horns', description: 'Chunky horns on a sturdy cap.', mesh: 'horns', tint: ['#b0b6c8', '#fff1c9'], ...meta('rare', 'store') },
  { id: 'headwear.propeller', slot: 'headwear', name: 'Whirly Cap', description: 'Spins when you move. Does not fly. Yet.', mesh: 'propeller-cap', tint: ['#3fa9ff', '#ffd23f', '#ff4f8b'], ...meta('uncommon', 'store') },
  { id: 'headwear.bunny', slot: 'headwear', name: 'Floppy Bunny', description: 'Ears that flop with every hop.', mesh: 'bunny-ears', tint: ['#ffffff', '#ffb3d9'], ...meta('rare', 'pass') },
  { id: 'headwear.halo', slot: 'headwear', name: 'Angel Ring', description: 'A glowing halo. Totally innocent, honest.', mesh: 'halo', tint: ['#fff3a0'], ...meta('legendary', 'store') },
  { id: 'headwear.top-hat', slot: 'headwear', name: 'Showtime Topper', description: 'A tall hat for the grand finale.', mesh: 'top-hat', tint: ['#2a2238', '#ff4f8b'], ...meta('epic', 'store') },
  { id: 'headwear.flower', slot: 'headwear', name: 'Daisy Pop', description: 'A cheerful bloom tucked on top.', mesh: 'flower', tint: ['#ffffff', '#ffd23f'], ...meta('common', 'challenge') },
  { id: 'headwear.antenna', slot: 'headwear', name: 'Boing Antennae', description: 'Wobbly feelers with glowing tips.', mesh: 'antenna', tint: ['#2a2238', '#b6ff3b'], ...meta('rare', 'store') },
  { id: 'headwear.headphones', slot: 'headwear', name: 'Bass Bumpers', description: 'Chunky cans for the round-one playlist.', mesh: 'headphones', tint: ['#2a2238', 'primary'], ...meta('uncommon', 'store') },
  { id: 'headwear.sprout', slot: 'headwear', name: 'Lil Sprout', description: 'A tiny leaf growing on top. Water daily.', mesh: 'sprout', tint: ['#5fd16b'], ...meta('common', 'store') },
  { id: 'headwear.cat-ears', slot: 'headwear', name: 'Kitty Ears', description: 'Pointy and perky.', mesh: 'cat-ears', tint: ['primary', '#ffb3d9'], ...meta('uncommon', 'pass') },
  { id: 'headwear.royal-tiara', slot: 'headwear', name: 'Gumdrop Majesty', description: 'Encrusted with sugar gems. Mythically shiny.', mesh: 'tiara', tint: ['#ff4fd8', '#7cf2ff'], ...meta('mythic', 'event') },
];

const back: CosmeticItemInput[] = [
  { id: 'back.cape', slot: 'back', name: 'Hero Cape', description: 'Flaps dramatically in every breeze.', mesh: 'cape', tint: ['#ff4f8b', '#ffd23f'], ...meta('rare', 'store') },
  { id: 'back.wings', slot: 'back', name: 'Sugar Wings', description: 'Translucent wings that flutter.', mesh: 'wings', tint: ['#bdf3ff', '#ffffff'], ...meta('epic', 'store') },
  { id: 'back.jetpack', slot: 'back', name: 'Rocket Pack', description: 'Retro rockets. Decorative. Probably.', mesh: 'jetpack', tint: ['#c7cede', '#ff8a3d'], ...meta('legendary', 'store') },
  { id: 'back.tail', slot: 'back', name: 'Wiggle Tail', description: 'Wags whenever you are happy.', mesh: 'tail', tint: ['primary', '#ffffff'], ...meta('uncommon', 'pass') },
  { id: 'back.backpack', slot: 'back', name: 'Snack Pack', description: 'Holds at least eleven snacks.', mesh: 'backpack', tint: ['#3fa9ff', '#ffd23f'], ...meta('common', 'store') },
  { id: 'back.shell', slot: 'back', name: 'Turtle Shell', description: 'Slow and steady? Not today.', mesh: 'shell', tint: ['#5fd16b', '#ffe5b4'], ...meta('rare', 'challenge') },
  { id: 'back.royal-cape', slot: 'back', name: 'Velvet Mantle', description: 'Fit for whoever holds the Crown.', mesh: 'cape', tint: ['#7c2bd9', '#ffd23f'], ...meta('mythic', 'event') },
];

const upper: CosmeticItemInput[] = [
  { id: 'upper.bow-tie', slot: 'upper', name: 'Bow Tie', description: 'Formal tumbling attire.', mesh: 'bow-tie', tint: ['#ff4f8b'], ...meta('common', 'store') },
  { id: 'upper.scarf', slot: 'upper', name: 'Cosy Scarf', description: 'Trails behind you as you run.', mesh: 'scarf', tint: ['#ff5a6e', '#ffffff'], ...meta('uncommon', 'store') },
  { id: 'upper.medal', slot: 'upper', name: 'Participation Medal', description: 'You showed up. That counts!', mesh: 'medal', tint: ['#ffcf4a', '#3fa9ff'], ...meta('common', 'challenge') },
];

const lower: CosmeticItemInput[] = [
  { id: 'lower.belt', slot: 'lower', name: 'Champion Belt', description: 'A shiny buckle the size of a waffle.', mesh: 'belt', tint: ['#5a3b2e', '#ffcf4a'], ...meta('uncommon', 'store') },
  { id: 'lower.tutu', slot: 'lower', name: 'Twirl Tutu', description: 'Ruffled tulle for maximum spin.', mesh: 'tutu', tint: ['#ffb3d9'], ...meta('rare', 'store') },
  { id: 'lower.shorts', slot: 'lower', name: 'Sporty Shorts', description: 'Two racing stripes. Twice the speed.', mesh: 'shorts-stripes', tint: ['#3fa9ff', '#ffffff'], ...meta('common', 'default') },
  { id: 'lower.floatie', slot: 'lower', name: 'Pool Floatie', description: 'Ready for any slime situation.', mesh: 'floatie', tint: ['#ffd23f', '#ff4f8b'], ...meta('epic', 'pass') },
];

// -----------------------------------------------------------------------------
// Animations
// -----------------------------------------------------------------------------

const emotes: CosmeticItemInput[] = [
  { id: 'emote.wave', slot: 'emote', name: 'Hiya!', description: 'A big friendly wave.', clip: 'wave', ...meta('common', 'default') },
  { id: 'emote.dance', slot: 'emote', name: 'Wiggle Jam', description: 'A bouncy little dance.', clip: 'dance', ...meta('common', 'default') },
  { id: 'emote.laugh', slot: 'emote', name: 'Belly Laugh', description: 'Ha! Ha! Ha!', clip: 'laugh', ...meta('common', 'default') },
  { id: 'emote.flex', slot: 'emote', name: 'Noodle Flex', description: 'Show off those mighty stubby arms.', clip: 'flex', ...meta('common', 'default') },
  { id: 'emote.facepalm', slot: 'emote', name: 'Oh No', description: 'When the door was fake. Again.', clip: 'facepalm', ...meta('uncommon', 'store') },
  { id: 'emote.spin', slot: 'emote', name: 'Top Spin', description: 'Spin like a toy top.', clip: 'spin', ...meta('rare', 'store') },
  { id: 'emote.jumping-jacks', slot: 'emote', name: 'Warm Up', description: 'Jumping jacks before the big race.', clip: 'jumping-jacks', ...meta('uncommon', 'challenge') },
  { id: 'emote.bow', slot: 'emote', name: 'Take a Bow', description: 'Thank you, thank you.', clip: 'bow', ...meta('rare', 'pass') },
  { id: 'emote.shrug', slot: 'emote', name: 'Whatever', description: 'Who, me? No idea.', clip: 'shrug', ...meta('uncommon', 'store') },
];

const celebrations: CosmeticItemInput[] = [
  { id: 'celebration.cheer', slot: 'celebration', name: 'Woo-Hoo!', description: 'Jump and cheer at the finish.', clip: 'cheer', ...meta('common', 'default') },
  { id: 'celebration.fist-pump', slot: 'celebration', name: 'Yes! Yes!', description: 'Triple fist pump of triumph.', clip: 'fist-pump', ...meta('rare', 'store') },
  { id: 'celebration.backflip', slot: 'celebration', name: 'Show-Off Flip', description: 'A backflip nobody asked for.', clip: 'backflip', ...meta('epic', 'store') },
];

const victories: CosmeticItemInput[] = [
  { id: 'victory.superstar', slot: 'victory', name: 'Superstar', description: 'Arms high, soaking in the applause.', clip: 'victory-superstar', ...meta('common', 'default') },
  { id: 'victory.hero', slot: 'victory', name: 'Hero Stance', description: 'Hands on hips, gazing into the distance.', clip: 'victory-hero', ...meta('rare', 'pass') },
  { id: 'victory.twirl', slot: 'victory', name: 'Grand Twirl', description: 'A pirouette and a curtsey.', clip: 'victory-twirl', ...meta('legendary', 'store') },
];

// -----------------------------------------------------------------------------
// Profile & VFX
// -----------------------------------------------------------------------------

const nameplates: CosmeticItemInput[] = [
  { id: 'nameplate.classic', slot: 'nameplate', name: 'Classic Pill', description: 'Clean and readable.', plate: { style: 'pill', bg: '#2a2238', bg2: '#3d3157', text: '#ffffff', border: '#ffffff' }, ...meta('common', 'default') },
  { id: 'nameplate.bubblegum', slot: 'nameplate', name: 'Bubble Pop', description: 'A bubbly pink plate.', plate: { style: 'bubble', bg: '#ff6fb5', bg2: '#ff9fd0', text: '#ffffff', border: '#ffe0f0' }, ...meta('uncommon', 'store') },
  { id: 'nameplate.ribbon', slot: 'nameplate', name: 'Prize Ribbon', description: 'First-place ribbon energy.', plate: { style: 'ribbon', bg: '#3fa9ff', bg2: '#77c4ff', text: '#ffffff', border: '#ffd23f' }, ...meta('rare', 'pass') },
  { id: 'nameplate.ticket', slot: 'nameplate', name: 'Admit One', description: 'A golden ticket to the show.', plate: { style: 'ticket', bg: '#ffd23f', bg2: '#ffe680', text: '#4a2f22', border: '#ff8a3d' }, ...meta('epic', 'store') },
  { id: 'nameplate.neon', slot: 'nameplate', name: 'Night Sign', description: 'Buzzing neon outline.', plate: { style: 'neon', bg: '#1e1530', bg2: '#2a1e45', text: '#7cf2ff', border: '#ff3bd4' }, ...meta('legendary', 'store') },
  { id: 'nameplate.mint', slot: 'nameplate', name: 'Fresh Mint', description: 'Cool and calm.', plate: { style: 'pill', bg: '#3fd0a8', bg2: '#7ff0c8', text: '#ffffff', border: '#e0fff4' }, ...meta('common', 'challenge') },
];

const banners: CosmeticItemInput[] = [
  { id: 'banner.confetti', slot: 'banner', name: 'Confetti Burst', description: 'Every day is a party.', banner: { motif: 'confetti', colors: ['#ff6fb5', '#ffd23f', '#5ce1e6'] }, ...meta('common', 'default') },
  { id: 'banner.clouds', slot: 'banner', name: 'Sky High', description: 'Fluffy clouds on a candy sky.', banner: { motif: 'clouds', colors: ['#5aa9ff', '#ffd6f2', '#ffffff'] }, ...meta('common', 'store') },
  { id: 'banner.stripes', slot: 'banner', name: 'Speedway', description: 'Racing stripes for racers.', banner: { motif: 'stripes', colors: ['#ff4f8b', '#ffffff', '#2a2238'] }, ...meta('uncommon', 'challenge') },
  { id: 'banner.stars', slot: 'banner', name: 'Starfield', description: 'A night sky full of wishes.', banner: { motif: 'stars', colors: ['#1e1530', '#7c5cff', '#ffd23f'] }, ...meta('rare', 'store') },
  { id: 'banner.candy', slot: 'banner', name: 'Sweet Shop', description: 'Lollipops and gumdrops galore.', banner: { motif: 'candy', colors: ['#ffc4e8', '#7ff0c8', '#ff8a3d'] }, ...meta('epic', 'pass') },
  { id: 'banner.waves', slot: 'banner', name: 'Goo Tide', description: 'Rolling waves of sparkly goo.', banner: { motif: 'waves', colors: ['#3fd0c9', '#9b5cff', '#ffffff'] }, ...meta('legendary', 'store') },
];

const trails: CosmeticItemInput[] = [
  { id: 'trail.sparkle', slot: 'trail', name: 'Glitter Dust', description: 'Leaves a sparkly path.', trail: { kind: 'sparkle', colors: ['#ffffff', '#ffd23f'] }, ...meta('uncommon', 'store') },
  { id: 'trail.bubbles', slot: 'trail', name: 'Bubble Wake', description: 'Pop, pop, pop.', trail: { kind: 'bubbles', colors: ['#bdf3ff', '#ffffff'] }, ...meta('common', 'challenge') },
  { id: 'trail.hearts', slot: 'trail', name: 'Love Trail', description: 'Hearts float up behind you.', trail: { kind: 'hearts', colors: ['#ff4f8b', '#ffb3d9'] }, ...meta('rare', 'pass') },
  { id: 'trail.confetti', slot: 'trail', name: 'Parade Route', description: 'A one-Tumbler parade.', trail: { kind: 'confetti', colors: ['#ff6fb5', '#ffd23f', '#5ce1e6', '#7c5cff'] }, ...meta('epic', 'store') },
  { id: 'trail.rainbow', slot: 'trail', name: 'Rainbow Dash', description: 'A full spectrum streak.', trail: { kind: 'rainbow', colors: ['#ff5a6e', '#ffd23f', '#5fd16b', '#3fa9ff'] }, ...meta('legendary', 'store') },
  { id: 'trail.stars', slot: 'trail', name: 'Comet Tail', description: 'Shooting stars at your heels.', trail: { kind: 'stars', colors: ['#fff3a0', '#ff8a3d'] }, ...meta('mythic', 'event') },
];

const footsteps: CosmeticItemInput[] = [
  { id: 'footsteps.squeak', slot: 'footsteps', name: 'Squeaky Toy', description: 'Every step squeaks.', pack: 'squeak', ...meta('common', 'default') },
  { id: 'footsteps.boing', slot: 'footsteps', name: 'Spring Step', description: 'Boing, boing, boing.', pack: 'boing', ...meta('uncommon', 'store') },
  { id: 'footsteps.tap', slot: 'footsteps', name: 'Tap Shoes', description: 'Clickety-clack on every surface.', pack: 'tap', ...meta('rare', 'store') },
  { id: 'footsteps.jelly', slot: 'footsteps', name: 'Jelly Feet', description: 'Squelchy and proud of it.', pack: 'jelly', ...meta('uncommon', 'challenge') },
  { id: 'footsteps.bell', slot: 'footsteps', name: 'Jingle Toes', description: 'Tiny bells. Hard to sneak.', pack: 'bell', ...meta('epic', 'pass') },
];

// -----------------------------------------------------------------------------
// Catalog
// -----------------------------------------------------------------------------

/** Every launch cosmetic, validated. */
export const COSMETICS: readonly CosmeticItem[] = [
  ...colors,
  ...patterns,
  ...faces,
  ...headwear,
  ...back,
  ...upper,
  ...lower,
  ...emotes,
  ...celebrations,
  ...victories,
  ...nameplates,
  ...banners,
  ...trails,
  ...footsteps,
].map((item) => CosmeticItemSchema.parse(item));

const byId = new Map<string, CosmeticItem>();
for (const item of COSMETICS) {
  if (byId.has(item.id)) throw new Error(`Duplicate cosmetic id: ${item.id}`);
  byId.set(item.id, item);
}

/**
 * Looks up a cosmetic by id.
 *
 * @param id - Cosmetic id.
 * @returns The item, or `undefined` when unknown.
 */
export function getCosmetic(id: string): CosmeticItem | undefined {
  return byId.get(id);
}

/**
 * The item type stored in slot `S`. Distributes over the item union because
 * accessory items share one schema across four slots.
 */
export type ItemOfSlot<S extends CosmeticSlot> = CosmeticItem extends infer T
  ? T extends { slot: infer U }
    ? S extends U
      ? T & { slot: S }
      : never
    : never
  : never;

/**
 * Looks up a cosmetic by id and checks its slot.
 *
 * @param id - Cosmetic id.
 * @param slot - Expected slot.
 * @returns The typed item, or `undefined` when unknown or in another slot.
 * @example
 * const hat = getCosmeticInSlot('headwear.halo', 'headwear');
 */
export function getCosmeticInSlot<S extends CosmeticSlot>(id: string, slot: S): ItemOfSlot<S> | undefined {
  const item = byId.get(id);
  return item && item.slot === slot ? (item as ItemOfSlot<S>) : undefined;
}

/**
 * Lists every item in a slot, sorted by rarity then name.
 *
 * @param slot - The slot to list.
 * @returns A new array of items.
 */
export function cosmeticsInSlot<S extends CosmeticSlot>(slot: S): ItemOfSlot<S>[] {
  const order = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
  return COSMETICS.filter((c) => c.slot === slot)
    .sort((a, b) => order.indexOf(a.rarity) - order.indexOf(b.rarity) || a.name.localeCompare(b.name))
    .map((c) => c as ItemOfSlot<S>);
}
