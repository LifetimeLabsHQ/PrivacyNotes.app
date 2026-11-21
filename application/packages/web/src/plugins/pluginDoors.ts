import { useSyncExternalStore } from 'react';
import { detectDeviceOs } from '../deviceFingerprint';
import { detectPlatform } from '../devices';
import { pluginsShown } from '../onDeviceAi';
import { speechIsTooOld } from './pluginState';

/**
 * The doors from a note into a plugin's sheet, on the boot path: a picture,
 * a PDF chip, an audio chip or a note's menu sends a request, and the sheet host in
 * NotesView (`PluginSheetHost.tsx`) decides what opens: the upgrade window on
 * a free account, the plugin's card when it is not on this device, else the
 * sheet. A node view can unmount while its sheet is open, so the sheet never
 * lives in the node view.
 * Spec: docs/internal/plans/plugins.md (sections 6.4 to 6.6)
 */

/**
 * The note an editor shows, for the doors inside it: a job takes the note its
 * door sits in, not the one open in the pane (a Home widget, beta #240 item
 * 4). `Editor.tsx` records it; an editor with no note (a vault item's Files)
 * gives '', and a job with no note is not checked against the live notes.
 */
const editorNotes = new WeakMap<object, string>();

export function setEditorNote(editor: object, noteId: string): void {
  editorNotes.set(editor, noteId);
}

export function editorNote(editor: object): string {
  return editorNotes.get(editor) ?? '';
}

export type OcrRequest = {
  kind: 'ocr';
  /** A picture, or a PDF whose text layer is read first. */
  source: 'picture' | 'pdf';
  /** The decrypted bytes, read only when the sheet runs. */
  load: () => Promise<Uint8Array | null>;
  /** Inserts the text as plain paragraphs below the picture or file; absent where there is no place (the viewer, a note that cannot be edited, an editor with no paragraphs). Throws when the place is gone. */
  insert?: (text: string) => void;
  /** The entry the person used: it decides the sheet's main button. */
  primary: 'copy' | 'add';
  /** The note the door sits in (`editorNote`); absent, the note open in the pane (the viewer). */
  noteId?: string;
};

export type TranslateRequest = {
  kind: 'translate';
  /** The note it reads: its job stops when the note goes (section 3.1). */
  noteId: string;
  /** The note's title and Markdown, read when the door opens. */
  title: string;
  body: string;
  /** Saves the translation as a new note, in the note's folder with its tags (D15). */
  save: (title: string, body: string) => Promise<void>;
};

export type VoiceRequest = {
  kind: 'voice';
  /** The recording's bytes, read only when the sheet runs. */
  load: () => Promise<Uint8Array | null>;
  /** Its MIME type, so its length is read from the header before any decode. */
  mimetype: string;
  /** Inserts the text as plain paragraphs below the audio chip; absent in a read-only note or an editor with no paragraphs (a vault item's Files). Throws when the place is gone. */
  insert?: (text: string) => void;
  /** The note the door sits in (`editorNote`). */
  noteId: string;
};

/** A recording's attributes: what Remove noise swaps, and Undo swaps back. */
export type AudioAttrs = { src: string; filename: string; filesize: string; mimetype: string };

export type CleanupRequest = {
  kind: 'cleanup';
  /** The recording's attachment id: its chip takes the result. */
  subject: string;
  /** Its name: the cleaned file keeps it, with the extension of its format. */
  filename: string;
  /** The recording's bytes, read when the job runs. */
  load: () => Promise<Uint8Array | null>;
  /** Stores the cleaned file as an attachment of its own; null when it could not. */
  store: (file: File) => Promise<{ attrs: AudioAttrs; uploaded: Promise<void> } | null>;
  /** The note the door sits in (`editorNote`). */
  noteId: string;
};

export type PluginRequest = OcrRequest | TranslateRequest | VoiceRequest | CleanupRequest;

/**
 * Remove noise: each job's recording, by job id, so the chip of that
 * recording shows the progress and takes the result, also when it mounts
 * again after the note was closed. Light, on the boot path; the job itself
 * lives in `cleanup.ts`.
 * Spec: docs/internal/specs/plugins-speech-enhancement.md (section 8)
 */
export const cleanupSubjects = new Map<string, string>();

/**
 * Whether a recording offers "Remove noise": the encoder runs in the plugin
 * worker, and a platform without WebCodecs audio (WebKitGTK) has none.
 */
export function cleanupShown(): boolean {
  return pluginsShown() && typeof AudioEncoder !== 'undefined';
}

/**
 * Whether a recording offers "Transcribe": not in a browser on iPhone or
 * iPad, where Whisper small adds 1.2 to 1.5 GB to the tab and iOS ends it
 * (D24), and not in the iOS app below iOS 26, which has no SpeechAnalyzer
 * and never runs Whisper (beta #242 item 1). The OS says so once asked
 * (`checkAppleSpeech`); until then the door shows, and its sheet says it.
 */
export function voiceShown(): boolean {
  if (!pluginsShown()) return false;
  const platform = detectPlatform();
  if (platform === 'ios') return !speechIsTooOld();
  const os = detectDeviceOs();
  return platform !== 'web' || (os !== 'iPhone' && os !== 'iPad');
}

/**
 * Whether an editor has a place for a plugin's text: one that can be edited
 * (the debounced write refuses a read-only note, so the text would show and
 * never be saved) with paragraphs in its schema (a vault item's Files holds
 * file chips alone). Beta #240 items 2 and 3.
 */
export function canAddText(editor: { isEditable: boolean; schema: { nodes: Record<string, unknown> } }): boolean {
  return editor.isEditable && !!editor.schema.nodes.paragraph;
}

let current: PluginRequest | null = null;
const listeners = new Set<() => void>();

export function openPluginSheet(request: PluginRequest): void {
  current = request;
  for (const l of listeners) l();
}

export function closePluginSheet(): void {
  current = null;
  for (const l of listeners) l();
}

export function usePluginRequest(): PluginRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
