/**
 * Round editor state: the round being edited, selection, tools, undo/redo,
 * live validation, local drafts, Test play and sharing.
 *
 * Built by {@link createEditorStore} with its storage and API injected, so
 * every flow (save, import, publish, load by code) runs in tests without a
 * browser. The 3D viewport and the React panels both read and drive this
 * store; neither talks to storage or the network directly.
 */
import {
  CUSTOM_ROUND_LIMITS,
  exportRoundFile,
  normalizeShareCode,
  parseRoundFile,
  starterRound,
  validateCustomRound,
  type CustomRoundType,
  type CustomRoundValidation,
} from '@tumble/content/custom';
import type { RoundDefinitionInput, Vec3 } from '@tumble/shared';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { PLAYTEST_DRAFT_ID, type DraftStore, type RoundDraft } from '../customRounds/drafts.ts';
import { History } from './history.ts';
import {
  addMarker,
  addObstacle,
  addPart,
  copyItems,
  deleteItems,
  finalizeRound,
  itemPosition,
  moveItems,
  pasteItems,
  refExists,
  refKey,
  rotateItems,
  scaleItems,
  setRoundType,
  type Clipboard,
  type ItemRef,
  type MarkerKind,
} from './model.ts';

/** What the next click in the viewport places. */
export type Placing =
  | { kind: 'part'; id: string }
  | { kind: 'obstacle'; type: string }
  | { kind: 'marker'; marker: MarkerKind }
  | null;

/** Gizmo mode. */
export type GizmoMode = 'move' | 'rotate' | 'scale';

/** Side panel tabs. */
export type EditorPanel = 'build' | 'round' | 'share' | 'files';

/** A shared round as the API lists it. */
export interface SharedRoundSummary {
  code: string;
  name: string;
  description: string;
  type: string;
  status: 'published' | 'unpublished' | 'taken_down';
  updatedAt: string;
  takedownReason?: string | null;
}

/** Report reasons for shared rounds. */
export type RoundReportReason = 'offensive' | 'broken' | 'spam' | 'copied' | 'other';

/** The network side the editor needs (an `ApiClient` in the app, a fake in tests). */
export interface EditorApi {
  /** Signed in at all (a stored session). */
  signedIn(): boolean;
  /** Whether the account is a guest; null when it cannot be told (offline). */
  isGuest(): Promise<boolean | null>;
  fetchRound(
    code: string,
  ): Promise<{ code: string; name: string; description: string; author: string | null; definition: unknown }>;
  publish(round: unknown, description: string): Promise<SharedRoundSummary>;
  update(code: string, round: unknown, description: string): Promise<SharedRoundSummary>;
  mine(): Promise<SharedRoundSummary[]>;
  setPublished(code: string, published: boolean): Promise<SharedRoundSummary>;
  remove(code: string): Promise<void>;
  report(code: string, reason: RoundReportReason, details?: string): Promise<void>;
}

/** A failed API call as the store reports it. */
export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

/** Turns anything an API call threw into an {@link ApiFailure}. */
export function apiFailure(err: unknown): ApiFailure {
  const e = err as Partial<ApiFailure> & { message?: string };
  return {
    status: typeof e?.status === 'number' ? e.status : 0,
    code: typeof e?.code === 'string' ? e.code : 'network',
    message: typeof e?.message === 'string' ? e.message : 'Something went wrong',
    ...(e?.details !== undefined ? { details: e.details } : {}),
  };
}

/** Status line under the toolbar. */
export interface EditorStatus {
  tone: 'info' | 'ok' | 'error';
  text: string;
}

/** A round loaded by share code, shown read-only until copied. */
export interface ViewingShared {
  code: string;
  author: string | null;
}

/** Editor state and actions. */
export interface EditorState {
  round: RoundDefinitionInput;
  description: string;
  draftId: string;
  /** Code of the shared round this draft publishes to. */
  sharedCode: string | null;
  /** Set while viewing someone's shared round (read-only until copied). */
  viewing: ViewingShared | null;
  selection: ItemRef[];
  placing: Placing;
  gizmo: GizmoMode;
  /** Grid step for moves (m); 0 = free. */
  snapStep: number;
  /** Rotation step (degrees). */
  rotateStep: number;
  panel: EditorPanel;
  validation: CustomRoundValidation;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  status: EditorStatus | null;
  drafts: RoundDraft[];
  shared: SharedRoundSummary[] | null;
  busy: boolean;

