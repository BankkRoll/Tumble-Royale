/**
 * Share sheet state: what the finished show offers to share (a card, clips
 * of recorded rounds) and where the sheet is (picking, rendering, ready,
 * failed).
 *
 * Kept in its own Zustand store, like `social`, so progress updates while a
 * clip renders never re-render the rewards screen underneath. The game fills
 * {@link ShareState.offer} when the rewards screen opens and drives
 * {@link ShareState.sheet} while it renders; the sheet only emits intents
 * (`shareCard`, `shareClip`, `shareCancel`, `shareDeliver`, `shareClose`).
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

/** Card variants: 1200×630 for feeds, 1080×1920 for stories. */
export type ShareCardFormat = 'social' | 'story';

/** A recorded round the player can clip. */
export interface ShareClipRound {
  /** Replay library key. */
  key: string;
  roundIndex: number;
  name: string;
  isFinal: boolean;
  outcome: 'qualified' | 'eliminated' | 'spectated';
  /** Recording length (s). */
  duration: number;
  /** Suggested window start (s). */
  defaultStart: number;
  /** Suggested window length (s). */
  defaultLength: number;
}

/** How this browser can make clips. */
export type ClipSupport = 'checking' | 'webcodecs' | 'mediarecorder' | 'none';

/** What the finished show offers. */
export interface ShareOffer {
  /** A share card is offered (a win or a notable finish). */
  card: boolean;
  /** Card headline, also the button's hint ("Crowned!", "Finalist!", "3rd place"). */
  headline: string;
  /** The player's own name, for the "show my name" toggle label. */
  playerName: string;
  /** Recorded rounds (empty while `replays.enabled` is off). */
  clips: ShareClipRound[];
  /** Round the clip tab starts on. */
  defaultClipKey: string | null;
  clipSupport: ClipSupport;
  /** Clip resolution this device renders ("720p" / "1080p"). */
  clipQuality: string;
}

/** A rendered card or clip, ready to share. */
export interface ShareResult {
  kind: 'card' | 'clip';
  /** Object URL for the preview (revoked by the game when replaced or closed). */
  url: string;
  mime: string;
  fileName: string;
  bytes: number;
  width: number;
  height: number;
  /** Clip length (s). */
  duration?: number;
  canShare: boolean;
  canDownload: boolean;
  canCopy: boolean;
}

/** Where the sheet is. */
export type ShareStatus = 'idle' | 'rendering' | 'ready' | 'error';

/** The sheet itself. */
export interface ShareSheet {
  open: boolean;
  tab: 'card' | 'clip';
  status: ShareStatus;
  /** What is rendering (status `rendering`). */
  task: 'card' | 'clip' | null;
  /** 0..1 while a clip renders. */
  progress: number;
  result: ShareResult | null;
  error: string | null;
  /** One-line confirmation after delivering ("Saved to your downloads"). */
  notice: string | null;
}

/** Share store shape. */
export interface ShareState {
  offer: ShareOffer | null;
  sheet: ShareSheet;
  setOffer(offer: ShareOffer | null): void;
  patchOffer(patch: Partial<ShareOffer>): void;
  /** Opens the sheet on a tab (fresh: no result, idle). */
  openSheet(tab?: 'card' | 'clip'): void;
  closeSheet(): void;
  patchSheet(patch: Partial<ShareSheet>): void;
}

/** A closed, idle sheet. */
export const CLOSED_SHARE_SHEET: ShareSheet = {
  open: false,
  tab: 'card',
  status: 'idle',
  task: null,
  progress: 0,
  result: null,
  error: null,
  notice: null,
};

/** The share store. */
export const shareUI = createStore<ShareState>()((set, get) => ({
  offer: null,
  sheet: CLOSED_SHARE_SHEET,
  setOffer: (offer) => set({ offer }),
  patchOffer: (patch) => {
    const o = get().offer;
    if (o) set({ offer: { ...o, ...patch } });
  },
  openSheet: (tab) => {
    const offer = get().offer;
    const pick = tab ?? (offer?.card ? 'card' : 'clip');
    set({ sheet: { ...CLOSED_SHARE_SHEET, open: true, tab: pick } });
  },
  closeSheet: () => set({ sheet: CLOSED_SHARE_SHEET }),
  patchSheet: (patch) => set({ sheet: { ...get().sheet, ...patch } }),
}));

/**
 * React hook over {@link shareUI}.
 *
 * @param selector - Picks the slice to subscribe to.
 */
export function useShare<T>(selector: (s: ShareState) => T): T {
  return useStore(shareUI, selector);
}
