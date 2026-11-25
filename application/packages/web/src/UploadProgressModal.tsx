/**
 * Upload progress modal - shows per-file status during batch uploads.
 *
 * States per file: validating → uploading → done | failed
 * Summary line at the bottom: "X done, Y uploading, Z failed"
 * Supported types + size limit shown as a footer hint.
 */

import { useTranslation } from 'react-i18next';
import { Trash } from './icons';
import { isStorageConfigured } from './paddle';
import { proUnlocked } from './demo';
import { Button, IconUpgrade, ProgressBar, ProgressModal } from './ui';

type FileUploadStatus = 'pending' | 'uploading' | 'done' | 'failed';

export interface FileUploadEntry {
  name: string;
  size: number;
  status: FileUploadStatus;
  error?: string;
  /** Structured failure class - preferred over sniffing `error` text.
   *  'storage-full' = refused up-front, nothing was created;
   *  'storage-full-kept' = server rejected mid-race, blob + note stay
   *  on this device until space frees (backlog #143). */
  errorCode?: 'storage-full' | 'storage-full-kept';
  /** Set on a shared file the upload kept: drops it from the share inbox. */
  discard?: () => Promise<void>;
  /** The kept file was dropped; its name is struck through. */
  discarded?: boolean;
}

interface Props {
  entries: FileUploadEntry[];
  isPro: boolean;
  hasStorageSub: boolean;
  onOpenUpgrade: () => void;
  onManageStorage: () => void;
  onClose: () => void;
}

export function UploadProgressModal({ entries, isPro, hasStorageSub, onOpenUpgrade, onManageStorage, onClose }: Props) {
  const { t } = useTranslation('importExport');
  const allDone = entries.length > 0 && entries.every((e) => e.status === 'done' || e.status === 'failed');

  const counts = { done: 0, uploading: 0, failed: 0, pending: 0 };
  for (const e of entries) counts[e.status]++;
  const active = counts.uploading + counts.pending;

  const title = allDone
    ? counts.failed > 0
      ? counts.done > 0
        ? t('upload.partialTitle', { done: counts.done, failed: counts.failed })
        : t('upload.failedTitle')
      : t('upload.completeTitle')
    : t('upload.uploadingTitle', { count: entries.length });

  return (
    <ProgressModal
      title={title}
      onClose={onClose}
      canClose={allDone}
      closeOnBackdrop={allDone}
      footer={
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-small text-pn-muted">
              {counts.done > 0 && t('upload.summaryDone', { count: counts.done })}
              {counts.done > 0 && (active > 0 || counts.failed > 0) && ', '}
              {active > 0 && t('upload.summaryUploading', { count: active })}
              {active > 0 && counts.failed > 0 && ', '}
              {counts.failed > 0 && t('upload.summaryFailed', { count: counts.failed })}
            </span>
            <Button action="done" onClick={onClose} disabled={!allDone} />
          </div>
          {!proUnlocked(isPro) ? (
            <div className="flex items-center gap-2 rounded-md bg-accent/10 px-2.5 py-1.5">
              <span className="shrink-0"><IconUpgrade size={13} /></span>
              <span className="flex-1 text-small text-pn-soft leading-tight">
                {t('upload.proPitch')}
              </span>
              <button type="button" onClick={onOpenUpgrade} className="shrink-0 text-small font-medium text-accent hover:underline">
                {t('upload.proPitchCta')}
              </button>
            </div>
          ) : !hasStorageSub && isStorageConfigured() ? (
            <div className="flex items-center gap-2 rounded-md bg-accent/10 px-2.5 py-1.5">
              <span className="shrink-0"><IconUpgrade size={13} /></span>
              <span className="flex-1 text-small text-pn-soft leading-tight">
                {t('upload.storagePitch')}
              </span>
              <button type="button" onClick={onManageStorage} className="shrink-0 text-small font-medium text-accent hover:underline">
                {t('upload.storagePitchCta')}
              </button>
            </div>
          ) : (
            <p className="text-meta text-pn-muted leading-relaxed">
              {t('upload.typesHint', { limit: hasStorageSub ? '100' : '50' })}
            </p>
          )}
        </div>
      }
    >
      {entries.map((entry, i) => (
        <div key={`${entry.name}-${i}`}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className={`text-compact truncate flex-1 ${
              entry.discarded
                ? 'text-pn-muted line-through'
                : entry.status === 'failed'
                  ? 'text-danger'
                  : 'text-pn'
            }`}>
              {entry.name}
            </span>
            {entry.discard && (
              <Button
                icon={<Trash size={12} aria-hidden="true" />}
                onClick={() => { void entry.discard?.().catch((err) => console.warn('[upload] discard failed:', err)); }}
                className="shrink-0 !px-2 !py-0.5 !text-small"
              >
                {t('upload.discard')}
              </Button>
            )}
            <span className={`text-small shrink-0 ${
              entry.status === 'done'
                ? 'text-success'
                : entry.status === 'failed'
                  ? 'text-danger'
                  : entry.status === 'uploading'
                    ? 'text-accent'
                    : 'text-pn-muted'
            }`}>
              {entry.status === 'done' && t('upload.statusDone')}
              {entry.status === 'failed' && t('upload.statusFailed')}
              {entry.status === 'uploading' && t('upload.statusUploading')}
              {entry.status === 'pending' && t('upload.statusWaiting')}
            </span>
          </div>
          <ProgressBar
            label={entry.name}
            value={entry.status === 'pending' ? 0 : entry.status === 'uploading' ? undefined : 1}
            tone={entry.status === 'done' ? 'success' : entry.status === 'failed' ? 'danger' : 'info'}
          />
          {entry.status === 'failed' && (entry.errorCode || entry.error) && (
            <p className="text-meta text-danger mt-0.5 leading-tight">
              {entry.errorCode === 'storage-full'
                ? `${t('upload.errorStorageFull')} ${t('notesChrome:quota.deletedSpace')}`
                : entry.errorCode === 'storage-full-kept'
                  ? t('upload.errorStorageFullKept')
                  : entry.error && /quota exceeded/i.test(entry.error)
                    ? t('upload.errorStorageFullKept')
                    : entry.error}
            </p>
          )}
        </div>
      ))}
    </ProgressModal>
  );
}
