/**
 * Server-renders the lobby games picker and the score HUD on the Play tab
 * for a solo player, a party leader and a party member, and checks what each
 * sees, that the HUD sits apart from the start card, and that nothing on a
 * button or chip uses emoji.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { LobbyGameScore, lobbyGameBlocker } from '../src/screens/menu/LobbyGames.tsx';
import { PlayTab } from '../src/screens/menu/PlayTab.tsx';
import { ui } from '../src/store/uiStore.ts';
import type { LobbyGameHud } from '../src/store/types.ts';

// NOTE: zustand's useStore renders the store's *initial* state on the server; point it at the live state.
(ui as unknown as { getInitialState: () => unknown }).getInitialState = ui.getState;

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

const hud = (over: Partial<LobbyGameHud> = {}): LobbyGameHud => ({
  kind: 'goal',
  title: 'Goal Rush',
  rule: 'Push or dive the ball into the other goal. First to 3 wins.',
  phase: 'play',
  countdown: 0,
  clock: 74,
  rows: [
    { id: 'team-0', label: 'Pink', score: 2, color: '#ff4f9a', self: true, out: false, it: false },
    { id: 'team-1', label: 'Blue', score: 1, color: '#4fa3ff', self: false, out: false, it: false },
  ],
  fuse: null,
  banner: null,
  result: null,
  won: false,
  spectating: false,
  ...over,
});

function textOf(html: string, cls: string): string[] {
  const re = new RegExp(`<[^>]*class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)</`, 'g');
  return [...html.matchAll(re)].map((m) => m[1]!.replace(/<[^>]+>/g, ''));
}

beforeEach(() => {
  ui.setState({ screen: 'menu', menuTab: 'play', overlay: 'none' });
  ui.getState().setLobbyGames({ pickerOpen: false, canStart: true, players: 1, hud: null });
});

describe('lobby games picker', () => {
  it('shows a Games button on the Play tab only', () => {
    expect(renderToStaticMarkup(<PlayTab />)).toContain('data-testid="lobby-games"');
    ui.setState({ menuTab: 'locker' });
    expect(renderToStaticMarkup(<PlayTab />)).not.toContain('data-testid="lobby-games"');
  });

  it('lets a solo player start the solo games, not Hot Potato', () => {
    ui.getState().setLobbyGames({ pickerOpen: true });
    const html = renderToStaticMarkup(<PlayTab />);
    expect(html).toContain('data-testid="lobby-games-panel"');
    for (const id of ['goal', 'potato', 'targets']) expect(html).toContain(`data-testid="lobby-game-${id}"`);
    expect(html).toMatch(/data-testid="lobby-game-goal"(?![^>]*disabled)/);
    expect(html).toMatch(/data-testid="lobby-game-potato"[^>]*disabled=""/);
    expect(html).toContain('Needs 2+ players');
    expect(html).not.toContain('data-testid="lobby-game-stop"');
  });

  it('leaves the choice to the leader for party members', () => {
    ui.getState().setLobbyGames({ pickerOpen: true, canStart: false, players: 3 });
    const html = renderToStaticMarkup(<PlayTab />);
    expect(html.match(/disabled=""/g)?.length).toBe(3);
    expect(html).toContain('The party leader picks the game');
  });

  it('offers End game to the leader while a game runs, and keeps Play available', () => {
    ui.getState().setLobbyGames({ pickerOpen: true, canStart: true, players: 2, hud: hud() });
    const html = renderToStaticMarkup(<PlayTab />);
    expect(html).toContain('data-testid="lobby-game-stop"');
    expect(html).toContain('data-testid="play"');
    expect(html).not.toMatch(/data-testid="play"[^>]*disabled/);
  });

  it('explains blockers', () => {
    expect(lobbyGameBlocker('potato', true, 1)).toBe('Needs 2+ players');
    expect(lobbyGameBlocker('potato', true, 2)).toBeNull();
    expect(lobbyGameBlocker('goal', false, 4)).toBe('The party leader picks the game');
  });
});

describe('lobby game HUD', () => {
  it('renders in its own slot beside the start card', () => {
    ui.getState().setLobbyGames({ hud: hud() });
    const html = renderToStaticMarkup(<PlayTab />);
    const slot = html.indexOf('tr-play-lgame');
    const start = html.indexOf('data-testid="start-cluster"');
    expect(slot).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    // The HUD is not nested inside the start card.
    expect(html.slice(start).includes('tr-play-lgame')).toBe(false);
  });

  it('shows team scores and the clock', () => {
    const html = renderToStaticMarkup(<LobbyGameScore hud={hud()} />);
    expect(textOf(html, 'tr-lgame-title')).toEqual(['Goal Rush']);
    expect(textOf(html, 'tr-lgame-clock')).toEqual(['1:14']);
    expect(textOf(html, 'tr-lgame-score')).toEqual(['2', '1']);
    expect(html).toContain('is-self');
  });

  it('counts down with the rules during the intro', () => {
    const html = renderToStaticMarkup(<LobbyGameScore hud={hud({ phase: 'intro', countdown: 2 })} />);
    expect(textOf(html, 'tr-lgame-count')).toEqual(['2']);
    expect(html).toContain('First to 3 wins.');
    expect(html).not.toContain('tr-lgame-clock');
    const go = renderToStaticMarkup(<LobbyGameScore hud={hud({ phase: 'intro', countdown: 0 })} />);
    expect(textOf(go, 'tr-lgame-count')).toEqual(['GO!']);
  });

  it('marks who holds the potato, who is out, and shows the fuse', () => {
    const html = renderToStaticMarkup(
      <LobbyGameScore
        hud={hud({
          kind: 'potato',
          title: 'Hot Potato',
          clock: null,
          fuse: 0.4,
          rows: [
            { id: 'a', label: 'Ann', score: 0, color: '#ff4f9a', self: true, out: false, it: true },
            { id: 'b', label: 'Bo', score: 0, color: '#3ee6b4', self: false, out: true, it: false },
            { id: 'c', label: 'Cy', score: 0, color: '#ffd23f', self: false, out: false, it: false },
          ],
        })}
      />,
    );
    expect(textOf(html, 'tr-lgame-score')).toEqual(['IT', 'OUT', '0']);
    expect(html).toContain('scaleX(0.4)');
    expect(html).not.toContain('tr-lgame-clock');
  });

  it('flashes on a goal unless flashing is reduced, and shows results', () => {
    const goal = hud({ banner: { text: 'GOAL!', tone: 'pink', seq: 3 } });
    expect(renderToStaticMarkup(<LobbyGameScore hud={goal} />)).toContain('tr-lgame-flash');
    expect(renderToStaticMarkup(<LobbyGameScore hud={goal} flash={false} />)).not.toContain('tr-lgame-flash');
    const done = renderToStaticMarkup(
      <LobbyGameScore hud={hud({ phase: 'results', result: 'Pink team wins!', won: true })} />,
    );
    expect(textOf(done, 'tr-lgame-result')).toEqual(['Pink team wins!']);
    expect(done).toContain('is-won');
  });

  it('uses no emoji on buttons, chips or the HUD', () => {
    ui.getState().setLobbyGames({
      pickerOpen: true,
      canStart: true,
      players: 2,
      hud: hud({ banner: { text: 'GOAL!', tone: 'blue', seq: 1 } }),
    });
    const html = renderToStaticMarkup(<PlayTab />);
    const visible = html.replace(/<[^>]+>/g, ' ');
    expect(EMOJI.test(visible)).toBe(false);
  });
});
