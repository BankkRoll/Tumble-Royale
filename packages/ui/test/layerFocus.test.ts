/**
 * Focus follows layers: opening Settings over the main menu moves focus into
 * it (Enter can no longer press Play underneath) and closing it hands focus
 * back to the control that had it. Runs on a small fake DOM: just the
 * element tree, attributes, layout boxes and focus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enterLayer } from '../src/nav/navigation.ts';
import { openLayerKey, type OpenLayers } from '../src/nav/layerFocus.ts';

class FakeElement {
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly attrs = new Map<string, string>();
  disabled = false;

  constructor(
    readonly name: string,
    attrs: Record<string, string> = {},
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }

  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs)
      if (k.startsWith('data-')) out[k.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = v;
    return out;
  }

  get isConnected(): boolean {
    let el: FakeElement | null = this;
    while (el.parent) el = el.parent;
    return el === doc.body;
  }

  append(...kids: FakeElement[]): this {
    for (const k of kids) {
      k.parent = this;
      this.children.push(k);
    }
    return this;
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
    if (doc.activeElement !== doc.body && !(doc.activeElement as FakeElement).isConnected)
      doc.activeElement = doc.body;
  }

  contains(other: FakeElement | null): boolean {
    for (let el = other; el; el = el.parent) if (el === this) return true;
    return false;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const attr = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const c of el.children) {
        if (attr && c.attrs.has(attr)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 100, height: 40 };
  }

  focus(): void {
    if (this.isConnected) doc.activeElement = this;
  }

  blur(): void {
    if (doc.activeElement === this) doc.activeElement = doc.body;
  }
}

const doc = { body: new FakeElement('body'), activeElement: null as FakeElement | null };

describe('layer focus', () => {
  let root: FakeElement;
  let play: FakeElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', display: 'block' }));
    doc.body = new FakeElement('body');
    doc.activeElement = doc.body;
    root = new FakeElement('root');
    play = new FakeElement('play', { 'data-nav': '', 'data-autofocus': '' });
    root.append(new FakeElement('menu', { 'data-nav-scope': '0' }).append(play));
    doc.body.append(root);
    play.focus();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function openSettings(): { sheet: FakeElement; firstTab: FakeElement } {
    const firstTab = new FakeElement('tab', { 'data-nav': '', 'data-autofocus': '' });
    const sheet = new FakeElement('settings', { 'data-nav-scope': '10' }).append(firstTab);
    root.append(sheet);
    return { sheet, firstTab };
  }

  it('moves focus into Settings, so Enter can no longer press Play underneath', () => {
    const { firstTab } = openSettings();
    enterLayer(root as unknown as HTMLElement);
    expect(doc.activeElement).toBe(firstTab);
  });

  it('never leaves focus on the control underneath, even before the layer settles', () => {
    const sheet = new FakeElement('settings', { 'data-nav-scope': '10' });
    root.append(sheet);
    enterLayer(root as unknown as HTMLElement);
    expect(doc.activeElement).toBe(doc.body);
    const late = new FakeElement('tab', { 'data-nav': '', 'data-autofocus': '' });
    sheet.append(late);
    vi.advanceTimersByTime(200);
    expect(doc.activeElement).toBe(late);
  });

  it('restores focus to Play when Settings closes', () => {
    const { sheet } = openSettings();
    const leave = enterLayer(root as unknown as HTMLElement);
    sheet.remove();
    leave();
    expect(doc.activeElement).toBe(play);
  });

  it('chains: a dialog over Settings returns focus to Settings, then Settings to Play', () => {
    const { sheet, firstTab } = openSettings();
    const leaveSettings = enterLayer(root as unknown as HTMLElement);
    const ok = new FakeElement('ok', { 'data-nav': '', 'data-autofocus': '' });
    const dialog = new FakeElement('dialog', { 'data-nav-scope': '20' }).append(ok);
    root.append(dialog);
    const leaveDialog = enterLayer(root as unknown as HTMLElement);
    expect(doc.activeElement).toBe(ok);
    dialog.remove();
    leaveDialog();
    expect(doc.activeElement).toBe(firstTab);
    sheet.remove();
    leaveSettings();
    expect(doc.activeElement).toBe(play);
  });

  it('leaves focus alone when it already moved somewhere still on screen', () => {
    const { sheet } = openSettings();
    const leave = enterLayer(root as unknown as HTMLElement);
    const other = new FakeElement('other', { 'data-nav': '' });
    root.children[0]!.append(other);
    other.focus();
    sheet.remove();
    leave();
    expect(doc.activeElement).toBe(other);
  });
});

describe('openLayerKey', () => {
  const none: OpenLayers = {
    overlay: 'none',
    dialogId: null,
    wallet: 'none',
    playerCard: null,
    report: null,
    quickChat: false,
  };

  it('is null with nothing open and changes whenever a layer opens, closes or is replaced', () => {
    expect(openLayerKey(none)).toBeNull();
    const keys = [
      openLayerKey({ ...none, overlay: 'settings' }),
      openLayerKey({ ...none, overlay: 'settings', dialogId: 'x' }),
      openLayerKey({ ...none, overlay: 'friends' }),
      openLayerKey({ ...none, wallet: 'gems' }),
      openLayerKey({ ...none, playerCard: 'u1' }),
      openLayerKey({ ...none, report: 'u1' }),
      openLayerKey({ ...none, quickChat: true }),
    ];
    expect(keys.every((k) => k !== null)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
