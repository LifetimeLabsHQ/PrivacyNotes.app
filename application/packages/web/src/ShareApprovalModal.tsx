import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmModal } from './ConfirmModal';
import { formatFileSize } from './attachmentValidation';
import { iconBookmark, iconFile, iconNote } from './icons';
import { TagInput } from './TagInput';
import { Button, FIELD_CLASS, ProMark, Select, SettingsSegmented, TextField } from './ui';
import {
  isSharedImage,
  loneWebUrl,
  readLastShareTaskList,
  type ShareApproval,
  type SharedItem,
  type ShareTarget,
} from './useShareInbox';

/**
 * The question the Android app asks before it saves what other apps shared
 * into it: any installed app can send an explicit share intent with no step by
 * the user, so nothing is saved until the user confirms. Unified share sheet
 * covering web links, text snippets, photos, and files, with smart defaults and
 * organization (Task list, Folder, Tags). Mixed multi-kind batches keep the
 * full item list for review.
 * Spec: docs/internal/specs/share-into-app.md
 */
/** Text from another app, with the direction controls that could make it
 *  show something other than what it holds taken out. */
function stripBidiControls(text: string | undefined): string {
  return (text ?? '').replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, '');
}

export interface ShareTaskListOption {
  id: string;
  title: string;
}

export interface ShareFolderOption {
  id: string;
  name: string;
}

type BatchKind = 'url' | 'text' | 'photos' | 'files' | 'mixed';

function classifyBatch(items: SharedItem[]): BatchKind {
  if (items.length === 0) return 'mixed';
  if (items.length === 1) {
    const only = items[0]!;
    if (only.kind === 'url' && only.url) return 'url';
    if (only.kind === 'text' && only.text) {
      return loneWebUrl(only.text) ? 'url' : 'text';
    }
  }
  if (items.every(isSharedImage)) return 'photos';
  if (items.every((it) => it.kind === 'file')) return 'files';
  return 'mixed';
}

function targetsFor(kind: BatchKind): ShareTarget[] {
  switch (kind) {
    case 'url': return ['bookmark', 'clip', 'task'];
    case 'text': return ['note', 'task', 'journal'];
    case 'photos': return ['note', 'files', 'journal'];
    case 'files': return ['files', 'note'];
    case 'mixed': return [];
  }
}

