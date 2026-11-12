/**
 * What the fill script reads from a page: its input fields in document
 * order, through shadow roots, each with the texts that say what it is for,
 * whether a person can see it and type into it, and the form it belongs to.
 * It reads; it never writes and never marks the page.
 * Spec: docs/internal/plans/click-to-fill.md (sections 3.4 and 3.5)
 */
import { EMPTY, prepare, type Prepared } from './text';

// Spec: docs/internal/plans/click-to-fill.md (section 3.4)
const MAX_INPUTS = 300;
const MAX_ROOTS = 6;
const MAX_TEXT = 200;
const MAX_NEAR_TEXT = 80;
// Spec: docs/internal/plans/click-to-fill.md (section 3.5)
const MIN_WIDTH = 20;
const MIN_HEIGHT = 8;
const MIN_OPACITY = 0.1;
/** What lies on a field may be this many times the field's size and still be its own decoration. */
const DECOR_MAX_AREA = 4;

const FIELD_TYPES = new Set(['text', 'email', 'tel', 'number', 'url', 'password']);
const DEV_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-name', 'data-field', 'formcontrolname'];
const HEADINGS = 'h1,h2,h3,legend,[role="heading"]';
const BUTTONS = 'button,input[type="submit"],[role="button"]';

/** The standard `autocomplete` tokens: they are read as roles, not as words. */
const KNOWN_AUTO =
  /^(on|off|name|honorific-(prefix|suffix)|(given|additional|family)-name|nickname|username|(new|current)-password|one-time-code|organization(-title)?|street-address|address-(line[123]|level[1234])|country(-name)?|postal-code|cc-.+|transaction-.+|language|bday(-.+)?|sex|url|photo|tel(-.+)?|email|impp|webauthn|shipping|billing|home|work|mobile|fax|pager|section-.+)$/;
/** The tokens for a person, an address or a payment detail. */
const PERSON_AUTO =
  /^(name|honorific-(prefix|suffix)|(given|additional|family)-name|nickname|organization(-title)?|street-address|address-(line[123]|level[1234])|country(-name)?|postal-code|transaction-.+|language|bday(-.+)?|sex|url|photo|impp)$/;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Field {
  el: HTMLInputElement;
  /** The place in document order, shadow content at its host. */
  index: number;
  kind: 'password' | 'text';
  type: string;
  /** The `autocomplete` tokens, lower case, without `webauthn`. */
  auto: string[];
  /** `webauthn` stood beside the tokens: the field signs in, it does not sign up. */
  webauthn: boolean;
  /** A person, address or payment token: never a username. */
  personAuto: boolean;
  /** What the developer called it: id, name, test ids. */
  dev: Prepared;
  /** id and name only. */
  idName: Prepared;
  /** What a person reads: label, aria-label, placeholder, title. */
  human: Prepared;
  usable: boolean;
  visible: boolean;
  box: Box;
  group: Group;
}

/** A hidden input that can name the account the page is signing in. */
interface HiddenValue {
  idName: Prepared;
  value: string;
}

export interface Group {
  form: HTMLFormElement | null;
  fields: Field[];
  hidden: HiddenValue[];
  /** The form's own names and its `action` path; empty for formless fields. */
  formText: Prepared;
}

export interface Page {
  fields: Field[];
  groups: Group[];
}

const cut = (text: string | null | undefined, max = MAX_TEXT): string => (text ?? '').trim().slice(0, max);

/** An open root, or a closed one through the door each browser gives an extension. */
function shadowOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  if (!el.localName.includes('-')) return null;
  try {
    const dom = (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } } }).chrome?.dom;
    return dom?.openOrClosedShadowRoot?.(el) ?? (el as { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot ?? null;
  } catch {
    return null;
  }
}

function collect(root: Document | ShadowRoot, depth: number, out: HTMLInputElement[]): void {
  const doc = root.ownerDocument ?? (root as Document);
  // 1 is NodeFilter.SHOW_ELEMENT.
  const walker = doc.createTreeWalker(root, 1);
  for (let node = walker.nextNode(); node && out.length < MAX_INPUTS; node = walker.nextNode()) {
    const el = node as Element;
    if (el.localName === 'input') out.push(el as HTMLInputElement);
    else if (depth < MAX_ROOTS) {
      const shadow = shadowOf(el);
      if (shadow) collect(shadow, depth + 1, out);
    }
  }
}

