/**
 * A map inside a note's body, put there with Insert > Location. Stored as a
 * fenced block that any Markdown app shows as readable text:
 *
 *     ```map
 *     35.3606, 138.7274
 *     Taishikan hut
 *     ```
 *
 * The first line is the place, the second its optional name. The map loads by
 * itself when the note opens (owner, 2026-11-11): the person put it there on
 * purpose, as the map in the place window does when it opens. A
 * `geo:` link that came in with an import stays a plain link and never loads
 * anything. A fence the parse cannot read stays a code block, so nothing is
 * lost.
 * Spec: docs/internal/plans/note-location.md (section 4b)
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { MapPin, Notches } from './icons';
import { HoverLabel } from './HoverLabel';
import { intlLocale } from './languages';
import { IMAGE_WIDTH_MAX, clampImageWidth } from './imageWidth';
import { openExternal } from './openExternal';
import { MAP_FENCE, MAP_HEIGHT_DEFAULT, clampMapHeight, formatCoordinates, makeLocation, mapFenceBody, osmUrl, parseMapFence } from './noteLocation';
import { ShownMap } from './notesView/NoteLocationChip';

type MapAttrs = { lat: number; lng: number; label: string | null; width: number | null; height: number | null };

function PlaceMapView({ node, selected, editor, updateAttributes }: NodeViewProps) {
  const { t } = useTranslation('notes');
  const attrs = node.attrs as MapAttrs;
  const place = makeLocation(attrs.lat, attrs.lng, attrs.label ?? undefined);
  const width = clampImageWidth(attrs.width ?? IMAGE_WIDTH_MAX) ?? IMAGE_WIDTH_MAX;
  const height = clampMapHeight(attrs.height ?? MAP_HEIGHT_DEFAULT) ?? MAP_HEIGHT_DEFAULT;
  // Tracked, not read once, as a file chip does (EncryptedAttachment.tsx):
  // Read-only switches the same editor, which draws no block again, so a
  // handle read at render time stayed on a read-only note and stayed away
  // once the note could be edited again. `setEditable` emits an update.
  const [editable, setEditable] = useState(editor.isEditable);
  useEffect(() => {
    const sync = () => setEditable(editor.isEditable);
    sync();
    editor.on('update', sync);
    return () => { editor.off('update', sync); };
  }, [editor]);

  // The corner handle, as a picture's (EncryptedImage.tsx): the width is a
  // percent of the column, the height is pixels, both follow the pointer and
  // are written once, on release. The map's start edge and top stay put.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [dragSize, setDragSize] = useState<{ width: number; height: number } | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; h: number; column: number; dir: number } | null>(null);
  const shown = dragSize ?? { width, height };
  const resizeStart = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const column = boxRef.current?.parentElement?.getBoundingClientRect().width;
    if (!column) return;
    drag.current = { x: e.clientX, y: e.clientY, px: (width / 100) * column, h: height, column, dir: document.documentElement.dir === 'rtl' ? -1 : 1 };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragSize({ width, height });
  };
  const resizeMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    setDragSize({
      width: clampImageWidth(((d.px + (e.clientX - d.x) * d.dir) / d.column) * 100) ?? width,
      height: clampMapHeight(d.h + e.clientY - d.y) ?? height,
    });
  };
  const resizeEnd = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (e.type === 'pointerup' && dragSize && (dragSize.width !== width || dragSize.height !== height)) {
      updateAttributes({
        width: dragSize.width === IMAGE_WIDTH_MAX ? null : dragSize.width,
        height: dragSize.height === MAP_HEIGHT_DEFAULT ? null : dragSize.height,
      });
    }
    setDragSize(null);
  };

  return (
    <NodeViewWrapper
      // my-6 (24px), one line of body text, as the file block has: the gap
      // above and below holds the "Add a line" hint (editorAddLine.ts) with
      // room for the pointer.
      className={`pn-place-map my-6 rounded-lg ${selected ? 'outline outline-2 outline-accent' : ''}`}
      contentEditable={false}
    >
      {place && (
        <div ref={boxRef} className="flex flex-col gap-1.5" style={{ width: `${shown.width}%` }}>
          {/* The header is the block's drag handle; a press on the map moves
              the map (stopEvent below). A div, not a p: the editor sizes
              every p as body text. */}
          <div data-drag-handle className="flex cursor-grab items-center gap-1.5 text-small text-pn-muted active:cursor-grabbing">
            <MapPin className="shrink-0 text-accent" aria-hidden="true" />
            <a
              href={osmUrl(place.lat, place.lng)}
              // A drag that starts on the name moves the block, never the link.
              draggable={false}
              className="truncate underline"
              dir="auto"
              onClick={(e) => { e.preventDefault(); openExternal(osmUrl(place.lat, place.lng)); }}
            >
              {place.label ?? formatCoordinates(place)}
            </a>
          </div>
          <div
            className="relative"
            data-map-surface=""
            // The browser's own drag (a credit link, a stray selection) would
            // drop the block's page text into the note: the map area never
            // starts one. The map pans on its own pointer events.
            onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >
            <ShownMap place={place} height={shown.height} />
            {editable && (
              <>
                {/* A button so ProseMirror leaves its events alone, out of
                    the Tab order like a picture's; above the credit line. */}
                <div className="pn-map-resize">
                  <HoverLabel label={t('media:image.resizeHint')} position="start" disabled={dragSize !== null}>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={t('media:image.resizeHint')}
                      className="pn-resize-plate cursor-nwse-resize rtl:cursor-nesw-resize"
                      onPointerDown={resizeStart}
                      onPointerMove={resizeMove}
                      onPointerUp={resizeEnd}
                      onPointerCancel={resizeEnd}
                      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                      onDragStart={(e) => e.preventDefault()}
                    >
                      <Notches aria-hidden="true" className="rtl:-scale-x-100" />
                    </button>
                  </HoverLabel>
                </div>
                {dragSize && (
                  <span className="pn-map-resize-value">
                    {(dragSize.width / 100).toLocaleString(intlLocale(), { style: 'percent' })}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/** Whether the last press in a map block began on the map (one pointer at a time). */
let pressInMap = false;

export const PlaceMapNode = Node.create({
  name: 'placeMap',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      lat: { default: 0 },
      lng: { default: 0 },
      label: { default: null },
      // Null is the default size: the full column, MAP_HEIGHT_DEFAULT tall.
      width: { default: null },
      height: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        // Above the code block's own `pre` rule: a `map` fence that reads as a
        // place becomes this node, anything else stays a code block.
        tag: 'pre',
        priority: 60,
        getAttrs(dom) {
          const code = (dom as HTMLElement).querySelector('code');
          if (!code || !code.classList.contains(`language-${MAP_FENCE}`)) return false;
          const place = parseMapFence(code.textContent ?? '');
          if (!place) return false;
          const el = dom as HTMLElement;
          const w = el.dataset['width'] ? clampImageWidth(Number(el.dataset['width'])) : null;
          const h = el.dataset['height'] ? clampMapHeight(Number(el.dataset['height'])) : null;
          return {
            lat: place.lat,
            lng: place.lng,
            label: place.label ?? null,
            width: w === IMAGE_WIDTH_MAX ? null : w,
            height: h === MAP_HEIGHT_DEFAULT ? null : h,
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const place = makeLocation(node.attrs['lat'], node.attrs['lng'], node.attrs['label'] ?? undefined);
    const size = {
      ...(node.attrs['width'] ? { 'data-width': String(node.attrs['width']) } : {}),
      ...(node.attrs['height'] ? { 'data-height': String(node.attrs['height']) } : {}),
    };
    return ['pre', mergeAttributes(HTMLAttributes, size), ['code', { class: `language-${MAP_FENCE}` }, place ? mapFenceBody(place) : '']];
  },

  addNodeView() {
    return ReactNodeViewRenderer(PlaceMapView as never, {
      // The map's own area keeps its presses, drags, pinches and wheel: the
      // editor never sees them, so it neither selects nor starts to drag the
      // block from there. A block dragged over the map can still drop. Every
      // other event (the header, the drag handle) goes to the editor.
      // A drag counts by where the press began: with the block selected, the
      // browser starts a selection drag whose target is the whole block, so a
      // press on the map would otherwise move the block (into a table, once).
      stopEvent: ({ event }) => {
        const target = event.target as Element | null;
        const inMap = Boolean(target?.closest?.('[data-map-surface]'));
        if (event.type === 'mousedown' || event.type === 'touchstart') pressInMap = inMap;
        if (event.type === 'dragstart' && (inMap || pressInMap)) {
          event.preventDefault();
          return true;
        }
        if (/^(dragover|dragenter|dragleave|drop)$/.test(event.type)) return false;
        return inMap;
      },
    });
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write: (s: string) => void; ensureNewLine: () => void; closeBlock: (n: unknown) => void },
          node: { attrs: MapAttrs },
        ) {
          const place = makeLocation(node.attrs.lat, node.attrs.lng, node.attrs.label ?? undefined);
          if (!place) return;
          // The size rides on the fence line, only where it is not the default.
          const size = `${node.attrs.width ? ` width=${node.attrs.width}` : ''}${node.attrs.height ? ` height=${node.attrs.height}` : ''}`;
          // The name is one line with no run of three backticks (makeLocation,
          // mapFenceBody), so the closing fence is always this one.
          state.write(`\`\`\`${MAP_FENCE}${size}\n${mapFenceBody(place)}\n\`\`\``);
          state.closeBlock(node);
        },
        parse: {
          // The fence comes in through markdown-it as `pre > code.language-map`,
          // which parseHTML above turns into this node.
        },
      },
    };
  },
});