export function ShareApprovalModal({
  items,
  onChoice,
  taskLists = [],
  folders = [],
  allTags = [],
  foldersUnlocked = false,
  onOpenFoldersUpgrade,
}: {
  items: SharedItem[];
  onChoice: (choice: ShareApproval) => void;
  taskLists?: readonly ShareTaskListOption[];
  folders?: readonly ShareFolderOption[];
  allTags?: [string, number][];
  foldersUnlocked?: boolean;
  onOpenFoldersUpgrade?: () => void;
}) {
  const { t } = useTranslation(['importExport', 'common', 'notes', 'shell', 'editor']);
  const batchKind = useMemo(() => classifyBatch(items), [items]);
  const targets = useMemo(() => targetsFor(batchKind), [batchKind]);
  const isUnified = batchKind !== 'mixed';

  const initialUrl = useMemo(() => {
    if (batchKind !== 'url') return '';
    const only = items[0]!;
    return only.kind === 'url' ? (only.url ?? '') : (loneWebUrl(only.text ?? '') ?? '');
  }, [batchKind, items]);

  const initialTitle = useMemo(() => {
    if (batchKind === 'url') {
      const raw = stripBidiControls(items[0]?.title).trim();
      if (raw) return raw;
      try {
        return new URL(initialUrl).hostname;
      } catch {
        return '';
      }
    }
    if (batchKind === 'files' && items.length === 1) {
      return stripBidiControls(items[0]?.name).trim();
    }
    return '';
  }, [batchKind, items, initialUrl]);

  const initialBody = useMemo(() => {
    if (batchKind === 'text') return stripBidiControls(items[0]?.text);
    return '';
  }, [batchKind, items]);

  const [target, setTarget] = useState<ShareTarget>(() => targets[0] ?? 'note');
  const [title, setTitle] = useState(initialTitle);
  const [noteText, setNoteText] = useState(initialBody);
  const [taskListId, setTaskListId] = useState<string>(() => {
    const remembered = readLastShareTaskList();
    return remembered && taskLists.some((l) => l.id === remembered) ? remembered : '';
  });
  const [folderId, setFolderId] = useState<string>('');
  const [tags, setTags] = useState<string[]>([]);
  const decidedRef = useRef(false);

  function decide(choice: ShareApproval) {
    if (decidedRef.current) return;
    decidedRef.current = true;
    onChoice(choice);
  }

  function targetLabel(option: ShareTarget): string {
    switch (option) {
      case 'bookmark': return t('notes:newMenu.bookmark');
      case 'clip': return t('notes:newMenu.clipPage');
      case 'note': return t('notes:newMenu.note');
      case 'task': return t('notes:newMenu.task');
      case 'journal': return t('notes:newMenu.journal');
      case 'files': return t('shell:tagsRail.files');
    }
  }

  function handleConfirm() {
    if (!isUnified) {
      decide('save');
      return;
    }
    const cleanTitle = title.trim();
    const cleanText = noteText.trim();
    decide({
      action: 'save',
      choice: {
        target,
        ...(cleanTitle ? { title: cleanTitle } : {}),
        ...(cleanText ? { text: cleanText } : {}),
        ...(target === 'task' ? { taskListId: taskListId || null } : {}),
        ...(target !== 'task' && target !== 'journal' && foldersUnlocked && folderId ? { folderId } : {}),
        ...(target !== 'task' && tags.length > 0 ? { tags } : {}),
      },
    });
  }

  const isTask = target === 'task';
  const isJournal = target === 'journal';
  const isFiles = target === 'files';
  const showTitle =
    (batchKind === 'url') ||
    (batchKind === 'text' && target === 'note') ||
    (batchKind === 'photos' && target === 'note') ||
    (batchKind === 'files' && target === 'note');
  const showNoteArea =
    (batchKind === 'url' && !isTask) ||
    (batchKind === 'text') ||
    (batchKind === 'photos' && !isFiles) ||
    (batchKind === 'files' && target === 'note');
  const showFolderControl = isUnified && !isTask && !isJournal && (foldersUnlocked ? folders.length > 0 : Boolean(onOpenFoldersUpgrade));
  const showTagsControl = isUnified && !isTask;

  return (
    <ConfirmModal
      title={t('importExport:shareSheet.title', { count: items.length })}
      confirmLabel={isUnified ? t('common:actions.save') : t('importExport:shareSheet.saveAll')}
      variant="info"
      cancelLabel={t('importExport:upload.discard')}
      onConfirm={handleConfirm}
      onCancel={() => decide('discard')}
      onClose={() => decide('later')}
    >
      <p className="text-compact text-pn-muted mb-3">{t('importExport:shareSheet.line')}</p>
      {isUnified && (
        <div className="space-y-2.5 mb-3">
          <SettingsSegmented
            value={target}
            onChange={(next) => setTarget(next as ShareTarget)}
            label={t('importExport:shareSheet.saveAs')}
            className="w-full [&>button]:flex-1"
            options={targets.map((opt) => ({ value: opt, label: targetLabel(opt) }))}
          />
          {batchKind === 'url' && initialUrl && (
            <p className="text-small text-pn-muted truncate" dir="ltr">{stripBidiControls(initialUrl)}</p>
          )}
          {showTitle && (
            <TextField
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                batchKind === 'url' && isTask
                  ? t('shell:shareInbox.taskPlaceholder')
                  : t('shell:shareInbox.titlePlaceholder')
              }
              aria-label={
                batchKind === 'url' && isTask
                  ? t('shell:shareInbox.taskPlaceholder')
                  : t('shell:shareInbox.titlePlaceholder')
              }
              maxLength={1000}
              className="w-full"
            />
          )}
          {showNoteArea && (
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder={
                isTask
                  ? t('shell:shareInbox.taskPlaceholder')
                  : t('shell:shareInbox.notePlaceholder')
              }
              aria-label={
                isTask
                  ? t('shell:shareInbox.taskPlaceholder')
                  : t('shell:shareInbox.notePlaceholder')
              }
              rows={batchKind === 'text' ? 3 : 2}
              className={`w-full resize-none ${FIELD_CLASS}`}
            />
          )}
          {isJournal && (
            <p className="text-help text-pn-muted">{t('shell:shareInbox.journalHint')}</p>
          )}
          {isTask && (
            <div className="space-y-1">
              <label htmlFor="pn-share-task-list" className="block text-small text-pn-muted">
                {t('editor:toolbar.taskList')}
              </label>
              <Select
                id="pn-share-task-list"
                value={taskListId}
                onChange={(e) => setTaskListId(e.target.value)}
                className="w-full"
              >
                <option value="">{t('shell:shareInbox.quickTasks')}</option>
                {taskLists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.title}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {showFolderControl && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-small text-pn-muted">
                <label htmlFor="pn-share-folder">{t('shell:folders.chipUnfiled')}</label>
                {!foldersUnlocked && <ProMark />}
              </div>
              {foldersUnlocked ? (
                <Select
                  id="pn-share-folder"
                  value={folderId}
                  onChange={(e) => setFolderId(e.target.value)}
                  className="w-full"
                >
                  <option value="">{t('shell:folders.unfiled')}</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Button
                  variant="secondary"
                  icon={<ProMark />}
                  onClick={() => onOpenFoldersUpgrade?.()}
                  className="w-full justify-start"
                >
                  {t('shell:folders.unfiled')}
                </Button>
              )}
            </div>
          )}
          {showTagsControl && (
            <div className="rounded-lg border border-divider bg-surface-2 px-2 py-1">
              <TagInput
                tags={tags}
                onChange={setTags}
                allTags={allTags}
              />
            </div>
          )}
        </div>
      )}
      {(batchKind === 'mixed' || batchKind === 'photos' || batchKind === 'files') && (
        <ul className="max-h-60 overflow-y-auto divide-y divide-divider border-y border-divider">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2 py-1.5 text-compact text-pn min-w-0">
              <span className="shrink-0 text-pn-muted" aria-hidden="true">
                {item.kind === 'url' ? iconBookmark() : item.kind === 'file' ? iconFile() : iconNote()}
              </span>
              <span className="truncate flex-1" dir="auto">
                {stripBidiControls(item.kind === 'url' ? item.url : item.kind === 'file' ? item.name : item.text)}
              </span>
              {item.kind === 'file' && item.size !== undefined && (
                <span className="shrink-0 text-small text-pn-muted tabular-nums">{formatFileSize(item.size)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </ConfirmModal>
  );
}
