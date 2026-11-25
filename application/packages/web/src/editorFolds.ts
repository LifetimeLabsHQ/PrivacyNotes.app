import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import i18n from './i18n';
import { CARET_ICON } from './editorCodeBlock';
import { TIP_PILL, observeTip, positionClasses, visibleBox } from './HoverLabel';
import { activeMatchRange } from './editorSearch';
import { readNoteFolds, writeNoteFolds } from './editorPrefs';
import { fnv1a } from './noteShortcut';
import { textDirection } from './textDirection';

/**
 * Heading and list folds (GitHub #727). A top-level heading folds every block
 * after it up to the next heading of the same level or higher; a list item
 * that holds a nested list folds what follows its first line. The control is
 * a faint chevron at the end of the line, shown on hover (always, faintly,
 * on a touch screen). The gutter before the line is not an option: the
 * editor scrolls wide content sideways and clips what sits outside its box,
 * the reason the task grip sits at the end of its row too.
 *
 * A fold is a view, never an edit: node decorations hide the blocks, the
 * document and its Markdown stay whole, so sync, export, print, copy and the
 * Markdown view see everything. The fold callouts (`[!note]-`) are a
 * different thing, stored in the note, and stay as they are.
 *
 * A folded section opens by itself when something needs to show a place in
 * it: the caret, the find bar's current match, an outline or note-link jump
 * (`openFoldsAt`), and a Backspace or Delete that would join a line into
 * hidden text. Enter at the end of a folded heading opens it (a line after
 * the hidden part would belong to the section and be hidden too); at the end
 * of a folded list item it starts the next item after the hidden part.
 *
 * Spec: docs/internal/plans/heading-folds-and-source-preview.md (Part 1)
 */

/** A place that can fold: a heading, or a list item with a nested list. */
export type Foldable = {
  /** The heading or the list item. */
  pos: number;
  /** The textblock that carries the chevron: the heading, or the item's first line. */
  line: { from: number; to: number };
  /** What a fold hides: the blocks after the heading, or the item's other children. */
  hidden: { from: number; to: number };
  /** Kind, level and text, with a count for repeats. Stored, so it survives a reload. */
  key: string;
};

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);
const ITEM_TYPES = new Set(['listItem', 'taskItem']);
/** Enough of a line to tell two apart; the stored record stays small. */
const KEY_TEXT_MAX = 80;

function keyText(node: PMNode): string {
  return node.textContent.replace(/\s+/g, ' ').trim().slice(0, KEY_TEXT_MAX);
}

/** Every place in the document that can fold, in document order. */
export function foldablesOf(doc: PMNode): Foldable[] {
  const out: Foldable[] = [];
  const seen = new Map<string, number>();
  const keyOf = (base: string) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  };
  const walkList = (list: PMNode, listPos: number) => {
    list.forEach((item, offset) => {
      const itemPos = listPos + 1 + offset;
      if (!ITEM_TYPES.has(item.type.name) || item.childCount === 0) return;
      const first = item.firstChild!;
      let nested = false;
      item.forEach((child, childOffset, i) => {
        if (i === 0 || !LIST_TYPES.has(child.type.name)) return;
        nested = true;
        walkList(child, itemPos + 1 + childOffset);
      });
      if (nested && first.isTextblock && keyText(first)) {
        const lineFrom = itemPos + 1;
        out.push({
          pos: itemPos,
          line: { from: lineFrom, to: lineFrom + first.nodeSize },
          hidden: { from: lineFrom + first.nodeSize, to: itemPos + item.nodeSize - 1 },
          key: keyOf(`l:${keyText(first)}`),
        });
      }
    });
  };
  const top: { node: PMNode; pos: number }[] = [];
  doc.forEach((node, pos) => top.push({ node, pos }));
  top.forEach(({ node, pos }, i) => {
    if (node.type.name === 'heading') {
      const level = node.attrs['level'] as number;
      let j = i + 1;
      while (j < top.length && !(top[j]!.node.type.name === 'heading' && (top[j]!.node.attrs['level'] as number) <= level)) j++;
      if (j > i + 1 && keyText(node)) {
        const last = top[j - 1]!;
        out.push({
          pos,
          line: { from: pos, to: pos + node.nodeSize },
          hidden: { from: pos + node.nodeSize, to: last.pos + last.node.nodeSize },
          key: keyOf(`h${level}:${keyText(node)}`),
        });
      }
    } else if (LIST_TYPES.has(node.type.name)) {
      walkList(node, pos);
    }
  });
  return out.sort((a, b) => a.pos - b.pos);
}

type FoldMeta = { toggle?: number; open?: number[]; all?: boolean };