  edit(change: (round: RoundDefinitionInput) => RoundDefinitionInput, group?: string | null): void;
  setDescription(text: string): void;
  select(refs: ItemRef[], mode?: 'replace' | 'toggle' | 'add'): void;
  selectAll(): void;
  setPlacing(p: Placing): void;
  placeAt(at: Vec3): void;
  setGizmo(mode: GizmoMode): void;
  setSnap(step: number): void;
  setPanel(panel: EditorPanel): void;
  moveSelection(delta: Vec3, group?: string | null): void;
  rotateSelection(deg: number): void;
  scaleSelection(factor: Vec3): void;
  deleteSelection(): void;
  copy(): void;
  paste(): void;
  duplicate(): void;
  undo(): void;
  redo(): void;
  setType(type: CustomRoundType): void;

  newRound(type?: CustomRoundType): void;
  refreshDrafts(): Promise<void>;
  saveDraft(): Promise<boolean>;
  openDraft(id: string): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  importFile(text: string): boolean;
  exportFile(): string;
  prepareTestPlay(): Promise<boolean>;

  loadByCode(input: string): Promise<boolean>;
  makeCopy(): void;
  publish(): Promise<string | null>;
  refreshShared(): Promise<void>;
  setSharedPublished(code: string, published: boolean): Promise<void>;
  deleteShared(code: string): Promise<void>;
  reportShared(reason: RoundReportReason, details?: string): Promise<boolean>;
}

/** Collaborators for {@link createEditorStore}. */
export interface EditorDeps {
  drafts: DraftStore;
  api: EditorApi | null;
  now?: () => number;
  newId?: () => string;
}

/** The validator's verdict on a finalized round. */
export function validateDraft(round: RoundDefinitionInput): CustomRoundValidation {
  return validateCustomRound(finalizeRound(round));
}

/** Paste offset, so a copy never lands exactly on its original. */
const PASTE_OFFSET = { x: 2, y: 0, z: 2 };

/**
 * Creates an editor store.
 *
 * @param deps - Draft storage, the API (null offline) and clocks.
 * @example
 * const editor = createEditorStore({ drafts: defaultDrafts(), api: editorApi(client) });
 * editor.getState().placeAt({ x: 0, y: 0, z: 10 });
 */
