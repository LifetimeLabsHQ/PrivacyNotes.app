/**
 * Points Excalidraw at our own copy of its fonts (the `pn-excalidraw-fonts`
 * plugin in vite.config.ts). Without it Excalidraw fetches them from a CDN.
 * `DrawingCanvas.tsx` imports this module before `@excalidraw/excalidraw`, so
 * the path is set before Excalidraw builds a font URL.
 * Spec: docs/internal/specs/drawing.md (section 7, Fonts)
 */

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

window.EXCALIDRAW_ASSET_PATH = __PN_EXCALIDRAW_ASSET_PATH__;

export {};