type FoldState = {
  foldables: Foldable[];
  /** `pos` of each folded place. */
  folded: number[];
  decorations: DecorationSet;
  /** Counts the folds opened and closed, so the stored record is written
   *  even when another plugin's transaction follows in the same step. */
  rev: number;
  /** Counts structural fold changes (added/removed/reshaped foldables), so
   *  FoldGutter knows when a non-wrapping inline edit can skip re-measuring. */
  structRev: number;
};

export const foldsKey = new PluginKey<FoldState>('pnFolds');

/** The folds whose hidden part holds `pos`: its first block start included, its end not. */
function foldsHolding(st: FoldState, pos: number): number[] {
  return st.foldables
    .filter((f) => st.folded.includes(f.pos) && pos >= f.hidden.from && pos < f.hidden.to)
    .map((f) => f.pos);
}

/** Where the chevron of a line sits, in the gutter layer's coordinates. */
type Placed = { folded: boolean; rtl: boolean; x: number; y: number; w: number; h: number; bottom: number; size: number };

type Painted = { x: number; y: number; w: number; h: number; size: number; rtl: boolean; folded: boolean };

type TouchFloat = { fw: number; fh: number; top: number };

type GutterEntry = {
  btn: HTMLElement;
  tip: HTMLElement;
  stopTip: (() => void) | undefined;
  pos: number;
  placed: Placed;
  painted: Painted | null;
};

const BUTTON_W = 18;
const BUTTON_MIN_W = 14;
/** The touch target at the end of a line; `.pn-fold-line` keeps this much free. */
const TOUCH_W = 32;

/**
 * The chevrons live in a layer beside the text, never in it: a control in the
 * line took width at its end (the end of a heading was hard to reach) and the
 * editor clips anything drawn before its own left edge, because it scrolls
 * wide content sideways. The layer sits in the editor's padding, which the
 * pane does not clip, and each chevron is placed against its line's box.
 *
 * Every line that can fold has its chevron in place at all times, so nothing
 * is built or removed while the pointer moves. Buttons are keyed by their
 * DOM line element rather than document offset, and `draw()` batches all DOM
 * reads ahead of any writes so typing above headings neither recreates buttons
 * nor forces per-heading layout reflows.
 */
class FoldGutter {
  private layer = document.createElement('div');
  private entries = new Map<HTMLElement, GutterEntry>();
  private hovered: HTMLElement | null = null;
  private frame = 0;
  private moveFrame = 0;
  private pointer: { x: number; y: number } | null = null;
  private resize: ResizeObserver | null = null;
  private scope: HTMLElement | null;
  private dirty = true;
  private lastLayout: { ox: number; oy: number; vw: number; vh: number; tailBottom: number } | null = null;
  private lastFoldRev = -1;
  private lastStructRev = -1;
  private touch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;

  constructor(private view: EditorView) {
    this.layer.className = 'pn-fold-gutter';
    this.layer.setAttribute('contenteditable', 'false');
    view.dom.parentElement?.insertBefore(this.layer, view.dom);
    this.scope = view.dom.closest<HTMLElement>('[data-pane="editor"]') ?? view.dom.parentElement;
    document.addEventListener('pointermove', this.onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', this.onOut);
    view.dom.addEventListener('scroll', this.scheduleDirty, { passive: true });
    view.dom.addEventListener('focus', this.onFocus);
    view.dom.addEventListener('blur', this.onFocus);
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(this.scheduleDirty);
      this.resize.observe(view.dom);
    }
    this.scheduleDirty();
  }

