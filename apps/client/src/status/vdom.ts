/**
 * A few dozen lines of element building for the status page, so it ships
 * without a UI framework.
 *
 * Views return plain {@link VNode} trees. {@link mount} turns them into DOM
 * with `textContent` and `setAttribute` only (never `innerHTML`), and
 * {@link toHtml} renders the same tree to an escaped string for tests. Text
 * from the API, such as incident updates, therefore can never become markup.
 */

/** An element to create. */
export interface VNode {
  tag: string;
  attrs: Readonly<Record<string, string | undefined>>;
  children: Child[];
}

/** Anything a view may put inside an element; falsy values render nothing. */
export type Child = VNode | string | number | null | undefined | false | Child[];

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Builds an element.
 *
 * @param tag - Lower-case tag name.
 * @param attrs - Attributes; `undefined` values are left out.
 * @param children - Text and elements.
 * @returns The node.
 * @example
 * h('p', { class: 'note' }, 'Hello ', h('b', {}, name));
 */
export function h(tag: string, attrs: Record<string, string | undefined> = {}, ...children: Child[]): VNode {
  return { tag, attrs, children };
}

// SECURITY: links only ever point at http(s) or same-origin paths, so no
// `javascript:` URL can come out of data.
const URL_ATTRS = new Set(['href', 'src']);
function safeAttr(name: string, value: string): string | null {
  if (!NAME_RE.test(name) || name.startsWith('on')) return null;
  if (URL_ATTRS.has(name) && !/^(https?:\/\/|\/|#|\.\/)/i.test(value)) return null;
  return value;
}

function flatten(children: readonly Child[], out: (VNode | string)[] = []): (VNode | string)[] {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) flatten(c, out);
    else out.push(typeof c === 'number' ? String(c) : c);
  }
  return out;
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

/**
 * Renders a tree to an HTML string with every text and attribute escaped.
 *
 * @param node - Tree to render.
 * @returns HTML.
 */
export function toHtml(node: Child): string {
  return flatten([node])
    .map((n) => {
      if (typeof n === 'string') return escapeText(n);
      if (!NAME_RE.test(n.tag)) return '';
      const attrs = Object.entries(n.attrs)
        .flatMap(([k, v]) => {
          const safe = v === undefined ? null : safeAttr(k, v);
          return safe === null ? [] : [` ${k}="${escapeAttr(safe)}"`];
        })
        .join('');
      return `<${n.tag}${attrs}>${flatten(n.children).map(toHtml).join('')}</${n.tag}>`;
    })
    .join('');
}

/**
 * Creates DOM nodes for a tree.
 *
 * @param node - Tree to create.
 * @param doc - Document to create them in.
 * @returns A fragment holding the nodes.
 */
export function toDom(node: Child, doc: Document): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const n of flatten([node])) {
    if (typeof n === 'string') {
      frag.append(doc.createTextNode(n));
      continue;
    }
    if (!NAME_RE.test(n.tag)) continue;
    const el = doc.createElement(n.tag);
    for (const [k, v] of Object.entries(n.attrs)) {
      const safe = v === undefined ? null : safeAttr(k, v);
      if (safe !== null) el.setAttribute(k, safe);
    }
    for (const c of flatten(n.children)) el.append(toDom(c, doc));
    frag.append(el);
  }
  return frag;
}

/**
 * Replaces an element's content with a tree.
 *
 * @param root - Container.
 * @param node - New content.
 */
export function mount(root: Element, node: Child): void {
  root.replaceChildren(toDom(node, root.ownerDocument));
}