/** The form of a field, also when the form is outside the field's shadow root. */
function formOf(el: HTMLInputElement): HTMLFormElement | null {
  if (el.form) return el.form;
  for (let node: Element | null = el; node; ) {
    const form = node.closest('form');
    if (form) return form;
    node = (node.getRootNode() as ShadowRoot).host ?? null;
  }
  return null;
}

/** The nearest text before a field with no label of any kind. It stops at
 *  another field: that text is the other field's. */
function textBefore(el: Element): string {
  let node: Element | null = el;
  for (let up = 0; up < 2 && node; up++) {
    for (let s = node.previousSibling; s; s = s.previousSibling) {
      if (s.nodeType === 1) {
        const sib = s as Element;
        if (sib.localName === 'input' || sib.querySelector('input,select,textarea')) return '';
      }
      const text = (s.textContent ?? '').trim();
      if (text) return text.slice(-MAX_NEAR_TEXT);
    }
    node = node.parentElement;
  }
  return '';
}

function humanText(el: HTMLInputElement): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const parts: string[] = [];
  const labels = Array.from(el.labels ?? []);
  for (const label of labels) parts.push(cut(label.textContent));
  if (!labels.length && el.id) {
    for (const label of Array.from(root.querySelectorAll('label[for]'))) {
      if (label.getAttribute('for') === el.id) parts.push(cut(label.textContent));
    }
  }
  for (const id of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) {
    parts.push(cut(root.getElementById?.(id)?.textContent));
  }
  parts.push(cut(el.getAttribute('aria-label')), cut(el.getAttribute('placeholder')), cut(el.getAttribute('title')));
  const text = parts.filter(Boolean).join(' ');
  return text || textBefore(el);
}

function parentOf(el: Element): Element | null {
  return el.parentElement ?? (el.getRootNode() as ShadowRoot).host ?? null;
}

/** Shown at all: not `display: none`, not hidden, not transparent. */
function rendered(el: HTMLElement): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  const check = (el as { checkVisibility?: (o: object) => boolean }).checkVisibility;
  if (typeof check === 'function') {
    if (!check.call(el, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
  } else {
    // A browser without checkVisibility (the unit tests' jsdom).
    for (let a: Element | null = el; a; a = parentOf(a)) {
      const style = view.getComputedStyle(a);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || a.hasAttribute('hidden')) return false;
    }
  }
  const opacity = Number(view.getComputedStyle(el).opacity);
  return !(opacity < MIN_OPACITY);
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** Nothing lies over the field where a person would click it. Asked only
 *  for a point inside the window; a field further down is asked again after
 *  it is scrolled into view, before the write. */
function onTop(el: HTMLInputElement, box: Box): boolean {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  if (!view || typeof doc.elementFromPoint !== 'function') return true;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) return true;
  const top = doc.elementFromPoint(x, y);
  if (!top || top === el) return true;
  // The document answers with the outermost shadow host of what is there.
  for (let host = (el.getRootNode() as ShadowRoot).host; host; host = (host.getRootNode() as ShadowRoot).host) {
    if (host === top) return true;
  }
  // A floating label.
  if (Array.from(el.labels ?? []).some((label) => label === top || label.contains(top))) return true;
  // Or a small thing the site draws on the field: an icon, a frame, a hint.
  // A sheet that covers the page is far larger than the field it hides.
  const near = el.parentElement?.parentElement ?? el.parentElement;
  if (!near?.contains(top)) return false;
  const over = top.getBoundingClientRect();
  return over.width * over.height <= DECOR_MAX_AREA * box.width * box.height;
}

/** A person can see the field and reach it. */
export function isVisible(el: HTMLInputElement): { visible: boolean; box: Box } {
  const box = boxOf(el);
  const view = el.ownerDocument.defaultView;
  const minWidth = el.maxLength === 1 ? MIN_HEIGHT : MIN_WIDTH;
  const visible =
    rendered(el) &&
    box.width >= minWidth &&
    box.height >= MIN_HEIGHT &&
    // Parked to the left of or above the document.
    box.x + box.width + (view?.scrollX ?? 0) > 0 &&
    box.y + box.height + (view?.scrollY ?? 0) > 0 &&
    // Hidden from people on purpose: the bait field of a form.
    !(el.tabIndex === -1 && el.closest('[aria-hidden="true"]')) &&
    onTop(el, box);
  return { visible, box };
}

export function isUsable(el: HTMLInputElement): boolean {
  return (
    !el.disabled &&
    !el.matches(':disabled') &&
    !el.readOnly &&
    el.getAttribute('aria-disabled') !== 'true' &&
    el.getAttribute('aria-readonly') !== 'true' &&
    !el.closest('[inert]')
  );
}