  update(docChanged: boolean, stateChanged: boolean, structural: boolean) {
    // A chevron under the pointer is noise while typing; the next pointer
    // move shows it again.
    if (docChanged) this.pointer = null;
    if (structural) this.dirty = true;
    if (docChanged || stateChanged) this.schedule();
    if (this.touch) this.markHover();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.moveFrame);
    this.resize?.disconnect();
    document.removeEventListener('pointermove', this.onMove);
    document.documentElement.removeEventListener('pointerleave', this.onOut);
    this.view.dom.removeEventListener('scroll', this.scheduleDirty);
    this.view.dom.removeEventListener('focus', this.onFocus);
    this.view.dom.removeEventListener('blur', this.onFocus);
    for (const entry of this.entries.values()) entry.stopTip?.();
    this.entries.clear();
    this.hovered = null;
    this.layer.remove();
  }

  private scheduleDirty = () => {
    this.dirty = true;
    this.schedule();
  };

  private schedule = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || !this.entries.size) return;
    // Ignore pointer moves outside the editor pane (e.g. sweeping the sidebar
    // or note list) so they never schedule frames or force editor layout reads.
    if (this.scope && e.target instanceof Node && !this.scope.contains(e.target)) {
      if (!this.hovered && !this.moveFrame) return;
      if (this.moveFrame) {
        cancelAnimationFrame(this.moveFrame);
        this.moveFrame = 0;
      }
      this.pointer = null;
      if (this.hovered) {
        this.entries.get(this.hovered)?.btn.removeAttribute('data-hover');
        this.hovered = null;
      }
      return;
    }
    this.pointer = { x: e.clientX, y: e.clientY };
    if (this.moveFrame) return;
    this.moveFrame = requestAnimationFrame(() => {
      this.moveFrame = 0;
      this.markHover();
    });
  };

  private onFocus = () => this.markHover();

  private onOut = () => {
    this.pointer = null;
    this.markHover();
  };

  /** The line whose band holds the pointer: its height, from the chevron to
   *  the editor's far edge. The innermost (last drawn) wins for nested items. */
  private markHover() {
    let hit: HTMLElement | null = null;
    if (this.touch) {
      // No hover on a phone: the line that holds the caret shows its chevron.
      hit = this.view.hasFocus() ? this.caretLine() : null;
    } else if (this.pointer && this.entries.size) {
      const o = this.layer.getBoundingClientRect();
      const box = this.view.dom.getBoundingClientRect();
      const x = this.pointer.x - o.left;
      const y = this.pointer.y - o.top;
      const left = box.left - o.left;
      const right = box.right - o.left;
      for (const [line, entry] of this.entries) {
        const at = entry.placed;
        const from = Math.min(at.x, left);
        const to = Math.max(at.x + at.w, right);
        if (y >= at.y && y < at.bottom && x >= from && x <= to) hit = line;
      }
    }
    if (hit === this.hovered) return;
    if (this.hovered) this.entries.get(this.hovered)?.btn.removeAttribute('data-hover');
    if (hit) this.entries.get(hit)?.btn.setAttribute('data-hover', '');
    this.hovered = hit;
  }

  /** The fold line the caret is in, as its DOM element. */
  private caretLine(): HTMLElement | null {
    const st = foldsKey.getState(this.view.state);
    const head = this.view.state.selection.head;
    const f = st?.foldables.find((x) => head > x.line.from && head < x.line.to);
    if (!f) return null;
    const dom = this.view.nodeDOM(f.line.from);
    return dom instanceof HTMLElement && this.entries.has(dom) ? dom : null;
  }

  private place(
    line: HTMLElement,
    r: DOMRect,
    folded: boolean,
    origin: DOMRect,
    bounds: { left: number; right: number },
    viewBox: DOMRect,
    touchFloat: TouchFloat | null,
  ): Placed {
    const cs = getComputedStyle(line);
    const fontSize = parseFloat(cs.fontSize) || 16;
    const lh = parseFloat(cs.lineHeight) || fontSize * 1.5;
    const rtl = cs.direction === 'rtl';
    // A heading's chevron sits in the editor's gutter; a list item's sits
    // before its own marker, at the start edge of the list that holds it.
    let edge: number;
    if (line.nodeName.startsWith('H')) {
      edge = rtl ? viewBox.right : viewBox.left;
    } else {
      const lb = (line.closest('ul, ol') ?? line).getBoundingClientRect();
      edge = rtl ? lb.right : lb.left;
    }
    // A touch screen's gutter is 16px: a chevron there sat on the screen's
    // edge and against the text. It goes to the line's end side instead, as
    // an expander does on a phone, in room the line keeps free for it
    // (`.pn-fold-line` padding in index.css), with a finger-sized target.
    if (this.touch && touchFloat) {
      const tw = TOUCH_W;
      let tx = rtl ? r.left : r.right - tw;
      if (!rtl && touchFloat.fw > 0 && r.top < touchFloat.top + touchFloat.fh) {
        tx = Math.min(tx, viewBox.right - touchFloat.fw - tw);
      }
      return { folded, rtl, w: tw, h: lh, x: tx - origin.left, y: r.top - origin.top, bottom: r.bottom - origin.top, size: Math.min(18, Math.max(13, fontSize * 0.6)) };
    }
    // A narrow gutter takes the room there is, down to BUTTON_MIN_W, and
    // never leaves the pane's visible box.
    const room = rtl ? bounds.right - edge : edge - bounds.left;
    const w = Math.max(BUTTON_MIN_W, Math.min(BUTTON_W, room - 2));
    let left = rtl ? edge + 2 : edge - w - 2;
    left = Math.min(Math.max(left, bounds.left), bounds.right - w);
    return {
      folded, rtl, w, h: lh,
      x: left - origin.left,
      y: r.top - origin.top,
      bottom: r.bottom - origin.top,
      size: Math.min(16, Math.max(11, fontSize * 0.55)),
    };
  }

  private draw() {
    if (this.view.isDestroyed) return;
    const st = foldsKey.getState(this.view.state);
    if (!st) return;

    // Phase 1: all DOM reads before any DOM writes, so the browser lays out
    // at most once instead of once per foldable line.
    const origin = this.layer.getBoundingClientRect();
    const viewBox = this.view.dom.getBoundingClientRect();
    const tail = this.view.dom.lastElementChild;
    const tailBottom = tail ? tail.getBoundingClientRect().bottom : viewBox.bottom;
    const layoutSame =
      this.lastLayout !== null &&
      Math.abs(origin.left - this.lastLayout.ox) < 0.5 &&
      Math.abs(origin.top - this.lastLayout.oy) < 0.5 &&
      Math.abs(viewBox.width - this.lastLayout.vw) < 0.5 &&
      Math.abs(viewBox.height - this.lastLayout.vh) < 0.5 &&
      Math.abs(tailBottom - this.lastLayout.tailBottom) < 0.5;
    if (
      !this.dirty &&
      layoutSame &&
      st.rev === this.lastFoldRev &&
      st.structRev === this.lastStructRev &&
      st.foldables.length === this.entries.size
    ) {
      // Non-wrapping inline edit: no heading or list item moved, so skip
      // measuring every chevron button across the document.
      if (this.hovered) {
        this.entries.get(this.hovered)?.btn.removeAttribute('data-hover');
        this.hovered = null;
      }
      this.markHover();
      return;
    }
    this.dirty = false;
    this.lastLayout = { ox: origin.left, oy: origin.top, vw: viewBox.width, vh: viewBox.height, tailBottom };
    this.lastFoldRev = st.rev;
    this.lastStructRev = st.structRev;
    const bounds = visibleBox(this.layer);
    let touchFloat: TouchFloat | null = null;
    if (this.touch) {
      const fl = getComputedStyle(this.view.dom, '::before');
      const padTop = parseFloat(getComputedStyle(this.view.dom).paddingTop) || 0;
      touchFloat = {
        fw: parseFloat(fl.width) || 0,
        fh: parseFloat(fl.height) || 0,
        top: viewBox.top + padTop,
      };
    }
    const foldedSet = st.folded.length ? new Set(st.folded) : null;
    const measured: { line: HTMLElement; pos: number; at: Placed }[] = [];
    for (const f of st.foldables) {
      const line = this.view.nodeDOM(f.line.from);
      if (!(line instanceof HTMLElement)) continue;
      const r = line.getBoundingClientRect();
      // A line inside a folded section has no box.
      if (r.width === 0 && r.height === 0) continue;
      const at = this.place(line, r, foldedSet ? foldedSet.has(f.pos) : false, origin, bounds, viewBox, touchFloat);
      measured.push({ line, pos: f.line.from, at });
    }

    // Phase 2: DOM writes only, skipping any style or attribute that did not
    // change since the last paint.
    const seen = new Set<HTMLElement>();
    const added: HTMLElement[] = [];
    for (const { line, pos, at } of measured) {
      seen.add(line);
      let entry = this.entries.get(line);
      if (!entry) {
        entry = this.createEntry(line, pos, at);
        this.entries.set(line, entry);
        added.push(entry.btn);
      } else {
        entry.pos = pos;
        entry.placed = at;
      }
      this.paint(entry, at);
    }
    if (added.length > 0) this.layer.append(...added);
    for (const [line, entry] of this.entries) {
      if (seen.has(line)) continue;
      entry.stopTip?.();
      entry.btn.remove();
      this.entries.delete(line);
      if (this.hovered === line) this.hovered = null;
    }
    if (this.hovered) {
      this.entries.get(this.hovered)?.btn.removeAttribute('data-hover');
      this.hovered = null;
    }
    this.markHover();
  }

  private paint(entry: GutterEntry, at: Placed) {
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    const w = Math.round(at.w);
    const h = Math.round(at.h);
    const size = Math.round(at.size);
    const prev = entry.painted;
    const { btn, tip } = entry;
    if (!prev || prev.x !== x || prev.y !== y) btn.style.transform = `translate(${x}px, ${y}px)`;
    if (!prev || prev.h !== h) btn.style.height = `${h}px`;
    if (!prev || prev.w !== w) btn.style.width = `${w}px`;
    if (!prev || prev.size !== size) btn.style.setProperty('--pn-fold-icon', `${size}px`);
    // A folded chevron points along the line's own direction.
    if (!prev || prev.rtl !== at.rtl) btn.toggleAttribute('data-rtl', at.rtl);
    if (!prev || prev.folded !== at.folded) {
      btn.toggleAttribute('data-folded', at.folded);
      btn.setAttribute('aria-expanded', at.folded ? 'false' : 'true');
      const label = i18n.t(at.folded ? 'editor:fold.expand' : 'editor:fold.collapse');
      btn.setAttribute('aria-label', label);
      tip.textContent = label;
    }
    entry.painted = { x, y, w, h, size, rtl: at.rtl, folded: at.folded };
  }

  private resolveLinePos(line: HTMLElement, hint: number): number {
    if (this.view.nodeDOM(hint) === line) return hint;
    const st = foldsKey.getState(this.view.state);
    const found = st?.foldables.find((f) => this.view.nodeDOM(f.line.from) === line);
    return found ? found.line.from : hint;
  }

  private createEntry(line: HTMLElement, pos: number, placed: Placed): GutterEntry {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.tabIndex = -1;
    btn.className = 'pn-fold-toggle pn-tip-host group/tip';
    btn.innerHTML = CARET_ICON;
    // `pn-tip-host`: no box until hovered, so it cannot widen the pane. Above
    // the chevron, opening toward the text; `observeTip` + `fitTip` move it
    // back inside the visible box and below the chevron whenever the pane's
    // top or sticky bars (toolbar, tag row, notice row) would cover it.
    const tip = document.createElement('span');
    tip.setAttribute('aria-hidden', 'true');
    tip.className = `${TIP_PILL} ${positionClasses['above-start']} whitespace-nowrap`;
    btn.append(tip);
    const stopTip = observeTip(tip);
    const entry: GutterEntry = { btn, tip, stopTip, pos, placed, painted: null };
    // No focus move off the text on the press.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleFold(this.view, this.resolveLinePos(line, entry.pos));
    });
    return entry;
  }
}

