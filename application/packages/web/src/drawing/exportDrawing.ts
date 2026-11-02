/**
 * One drawing out of the app: as a `.excalidraw` file, which excalidraw.com
 * and Obsidian open, with every picture's bytes back inside it; or as a
 * PNG. A lazy module (it loads Excalidraw for the PNG), reached from the
 * share menu through `useExports.ts`, which builds the file: this chunk
 * imports nothing of the NotesView chunk (docs/contrib/bundle-size.md section 8).
 *
 * HTML, PDF and print leave a drawing out: an SVG of it would need
 * Excalidraw's font subsetter, whose WebAssembly the content security
 * policy blocks. Full backup keeps the body as stored, references included.
 * Spec: docs/internal/specs/drawing.md (section 7, Export)
 */

import './assetPath';
import { exportToBlob } from '@excalidraw/excalidraw';
import { slugify } from '../exportNames';
import { saveBlob } from '../saveFile';

/** Save `file`, a `.excalidraw` document with its pictures inside. */
export async function saveDrawing(title: string, file: string, format: 'excalidraw' | 'png'): Promise<void> {
  const blob = format === 'excalidraw'
    ? new Blob([file], { type: 'application/vnd.excalidraw+json' })
    : await (() => {
      const scene = JSON.parse(file) as { elements: unknown[]; appState: Record<string, unknown>; files: Record<string, unknown> };
      return exportToBlob({
        elements: scene.elements as never,
        // The drawing stores no background (the note's colour shows in the
        // app), so the picture gets a white one.
        appState: { ...scene.appState, exportBackground: true, viewBackgroundColor: '#ffffff' } as never,
        files: scene.files as never,
        mimeType: 'image/png',
      });
    })();
  const saved = await saveBlob(blob, `${slugify(title)}.${format}`);
  if (!saved.ok && saved.reason === 'failed') throw saved.error;
}
