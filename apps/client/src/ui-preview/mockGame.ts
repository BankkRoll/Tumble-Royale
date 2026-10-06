/**
 * A tiny stand-in for the real game: answers UI intents so every button in the
 * preview does something plausible (equip, purchase, claim, queue, spectate…).
 */
import { bindUI, ui, type CosmeticItem, type InventoryData } from '@tumble/ui';
import { autoplayRunning, runShow, stopAutoplay } from './autoplay.ts';
import { makeRewards, randomColors } from './mocks.ts';
import { MAX_PLAYERS, Rng } from '@tumble/shared';
import { world } from './world.ts';

const s = () => ui.getState();

function updateItem(id: string, patch: Partial<CosmeticItem>): void {
  world.items = world.items.map((i) => (i.id === id ? { ...i, ...patch } : i));
  const inv = s().inventory;
  if (inv) s().setInventory({ ...inv, items: world.items });
}

function withLoadout(fn: (inv: InventoryData) => InventoryData): void {
  const inv = s().inventory;
  if (inv) s().setInventory(fn(inv));
}

/**
 * Installs mock intent handlers.
 * @returns Uninstall function.
 */
export function installMockGame(): () => void {
  const rng = new Rng(1234);
  return bindUI({
    onStart: () => s().setScreen('welcome'),
    onWelcomeDone: ({ name, colors }) => {
      const p = s().profile;
      if (p) s().setProfile({ ...p, name, colors });
      s().setScreen('tutorialPrompt');
    },
    onTutorialChoice: ({ accept }) => {
      s().setScreen('menu');
      if (accept)
        s().pushToast({
          kind: 'info',
          title: 'Practice Island is coming soon!',
          body: 'Coach Boing is still inflating the course.',
        });
    },
    onPlay: () => void runShow({ win: true }),
    onCancelQueue: () => {
      stopAutoplay();
      s().setQueue({ status: 'idle' });
      s().setScreen('menu');
    },
    onReady: ({ ready }) => {
      const party = s().party;
      if (party)
        s().setParty({ ...party, members: party.members.map((m) => (m.isSelf ? { ...m, ready } : m)) });
    },
    onEquip: ({ slot, itemId }) =>
      withLoadout((inv) => {
        const loadouts = inv.loadouts.map((l, i) => {
          if (i !== inv.activeLoadout) return l;
          if (slot === 'emote')
            return { ...l, emotes: [itemId, ...l.emotes.filter((e) => e !== itemId)].slice(0, 4) };
          return { ...l, items: { ...l.items, [slot]: itemId } };
        });
        return { ...inv, loadouts };
      }),
    onSelectLoadout: ({ index }) => withLoadout((inv) => ({ ...inv, activeLoadout: index })),
    onCustomizeColors: ({ colors }) => {
      withLoadout((inv) => ({
        ...inv,
        loadouts: inv.loadouts.map((l, i) => (i === inv.activeLoadout ? { ...l, colors } : l)),
      }));
      const p = s().profile;
      if (p) s().setProfile({ ...p, colors });
    },
    onRandomizeOutfit: () => {
      const colors = randomColors(rng);
      withLoadout((inv) => ({
        ...inv,
        loadouts: inv.loadouts.map((l, i) => (i === inv.activeLoadout ? { ...l, colors } : l)),
      }));
      const p = s().profile;
      if (p) s().setProfile({ ...p, colors });
    },
    onPurchase: ({ offerId }) => {
      const store = s().store;
      const offer = store ? [...store.featured, ...store.daily].find((o) => o.id === offerId) : undefined;
      const p = s().profile;
      if (!offer || !p || !store) return;
      const key = offer.currency === 'gems' ? 'gems' : 'gumballs';
      if (p[key] < offer.price) {
        s().showDialog({
          id: 'nofunds',
          kind: 'error',
          title: 'Not enough ' + (key === 'gems' ? 'Gems' : 'Gumballs'),
          body: 'Play a few shows and come back!',
        });
        return;
      }
      s().setWallet({ [key]: p[key] - offer.price });
      updateItem(offer.item.id, { owned: true });
      const mark = (o: typeof offer) => (o.id === offerId ? { ...o, item: { ...o.item, owned: true } } : o);
      s().setStoreData({ ...store, featured: store.featured.map(mark), daily: store.daily.map(mark) });
      s().pushToast({ kind: 'reward', title: `${offer.item.name} is yours!`, icon: offer.item.icon });
    },
    onClaimPassTier: ({ tier, track }) => {
      const pass = s().pass;
      if (!pass) return;
      window.setTimeout(() => {
        s().setPass({
          ...pass,
          tiers: pass.tiers.map((t) => {
            if (t.tier !== tier) return t;
            const r = t[track];
            return r ? { ...t, [track]: { ...r, claimed: true } } : t;
          }),
        });
      }, 500);
    },
    onBuyPremiumPass: () => {
      const pass = s().pass;
      if (pass) s().setPass({ ...pass, premium: true });
      s().pushToast({ kind: 'reward', title: 'Premium unlocked!', body: 'Go claim all the shiny things.' });
    },
    onClaimChallenge: ({ id }) => {
      const c = s().challenges;
      if (c)
        s().setChallenges({ ...c, list: c.list.map((x) => (x.id === id ? { ...x, claimed: true } : x)) });
    },
    onClaimLoginStreak: () => {
      const l = s().loginStreak;
      if (!l) return;
      s().setLoginStreak({
        ...l,
        streak: l.streak + 1,
        claimedToday: true,
        canClaim: false,
        nextClaimAt: Date.now() + 5 * 3600_000,
        ladder: l.ladder.map((d) => (d.state === 'today' ? { ...d, state: 'claimed' } : d)),
      });
      s().pushToast({ kind: 'reward', title: `Day ${l.next.day} reward claimed` });
    },
    onRerollChallenge: ({ id }) => {
      const c = s().challenges;
      if (c)
        s().setChallenges({
          ...c,
          list: c.list.map((x) =>
            x.id === id
              ? { ...x, title: 'Bounce on 20 pads', icon: '🦘', progress: 0, goal: 20, canReroll: false }
              : x,
          ),
        });
    },
    onSpectate: () => {
      const p = world.players[4];
      if (!autoplayRunning() && p) {
        s().setHud({ localStatus: 'spectating' });
        s().setSpectate({ player: p, detail: '3rd place', qualified: false, index: 0, count: 20 });
      }
    },
    onSpectateNext: ({ dir }) => {
      const cur = s().spectate;
      if (!cur) return;
      const watch = world.players.filter((p) => !p.isLocal);
      const index = (cur.index + dir + watch.length) % watch.length;
      const p = watch[index];
      if (p)
        s().setSpectate({
          ...cur,
          player: p,
          index,
          qualified: index % 3 === 0,
          detail: `${index + 1}${['st', 'nd', 'rd'][index] ?? 'th'} place`,
        });
    },
    onPlayAgain: () => void runShow({ win: Math.random() > 0.5 }),
    onBackToLobby: () => {
      stopAutoplay();
      s().setScreen('menu');
    },
    onContinue: ({ from }) => {
      if (autoplayRunning()) return;
      if (from === 'playerWall') {
        if (!s().rewards) s().setRewards(makeRewards(world.items, true));
        s().setScreen('rewards');
      } else if (from === 'victory' || from === 'winnerCam') {
        s().setPlayerWall(world.winSummary, { render3D: false, autoContinueMs: 6000 });
        s().setScreen('playerWall');
      }
    },
    onCreateCustom: ({ options }) =>
      s().setCustomLobby({
        code: 'TUMB' + rng.int(10, 99),
        isHost: true,
        players: world.players.slice(0, 1).map((p) => ({
          id: String(p.id),
          name: p.name,
          colors: p.colors,
          isHost: true,
          isSelf: true,
          ready: true,
          away: false,
        })),
        spectators: [],
        options,
        locked: false,
        banned: [],
      }),
    onJoinCode: ({ code }) => {
      if (code.startsWith('X')) {
        s().showDialog({
          id: 'badcode',
          kind: 'error',
          title: 'No show with that code',
          body: 'Double-check the code — or ask your friend to read it slower.',
          code: 'E-LOBBY-404',
        });
        return;
      }
      s().setCustomLobby({
        code,
        isHost: false,
        players: world.players.slice(0, 7).map((p, i) => ({
          id: String(p.id),
          name: p.name,
          colors: p.colors,
          isHost: i === 0,
          isSelf: i === 6,
          ready: i % 2 === 0,
          away: false,
        })),
        spectators: [],
        options: {
          rounds: [],
          bots: true,
          maxPlayers: MAX_PLAYERS,
          timerScale: 1,
          spectators: true,
          isPrivate: true,
        },
        locked: false,
        banned: [],
      });
    },
    onStartCustom: () => void runShow({ win: true }),
    onInviteFriend: () => s().pushToast({ kind: 'social', title: 'Invite sent!', icon: '💌' }),
    onAddFriend: ({ nameTag }) =>
      s().pushToast({ kind: 'social', title: `Friend request sent to ${nameTag}` }),
    onEmote: ({ id }) => s().pushToast({ title: `You did: ${id}`, icon: '💃', variant: 'feed' }),
    onQuickPing: ({ kind }) => s().pushToast({ title: `Ping: ${kind}`, icon: '📍', variant: 'feed' }),
    onPhotoMode: () =>
      s().pushToast({ kind: 'info', title: 'Photo mode', body: 'The 3D scene takes over here. Say cheese!' }),
    onRetryConnection: () => s().setConnection({ status: 'online' }),
    onLeaveShow: () => {
      stopAutoplay();
      s().setConnection({ status: 'online' });
      s().setScreen('menu');
    },
    onDialogResult: ({ dialogId, buttonId }) => {
      if (dialogId === 'disconnect' && buttonId === 'retry')
        s().setConnection({ status: 'reconnecting', attempt: 1, maxAttempts: 5 });
    },
  });
}