function buildDecorations(doc: PMNode, foldables: Foldable[], folded: number[]): DecorationSet {
  if (foldables.length === 0) return DecorationSet.empty;
  const foldedSet = folded.length ? new Set(folded) : null;
  const decos: Decoration[] = [];
  for (const f of foldables) {
    const isFolded = foldedSet ? foldedSet.has(f.pos) : false;
    decos.push(Decoration.node(f.line.from, f.line.to, { class: isFolded ? 'pn-fold-line pn-fold-closed' : 'pn-fold-line' }));
    if (!isFolded) continue;
    // The direct children of the hidden span: top-level blocks after a
    // heading, the item's children after its first line.
    const $from = doc.resolve(f.hidden.from);
    const parent = $from.parent;
    let from = f.hidden.from;
    for (let i = $from.index(); i < parent.childCount && from < f.hidden.to; i++) {
      const child = parent.child(i);
      if (from + child.nodeSize <= f.hidden.to) {
        decos.push(Decoration.node(from, from + child.nodeSize, { class: 'pn-fold-hidden' }));
      }
      from += child.nodeSize;
    }
  }
  return DecorationSet.create(doc, decos);
}

function stateFor(doc: PMNode, folded: number[], rev: number, structRev: number): FoldState {
  const foldables = foldablesOf(doc);
  let live = folded;
  if (folded.length) {
    const valid = new Set(foldables.map((f) => f.pos));
    live = folded.filter((p) => valid.has(p));
  }
  return { foldables, folded: live, decorations: buildDecorations(doc, foldables, live), rev, structRev };
}

