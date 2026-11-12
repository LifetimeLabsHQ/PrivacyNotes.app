/**
 * JSON Canvas (Obsidian's `.canvas` file) to a drawing body.
 *
 * Format facts: the open JSON Canvas 1.0 spec (jsoncanvas.org/spec/1.0),
 * `{ nodes, edges }`. A node is a `text`, `file`, `link` or `group` box with
 * an `x`, `y`, `width` and `height` in pixels, in z-order (first is lowest);
 * an edge joins two nodes, from a side to a side, with an arrowhead at
 * either end (`fromEnd` defaults to none, `toEnd` to an arrow) and an
 * optional label. A color is a preset "1" to "6" (red, orange, yellow,
 * green, cyan, purple) or a hex value.
 *
 * Each node becomes an Excalidraw rectangle with its text bound inside (a
 * group's label sits above its box); a picture file the import holds
 * becomes an image; each edge an arrow bound to its two boxes. The body is
 * the drawing format of `drawing/scene.ts`; Excalidraw fills the fields it
 * restores (index, line height) when the drawing opens.
 *
 * Kept as text: a text node's Markdown (a drawing has no formatting), a
 * file node that is a note or a file other than a picture (its name), a
 * link node's URL (also the box's link). A note file node's box links to
 * that note, `[[Note]]`, and a text node's box to its first note-link: a
 * click on the box opens the note (`drawing/DrawingItem.tsx`). Not kept: a group's background
 * picture.
 * Synthetic only: built from the public spec, with no lab fixture.
 * Spec: docs/internal/specs/drawing.md (section 0, Exports)
 */

import { serializeScene, emptyScene } from '../drawing/scene';
import { noteLinkTarget, noteLinkTargets } from '../noteLinks';

/** A picture a file node names, as the import holds it: its blob key and type. */
export type CanvasPicture = { key: string; mime: string };

/** What one `.canvas` file came to: the body, and the file nodes it could not show. */
export type CanvasDrawing = {
  body: string;
  /** Picture file nodes with no bytes in the import (shown as their name). */
  outsidePictures: number;
  /** Live elements: 0 is an empty canvas. */
  elements: number;
};

type Node = { id: string; type: 'text' | 'file' | 'link' | 'group'; x: number; y: number; width: number; height: number; color?: string; text?: string; file?: string; subpath?: string; url?: string; label?: string };
type Side = 'top' | 'right' | 'bottom' | 'left';
type Edge = { fromNode: string; toNode: string; fromSide?: Side; toSide?: Side; fromEnd: boolean; toEnd: boolean; color?: string; label?: string };

const NODE_TYPES = new Set(['text', 'file', 'link', 'group']);
const SIDES = new Set(['top', 'right', 'bottom', 'left']);

/** The picture extensions a file node can show as an image. */
export const CANVAS_PICTURE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

/** Presets "1" to "6": a line color and a light fill, from Excalidraw's palette. */
const PRESETS: ReadonlyMap<string, { stroke: string; fill: string }> = new Map([
  ['1', { stroke: '#e03131', fill: '#ffc9c9' }],
  ['2', { stroke: '#e8590c', fill: '#ffd8a8' }],
  ['3', { stroke: '#f08c00', fill: '#ffec99' }],
  ['4', { stroke: '#2f9e44', fill: '#b2f2bb' }],
  ['5', { stroke: '#0c8599', fill: '#99e9f2' }],
  ['6', { stroke: '#6741d9', fill: '#d0bfff' }],
]);
const INK = '#1e1e1e';
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Nunito, the drawing font closest to a canvas card's text. */
const FONT_FAMILY = 6;
const FONT_SIZE = 16;
const LINE_HEIGHT = 1.35;
const PADDING = 12;
/** A coordinate past this is not a canvas a person drew. */
const MAX_COORD = 1e7;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD ? v : null);

function colorOf(color: string | undefined): { stroke: string; fill: string } | null {
  if (!color) return null;
  const preset = PRESETS.get(color);
  if (preset) return preset;
  return HEX.test(color) ? { stroke: color, fill: 'transparent' } : null;
}

function readNode(raw: unknown): Node | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const type = str(raw.type);
  const x = num(raw.x);
  const y = num(raw.y);
  const width = num(raw.width);
  const height = num(raw.height);
  if (!id || !type || !NODE_TYPES.has(type) || x === null || y === null || width === null || height === null) return null;
  return {
    id,
    type: type as Node['type'],
    x,
    y,
    width: Math.max(1, width),
    height: Math.max(1, height),
    color: str(raw.color),
    text: str(raw.text),
    file: str(raw.file),
    subpath: str(raw.subpath),
    url: str(raw.url),
    label: str(raw.label),
  };
}

function readEdge(raw: unknown): Edge | null {
  if (!isRecord(raw)) return null;
  const fromNode = str(raw.fromNode);
  const toNode = str(raw.toNode);
  if (!fromNode || !toNode) return null;
  const side = (v: unknown): Side | undefined => (typeof v === 'string' && SIDES.has(v) ? (v as Side) : undefined);
  return {
    fromNode,
    toNode,
    fromSide: side(raw.fromSide),
    toSide: side(raw.toSide),
    fromEnd: raw.fromEnd === 'arrow',
    toEnd: raw.toEnd !== 'none',
    color: str(raw.color),
    label: str(raw.label),
  };
}

