import { useEffect, useMemo, useRef, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Node } from '@tiptap/core';
import Text from '@tiptap/extension-text';
import { useEditor, EditorContent, type JSONContent } from '@tiptap/react';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EncryptedAttachment, triggerAttachmentUpload } from './EncryptedAttachment';
import { DetailGroup } from './detailPane';
import { FileArrowUp } from './icons';
import { Button, useProGate } from './ui';
import { proUnlocked } from './demo';
import type { UpgradeTrigger } from './UpgradeModal';
import { vaultFiles, withVaultFiles, type VaultFile } from './vaultBody';
import type { LocalNote } from './db';

/** A document that holds file chips and nothing else. */
const FilesDoc = Node.create({ name: 'doc', topNode: true, content: 'attachment*' });

const FILE_PREFIX = 'pn:file/';

function toDoc(files: VaultFile[]): JSONContent {
  return {
    type: 'doc',
    content: files.map((f) => ({
      type: 'attachment',
      attrs: { src: `${FILE_PREFIX}${f.uuid}`, filename: f.name, filesize: f.size, mimetype: f.mime },
    })),
  };
}

function fromDoc(doc: PMNode): VaultFile[] {
  const files: VaultFile[] = [];
  doc.forEach((node) => {
    const src = String(node.attrs.src ?? '');
    if (node.type.name !== 'attachment' || !src.startsWith(FILE_PREFIX)) return;
    files.push({
      uuid: src.slice(FILE_PREFIX.length),
      name: String(node.attrs.filename ?? ''),
      size: String(node.attrs.filesize ?? ''),
      mime: String(node.attrs.mimetype ?? ''),
    });
  });
  return files;
}

const sameFiles = (a: VaultFile[], b: VaultFile[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The Files section of a login, card or SSH key (#563). It is the note
 * editor's own file chip in an editor whose document holds only chips, so
 * open, save, rename, play, remove, the damaged and the not-uploaded states
 * are the ones a note has. The files live in the item's body (`vaultFiles`)
 * and every change is saved at once, the way a file in a note is. Attaching
 * is Pro, like Bitwarden; a file already attached stays usable on every plan.
 * Spec: docs/internal/issues/0563.md
 */
export default function VaultFiles({ note, readOnly, isPro, onOpenUpgrade, onSave }: {
  note: LocalNote;
  readOnly: boolean;
  isPro: boolean | null;
  onOpenUpgrade: (trigger: UpgradeTrigger) => void;
  onSave: (body: string) => Promise<boolean>;
}) {
  const { t } = useTranslation('shell');
  const files = useMemo(() => vaultFiles(note.body), [note.body]);
  const unlocked = proUnlocked(isPro);
  const bodyRef = useRef(note.body);
  bodyRef.current = note.body;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const inputRef = useRef<HTMLInputElement>(null);
  const gate = useProGate(unlocked, () => onOpenUpgrade('vaultFiles'));
  // The editor keeps its first props; a paste reaches the current gate here.
  const attachRef = useRef<(list: File[], view?: EditorView) => void>(() => {});

  const editor = useEditor({
    extensions: [FilesDoc, Text, EncryptedAttachment],
    content: toDoc(files),
    editable: !readOnly,
    editorProps: {
      // Drops are taken by the section around the chips, which checks Pro
      // first; the chip extension's own drop handler would not.
      handleDrop: () => true,
      handlePaste: (view, event) => {
        const pasted = Array.from(event.clipboardData?.files ?? []);
        if (pasted.length > 0) attachRef.current(pasted, view);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const next = fromDoc(ed.state.doc);
      if (!sameFiles(next, vaultFiles(bodyRef.current))) void saveRef.current(withVaultFiles(bodyRef.current, next));
    },
  }, [note.id]);

  // Another device's change, or a restore from history, arrives as a new body.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (!sameFiles(fromDoc(editor.state.doc), files)) editor.commands.setContent(toDoc(files), { emitUpdate: false });
  }, [editor, files]);

  useEffect(() => { editor?.setEditable(!readOnly); }, [editor, readOnly]);

  const attach = gate((list: File[], view: EditorView | undefined = editor?.view) => {
    if (!view || readOnly) return;
    // A vault file keeps its bytes and name, whatever the image switches say.
    for (const file of list) void triggerAttachmentUpload(file, view, { keepOriginal: true });
  });
  attachRef.current = attach;

  function onDrop(event: DragEvent) {
    if (readOnly || !event.dataTransfer.files.length) return;
    event.preventDefault();
    attach(Array.from(event.dataTransfer.files));
  }

  if (readOnly && files.length === 0) return null;

  return (
    <div onDragOver={(e) => { if (!readOnly) e.preventDefault(); }} onDrop={onDrop}>
      <DetailGroup heading={t('tagsRail.files')}>
        {/* Chips sit closer than in a note; index.css drops the editor root's
            page minimum and top gap under pn-vault-files. */}
        <EditorContent editor={editor} className="pn-vault-files [&_.encrypted-attachment-wrapper]:my-2" />
        {!readOnly && <>
          <Button icon={<FileArrowUp aria-hidden="true" />} pro={!isPro} className="mt-2" onClick={gate(() => inputRef.current?.click())}>
            {t('editor:toolbar.attachFile')}
          </Button>
          <input ref={inputRef} type="file" multiple hidden
            onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ''; attach(picked); }} />
        </>}
      </DetailGroup>
    </div>
  );
}