/** Recomputes `key` for already-mapped foldables after an inline edit renamed
 *  a heading or list header line, without walking the document or rebuilding
 *  decorations. */
function refreshFoldableKeys(doc: PMNode, foldables: Foldable[]): Foldable[] {
  const seen = new Map<string, number>();
  const keyOf = (base: string) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  };
  return foldables.map((f) => {
    const node = doc.nodeAt(f.line.from);
    if (!node) return f;
    const base = node.type.name === 'heading'
      ? `h${node.attrs['level'] as number}:${keyText(node)}`
      : `l:${keyText(node)}`;
    const key = keyOf(base);
    return key === f.key ? f : { ...f, key };
  });
}

/** Result of checking whether a transaction is strictly an inline edit inside a
 *  single textblock that leaves foldable structure unchanged. */
type InlineEditKind = 'none' | 'plain' | 'header';

/** Checks whether every step edits strictly inside a single textblock without
 *  splitting, merging, changing block types/levels, or toggling a heading or
 *  list-item header line between empty and non-empty. Returns `'plain'` when
 *  no foldable key changed, `'header'` when a heading or list header text
 *  changed (keys refresh in O(foldables) with zero doc walk or decoration
 *  rebuild), or `'none'` when a full structural pass is needed. */
function classifyInlineEdit(tr: Transaction, oldDoc: PMNode, nextDoc: PMNode): InlineEditKind {
  if (oldDoc.childCount !== nextDoc.childCount || tr.steps.length === 0) return 'none';
  let touchedHeader = false;
  for (let i = 0; i < tr.steps.length; i++) {
    const step = tr.steps[i]!;
    const before = tr.docs[i]!;
    const after = tr.docs[i + 1] ?? nextDoc;
    const map = tr.mapping.maps[i];
    if (!map || before.childCount !== after.childCount) return 'none';
    const { from, to } = step as { from?: number; to?: number };
    if (typeof from !== 'number' || typeof to !== 'number') return 'none';
    if (from < 0 || to > before.content.size) return 'none';
    const $from = before.resolve(from);
    const $to = before.resolve(to);
    if ($from.depth < 1 || !$from.sameParent($to) || !$from.parent.isTextblock) return 'none';
    const aFrom = map.map(from, -1);
    const aTo = map.map(to, 1);
    if (aFrom < 0 || aTo > after.content.size) return 'none';
    const $aFrom = after.resolve(aFrom);
    const $aTo = after.resolve(aTo);
    if ($aFrom.depth !== $from.depth || !$aFrom.sameParent($aTo)) return 'none';
    if ($aFrom.parent.type !== $from.parent.type) return 'none';
    for (let d = 1; d < $from.depth; d++) {
      if ($from.node(d).type !== $aFrom.node(d).type || $from.node(d).childCount !== $aFrom.node(d).childCount) {
        return 'none';
      }
    }
    const isHeading = $from.parent.type.name === 'heading';
    if (isHeading && $aFrom.parent.attrs['level'] !== $from.parent.attrs['level']) return 'none';
    // A script flip (LTR <-> RTL) moves the fold chevron to the opposite side
    // without changing document height, so let FoldGutter re-measure.
    if (textDirection($from.parent.textContent) !== textDirection($aFrom.parent.textContent)) return 'none';
    const isListHeader = $from.depth >= 2 && ITEM_TYPES.has($from.node($from.depth - 1).type.name) && $from.index($from.depth - 1) === 0;
    if (isHeading || isListHeader) {
      const beforeKey = keyText($from.parent);
      const afterKey = keyText($aFrom.parent);
      if ((beforeKey !== '') !== (afterKey !== '')) return 'none';
      if (beforeKey !== afterKey) touchedHeader = true;
    }
  }
  return touchedHeader ? 'header' : 'plain';
}