/** The name a file node shows: a note's name with its heading, else the file name. */
function fileLabel(path: string, subpath: string | undefined): string {
  const name = path.split('/').pop() ?? path;
  const shown = /\.md$/i.test(name) ? name.slice(0, -3) : name;
  return subpath?.startsWith('#') ? `${shown}${subpath}` : shown;
}

/** Only a web or mail link becomes a box's link; anything else stays text. */
function safeUrl(url: string): string | null {
  return /^(?:https?:|mailto:)/i.test(url.trim()) ? url.trim() : null;
}

const seed = (): number => Math.floor(Math.random() * 2 ** 31);
const newId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

type Element = Record<string, unknown> & { id: string; boundElements: { type: string; id: string }[] | null };

function base(type: string, x: number, y: number, width: number, height: number, stroke: string, fill: string): Element {
  return {
    id: newId(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: stroke,
    backgroundColor: fill,
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === 'rectangle' ? { type: 3 } : type === 'arrow' ? { type: 2 } : null,
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

/** The average glyph width as a share of the font size, kept wide so a
 *  wrapped line never runs past its box. */
const GLYPH_WIDTH = 0.6;
/** Where the canvas's top-left corner lands, so the drawing opens on it. */
const ORIGIN = 40;

/**
 * The text broken into lines that fit `width`. Excalidraw wraps a box's
 * text only when it is edited, so the import wraps it once; `originalText`
 * keeps the text as written, which Excalidraw wraps again on an edit.
 */
function wrapText(text: string, width: number): string {
  const perLine = Math.max(1, Math.floor(width / (FONT_SIZE * GLYPH_WIDTH)));
  return text
    .split('\n')
    .map((line) => {
      const out: string[] = [];
      let current = '';
      for (const word of line.split(' ')) {
        let rest = word;
        while (rest.length > perLine) {
          if (current) {
            out.push(current);
            current = '';
          }
          out.push(rest.slice(0, perLine));
          rest = rest.slice(perLine);
        }
        const next = current ? `${current} ${rest}` : rest;
        if (next.length > perLine && current) {
          out.push(current);
          current = rest;
        } else current = next;
      }
      out.push(current);
      return out.join('\n');
    })
    .join('\n');
}

const textHeight = (text: string): number => Math.ceil(text.split('\n').length * FONT_SIZE * LINE_HEIGHT);

function textElement(text: string, x: number, y: number, width: number, containerId: string | null, align: 'left' | 'center'): Element {
  const wrapped = containerId ? wrapText(text, width) : text;
  return {
    ...base('text', x, y, width, textHeight(wrapped), INK, 'transparent'),
    roundness: null,
    text: wrapped,
    originalText: text,
    fontSize: FONT_SIZE,
    fontFamily: FONT_FAMILY,
    lineHeight: LINE_HEIGHT,
    textAlign: align,
    verticalAlign: containerId && align === 'left' ? 'top' : 'middle',
    containerId,
    autoResize: true,
  };
}

/** The point on a box's side an edge leaves or meets. */
function sidePoint(n: Node, side: Side): [number, number] {
  switch (side) {
    case 'top': return [n.x + n.width / 2, n.y];
    case 'bottom': return [n.x + n.width / 2, n.y + n.height];
    case 'left': return [n.x, n.y + n.height / 2];
    case 'right': return [n.x + n.width, n.y + n.height / 2];
  }
}

/** The side facing the other box, when the edge names none. */
function facingSide(from: Node, to: Node): Side {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** The file paths a canvas's file nodes name, for the caller to read. */
export function canvasFilePaths(text: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(data) || !Array.isArray(data.nodes)) return [];
  return data.nodes.flatMap((n) => {
    const node = readNode(n);
    return node?.type === 'file' && node.file ? [node.file] : [];
  });
}

/**
 * The drawing a `.canvas` text holds, or null when it is not a canvas.
 * `pictureOf` gives the blob a picture file node names, when the import
 * holds its bytes; the body then names the blob key in `files[id].src`,
 * which the shared blob import swaps for its `pn:img/` reference.
 */
export function canvasToDrawing(text: string, pictureOf: (path: string) => CanvasPicture | null = () => null): CanvasDrawing | null {
  let data: unknown;
  try {
    // An empty file is an empty canvas.
    data = text.trim() ? JSON.parse(text) : {};
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (data.nodes !== undefined && !Array.isArray(data.nodes)) return null;
  if (data.edges !== undefined && !Array.isArray(data.edges)) return null;
  const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
  const rawEdges = Array.isArray(data.edges) ? data.edges : [];

  const elements: Element[] = [];
  const files: Record<string, { id: string; mimeType: string; created: number; src: string }> = {};
  const boxes = new Map<string, { node: Node; element: Element }>();
  let outsidePictures = 0;

  // The canvas moves so its top-left corner (a group's label included)
  // sits near the origin, where the drawing opens.
  const seen = new Set<string>();
  const nodes = rawNodes.flatMap((raw) => {
    const node = readNode(raw);
    if (!node || seen.has(node.id)) return [];
    seen.add(node.id);
    return [node];
  });
  const labelRoom = FONT_SIZE * LINE_HEIGHT + 6;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => (n.type === 'group' && n.label?.trim() ? n.y - labelRoom : n.y)));
  for (const n of nodes) {
    n.x += ORIGIN - minX;
    n.y += ORIGIN - minY;
  }

  for (const node of nodes) {
    const color = colorOf(node.color);

    if (node.type === 'file' && node.file && CANVAS_PICTURE_EXT.test(node.file)) {
      const picture = pictureOf(node.file);
      if (picture) {
        const fileId = newId();
        const image = { ...base('image', node.x, node.y, node.width, node.height, 'transparent', 'transparent'), fileId, status: 'saved', scale: [1, 1], crop: null };
        files[fileId] = { id: fileId, mimeType: picture.mime, created: Date.now(), src: picture.key };
        elements.push(image);
        boxes.set(node.id, { node, element: image });
        continue;
      }
      outsidePictures++;
    }

    const isGroup = node.type === 'group';
    const box = base('rectangle', node.x, node.y, node.width, node.height, color?.stroke ?? INK, isGroup ? 'transparent' : color ? color.fill : 'transparent');
    if (isGroup) box.strokeStyle = 'dashed';
    elements.push(box);
    boxes.set(node.id, { node, element: box });

    let label = '';
    if (node.type === 'text') {
      label = node.text ?? '';
      const first = noteLinkTargets(label)[0];
      if (first) box.link = `[[${first}]]`;
    } else if (node.type === 'file') {
      label = node.file ? fileLabel(node.file, node.subpath) : '';
      if (node.file && /\.md$/i.test(node.file)) box.link = `[[${noteLinkTarget(label)}]]`;
    }
    else if (node.type === 'link') {
      label = node.url ?? '';
      const url = node.url ? safeUrl(node.url) : null;
      if (url) box.link = url;
    } else label = node.label ?? '';
    if (!label.trim()) continue;

    if (isGroup) {
      // A group's label sits above its top-left corner, as in Obsidian.
      elements.push(textElement(label, node.x, node.y - labelRoom, node.width, null, 'left'));
      continue;
    }
    const inner = textElement(label, node.x + PADDING, node.y + PADDING, Math.max(1, node.width - PADDING * 2), box.id, node.type === 'text' ? 'left' : 'center');
    // A card scrolls its text in Obsidian; here the box grows to hold it.
    const needed = (inner.height as number) + PADDING * 2;
    if (needed > node.height) {
      node.height = needed;
      box.height = needed;
    }
    // A name or a URL sits in the middle of its box, as Excalidraw lays it out.
    if (node.type !== 'text') inner.y = node.y + (node.height - (inner.height as number)) / 2;
    box.boundElements = [{ type: 'text', id: inner.id }];
    elements.push(inner);
  }

  for (const raw of rawEdges) {
    const edge = readEdge(raw);
    const from = edge ? boxes.get(edge.fromNode) : undefined;
    const to = edge ? boxes.get(edge.toNode) : undefined;
    if (!edge || !from || !to) continue;
    const [x1, y1] = sidePoint(from.node, edge.fromSide ?? facingSide(from.node, to.node));
    const [x2, y2] = sidePoint(to.node, edge.toSide ?? facingSide(to.node, from.node));
    const stroke = colorOf(edge.color)?.stroke ?? INK;
    const arrow: Element = {
      ...base('arrow', x1, y1, Math.abs(x2 - x1), Math.abs(y2 - y1), stroke, 'transparent'),
      strokeWidth: 2,
      points: [[0, 0], [x2 - x1, y2 - y1]],
      lastCommittedPoint: null,
      startBinding: { elementId: from.element.id, focus: 0, gap: 1 },
      endBinding: { elementId: to.element.id, focus: 0, gap: 1 },
      startArrowhead: edge.fromEnd ? 'arrow' : null,
      endArrowhead: edge.toEnd ? 'arrow' : null,
      elbowed: false,
    };
    for (const end of [from.element, to.element]) {
      end.boundElements = [...(end.boundElements ?? []), { type: 'arrow', id: arrow.id }];
    }
    elements.push(arrow);
    if (edge.label?.trim()) {
      const w = Math.max(40, Math.min(240, edge.label.length * FONT_SIZE * 0.6));
      const t = textElement(edge.label, (x1 + x2) / 2 - w / 2, (y1 + y2) / 2 - (FONT_SIZE * LINE_HEIGHT) / 2, w, arrow.id, 'center');
      arrow.boundElements = [{ type: 'text', id: t.id }];
      elements.push(t);
    }
  }

  const scene = emptyScene();
  const body = serializeScene(scene, elements, {}, files, (id) => (Object.hasOwn(files, id) ? files[id]!.src : undefined));
  return { body, outsidePictures, elements: elements.length };
}
