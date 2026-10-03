/**
 * Lobby emote button + picker for the main menu Play tab: plays any unlocked
 * emote on the 3D lobby Tumbler (the party joins in, confetti fires).
 *
 * Keys: B toggles the picker, 1–4 play the equipped emotes, Esc closes.
 * Locked emotes are shown greyed and jump to the Store or Season Pass tab.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { playCue } from '../../audio-cues.ts';
import { ItemArt } from '../../components/bits.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { CosmeticItem, InventoryData, SeasonPassData } from '../../store/types.ts';

/** One entry in the picker. */
interface EmoteEntry {
  item: CosmeticItem;
  /** Equipped slot index 0–3, or -1. */
  slot: number;
  /** Where a locked emote can be unlocked. */
  source: 'store' | 'pass';
  /** Pass tier that awards it (locked pass emotes). */
  tier?: number;
}

function passTierOf(pass: SeasonPassData | null, id: string): number | undefined {
  for (const t of pass?.tiers ?? []) if (t.free?.item?.id === id || t.premium?.item?.id === id) return t.tier;
  return undefined;
}

function buildEntries(inv: InventoryData | null, pass: SeasonPassData | null): EmoteEntry[] {
  if (!inv) return [];
  const equipped = inv.loadouts[inv.activeLoadout]?.emotes ?? [];
  const emotes = inv.items.filter((i) => i.slot === 'emote');
  const out: EmoteEntry[] = [];
  for (const [slot, id] of equipped.entries()) {
    const item = emotes.find((e) => e.id === id && e.owned);
    if (item) out.push({ item, slot, source: 'store' });
  }
  const rest = emotes.filter((e) => !out.some((o) => o.item.id === e.id));
  rest.sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name));
  for (const item of rest) {
    const tier = item.owned ? undefined : passTierOf(pass, item.id);
    out.push({
      item,
      slot: -1,
      source: tier !== undefined ? 'pass' : 'store',
      ...(tier !== undefined ? { tier } : {}),
    });
  }
  return out;
}

function play(entry: EmoteEntry): void {
  playCue('ui.confirm');
  uiEvents.emit('emote', { slot: Math.max(0, entry.slot), id: entry.item.id });
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}

/** Props for {@link LobbyEmotes}. */
export interface LobbyEmotesProps {
  /** Extra class on the root (positioning is up to the menu layout). */
  className?: string;
}

/**
 * Round sticker button that opens the lobby emote picker. Renders only on the
 * menu's Play tab; the menu layout positions it (the picker opens upward and
 * to the right of the button, so a bottom-left placement suits it best).
 *
 * @param props - Optional `className` for placement.
 * @returns The button and picker, or null off the Play tab.
 * @example
 * <LobbyEmotes className="my-menu__emotes" />
 */
export const LobbyEmotes = memo(function LobbyEmotes({ className }: LobbyEmotesProps): JSX.Element | null {
  const visible = useUI((s) => s.screen === 'menu' && s.menuTab === 'play');
  const inventory = useUI((s) => s.inventory);
  const pass = useUI((s) => s.pass);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => buildEntries(inventory, pass), [inventory, pass]);
  const equipped = useMemo(() => entries.filter((e) => e.slot >= 0), [entries]);
  const ownedCount = useMemo(() => entries.filter((e) => e.item.owned).length, [entries]);

  const toggle = useCallback((next?: boolean) => {
    setOpen((o) => {
      const v = next ?? !o;
      if (v !== o) playCue(v ? 'ui.whoosh' : 'ui.back');
      return v;
    });
  }, []);

  useEffect(() => {
    if (!visible) {
      setOpen(false);
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = ui.getState();
      if (s.overlay !== 'none' || s.dialog) return;
      if (e.code === 'KeyB') {
        e.preventDefault();
        toggle();
      } else if (e.code === 'Escape' && open) {
        // Capture phase: closing the picker must not also count as menu Back.
        e.preventDefault();
        toggle(false);
      } else if (/^Digit[1-4]$/.test(e.code)) {
        const entry = equipped.find((x) => x.slot === Number(e.code.slice(5)) - 1);
        if (entry) play(entry);
      }
    };
    const onDown = (e: PointerEvent): void => {
      if (open && rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [visible, open, equipped, toggle]);

  if (!visible || entries.length === 0) return null;

  const pick = (entry: EmoteEntry): void => {
    if (!entry.item.owned) {
      playCue('ui.tab');
      setOpen(false);
      ui.getState().setMenuTab(entry.source);
      return;
    }
    play(entry);
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className={`tr-lobby-emotes${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
    >
      {open && (
        <div className="tr-lobby-emote-panel" role="menu" aria-label="Emotes">
          <div className="tr-lobby-emote-head">
            <span className="tr-lobby-emote-title">Emotes</span>
            <span className="tr-lobby-emote-count">
              {ownedCount}/{entries.length}
            </span>
          </div>
          <div className="tr-lobby-emote-grid">
            {entries.map((entry, i) => {
              const { item } = entry;
              const locked = !item.owned;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  data-nav
                  data-autofocus={i === 0 ? true : undefined}
                  className={`tr-lobby-emote-item${locked ? ' is-locked' : ''}${entry.slot >= 0 ? ' is-equipped' : ''}`}
                  style={{
                    ['--art-a' as string]: item.art[0],
                    ['--art-b' as string]: item.art[1],
                    animationDelay: `${Math.min(i, 12) * 22}ms`,
                  }}
                  title={
                    locked ? `Unlock in the ${entry.source === 'pass' ? 'Season Pass' : 'Store'}` : item.name
                  }
                  onClick={() => pick(entry)}
                  onPointerEnter={() => playCue('ui.hover')}
                >
                  <span className="tr-lobby-emote-art">
                    <ItemArt item={item} className="tr-lobby-emote-img" />
                  </span>
                  <span className="tr-lobby-emote-name tr-ellipsis">{item.name}</span>
                  {entry.slot >= 0 && <span className="tr-lobby-emote-slot">{entry.slot + 1}</span>}
                  {locked && (
                    <>
                      <span className="tr-lobby-emote-lock" aria-hidden>
                        <Icon name="lock" size="1.15em" />
                      </span>
                      <span className="tr-lobby-emote-where">
                        {entry.source === 'pass'
                          ? `Pass${entry.tier !== undefined ? ` · T${entry.tier}` : ''}`
                          : 'Store'}
                      </span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
          <div className="tr-lobby-emote-foot">
            <span className="tr-lobby-emote-kbd">1</span>–<span className="tr-lobby-emote-kbd">4</span> quick
            emote
            <span className="tr-lobby-emote-sep" />
            <span className="tr-lobby-emote-kbd">B</span> close
          </div>
        </div>
      )}
      <button
        type="button"
        data-nav
        className="tr-lobby-emote-btn"
        aria-label="Emotes"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => toggle()}
      >
        <span className="tr-lobby-emote-btn-face" aria-hidden>
          <Icon name="emote" size="1.9em" />
        </span>
        <span className="tr-lobby-emote-btn-key" aria-hidden>
          B
        </span>
      </button>
    </div>
  );
});