/** Folds or opens the place whose chevron line starts at `line`. A caret in
 *  the part a fold hides moves to the end of the folded line. Returns false
 *  when the fold plugin is absent or `line` is not foldable. */
export function toggleFold(view: EditorView, line: number): boolean {
  const st = foldsKey.getState(view.state);
  const f = st?.foldables.find((x) => x.line.from === line);
  if (!st || !f) return false;
  const tr = view.state.tr.setMeta(foldsKey, { toggle: f.pos } satisfies FoldMeta).setMeta('addToHistory', false);
  const { head } = view.state.selection;
  if (!st.folded.includes(f.pos) && head >= f.hidden.from && head < f.hidden.to) {
    tr.setSelection(TextSelection.create(view.state.doc, f.line.to - 1));
  }
  view.dispatch(tr);
  return true;
}

/** Positions currently folded by the editor fold plugin, or null when the
 *  plugin is not mounted (e.g. the Markdown view's read-only preview). */
export function foldedPositions(state: EditorState): readonly number[] | null {
  return foldsKey.getState(state)?.folded ?? null;
}

/** For Collapse all / Expand all (#779): how many places can fold, and how
 *  many are folded now. */
export function foldCounts(state: EditorState): { foldable: number; folded: number } {
  const st = foldsKey.getState(state);
  return { foldable: st?.foldables.length ?? 0, folded: st?.folded.length ?? 0 };
}

/** Folds or opens every heading and list fold, on the caller's transaction
 *  (one step with its own changes). A caret left inside a section stays; the
 *  caret rule opens that one section on the next move. */
export function setAllFolded(tr: Transaction, folded: boolean): Transaction {
  return tr.setMeta(foldsKey, { all: folded } satisfies FoldMeta).setMeta('addToHistory', false);
}

/** Opens every fold that hides `pos`, so a jump to it lands on something
 *  drawn. True when one opened. */
export function openFoldsAt(view: EditorView, pos: number): boolean {
  const st = foldsKey.getState(view.state);
  if (!st || st.folded.length === 0) return false;
  const open = foldsHolding(st, pos);
  if (open.length === 0) return false;
  view.dispatch(view.state.tr.setMeta(foldsKey, { open } satisfies FoldMeta).setMeta('addToHistory', false));
  return true;
}

