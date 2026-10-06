/**
 * Round editor: document operations, undo/redo, generated param forms, the
 * store's flows (place, clipboard, save, import/export round trip, Test play
 * handoff, publish, load by code read-only, report) against fakes, the panels'
 * states as server-rendered markup, and that the editor stays out of the
 * game's bundle.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { starterRound, validateCustomRound } from '@tumble/content/custom';
import { PLAYTEST_DRAFT_ID, memoryDrafts } from '../src/customRounds/drafts.ts';
import { humanize, paramFields, readField } from '../src/editor/forms.ts';
import { History } from '../src/editor/history.ts';
import {
  addMarker,
  addObstacle,
  addPart,
  copyItems,
  deleteItems,
  finalizeRound,
  moveItems,
  pasteItems,
  rotateItems,
  scaleItems,
  setRoundType,
  snap,
} from '../src/editor/model.ts';
import { createEditorStore, type EditorApi, type SharedRoundSummary } from '../src/editor/store.ts';
import { EditorContext } from '../src/editor/ui/kit.tsx';
import { Inspector } from '../src/editor/ui/Inspector.tsx';
import { Issues } from '../src/editor/ui/Issues.tsx';
import { Palette } from '../src/editor/ui/Palette.tsx';
import { OpenByCode, PublishBox } from '../src/editor/ui/SharePanel.tsx';
import { Toolbar } from '../src/editor/ui/Toolbar.tsx';
import { typingInto } from '../src/editor/ui/App.tsx';

const at = (x: number, y: number, z: number) => ({ x, y, z });

describe('document operations', () => {
  it('adds parts, obstacles and course markers', () => {
    const base = starterRound();
    const p = addPart(base, 'floor', at(0, 2, 80));
    expect(p.round.geometry).toHaveLength(base.geometry.length + 1);
    expect(p.round.geometry.at(-1)?.position.y).toBe(1.5);
    expect(base.geometry).toHaveLength(4);
    const o = addObstacle(p.round, 'pendulumHammer', at(0, 0, 20));
    expect(o.ref).toEqual({ kind: 'obstacle', id: 'pendulum-hammer-1' });
    const cp = addMarker(o.round, 'checkpoint', at(0, 0, 22));
    const trig = cp.round.triggers!.find((t) => t.id === (cp.refs[0] as { id: string }).id)!;
    expect(trig.index).toBe(2);
    expect(trig.respawn).toHaveLength(3);
    expect(cp.round.obstacles!.at(-1)).toMatchObject({ type: 'checkpointGate', params: { index: 2 } });
  });

  it('moves, turns and sizes the selection', () => {
    const r = starterRound();
    const cp = { kind: 'trigger' as const, id: 'cp-1' };
    const moved = moveItems(r, [cp, { kind: 'spawn' }], at(1, 0, 2));
    const t = moved.triggers!.find((x) => x.id === 'cp-1')!;
    expect(t.position).toEqual(at(1, 2, 42));
    expect(t.respawn![0]).toEqual(at(-2, 0.1, 44));
    expect(moved.spawn.origin).toEqual(at(1, 0.1, 2));
    const turned = rotateItems(r, [{ kind: 'geometry', index: 1 }], 90, at(0, 0, 0));
    expect(turned.geometry[1]!.position).toEqual(at(22, -0.5, 0));
    expect(turned.geometry[1]!.rotation?.yaw).toBe(90);
    const sized = scaleItems(r, [{ kind: 'geometry', index: 0 }], at(2, 1, 0.5));
    expect(sized.geometry[0]!.size).toEqual(at(32, 1, 8));
    expect(snap(3.4, 0.5)).toBe(3.5);
    expect(snap(3.456, 0)).toBe(3.46);
  });

  it('copies, pastes with fresh ids and renumbers pasted checkpoints', () => {
    const r = starterRound();
    const clip = copyItems(r, [
      { kind: 'trigger', id: 'cp-1' },
      { kind: 'obstacle', id: 'cp-1-gate' },
      { kind: 'geometry', index: 2 },
    ]);
    const p = pasteItems(r, clip, at(0, 0, 10));
    expect(p.refs).toHaveLength(3);
    const t = p.round.triggers!.find((x) => x.id === (p.refs[1] as { id: string }).id)!;
    expect(t.index).toBe(2);
    expect(t.position.z).toBe(50);
    const gate = p.round.obstacles!.find((x) => x.id === (p.refs[2] as { id: string }).id)!;
    expect(gate.params).toMatchObject({ index: 2 });
    expect(new Set(p.round.obstacles!.map((o) => o.id)).size).toBe(p.round.obstacles!.length);
  });

  it('deletes and keeps the type consistent', () => {
    const r = deleteItems(starterRound(), [
      { kind: 'geometry', index: 0 },
      { kind: 'trigger', id: 'finish' },
    ]);
    expect(r.geometry).toHaveLength(3);
    expect(r.triggers!.map((t) => t.id)).toEqual(['cp-1']);
    const hunt = setRoundType(starterRound(), 'hunt');
    expect(hunt.qualification).toMatchObject({ mode: 'scoreTarget', scoreGoal: 5 });
    const surv = setRoundType(hunt, 'survival');
    expect(surv.qualification.mode).toBe('survive');
    expect(surv.qualification.scoreGoal).toBeUndefined();
    expect(surv.fallBehavior).toBe('eliminate');
  });

  it('fits bounds and flyover to the content', () => {
    const r = addPart(starterRound(), 'floor', at(0, 0, 300)).round;
    const f = finalizeRound(r);
    expect(f.bounds.max.z).toBeGreaterThan(300);
    expect(f.flyover.path.length).toBeGreaterThanOrEqual(2);
    expect(validateCustomRound(finalizeRound(starterRound())).ok).toBe(true);
  });
});

describe('undo/redo', () => {
  it('steps back and forward and drops redo after a new edit', () => {
    const h = new History(0, 3);
    h.push(1, null, 0);
    h.push(2, null, 10);
    expect(h.undo()).toBe(1);
    expect(h.redo()).toBe(2);
    h.undo();
    h.push(5, null, 20);
    expect(h.canRedo).toBe(false);
    h.push(6, null, 30);
    h.push(7, null, 40);
    h.push(8, null, 50);
    // Limited to 3 steps.
    expect([h.undo(), h.undo(), h.undo(), h.undo()]).toEqual([7, 6, 5, 5]);
  });

  it('merges quick edits of the same field', () => {
    const h = new History('a');
    h.push('b', 'speed', 0);
    h.push('c', 'speed', 100);
    h.push('d', 'speed', 2000);
    expect(h.undo()).toBe('c');
    expect(h.undo()).toBe('a');
  });
});

describe('generated forms', () => {
  it('describes obstacle params from their schemas', () => {
    const f = paramFields('pendulumHammer');
    expect(f.find((x) => x.key === 'amplitudeDeg')).toMatchObject({
      kind: 'number',
      min: 1,
      max: 170,
      default: 65,
      label: 'Amplitude (°)',
    });
    expect(f.find((x) => x.key === 'supports')).toMatchObject({ kind: 'boolean', default: true });
    expect(f.find((x) => x.key === 'period')).toMatchObject({ exclusiveMin: true, min: 0 });
    const mover = paramFields('movingPlatform');
    expect(mover.find((x) => x.key === 'points')?.kind).toBe('points');
    expect(mover.find((x) => x.key === 'size')?.kind).toBe('vec3');
    expect(mover.find((x) => x.key === 'mode')).toMatchObject({
      kind: 'enum',
      options: ['pingPong', 'loop'],
    });
    expect(paramFields('risingSlime').find((x) => x.key === 'keyframes')?.kind).toBe('json');
    expect(paramFields('nope')).toEqual([]);
    expect(humanize('armLength')).toBe('Arm length');
  });

  it('reads typed values with errors', () => {
    const period = paramFields('pendulumHammer').find((x) => x.key === 'period')!;
    expect(readField(period, '2.5')).toEqual({ ok: true, value: 2.5 });
    expect(readField(period, '0')).toEqual({ ok: false, error: 'Must be above 0' });
    expect(readField(period, 'x')).toEqual({ ok: false, error: 'Enter a number' });
    const seed = paramFields('teleporterPair').find((x) => x.key === 'seed')!;
    expect(readField(seed, '1.5')).toEqual({ ok: false, error: 'Enter a whole number' });
    const json = paramFields('risingSlime').find((x) => x.key === 'keyframes')!;
    expect(readField(json, '[{"t":0,"h":1}]')).toEqual({ ok: true, value: [{ t: 0, h: 1 }] });
    expect(readField(json, '[')).toEqual({ ok: false, error: 'Not valid JSON' });
  });
});

function fakeApi(over: Partial<EditorApi> = {}) {
  const calls: string[] = [];
  const summary = (code: string): SharedRoundSummary => ({
    code,
    name: 'My Race',
    description: '',
    type: 'race',
    status: 'published',
    updatedAt: '2026-10-06T12:00:00.000Z',
  });
  const api: EditorApi = {
    signedIn: () => true,
    isGuest: async () => false,
    fetchRound: async (code) => ({
      code,
      name: 'Their Race',
      description: 'hi',
      author: 'Maker#1234',
      definition: starterRound(),
    }),
    publish: async () => {
      calls.push('publish');
      return summary('K7MQ2X9A');
    },
    update: async (code) => {
      calls.push(`update:${code}`);
      return summary(code);
    },
    mine: async () => [summary('K7MQ2X9A')],
    setPublished: async (code) => summary(code),
    remove: async () => undefined,
    report: async (code, reason) => void calls.push(`report:${code}:${reason}`),
    ...over,
  };
  return { api, calls };
}

let idn = 0;
const store = (api: EditorApi | null = fakeApi().api, drafts = memoryDrafts()) => {
  const s = createEditorStore({ drafts, api, newId: () => `d${++idn}`, now: () => 1_000 });
  // NOTE: zustand's useStore renders a store's *initial* state on the server; point it at the live state.
  (s as unknown as { getInitialState: () => unknown }).getInitialState = s.getState;
  return s;
};

describe('editor store', () => {
  it('places, selects and undoes as one step each', () => {
    const s = store();
    s.getState().setPlacing({ kind: 'obstacle', type: 'bumperPillar' });
    s.getState().placeAt(at(0.4, 0, 20.6));
    const st = s.getState();
    expect(st.round.obstacles!.at(-1)).toMatchObject({ type: 'bumperPillar', position: at(0, 0, 21) });
    expect(st.selection).toEqual([{ kind: 'obstacle', id: 'bumper-pillar-1' }]);
    st.moveSelection(at(1, 0, 0));
    expect(s.getState().round.obstacles!.at(-1)!.position.x).toBe(1);
    s.getState().undo();
    s.getState().undo();
    expect(s.getState().round.obstacles).toHaveLength(2);
    expect(s.getState().selection).toEqual([]);
    s.getState().redo();
    expect(s.getState().round.obstacles).toHaveLength(3);
  });

  it('copies, pastes, duplicates and deletes the selection', () => {
    const s = store();
    s.getState().select([{ kind: 'geometry', index: 1 }]);
    s.getState().duplicate();
    expect(s.getState().round.geometry).toHaveLength(5);
    expect(s.getState().selection).toEqual([{ kind: 'geometry', index: 4 }]);
    s.getState().paste();
    expect(s.getState().round.geometry).toHaveLength(6);
    expect(s.getState().round.geometry[5]!.position.x).toBe(4);
    s.getState().deleteSelection();
    expect(s.getState().round.geometry).toHaveLength(5);
  });

  it('flags errors live and blocks Test play and sharing until fixed', async () => {
    const drafts = memoryDrafts();
    const { api, calls } = fakeApi();
    const s = store(api, drafts);
    s.getState().edit((r) => ({ ...r, triggers: r.triggers!.filter((t) => t.kind !== 'finish') }));
    expect(s.getState().validation.ok).toBe(false);
    expect(await s.getState().prepareTestPlay()).toBe(false);
    expect(await drafts.get(PLAYTEST_DRAFT_ID)).toBeNull();
    expect(await s.getState().publish()).toBeNull();
    expect(calls).toEqual([]);
    s.getState().undo();
    expect(await s.getState().prepareTestPlay()).toBe(true);
    expect((await drafts.get(PLAYTEST_DRAFT_ID))?.round.bounds).toBeDefined();
  });

  it('saves drafts and round-trips export and import', async () => {
    const drafts = memoryDrafts();
    const s = store(null, drafts);
    s.getState().edit((r) => ({ ...r, name: 'Bouncy Bridges' }));
    s.getState().setDescription('Hop across');
    expect(await s.getState().saveDraft()).toBe(true);
    expect(s.getState().dirty).toBe(false);
    expect(s.getState().drafts.map((d) => d.name)).toEqual(['Bouncy Bridges']);
    const file = s.getState().exportFile();
    const other = store(null, drafts);
    expect(other.getState().importFile(file)).toBe(true);
    expect(other.getState().round.name).toBe('Bouncy Bridges');
    expect(other.getState().description).toBe('Hop across');
    expect(other.getState().exportFile()).toBe(file);
    expect(other.getState().importFile('not json')).toBe(false);
    expect(other.getState().status?.tone).toBe('error');
    await other.getState().openDraft(s.getState().draftId);
    expect(other.getState().round.name).toBe('Bouncy Bridges');
  });

  it('publishes, then updates the same code', async () => {
    const { api, calls } = fakeApi();
    const s = store(api);
    expect(await s.getState().publish()).toBe('K7MQ2X9A');
    expect(s.getState().sharedCode).toBe('K7MQ2X9A');
    await s.getState().publish();
    expect(calls).toEqual(['publish', 'update:K7MQ2X9A']);
  });

  it('refuses to share for guests and signed-out players', async () => {
    const guest = store(fakeApi({ isGuest: async () => true }).api);
    expect(await guest.getState().publish()).toBeNull();
    expect(guest.getState().status?.text).toMatch(/Guests cannot share/);
    const out = store(fakeApi({ signedIn: () => false }).api);
    expect(await out.getState().publish()).toBeNull();
    expect(out.getState().status?.text).toMatch(/Sign in/);
  });

  it('opens a shared round read-only until copied, and reports it', async () => {
    const { api, calls } = fakeApi();
    const s = store(api);
    expect(await s.getState().loadByCode('k7mq-2x9a')).toBe(true);
    expect(s.getState().viewing).toEqual({ code: 'K7MQ2X9A', author: 'Maker#1234' });
    const before = s.getState().round;
    s.getState().select([{ kind: 'geometry', index: 0 }]);
    s.getState().deleteSelection();
    expect(s.getState().round).toBe(before);
    expect(await s.getState().saveDraft()).toBe(false);
    expect(await s.getState().reportShared('offensive')).toBe(true);
    expect(calls).toEqual(['report:K7MQ2X9A:offensive']);
    s.getState().makeCopy();
    expect(s.getState().viewing).toBeNull();
    expect(s.getState().round.name).toBe('My Race copy');
    s.getState().deleteSelection();
    expect(await s.getState().loadByCode('bad')).toBe(false);
  });

  it('explains takedowns and unknown codes', async () => {
    const gone = store(
      fakeApi({
        fetchRound: async () => {
          throw Object.assign(new Error('removed'), { status: 410, code: 'taken_down' });
        },
      }).api,
    );
    await gone.getState().loadByCode('K7MQ2X9A');
    expect(gone.getState().status?.text).toBe('That round was removed by moderators');
    const missing = store(
      fakeApi({
        fetchRound: async () => {
          throw Object.assign(new Error('nope'), { status: 404, code: 'not_found' });
        },
      }).api,
    );
    await missing.getState().loadByCode('K7MQ2X9A');
    expect(missing.getState().status?.text).toBe('No shared round has that code');
  });
});

const render = (s: ReturnType<typeof store>, node: React.ReactNode) =>
  renderToStaticMarkup(<EditorContext.Provider value={s}>{node}</EditorContext.Provider>);

describe('editor panels', () => {
  it('shows checks: ready, then errors that block Test play', () => {
    const s = store();
    expect(render(s, <Issues />)).toContain('Ready to play');
    expect(render(s, <Toolbar onTestPlay={() => {}} onFocus={() => {}} />)).not.toMatch(
      /disabled=""[^>]*>Test play/,
    );
    s.getState().edit((r) => ({ ...r, triggers: [] }));
    const issues = render(s, <Issues />);
    expect(issues).toContain('1 error');
    expect(issues).toContain('Races need a finish');
    expect(render(s, <Toolbar onTestPlay={() => {}} onFocus={() => {}} />)).toMatch(
      /disabled=""[^>]*>Test play/,
    );
  });

  it('inspects an obstacle with generated param fields', () => {
    const s = store();
    s.getState().select([{ kind: 'obstacle', id: 'finish-arch' }]);
    const html = render(s, <Inspector />);
    expect(html).toContain('Finish Arch');
    expect(html).toContain('Pillar size');
    // `width` is overridden in the starter round and offers a reset.
    expect(html).toContain('aria-label="Reset Width"');
    expect(render(store(), <Inspector />)).toContain('Select something to edit it');
  });

  it('filters the palette by round type and locks it while viewing', async () => {
    const s = store();
    expect(render(s, <Palette />)).not.toContain('Comet Field');
    s.getState().setType('hunt');
    expect(render(s, <Palette />)).toContain('Comet Field');
    await s.getState().loadByCode('K7MQ2X9A');
    expect(render(s, <Palette />)).toContain('Make a copy to build on it');
  });

  it('shows share states', async () => {
    const s = store();
    expect(render(s, <PublishBox signedIn={false} />)).toContain('Guest accounts cannot share');
    await s.getState().publish();
    expect(render(s, <PublishBox signedIn />)).toContain('K7MQ2X9A');
    expect(render(s, <PublishBox signedIn />)).toContain('Update shared round');
    await s.getState().loadByCode('K7MQ2X9A');
    const view = render(s, <OpenByCode />);
    expect(view).toContain('viewing-banner');
    expect(view).toContain('Make a copy to edit');
  });

  it('keeps shortcuts out of text fields', () => {
    expect(typingInto({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(typingInto({ tagName: 'CANVAS' } as unknown as EventTarget)).toBe(false);
  });
});

describe('editor bundle', () => {
  const ROOT = resolve(import.meta.dirname, '..');
  const SRC = resolve(ROOT, 'src');
  const IMPORT_RE =
    /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g;
  function graph(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!/\.(ts|tsx)$/.test(file)) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
        const target = resolve(dirname(file), m[1] ?? m[2] ?? m[3]!);
        if (existsSync(target)) stack.push(target);
      }
    }
    return seen;
  }

  it('is its own production entry the game never reaches', () => {
    expect(readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8')).toMatch(
      /editor:\s*resolve\(root, 'editor\.html'\)/,
    );
    const game = graph(resolve(SRC, 'main.ts'));
    expect([...game].filter((f) => f.startsWith(resolve(SRC, 'editor')))).toEqual([]);
    expect(
      [...graph(resolve(SRC, 'editor/main.tsx'))].some((f) => f.startsWith(resolve(SRC, 'editor'))),
    ).toBe(true);
  });
});
