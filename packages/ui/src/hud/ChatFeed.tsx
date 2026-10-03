/**
 * In-show chat: a compact fading feed of quick pings and text, plus the text
 * input (online shows only).
 *
 * Enter opens the input; Enter sends, Esc or clicking away closes it. While
 * closed the feed takes no keys except Enter, and only when text chat is
 * enabled, so gameplay bindings are never stolen. Opening emits `chatInput`
 * so the game frees the mouse and drops held movement keys.
 */
import { memo, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { CHAT_MAX_LENGTH } from '@tumble/shared';
import { uiEvents } from '../store/events.ts';
import { social, useSocial, visibleChat, type VisibleChatLine } from '../store/social.ts';
import type { ScreenId } from '../store/types.ts';
import { ui, useUI } from '../store/uiStore.ts';

/** Seconds a line stays fully visible while the input is closed. */
export const CHAT_LINE_SECONDS = 8;
/** Lines shown at once. */
const MAX_LINES = 7;

function setOpen(open: boolean): void {
  if (social.getState().chatOpen === open) return;
  social.getState().setChatOpen(open);
  uiEvents.emit('chatInput', { open });
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

function ChatInput(): JSX.Element {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Keep Enter/Esc away from the in-game menu and menu navigation.
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
    }
    if (e.key === 'Enter') {
      const t = text.trim();
      if (t) uiEvents.emit('sendChat', { text: t });
      setText('');
      setOpen(false);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };
  return (
    <input
      ref={ref}
      className="tr-input tr-chat-input"
      value={text}
      maxLength={CHAT_MAX_LENGTH}
      placeholder="Say something nice"
      aria-label="Chat message"
      enterKeyHint="send"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => setOpen(false)}
    />
  );
}

function Line({ l, faded, open }: { l: VisibleChatLine; faded: boolean; open: boolean }): JSX.Element {
  const name = (
    <b className="tr-chat-name" style={l.color ? { color: l.color } : undefined}>
      {l.self ? 'You' : l.from.name}
    </b>
  );
  return (
    <div
      className={`tr-chat-line${l.quick ? ' is-ping' : ''}${faded ? ' is-faded' : ''}`}
      data-testid="chat-line"
    >
      {open && !l.self ? (
        <button
          type="button"
          className="tr-chat-who"
          aria-label={`Actions for ${l.from.name}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => social.getState().openPlayerMenu(l.from)}
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

/**
 * The chat feed (and input, when open). Rendered over rounds and the winner cam.
 */
export const ChatFeed = memo(function ChatFeed(): JSX.Element | null {
  const lines = useSocial((s) => s.showChat);
  const open = useSocial((s) => s.chatOpen);
  const enabled = useSocial((s) => s.chatEnabled);
  const muted = useSocial((s) => s.muted);
  const blocked = useSocial((s) => s.blocked);
  const showChat = useUI((s) => s.settings.gameplay.showChat);
  const filter = useUI((s) => s.settings.gameplay.chatFilter);
  const now = useNow(lines.length > 0 && !open);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.repeat || social.getState().chatOpen) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (ui.getState().overlay !== 'none') return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);

  const shown = visibleChat(lines, {
    showChat,
    filter,
    muted,
    blocked: blocked.map((b) => b.userId),
  })
    .filter((l) => open || now - l.at < CHAT_LINE_SECONDS * 1000)
    .slice(-MAX_LINES);
  if (shown.length === 0 && !open) return null;
  return (
    <div className={`tr-chat${open ? ' is-open tr-interactive' : ''}`} aria-live="polite">
      <div className="tr-chat-lines">
        {shown.map((l) => (
          <Line key={l.id} l={l} open={open} faded={!open && now - l.at > (CHAT_LINE_SECONDS - 2) * 1000} />
        ))}
      </div>
      {open && enabled && <ChatInput />}
    </div>
  );
});

/** Opens the input: a key hint on keyboards, a button on touch screens. */
function ChatHint(): JSX.Element | null {
  const enabled = useSocial((s) => s.chatEnabled);
  const open = useSocial((s) => s.chatOpen);
  const device = useUI((s) => s.hud.device);
  if (!enabled || open || device === 'gamepad') return null;
  if (device === 'touch')
    return (
      <button type="button" className="tr-chat-hint tr-interactive" onClick={() => setOpen(true)}>
        Chat
      </button>
    );
  return (
    <span className="tr-chat-hint">
      <kbd>Enter</kbd> Chat
    </span>
  );
}

/** Feed plus the open-chat hint, positioned bottom-left. Used by the HUD and the winner cam. */
export function ChatLayer(): JSX.Element {
  return (
    <div className="tr-chat-wrap">
      <ChatFeed />
      <ChatHint />
    </div>
  );
}

/** Show screens where the chat feed is visible (lobby, rounds, results, winner cam). */
const CHAT_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  'preShow',
  'round',
  'roundResults',
  'betweenRounds',
  'victory',
  'winnerCam',
]);

/** App-level mount: the chat layer on show screens only. */
export function ShowChatLayer(): JSX.Element | null {
  const visible = useUI((s) => CHAT_SCREENS.has(s.screen));
  return visible ? <ChatLayer /> : null;
}