/** Moves the editor's selection to the page's, when the page's lies in the
 *  editor and differs. */
function syncSelection(view: EditorView) {
  const sel = (view.root as Document).getSelection?.();
  if (!sel?.anchorNode || !sel.focusNode || !view.dom.contains(sel.anchorNode) || !view.dom.contains(sel.focusNode)) return;
  let anchor: number, head: number;
  try {
    anchor = view.posAtDOM(sel.anchorNode, sel.anchorOffset);
    head = view.posAtDOM(sel.focusNode, sel.focusOffset);
  } catch {
    return;
  }
  const now = view.state.selection;
  if (now.anchor === anchor && now.head === head) return;
  if (!(now instanceof TextSelection)) return;
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
  } catch {
    /* a place a text selection cannot hold */
  }
}

/** No text and no leaf between a and b: the caret at b is the first thing
 *  after a. */
function nothingBetween(doc: PMNode, a: number, b: number): boolean {
  return a <= b && doc.textBetween(a, b, '', 'x') === '';
}

function folded(state: EditorState, f: Foldable): boolean {
  return !!foldsKey.getState(state)?.folded.includes(f.pos);
}

/** Opaque disk key: noteId + fold key hashed with FNV-1a so no heading or
 *  list text lands in localStorage in the clear while app lock is closed. */
function diskFoldKey(noteId: string, key: string): string {
  return fnv1a(`${noteId.toLowerCase()}\n${key}`);
}

function save(noteId: string | undefined, st: FoldState | undefined) {
  if (!noteId || !st) return;
  writeNoteFolds(
    noteId,
    st.foldables.filter((f) => st.folded.includes(f.pos)).map((f) => diskFoldKey(noteId, f.key)),
  );
}

