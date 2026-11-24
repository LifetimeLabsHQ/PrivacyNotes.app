/**
 * The launch switch of the bookmark Notes box.
 *
 * A build before NOTES_GUARD_VERSION rebuilds a bookmark body from the keys
 * it knows when the URL is edited, so it erases the notes (the old body stays
 * in the note's history). From NOTES_GUARD_VERSION on, `updateLinkBody` keeps
 * every key. Release builds offer an empty Notes box only once the release
 * floor (`minVersion` in packages/desktop/update-policy.json) is at or above
 * it; a bookmark that already has notes, from an import, always shows them.
 * `tests/bookmarkNotesLaunch.test.ts` fails a switch set before that. Web
 * builds update themselves and need no wait; a dev build always offers it.
 * Spec: docs/internal/specs/bookmarks-pillar.md (section 10)
 */

export const NOTES_GUARD_VERSION = '0.796.0';

export const BOOKMARK_NOTES_LAUNCHED = true;

/** Whether a bookmark with no notes shows the Notes box. */
export const BOOKMARK_NOTES_OFFERED: boolean = BOOKMARK_NOTES_LAUNCHED || import.meta.env.DEV;
