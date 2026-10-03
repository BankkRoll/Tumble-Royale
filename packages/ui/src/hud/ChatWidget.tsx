/**
 * The global chat widget, bottom-left, on the menu and every show screen.
 *
 * Collapsed: a faint feed of recent lines that fades after a few seconds.
 * Enter or T opens it (Enter only when no button has focus, so menu buttons
 * keep Enter); Enter sends, Esc closes, Tab cycles the channel tabs. A
 * gamepad's View button opens a quick-chat picker instead of a text field.
 *
 * While open it emits `chatInput` so the game releases pointer lock and held
 * keys; the text field keeps every key, so gameplay and menu hotkeys never
 * fire. While closed it only listens for Enter/T outside text fields.
 *
 * Hidden in photo mode, the replay viewer and while the Tumble Wipe covers
 * the screen.
 */
import { memo, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { CHAT_MAX_LENGTH, QUICK_CHAT } from '@tumble/shared';
import { CHANNEL_LABEL, CHANNEL_ORDER, channelOf, type ChatChannel } from '../store/chatChannels.ts';
import { uiEvents } from '../store/events.ts';
import { social, useSocial, visibleChat, type VisibleChatLine } from '../store/social.ts';
import type { ScreenId } from '../store/types.ts';
import { ui, useUI } from '../store/uiStore.ts';

/** Seconds a line stays visible while the widget is collapsed. */
export const CHAT_LINE_SECONDS = 8;
/** Lines in the collapsed feed. */
const FEED_LINES = 6;
/** Lines in the open history. */
const OPEN_LINES = 40;
/** Standard-mapping gamepad View/Back button (unused by gameplay). */
const PAD_VIEW = 8;

/** Screens that show the widget. */
const CHAT_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  'menu',
  'matchmaking',
  'matchFound',
  'preShow',
  'showIntro',
  'roundIntro',
  'round',
  'roundResults',
  'betweenRounds',
  'finalHype',
  'victory',
  'winnerCam',
  'playerWall',
  'rewards',
]);

/**
 * Opens or closes the chat input (and tells the game).
 *
 * @param open - Desired state.
 * @param opts - Channel to focus and input mode when opening.
 */
export function setChatOpen(
  open: boolean,
  opts: { channel?: ChatChannel; mode?: 'text' | 'quick' } = {},
): void {
  const s = social.getState();
  if (open) s.dispatchChat({ type: 'open', ...opts });
  else s.dispatchChat({ type: 'close' });
  uiEvents.emit('chatInput', { open });
}

/**
 * Opens the Whispers tab for a friend.
 *
 * @param userId - Friend's account id.
 * @param name - Display name.
 */