export function createEditorStore(deps: EditorDeps): StoreApi<EditorState> {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => `draft-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const initial = starterRound('race');
  const history = new History<RoundDefinitionInput>(initial);
  let clipboard: Clipboard | null = null;

  return createStore<EditorState>()((set, get) => {
    /** Applies a new round: history, validation, selection clean-up. */
    const commit = (round: RoundDefinitionInput, group: string | null = null, selection?: ItemRef[]) => {
      if (get().viewing) {
        set({ status: { tone: 'info', text: 'This is a shared round. Make a copy to edit it.' } });
        return;
      }
      history.push(round, group, now());
      apply(round, selection);
    };
    const apply = (round: RoundDefinitionInput, selection?: ItemRef[]) => {
      set({
        round,
        dirty: true,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        validation: validateDraft(round),
        selection: (selection ?? get().selection).filter((r) => refExists(round, r)),
      });
    };
    const load = (round: RoundDefinitionInput, extra: Partial<EditorState>) => {
      history.reset(round);
      set({
        round,
        selection: [],
        placing: null,
        dirty: false,
        canUndo: false,
        canRedo: false,
        validation: validateDraft(round),
        ...extra,
      });
    };
    const centroid = (): Vec3 => {
      const pts = get()
        .selection.map((r) => itemPosition(get().round, r))
        .filter((p): p is Vec3 => !!p);
      if (pts.length === 0) return { x: 0, y: 0, z: 0 };
      return {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
        z: pts.reduce((s, p) => s + p.z, 0) / pts.length,
      };
    };
    const draftOf = (s: EditorState, round: RoundDefinitionInput, id = s.draftId): RoundDraft => ({
      id,
      name: String(round.name ?? 'Untitled'),
      type: String(round.type),
      description: s.description,
      round,
      sharedCode: s.sharedCode,
      updatedAt: now(),
    });
    const fail = (err: unknown, prefix: string) => {
      const f = apiFailure(err);
      set({ busy: false, status: { tone: 'error', text: `${prefix}: ${f.message}` } });
      return f;
    };

    return {
      round: initial,
      description: '',
      draftId: newId(),
      sharedCode: null,
      viewing: null,
      selection: [],
      placing: null,
      gizmo: 'move',
      snapStep: 1,
      rotateStep: 15,
      panel: 'build',
      validation: validateDraft(initial),
      dirty: false,
      canUndo: false,
      canRedo: false,
      status: null,
      drafts: [],
      shared: null,
      busy: false,

      edit: (change, group = null) => commit(change(get().round), group),
      setDescription: (text) => {
        if (get().viewing) return;
        set({ description: text.slice(0, CUSTOM_ROUND_LIMITS.descriptionMax), dirty: true });
      },
      select: (refs, mode = 'replace') => {
        const cur = get().selection;
        if (mode === 'replace') set({ selection: refs });
        else if (mode === 'add')
          set({ selection: [...cur, ...refs.filter((r) => !cur.some((c) => refKey(c) === refKey(r)))] });
        else {
          const keys = new Set(refs.map(refKey));
          const kept = cur.filter((c) => !keys.has(refKey(c)));
          set({ selection: [...kept, ...refs.filter((r) => !cur.some((c) => refKey(c) === refKey(r)))] });
        }
      },
      selectAll: () => {
        const r = get().round;
        set({
          selection: [
            ...r.geometry.map((_, index): ItemRef => ({ kind: 'geometry', index })),
            ...(r.obstacles ?? []).map((o): ItemRef => ({ kind: 'obstacle', id: o.id })),
            ...(r.triggers ?? []).map((t): ItemRef => ({ kind: 'trigger', id: t.id })),
          ],
        });
      },
      setPlacing: (placing) => set({ placing }),
      placeAt: (at) => {
        const p = get().placing;
        if (!p) return;
        const step = get().snapStep;
        const s = (n: number) => (step > 0 ? Math.round(n / step) * step : Math.round(n * 100) / 100);
        const spot = { x: s(at.x), y: Math.round(at.y * 100) / 100, z: s(at.z) };
        const round = get().round;
        if (p.kind === 'part') {
          const r = addPart(round, p.id, spot);
          commit(r.round, null, [r.ref]);
        } else if (p.kind === 'obstacle') {
          const r = addObstacle(round, p.type, spot);
          commit(r.round, null, [r.ref]);
        } else {
          const r = addMarker(round, p.marker, spot);
          commit(r.round, null, r.refs);
        }
      },
      setGizmo: (gizmo) => set({ gizmo }),
      setSnap: (snapStep) => set({ snapStep: Math.max(0, Math.min(10, snapStep)) }),
      setPanel: (panel) => set({ panel }),
      moveSelection: (delta, group = null) => {
        if (get().selection.length === 0) return;
        commit(moveItems(get().round, get().selection, delta), group);
      },
      rotateSelection: (deg) => {
        if (get().selection.length === 0) return;
        commit(rotateItems(get().round, get().selection, deg, centroid()));
      },
      scaleSelection: (factor) => {
        if (get().selection.length === 0) return;
        commit(scaleItems(get().round, get().selection, factor));
      },
      deleteSelection: () => {
        const sel = get().selection.filter((r) => r.kind !== 'spawn');
        if (sel.length === 0) return;
        commit(deleteItems(get().round, sel), null, []);
      },
      copy: () => {
        const sel = get().selection.filter((r) => r.kind !== 'spawn');
        if (sel.length === 0) return;
        clipboard = copyItems(get().round, sel);
        set({ status: { tone: 'info', text: `Copied ${sel.length} item${sel.length === 1 ? '' : 's'}` } });
      },
      paste: () => {
        if (!clipboard) return;
        const r = pasteItems(get().round, clipboard, PASTE_OFFSET);
        commit(r.round, null, r.refs);
        // Pasting again stacks the next copy one more step along.
        clipboard = copyItems(r.round, r.refs);
      },
      duplicate: () => {
        get().copy();
        get().paste();
      },
      undo: () => {
        if (get().viewing || !history.canUndo) return;
        apply(history.undo());
      },
      redo: () => {
        if (get().viewing || !history.canRedo) return;
        apply(history.redo());
      },
      setType: (type) => commit(setRoundType(get().round, type)),

      newRound: (type = 'race') => {
        if (get().busy) return;
        load(starterRound(type), {
          draftId: newId(),
          description: '',
          sharedCode: null,
          viewing: null,
          status: null,
        });
      },
      refreshDrafts: async () => {
        try {
          set({ drafts: await deps.drafts.list() });
        } catch {
          set({ status: { tone: 'error', text: 'Local saves are unavailable in this browser' } });
        }
      },
      saveDraft: async () => {
        const s = get();
        if (s.viewing) {
          set({ status: { tone: 'info', text: 'Make a copy to save this round' } });
          return false;
        }
        try {
          await deps.drafts.put(draftOf(s, s.round));
          set({ dirty: false, status: { tone: 'ok', text: 'Saved on this device' } });
          await get().refreshDrafts();
          return true;
        } catch {
          set({ status: { tone: 'error', text: 'Could not save on this device' } });
          return false;
        }
      },
      openDraft: async (id) => {
        if (get().busy) return;
        const d = await deps.drafts.get(id);
        if (!d) return;
        load(d.round, {
          draftId: d.id,
          description: d.description,
          sharedCode: d.sharedCode,
          viewing: null,
          status: null,
        });
      },
      deleteDraft: async (id) => {
        await deps.drafts.delete(id);
        await get().refreshDrafts();
      },
      importFile: (text) => {
        const f = parseRoundFile(text);
        if (!f.ok) {
          set({ status: { tone: 'error', text: f.error } });
          return false;
        }
        load(f.round as RoundDefinitionInput, {
          draftId: newId(),
          description: f.description,
          sharedCode: null,
          viewing: null,
          status: { tone: 'ok', text: 'Imported. Save to keep it on this device.' },
        });
        set({ dirty: true });
        return true;
      },
      exportFile: () => exportRoundFile(finalizeRound(get().round), get().description),
      prepareTestPlay: async () => {
        const round = finalizeRound(get().round);
        const v = validateCustomRound(round);
        if (!v.ok) {
          set({ status: { tone: 'error', text: 'Fix the errors before Test play' } });
          return false;
        }
        try {
          await deps.drafts.put(draftOf(get(), round, PLAYTEST_DRAFT_ID));
          return true;
        } catch {
          set({ status: { tone: 'error', text: 'Local storage is unavailable, so Test play cannot start' } });
          return false;
        }
      },

      loadByCode: async (input) => {
        const code = normalizeShareCode(input);
        if (!code) {
          set({ status: { tone: 'error', text: 'Codes are 8 letters and numbers' } });
          return false;
        }
        if (!deps.api) {
          set({ status: { tone: 'error', text: 'Sharing needs the online service' } });
          return false;
        }
        const from = get().draftId;
        set({ busy: true });
        try {
          const shared = await deps.api.fetchRound(code);
          // Another round was opened while this one loaded: it keeps the editor.
          if (get().draftId !== from) {
            set({ busy: false });
            return false;
          }
          load(shared.definition as RoundDefinitionInput, {
            draftId: newId(),
            description: shared.description,
            sharedCode: null,
            viewing: { code, author: shared.author },
            busy: false,
            status: {
              tone: 'info',
              text: `Viewing ${shared.name}${shared.author ? ` by ${shared.author}` : ''}`,
            },
          });
          return true;
        } catch (err) {
          const f = fail(err, 'Could not load that round');
          if (f.code === 'taken_down')
            set({ status: { tone: 'error', text: 'That round was removed by moderators' } });
          else if (f.status === 404)
            set({ status: { tone: 'error', text: 'No shared round has that code' } });
          return false;
        }
      },
      makeCopy: () => {
        const s = get();
        if (!s.viewing) return;
        const round = {
          ...s.round,
          name: `${String(s.round.name)} copy`.slice(0, CUSTOM_ROUND_LIMITS.nameMax),
        };
        load(round, {
          draftId: newId(),
          sharedCode: null,
          viewing: null,
          status: { tone: 'ok', text: 'Copied. This draft is yours to edit.' },
        });
        set({ dirty: true });
      },
      publish: async () => {
        const s = get();
        if (s.viewing) return null;
        if (!deps.api || !deps.api.signedIn()) {
          set({ status: { tone: 'error', text: 'Sign in from the game to share rounds' } });
          return null;
        }
        const round = finalizeRound(s.round);
        if (!validateCustomRound(round).ok) {
          set({ status: { tone: 'error', text: 'Fix the errors before sharing' } });
          return null;
        }
        const draftId = s.draftId;
        set({ busy: true, status: { tone: 'info', text: 'Sharing…' } });
        try {
          if ((await deps.api.isGuest()) === true) {
            set({
              busy: false,
              status: { tone: 'error', text: 'Guests cannot share. Link a sign-in in the game first.' },
            });
            return null;
          }
          const summary = s.sharedCode
            ? await deps.api.update(s.sharedCode, round, s.description)
            : await deps.api.publish(round, s.description);
          if (get().draftId !== draftId) {
            // Another round was opened meanwhile: the code belongs to the draft that was shared, so
            // the next Update from the open one doesn't overwrite this shared round.
            const stored = await deps.drafts.get(draftId).catch(() => null);
            await deps.drafts
              .put(stored ? { ...stored, sharedCode: summary.code } : draftOf({ ...s, sharedCode: summary.code }, round))
              .catch(() => undefined);
            set({ busy: false, status: { tone: 'ok', text: `Shared ${String(round.name)} as ${summary.code}` } });
            void get().refreshDrafts();
            void get().refreshShared();
            return summary.code;
          }
          set({
            sharedCode: summary.code,
            busy: false,
            status: { tone: 'ok', text: `Shared as ${summary.code}` },
          });
          await get().saveDraft();
          set({ status: { tone: 'ok', text: `Shared as ${summary.code}` } });
          void get().refreshShared();
          return summary.code;
        } catch (err) {
          const f = fail(err, 'Sharing failed');
          if (f.code === 'invalid_round' && Array.isArray(f.details) && f.details.length > 0)
            set({
              status: {
                tone: 'error',
                text: `The server refused it: ${(f.details[0] as { message?: string }).message ?? f.message}`,
              },
            });
          return null;
        }
      },
      refreshShared: async () => {
        if (!deps.api?.signedIn()) {
          set({ shared: null });
          return;
        }
        try {
          set({ shared: await deps.api.mine() });
        } catch {
          set({ shared: null });
        }
      },
      setSharedPublished: async (code, published) => {
        if (!deps.api) return;
        try {
          await deps.api.setPublished(code, published);
          await get().refreshShared();
        } catch (err) {
          fail(err, published ? 'Could not republish' : 'Could not unpublish');
        }
      },
      deleteShared: async (code) => {
        if (!deps.api) return;
        try {
          await deps.api.remove(code);
          if (get().sharedCode === code) set({ sharedCode: null });
          await get().refreshShared();
        } catch (err) {
          fail(err, 'Could not delete');
        }
      },
      reportShared: async (reason, details) => {
        const v = get().viewing;
        if (!v || !deps.api) return false;
        if (!deps.api.signedIn()) {
          set({ status: { tone: 'error', text: 'Sign in from the game to report rounds' } });
          return false;
        }
        try {
          await deps.api.report(v.code, reason, details);
          set({ status: { tone: 'ok', text: 'Thanks. Moderators will take a look.' } });
          return true;
        } catch (err) {
          const f = fail(err, 'Report failed');
          if (f.code === 'already_reported')
            set({ status: { tone: 'info', text: 'You already reported this round' } });
          return false;
        }
      },
    };
  });
}
