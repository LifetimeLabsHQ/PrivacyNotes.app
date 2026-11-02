// Build-time replacement for @excalidraw/mermaid-to-excalidraw.
//
// Excalidraw reaches for it in two places: the "Mermaid to Excalidraw"
// dialog of its extra tools menu, which drawing/drawing.css hides, and a
// paste of text that looks like a Mermaid diagram, which catches the
// failure and pastes the plain text instead. The real package pulls in
// Mermaid, cytoscape and a second KaTeX: megabytes in every app download,
// and a KaTeX copy that the bundler merged into the boot-path katex chunk.
// Aliased away in vite.config.ts.
//
// Spec: docs/internal/specs/drawing.md (section 7, Bundle)

export async function parseMermaidToExcalidraw() {
  throw new Error(
    'Mermaid is stubbed out of this build (packages/web/stubs/mermaid-to-excalidraw.js). ' +
      'Remove the alias in vite.config.ts to use @excalidraw/mermaid-to-excalidraw.',
  );
}
