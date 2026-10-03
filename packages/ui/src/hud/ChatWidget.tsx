/**
 * The global chat widget, bottom-left, on the menu and every show screen.
 *
 * Just type: Enter or T opens it on the All tab, Enter sends to everyone in
 * the current room (the menu's public room, the show, or the private-show
 * lobby), Esc closes, Tab cycles All / Party / Whispers. System notices show
 * greyed inline in every tab; refusals show once as a short hint.
 *
 * Collapsed: the last few lines, fading after a few seconds. Enter only opens
 * when no button has focus, so menu buttons keep Enter. A gamepad's View
 * button opens a quick-chat picker instead of a text field.
 *
 * While open it emits `chatInput` so the game releases pointer lock and held
 * keys; the text field keeps every key, so gameplay and menu hotkeys never
 * fire. While closed it only listens for Enter/T outside text fields.
 *
 * Hidden in photo mode, the replay viewer and while the Tumble Wipe covers
 * the screen.
 */
import { memo, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { CHAT_MAX_LENGTH, QUICK_CHAT } from '@tumble/shared';
import {
  CHANNEL_LABEL,
  channelOf,
  chatPlaceholder,
  chatTabs,
  feedLines,
  linesOf,
  nameTag,
  publicRoom,
  type ChatChannel,
  type ChatLine,
} from '../store/chatChannels.ts';
import { uiEvents } from '../store/events.ts';
import { social, useSocial, visibleChat, type VisibleChatLine } from '../store/social.ts';
import type { ScreenId } from '../store/types.ts';
import { ui, useUI } from '../store/uiStore.ts';

/** Seconds a line stays visible while the widget is collapsed. */
export const CHAT_LINE_SECONDS = 10;
/** Seconds a refusal hint stays up. */
export const CHAT_HINT_SECONDS = 5;
/** Lines in the collapsed feed. */
const FEED_LINES = 8;
/** Lines in the open history. */
const OPEN_LINES = 100;
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
 * @param opts - Tab to focus and input mode when opening.
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
 * Opens the Whispers tab for a friend (player card "Whisper").
 *
 * @param userId - Friend's account id.
 * @param name - Display name.
 * @param tag - Discriminator, shown as `Name#tag`.
 */
export function openWhisper(userId: string, name: string, tag?: string): void {
  social.getState().dispatchChat({ type: 'whisperTo', target: { userId, name, ...(tag ? { tag } : {}) } });
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

function useVisible(): (lines: readonly ChatLine[]) => VisibleChatLine[] {
  const muted = useSocial((s) => s.muted);
  const blocked = useSocial((s) => s.blocked);
  const showChat = useUI((s) => s.settings.gameplay.showChat);
  const filter = useUI((s) => s.settings.gameplay.chatFilter);
  return useMemo(() => {
    const rules = { showChat, filter, muted, blocked: blocked.map((b) => b.userId) };
    return (lines) => visibleChat(lines, rules);
  }, [muted, blocked, showChat, filter]);
}

/** Account ids the local player knows: friends and party members. */
function useRelations(): { friends: ReadonlySet<string>; party: ReadonlySet<string> } {
  const friendList = useUI((s) => s.friends);
  const members = useUI((s) => s.party?.members);
  return useMemo(
    () => ({
      friends: new Set(friendList.filter((f) => !f.recent).map((f) => f.id)),
      party: new Set((members ?? []).filter((m) => !m.isSelf).map((m) => m.id)),
    }),
    [friendList, members],
  );
}

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function Line({
  l,
  interactive,
  rel,
}: {
  l: VisibleChatLine;
  interactive: boolean;
  rel: ReturnType<typeof useRelations>;
}): JSX.Element {
  const ch = channelOf(l);
  if (ch === 'system')
    return (
      <div
        className="tr-chat-line is-system"
        data-testid="chat-line"
        data-channel="system"
        title={clock(l.at)}
      >
        <span className="tr-chat-text">{l.display}</span>
      </div>
    );
  const outgoing = l.self && ch === 'whisper' && l.to ? l.to : null;
  const who = outgoing ?? l.from;
  const friend = !!who.userId && rel.friends.has(who.userId);
  const partyMate = !!who.userId && rel.party.has(who.userId);
  const name = (
    <b
      className={`tr-chat-name${partyMate ? ' is-party-mate' : ''}`}
      style={l.color && !partyMate ? { color: l.color } : undefined}
    >
      {outgoing ? `To ${nameTag(who)}` : nameTag(who)}
      {friend && <i className="tr-chat-friend" aria-hidden="true" />}:
    </b>
  );
  const clickable = interactive && !(l.self && !outgoing);
  return (
    <div
      className={`tr-chat-line is-${ch}${l.quick ? ' is-ping' : ''}`}
      data-testid="chat-line"
      data-channel={ch}
      title={clock(l.at)}
    >
      {ch !== 'all' && <span className="tr-chat-tag">{CHANNEL_LABEL[ch]}</span>}
      {clickable ? (
        <button
          type="button"
          className="tr-chat-who"
          aria-label={`Actions for ${who.name}${friend ? ' (friend)' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => social.getState().openPlayerMenu(who)}
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
  const chat = useSocial((s) => s.chat);
  const tabs = chatTabs(chat);
  return (
    <div className="tr-chat-tabs" role="tablist" aria-label="Chat tabs">
      {tabs.map((c) => (
        <button
          key={c}
          type="button"
          role="tab"
          aria-selected={c === chat.active}
          className={`tr-chat-tab${c === chat.active ? ' is-active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => social.getState().dispatchChat({ type: 'focus', channel: c })}
        >
          {CHANNEL_LABEL[c]}
          {chat.unread[c] > 0 && c !== chat.active && (
            <span className="tr-chat-unread" role="status" aria-label={`${chat.unread[c]} unread`} />
          )}
        </button>
      ))}
    </div>
  );
}

function ChatInput(): JSX.Element {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const placeholder = useSocial((s) => chatPlaceholder(s.chat));
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
      placeholder={placeholder}
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
  const toShow = useSocial((s) => s.chat.active === 'all' && publicRoom(s.chat) === 'show');
  const presets = QUICK_CHAT.filter((p) => p.id.startsWith('ping:') || p.id.startsWith('cam:')).filter(
    (p, i, all) => all.findIndex((q) => q.text === p.text) === i,
  );
  const send = (id: string, text: string): void => {
    if (toShow) uiEvents.emit('quickPing', { kind: id });
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
  const chat = useSocial((s) => s.chat);
  const { open, mode, active, hint } = chat;
  const device = useUI((s) => s.hud.device);
  const visible = useVisible();
  const rel = useRelations();
  const feed = useMemo(() => visible(feedLines(chat)), [visible, chat]);
  const now = useNow((feed.length > 0 && !open) || hint !== null);
  useOpenKeys();
  const list = useRef<HTMLDivElement>(null);
  const shown = open
    ? visible(linesOf(chat, active)).slice(-OPEN_LINES)
    : feed.filter((l) => now - l.at < CHAT_LINE_SECONDS * 1000).slice(-FEED_LINES);
  const hintUp = hint !== null && now - hint.at < CHAT_HINT_SECONDS * 1000;
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
            <Line l={l} interactive={open} rel={rel} />
          </div>
        ))}
        {open && shown.length === 0 && publicRoom(chat) !== null && (
          <small className="tr-muted tr-chat-empty">No messages yet. Say hi!</small>
        )}
      </div>
      {hintUp && (
        <div className="tr-chat-notice" role="status" data-testid="chat-hint">
          {hint.text}
        </div>
      )}
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