export function openWhisper(userId: string, name: string): void {
  social.getState().dispatchChat({ type: 'whisperTo', target: { userId, name } });
  setChatOpen(true, { channel: 'whisper' });
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function useVisibleLines(): VisibleChatLine[] {
  const lines = useSocial((s) => s.chat.lines);
  const muted = useSocial((s) => s.muted);
  const blocked = useSocial((s) => s.blocked);
  const showChat = useUI((s) => s.settings.gameplay.showChat);
  const filter = useUI((s) => s.settings.gameplay.chatFilter);
  return visibleChat(lines, { showChat, filter, muted, blocked: blocked.map((b) => b.userId) });
}

function Line({ l, interactive }: { l: VisibleChatLine; interactive: boolean }): JSX.Element {
  const ch = channelOf(l);
  const label = l.self && ch === 'whisper' && l.to ? `To ${l.to.name}` : l.self ? 'You' : l.from.name;
  const name = (
    <b className="tr-chat-name" style={l.color ? { color: l.color } : undefined}>
      {label}
    </b>
  );
  const target = l.self && l.to ? l.to : l.from;
  const clickable = interactive && ch !== 'system' && !(l.self && !l.to);
  return (
    <div
      className={`tr-chat-line is-${ch}${l.quick ? ' is-ping' : ''}`}
      data-testid="chat-line"
      data-channel={ch}
    >
      {ch !== 'show' && ch !== 'system' && <span className="tr-chat-tag">{CHANNEL_LABEL[ch]}</span>}
      {ch === 'system' ? null : clickable ? (
        <button
          type="button"
          className="tr-chat-who"
          aria-label={`Actions for ${target.name}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => social.getState().openPlayerMenu(target)}
        >
          {name}
        </button>
      ) : (
        name
      )}
      <span className="tr-chat-text">{l.display}</span>
    </div>
  );
}

function Tabs(): JSX.Element {
  const available = useSocial((s) => s.chat.available);
  const active = useSocial((s) => s.chat.active);
  const unread = useSocial((s) => s.chat.unread);
  const whisperTo = useSocial((s) => s.chat.whisperTo);
  return (
    <div className="tr-chat-tabs" role="tablist" aria-label="Chat channels">
      {CHANNEL_ORDER.filter((c) => available[c]).map((c) => (
        <button
          key={c}
          type="button"
          role="tab"
          aria-selected={c === active}
          className={`tr-chat-tab${c === active ? ' is-active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => social.getState().dispatchChat({ type: 'focus', channel: c })}
        >
          {c === 'whisper' && whisperTo && c === active ? `To ${whisperTo.name}` : CHANNEL_LABEL[c]}
          {unread[c] > 0 && c !== active && (
            <span className="tr-chat-unread" aria-label={`${unread[c]} unread`}>
              {unread[c] > 9 ? '9+' : unread[c]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function placeholder(c: ChatChannel, writable: boolean, whisper: string | undefined): string {
  if (c === 'system') return 'Type /help for commands';
  if (c === 'whisper') return whisper ? `Whisper ${whisper}` : '/w name message';
  if (!writable) return 'Quick pings only here. /help for commands';
  return c === 'party' ? 'Message your party' : c === 'lobby' ? 'Message the lobby' : 'Say something nice';
}

function ChatInput(): JSX.Element {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const active = useSocial((s) => s.chat.active);
  const writable = useSocial((s) => s.chat.writable[s.chat.active]);
  const whisperTo = useSocial((s) => s.chat.whisperTo?.name);
  useEffect(() => ref.current?.focus(), []);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    // The field owns these keys: no in-game menu, no focus hop, no menu navigation.
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
    }
    if (e.key === 'Enter') {
      if (text.trim()) uiEvents.emit('sendChat', { text });
      setText('');
      setChatOpen(false);
    } else if (e.key === 'Escape') {
      setChatOpen(false);
    } else if (e.key === 'Tab') {
      social.getState().dispatchChat({ type: 'cycle', dir: e.shiftKey ? -1 : 1 });
    }
  };
  return (
    <input
      ref={ref}
      className="tr-input tr-chat-input"
      value={text}
      maxLength={CHAT_MAX_LENGTH + 40}
      placeholder={placeholder(active, writable, whisperTo)}
      aria-label="Chat message"
      enterKeyHint="send"
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        // Clicking a tab or a name keeps the input; clicking the game closes it.
        if (!(e.relatedTarget as HTMLElement | null)?.closest?.('.tr-chat')) setChatOpen(false);
      }}
    />
  );
}

/** Gamepad quick chat: preset buttons, navigable with the D-pad. */
function QuickPicker(): JSX.Element {
  const active = useSocial((s) => s.chat.active);
  const presets = QUICK_CHAT.filter((p) => p.id.startsWith('ping:') || p.id.startsWith('cam:')).filter(
    (p, i, all) => all.findIndex((q) => q.text === p.text) === i,
  );
  const send = (id: string, text: string): void => {
    if (active === 'show') uiEvents.emit('quickPing', { kind: id });
    else uiEvents.emit('sendChat', { text });
    setChatOpen(false);
  };
  return (
    <div className="tr-chat-quick" data-nav-scope="18" role="menu" aria-label="Quick chat">
      {presets.map((p, i) => (
        <button
          key={p.id}
          type="button"
          role="menuitem"
          className="tr-btn tr-btn--sm tr-btn--secondary"
          data-nav=""
          {...(i === 0 ? { 'data-autofocus': '' } : {})}
          onClick={() => send(p.id, p.text)}
        >
          {p.text}
        </button>
      ))}
      <button
        type="button"
        className="tr-btn tr-btn--sm tr-btn--ghost"
        data-nav=""
        data-nav-back=""
        onClick={() => setChatOpen(false)}
      >
        Close
      </button>
    </div>
  );
}

function canOpenNow(): boolean {
  const u = ui.getState();
  return CHAT_SCREENS.has(u.screen) && u.overlay === 'none' && u.dialog === null && !hidden();
}

function hidden(): boolean {
  const u = ui.getState();
  return u.photo.active || u.replay !== null || u.wipe.phase !== 'idle';
}

/** Opens on Enter/T and the gamepad View button. */
function useOpenKeys(): void {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || social.getState().chat.open) return;
      const isT = e.code === 'KeyT';
      if (e.key !== 'Enter' && !isT) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // A focused menu button owns Enter.
      if (
        e.key === 'Enter' &&
        t &&
        t !== document.body &&
        t.closest('button, a, [data-nav], [role="button"]')
      )
        return;
      if (!canOpenNow()) return;
      e.preventDefault();
      setChatOpen(true);
    };
    window.addEventListener('keydown', onKey);
    let raf = 0;
    let was = false;
    const poll = (): void => {
      raf = requestAnimationFrame(poll);
      const pads = navigator.getGamepads?.() ?? [];
      let down = false;
      for (const p of pads) if (p?.connected && p.buttons[PAD_VIEW]?.pressed) down = true;
      if (down && !was) {
        if (social.getState().chat.open) setChatOpen(false);
        else if (canOpenNow()) setChatOpen(true, { mode: 'quick' });
      }
      was = down;
    };
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(poll);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
}

/** The widget body (always rendered by {@link ChatWidgetLayer} when visible). */
export const ChatWidget = memo(function ChatWidget(): JSX.Element | null {
  const open = useSocial((s) => s.chat.open);
  const mode = useSocial((s) => s.chat.mode);
  const active = useSocial((s) => s.chat.active);
  const device = useUI((s) => s.hud.device);
  const all = useVisibleLines();
  const now = useNow(all.length > 0 && !open);
  useOpenKeys();
  const list = useRef<HTMLDivElement>(null);
  const shown = open
    ? all.filter((l) => channelOf(l) === active).slice(-OPEN_LINES)
    : all.filter((l) => now - l.at < CHAT_LINE_SECONDS * 1000).slice(-FEED_LINES);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [shown.length, open, active]);
  return (
    <div
      className={`tr-chat${open ? ' is-open tr-interactive' : ''}`}
      data-testid="chat-widget"
      aria-label="Chat"
    >
      {open && <Tabs />}
      <div ref={list} className={`tr-chat-lines${open ? ' tr-scroll' : ''}`} aria-live="polite">
        {shown.map((l) => (
          <div
            key={l.id}
            className={
              !open && now - l.at > (CHAT_LINE_SECONDS - 2) * 1000 ? 'tr-chat-fade is-faded' : 'tr-chat-fade'
            }
          >
            <Line l={l} interactive={open} />
          </div>
        ))}
        {open && shown.length === 0 && (
          <small className="tr-muted tr-chat-empty">Nothing here yet. Type /help for commands.</small>
        )}
      </div>
      {open && (mode === 'quick' ? <QuickPicker /> : <ChatInput />)}
      {!open &&
        (device === 'touch' ? (
          <button type="button" className="tr-chat-hint tr-interactive" onClick={() => setChatOpen(true)}>
            Chat
          </button>
        ) : (
          <span className="tr-chat-hint">
            {device === 'gamepad' ? (
              <>
                <kbd>View</kbd> Quick chat
              </>
            ) : (
              <>
                <kbd>Enter</kbd> Chat
              </>
            )}
          </span>
        ))}
    </div>
  );
});

/** App-level mount: the widget on chat screens, hidden in photo mode, replays and wipes. */
export function ChatWidgetLayer(): JSX.Element | null {
  const visible = useUI(
    (s) => CHAT_SCREENS.has(s.screen) && !s.photo.active && s.replay === null && s.wipe.phase === 'idle',
  );
  const open = useSocial((s) => s.chat.open);
  useEffect(() => {
    if (!visible && open) setChatOpen(false);
  }, [visible, open]);
  return visible ? (
    <div className="tr-chat-wrap">
      <ChatWidget />
    </div>
  ) : null;
}
