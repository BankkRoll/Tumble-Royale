/**
 * The menu's tab cross-fade fades a dead copy of the outgoing tab, never a
 * second live mount: the copy has no navigation targets or test ids, is
 * hidden from assistive tech and inert.
 */
import { describe, expect, it } from 'vitest';
import { inertTabGhost } from '../src/screens/menu/MainMenu.tsx';

/** Just the Element surface `inertTabGhost` touches. */
class FakeEl {
  readonly attrs = new Map<string, string>();
  constructor(
    attrs: Record<string, string>,
    readonly children: FakeEl[] = [],
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    if (sel !== '*') throw new Error(`unexpected selector ${sel}`);
    return this.children.flatMap((c) => [c, ...c.querySelectorAll('*')]);
  }
}

describe('inertTabGhost', () => {
  const tree = (): FakeEl =>
    new FakeEl(
      {
        class: 'tr-tab-panel tr-tab-panel--locker tr-tab-from-right',
        role: 'tabpanel',
        'data-testid': 'panel-locker',
      },
      [
        new FakeEl({ 'data-nav': '', 'data-autofocus': '', 'data-testid': 'equip' }, [
          new FakeEl({ 'data-nav-back': '', 'data-nav': '', title: 'Back' }),
        ]),
        new FakeEl({ 'data-nav-scope': '5', 'data-nav-tabs': '' }),
      ],
    );

  it('strips every navigation target and test id, at any depth', () => {
    const g = inertTabGhost(tree() as unknown as Element, 'locker', 'right') as unknown as FakeEl;
    for (const el of [g, ...g.querySelectorAll('*')]) {
      for (const a of [
        'data-nav',
        'data-autofocus',
        'data-nav-back',
        'data-nav-scope',
        'data-nav-tabs',
        'data-testid',
      ])
        expect(el.getAttribute(a)).toBeNull();
    }
    // Non-interactive attributes survive, so the picture looks the same.
    expect(g.querySelectorAll('*')[1]!.getAttribute('title')).toBe('Back');
  });

  it('becomes a hidden, inert leaving panel moving the right way', () => {
    const g = inertTabGhost(tree() as unknown as Element, 'locker', 'left') as unknown as FakeEl;
    expect(g.getAttribute('class')).toBe('tr-tab-panel tr-tab-panel--locker is-leaving to-left');
    expect(g.getAttribute('role')).toBeNull();
    expect(g.getAttribute('aria-hidden')).toBe('true');
    expect(g.getAttribute('inert')).toBe('');
  });
});
