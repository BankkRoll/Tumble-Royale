/**
 * Focus follows the layers opened over the screen: overlays, dialogs, the
 * wallet popover, the player card, the report dialog and quick chat each
 * take focus as they open and give it back as they close (see
 * {@link enterLayer}).
 */
import { useEffect, type RefObject } from 'react';
import { useSocial } from '../store/social.ts';
import type { OverlayId } from '../store/types.ts';
import { useUI } from '../store/uiStore.ts';
import { enterLayer } from './navigation.ts';

/** The layers that can be open over the screen. */
export interface OpenLayers {
  overlay: OverlayId;
  /** Id of the open dialog. */
  dialogId: string | null;
  wallet: 'none' | 'gumballs' | 'gems';
  /** Mute key of the player whose card is open. */
  playerCard: string | null;
  /** Mute key of the player being reported. */
  report: string | null;
  quickChat: boolean;
}

const NONE: OpenLayers = {
  overlay: 'none',
  dialogId: null,
  wallet: 'none',
  playerCard: null,
  report: null,
  quickChat: false,
};

/**
 * Names the layers open over the screen, so any change (one opens, closes or
 * replaces another) gives a new key.
 *
 * @param l - The open layers.
 * @returns The key, or null when no layer is open.
 */
export function openLayerKey(l: OpenLayers): string | null {
  const parts = [
    l.overlay === 'none' ? '' : l.overlay,
    l.dialogId !== null ? `dialog:${l.dialogId}` : '',
    l.wallet === 'none' ? '' : `wallet:${l.wallet}`,
    l.playerCard !== null ? `card:${l.playerCard}` : '',
    l.report !== null ? `report:${l.report}` : '',
    l.quickChat ? 'quickChat' : '',
  ];
  return parts.some(Boolean) ? parts.join('|') : null;
}

function useLayer(rootRef: RefObject<HTMLElement | null>, key: string | null): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !key) return;
    return enterLayer(root);
  }, [key, rootRef]);
}

/**
 * Moves focus into each layer as it opens and back as it closes. Each kind
 * of layer tracks its own opener, so a dialog over Settings hands focus back
 * to Settings, and Settings then back to the menu.
 *
 * @param rootRef - The UI root.
 */
export function useLayerFocus(rootRef: RefObject<HTMLElement | null>): void {
  const overlay = useUI((s) => s.overlay);
  const dialogId = useUI((s) => s.dialog?.id ?? null);
  const wallet = useUI((s) => s.currencyPanel);
  const playerCard = useSocial((s) => s.playerMenu?.key ?? null);
  const report = useSocial((s) => s.reportTarget?.key ?? null);
  const quickChat = useSocial((s) => s.chat.open && s.chat.mode === 'quick');
  useLayer(rootRef, openLayerKey({ ...NONE, overlay }));
  useLayer(rootRef, openLayerKey({ ...NONE, wallet }));
  useLayer(rootRef, openLayerKey({ ...NONE, quickChat }));
  useLayer(rootRef, openLayerKey({ ...NONE, playerCard }));
  useLayer(rootRef, openLayerKey({ ...NONE, report }));
  useLayer(rootRef, openLayerKey({ ...NONE, dialogId }));
}