export const Folds = Extension.create<{ noteId?: string }>({
  name: 'pnFolds',
  // Ahead of the list and heading keys, so Enter, Backspace and Delete at a
  // fold's edge are decided here first.
  priority: 1000,
  addOptions() {
    return { noteId: undefined };
  },

  addKeyboardShortcuts() {
    // The caret as the page has it. A key can arrive before the browser's
    // selectionchange has told the editor where Home or a click put it; the
    // editor then still holds the old place, its own keys pass on, and the
    // browser's Backspace deletes hidden text it cannot see. So the editor
    // takes the page's caret first.
    const atFold = (view: EditorView) => {
      if (!foldsKey.getState(view.state)?.folded.length) return null;
      syncSelection(view);
      const st = foldsKey.getState(view.state)!;
      const { selection } = view.state;
      if (!selection.empty) return null;
      return { st, $head: selection.$head };
    };
    return {
      Enter: ({ editor }) => {
        const at = atFold(editor.view);
        if (!at) return false;
        const { st, $head } = at;
        if ($head.parentOffset !== $head.parent.content.size) return false;
        const f = st.foldables.find((x) => x.line.to - 1 === $head.pos && st.folded.includes(x.pos));
        if (!f) return false;
        const { state } = editor;
        const item = state.doc.nodeAt(f.pos)!;
        if (item.type.name === 'heading') {
          // Everything up to the next heading of its level belongs to this
          // one, so a new line after the hidden part would be hidden too.
          // The section opens and Enter writes under the heading as usual.
          editor.view.dispatch(state.tr.setMeta(foldsKey, { open: [f.pos] } satisfies FoldMeta).setMeta('addToHistory', false));
          return false;
        }
        // A list item: a new item of its kind after the whole item.
        const fresh = item.type.createAndFill();
        if (!fresh) return false;
        const after = f.pos + item.nodeSize;
        const tr = state.tr.insert(after, fresh);
        tr.setSelection(TextSelection.create(tr.doc, after + 2));
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
      Backspace: ({ editor }) => {
        const at = atFold(editor.view);
        if (!at || at.$head.parentOffset !== 0) return false;
        const { st, $head } = at;
        const doc = editor.state.doc;
        const open = st.foldables
          .filter((f) => st.folded.includes(f.pos) && f.hidden.to <= $head.pos && nothingBetween(doc, f.hidden.to, $head.pos))
          .map((f) => f.pos);
        if (open.length === 0) return false;
        editor.view.dispatch(editor.state.tr.setMeta(foldsKey, { open } satisfies FoldMeta).setMeta('addToHistory', false));
        return true;
      },
      Delete: ({ editor }) => {
        const at = atFold(editor.view);
        if (!at || at.$head.parentOffset !== at.$head.parent.content.size) return false;
        const { st, $head } = at;
        const f = st.foldables.find((x) => x.line.to - 1 === $head.pos && folded(editor.state, x));
        if (!f) return false;
        editor.view.dispatch(editor.state.tr.setMeta(foldsKey, { open: [f.pos] } satisfies FoldMeta).setMeta('addToHistory', false));
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const noteId = this.options.noteId;
    return [
      new Plugin<FoldState>({
        key: foldsKey,
        state: {
          init: (_, state) => {
            const stored = noteId ? new Set(readNoteFolds(noteId)) : new Set<string>();
            const foldables = foldablesOf(state.doc);
            const folded = noteId && stored.size
              ? foldables.filter((f) => stored.has(diskFoldKey(noteId, f.key))).map((f) => f.pos)
              : [];
            return { foldables, folded, decorations: buildDecorations(state.doc, foldables, folded), rev: 0, structRev: 0 };
          },
          apply: (tr: Transaction, prev: FoldState, oldState, next): FoldState => {
            const meta = tr.getMeta(foldsKey) as FoldMeta | undefined;
            if (!tr.docChanged && !meta) return prev;
            const inlineKind = !meta && tr.docChanged ? classifyInlineEdit(tr, oldState.doc, next.doc) : 'none';
            if (inlineKind !== 'none') {
              if (prev.foldables.length === 0) return prev;
              const mapped = prev.foldables.map((f) => ({
                pos: tr.mapping.map(f.pos, 1),
                line: { from: tr.mapping.map(f.line.from, 1), to: tr.mapping.map(f.line.to, 1) },
                hidden: { from: tr.mapping.map(f.hidden.from, 1), to: tr.mapping.map(f.hidden.to, 1) },
                key: f.key,
              }));
              const foldables = inlineKind === 'header' ? refreshFoldableKeys(next.doc, mapped) : mapped;
              const folded = prev.folded.length ? prev.folded.map((p) => tr.mapping.map(p, 1)) : prev.folded;
              return {
                foldables,
                folded,
                decorations: prev.decorations.map(tr.mapping, next.doc),
                rev: prev.rev,
                structRev: prev.structRev,
              };
            }
            let folded = prev.folded;
            if (tr.docChanged) {
              folded = folded.flatMap((p) => {
                const r = tr.mapping.mapResult(p, 1);
                return r.deleted ? [] : [r.pos];
              });
            }
            if (meta?.toggle !== undefined) {
              folded = folded.includes(meta.toggle) ? folded.filter((p) => p !== meta.toggle) : [...folded, meta.toggle];
            }
            if (meta?.open) folded = folded.filter((p) => !meta.open!.includes(p));
            if (meta?.all !== undefined) folded = meta.all ? foldablesOf(next.doc).map((f) => f.pos) : [];
            return stateFor(next.doc, folded, prev.rev + (meta ? 1 : 0), prev.structRev + 1);
          },
        },
        props: {
          decorations: (state) => foldsKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
        // The caret or the find bar's current match inside a fold opens it.
        appendTransaction: (trs, oldState, newState) => {
          const st = foldsKey.getState(newState);
          if (!st || st.folded.length === 0) return null;
          const open = new Set<number>();
          if (trs.some((tr) => tr.selectionSet || tr.docChanged)) {
            for (const p of foldsHolding(st, newState.selection.head)) open.add(p);
          }
          const hit = activeMatchRange(newState);
          const before = activeMatchRange(oldState);
          if (hit && (hit.from !== before?.from || hit.to !== before?.to)) {
            for (const p of foldsHolding(st, hit.from)) open.add(p);
          }
          if (open.size === 0) return null;
          return newState.tr.setMeta(foldsKey, { open: [...open] } satisfies FoldMeta).setMeta('addToHistory', false);
        },
        view: (view) => {
          const gutter = new FoldGutter(view);
          let savedRev = 0;
          return {
            update: (view, prevState) => {
              const st = foldsKey.getState(view.state);
              const prevSt = foldsKey.getState(prevState);
              if (st && st.rev !== savedRev) {
                savedRev = st.rev;
                save(noteId, st);
              }
              const structural = st !== prevSt && (st?.structRev !== prevSt?.structRev || st?.rev !== prevSt?.rev);
              gutter.update(view.state.doc !== prevState.doc, st !== prevSt, structural);
            },
            destroy: () => gutter.destroy(),
          };
        },
      }),
    ];
  },

  // A renamed heading keeps its fold for the session by position; the
  // stored key follows the new text here.
  onDestroy() {
    try {
      save(this.options.noteId, foldsKey.getState(this.editor.state));
    } catch {
      /* the view is gone */
    }
  },
});
