/**
 * Lobby game HUD model (no three.js, no DOM): turns the game snapshot every
 * client shows into what the Play tab's score HUD renders, plus the
 * one-shot call-outs for events. Pure, so the same snapshot always reads
 * the same on every member's screen.
 */
import { LOBBY_GAME_INFO, type LobbyGameEvent, type LobbyGameWire } from '@tumble/shared';
import type { LobbyGameHud, LobbyGameRow } from '@tumble/ui';
import { LOBBY_TEAMS } from './lobbyGames.ts';

/** How a player is labelled and tinted on the scoreboard. */
export interface LobbyHudPlayer {
  name: string;
  color: string;
}

/** Live numbers that move between snapshots (timers are extrapolated locally). */
export interface LobbyHudClock {
  /** Seconds left in the current phase. */
  left: number;
  /** Fuse left as a fraction (Hot Potato), or null. */
  fuse: number | null;
}

/**
 * The intro countdown digit for `left` seconds of a 3.5 s intro: 3, 2, 1,
 * then 0 (GO) for the last half second.
 */
export function introCountdown(left: number): number {
  return Math.max(0, Math.ceil(left - 0.5));
}

function bit(mask: number, i: number): boolean {
  return (mask & (1 << i)) !== 0;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/**
 * The results line for a finished (or cancelled) game.
 *
 * @param g - Snapshot in the results phase.
 * @param self - Local user id.
 * @param who - Player label lookup.
 */
export function resultLine(g: LobbyGameWire, self: string, who: (id: string) => LobbyHudPlayer): string {
  if (g.reason === 'cancel') return 'Game cancelled';
  const n = g.players.length;
  if (n === 1) {
    const s = g.score[0] ?? 0;
    return s === 0 ? 'No score this time' : `You scored ${s}!`;
  }
  if (g.win === 0) return 'Draw!';
  if (g.kind === 'goal') {
    const team = g.teams[g.players.findIndex((_, i) => bit(g.win, i))] ?? 0;
    return `${LOBBY_TEAMS[team]!.name} team wins!`;
  }
  const winners: string[] = [];
  let selfWon = false;
  for (let i = 0; i < n; i++) {
    if (!bit(g.win, i)) continue;
    if (g.players[i] === self) selfWon = true;
    else winners.push(who(g.players[i]!).name);
  }
  if (selfWon) return winners.length ? `You & ${joinNames(winners)} win!` : 'You win!';
  return `${joinNames(winners)} ${winners.length > 1 ? 'win' : 'wins'}!`;
}

/**
 * The call-out an event shows on this client, if any: goals for everyone,
 * a tag or pop that involves you, your own target points.
 *
 * @param g - Current snapshot.
 * @param ev - The fresh event.
 * @param self - Local user id.
 * @param who - Player label lookup.
 * @returns Text and tone, or null for no call-out.
 */
export function eventBanner(
  g: LobbyGameWire,
  ev: LobbyGameEvent,
  self: string,
  who: (id: string) => LobbyHudPlayer,
): { text: string; tone: 'pink' | 'blue' | 'gold' | 'mint' } | null {
  const me = g.players.indexOf(self);
  switch (ev.k) {
    case 'goal':
      return { text: 'GOAL!', tone: g.players.length === 1 ? 'gold' : ev.a === 0 ? 'pink' : 'blue' };
    case 'tag':
      if (ev.b === me) return { text: "You're it!", tone: 'pink' };
      if (ev.a === me) return { text: 'Passed!', tone: 'mint' };
      if (ev.a < 0 && ev.b >= 0) return { text: `${who(g.players[ev.b]!).name} has it!`, tone: 'gold' };
      return null;
    case 'pop':
      return { text: ev.a === me ? 'POP! You are out' : 'POP!', tone: 'gold' };
    case 'hit': {
      if (ev.a !== me) return null;
      const pts = g.score[me] ?? 0;
      return { text: `${pts} pts`, tone: 'mint' };
    }
    default:
      return null;
  }
}

/**
 * Builds the HUD for the current snapshot.
 *
 * @param g - The game every client shows.
 * @param self - Local user id.
 * @param who - Player label lookup.
 * @param clock - Locally extrapolated timers.
 * @param banner - The latest call-out (kept until replaced), or null.
 * @param spectating - The local player is watching.
 * @returns A fresh HUD object for the UI store.
 */
export function buildLobbyHud(
  g: LobbyGameWire,
  self: string,
  who: (id: string) => LobbyHudPlayer,
  clock: LobbyHudClock,
  banner: LobbyGameHud['banner'],
  spectating: boolean,
): LobbyGameHud {
  const info = LOBBY_GAME_INFO[g.kind];
  const me = g.players.indexOf(self);
  const rows: LobbyGameRow[] = [];
  if (g.kind === 'goal' && g.players.length > 1) {
    for (let t = 0; t < 2; t++)
      rows.push({
        id: `team-${t}`,
        label: LOBBY_TEAMS[t]!.name,
        score: g.score[t] ?? 0,
        color: LOBBY_TEAMS[t]!.color,
        self: me >= 0 && g.teams[me] === t,
        out: false,
        it: false,
      });
  } else {
    for (let i = 0; i < g.players.length; i++) {
      const id = g.players[i]!;
      const p = who(id);
      rows.push({
        id,
        label: id === self ? 'You' : p.name,
        score: g.kind === 'goal' ? (g.score[0] ?? 0) : (g.score[i] ?? 0),
        color: p.color,
        self: id === self,
        out: bit(g.out, i),
        it: g.it === i,
      });
    }
  }
  return {
    kind: g.kind,
    title: info.title,
    rule: info.rule,
    phase: g.phase,
    countdown: g.phase === 'intro' ? introCountdown(clock.left) : 0,
    clock: info.playS > 0 ? Math.ceil(Math.max(0, clock.left)) : null,
    rows,
    fuse: g.kind === 'potato' && g.it >= 0 ? clock.fuse : null,
    banner,
    result: g.phase === 'results' ? resultLine(g, self, who) : null,
    won: g.phase === 'results' && me >= 0 && bit(g.win, me),
    spectating,
  };
}