function formText(form: HTMLFormElement): string {
  let path = '';
  const action = form.getAttribute('action');
  if (action) {
    try {
      path = new URL(action, form.ownerDocument.baseURI).pathname;
    } catch {
      path = '';
    }
  }
  return [form.id, form.getAttribute('name'), form.getAttribute('class'), form.getAttribute('aria-label'), path].map((t) => cut(t)).join(' ');
}

/** The last heading before a field, looked for in ever wider circles. */
function headingBefore(el: Element): string {
  let a = el.parentElement;
  for (let up = 0; up < 5 && a; up++, a = a.parentElement) {
    // 4 is DOCUMENT_POSITION_FOLLOWING: the field comes after the heading.
    const before = Array.from(a.querySelectorAll(HEADINGS)).filter((h) => h.compareDocumentPosition(el) & 4);
    const last = before[before.length - 1];
    if (last) return cut(last.textContent, MAX_NEAR_TEXT);
  }
  return '';
}

/** For fields with no form: the nearest box around the field that has a button. */
function scopeOf(el: Element): Element | null {
  let a = el.parentElement;
  for (let up = 0; up < 4 && a; up++, a = a.parentElement) {
    if (a.querySelector(BUTTONS)) return a;
  }
  return el.parentElement;
}

/**
 * What the place around a field says it is: the form's names, its headings
 * and its buttons. A link beside the form ("Already have an account? Log
 * in") is not part of it.
 */
export function contextOf(field: Field): Prepared {
  const form = field.group.form;
  const scope = form ?? scopeOf(field.el);
  if (!scope) return EMPTY;
  const parts: string[] = [];
  if (form) parts.push(formText(form));
  const headings = Array.from(scope.querySelectorAll(HEADINGS)).slice(0, 4);
  if (headings.length) for (const h of headings) parts.push(cut(h.textContent, MAX_NEAR_TEXT));
  else parts.push(headingBefore(field.el));
  for (const b of Array.from(scope.querySelectorAll(BUTTONS)).slice(0, 6)) {
    const button = b as HTMLButtonElement | HTMLInputElement;
    if (button.localName === 'button' && button.type !== 'submit') continue;
    parts.push(cut(button.localName === 'input' ? button.value : button.textContent, MAX_NEAR_TEXT), cut(button.getAttribute('aria-label'), MAX_NEAR_TEXT));
  }
  return prepare(parts.filter(Boolean).join(' | '));
}

/** The focused element, also inside shadow roots. */
export function activeElement(doc: Document): Element | null {
  let active = doc.activeElement;
  while (active) {
    const inner = shadowOf(active)?.activeElement;
    if (!inner) break;
    active = inner;
  }
  return active;
}

export function readPage(doc: Document): Page {
  const inputs: HTMLInputElement[] = [];
  collect(doc, 0, inputs);
  const groups = new Map<Node, Group>();
  const fields: Field[] = [];
  for (const el of inputs) {
    const hidden = el.type === 'hidden';
    if (!hidden && !FIELD_TYPES.has(el.type)) continue;
    if (el.closest('[contenteditable]:not([contenteditable="false"])')) continue;
    const form = formOf(el);
    const key: Node = form ?? el.getRootNode();
    let group = groups.get(key);
    if (!group) {
      group = { form, fields: [], hidden: [], formText: form ? prepare(formText(form)) : EMPTY };
      groups.set(key, group);
    }
    const idName = prepare(`${cut(el.id)} ${cut(el.getAttribute('name'))}`);
    if (hidden) {
      const value = el.value.trim();
      if (value) group.hidden.push({ idName, value });
      continue;
    }
    const tokens = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const extra = tokens.filter((t) => !KNOWN_AUTO.test(t));
    const dev = [el.id, el.getAttribute('name'), extra.join(' '), ...DEV_ATTRS.map((a) => el.getAttribute(a))];
    const { visible, box } = isVisible(el);
    const field: Field = {
      el,
      index: fields.length,
      kind: el.type === 'password' ? 'password' : 'text',
      type: el.type,
      auto: tokens.filter((t) => t !== 'webauthn'),
      webauthn: tokens.includes('webauthn'),
      personAuto: tokens.some((t) => PERSON_AUTO.test(t)),
      dev: prepare(dev.map((t) => cut(t)).filter(Boolean).join(' ')),
      idName,
      human: prepare(humanText(el)),
      usable: isUsable(el),
      visible,
      box,
      group,
    };
    fields.push(field);
    group.fields.push(field);
  }
  return { fields, groups: [...groups.values()] };
}
