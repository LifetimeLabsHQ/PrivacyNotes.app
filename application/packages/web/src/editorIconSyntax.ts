/**
 * The stored form of an icon in a note's text: `:icon[<id>]` for a look icon
 * and `:logo[<slug>]` for a logo, whose id inside the app is `logo:<slug>`.
 * For every reader of a body: the editor node (editorIcon.tsx), the list
 * preview (notesViewUtils.ts) and the export renderer (markdownRender.ts).
 * Spec: docs/internal/specs/folder-tag-icons.md (section 3.7)
 */

/** A look icon id or a logo id: lower-case letters, digits and hyphens. */
export const INLINE_ICON_ID = /^(?:logo:)?[a-z0-9][a-z0-9-]*$/;
/** The stored form, anywhere in a body; group 1 is `icon` or `logo`, group 2
 *  the name. */
export const INLINE_ICON_RE = /:(icon|logo)\[([a-z0-9][a-z0-9-]*)\]/g;

/** The app's id for a stored `:icon[...]` or `:logo[...]`. */
export const inlineIconId = (kind: string, name: string) => (kind === 'logo' ? `logo:${name}` : name);

export const inlineIconMarkdown = (id: string) =>
  id.startsWith('logo:') ? `:logo[${id.slice('logo:'.length)}]` : `:icon[${id}]`;
