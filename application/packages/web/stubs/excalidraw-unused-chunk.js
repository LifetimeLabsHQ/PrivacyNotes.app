// Build-time replacement for the parts of Excalidraw the app never runs,
// each a chunk of its own that the app download would otherwise carry:
//
// - The font subsetter (`subset-worker.chunk.js`, `subset-shared.chunk.js`
//   and the WebAssembly they share). Only an SVG export with its fonts
//   inlined reaches it; the app offers none, and the content security
//   policy blocks WebAssembly anyway. Excalidraw catches the failure and
//   names the font file instead.
// - Every UI translation but English (`locales/*.js`). The canvas gets no
//   `langCode`, so Excalidraw asks only for English; a failed language
//   falls back to the English it bundles.
//
// Importing this module fails, so each of those imports takes Excalidraw's
// own fallback. Swapped in by `pn-excalidraw-no-unused-chunks` in
// vite.config.ts (build only).
//
// Spec: docs/internal/specs/drawing.md (section 7, Bundle)

throw new Error(
  'This part of Excalidraw is stubbed out of this build (packages/web/stubs/excalidraw-unused-chunk.js). ' +
    'Remove pn-excalidraw-no-unused-chunks in vite.config.ts to ship it.',
);
