/**
 * Export progress modal - shows status during full backup export.
 *
 * Mirrors the visual style of UploadProgressModal (same width, backdrop,
 * borders, progress bar treatment) but simpler: export is a sequential
 * pipeline, so one line names the step and its count, one bar fills for a
 * step that counts, and a row of steps shows what is done and what is next.
 *
 * Spec: docs/internal/design/patterns/151-160.md section 156
 */

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useEscapeToClose } from './useEscapeToClose';
import { Button, Callout, CloseButton, ProgressBar } from './ui';
import { Check, FolderOpen } from './icons';
import type { ExportStep, ExportStepName } from './export';
import { detectPlatform } from './devices';

// Step names reuse labels the app already shows, already translated: the
// Files pane's filters and the Notes pillar. Only Zip is this window's own.
const STEP_LABELS: Record<ExportStepName, string> = {
  pictures: 'notes:settings.imagesLabel',
  files: 'shell:filesList.filterFiles',
  notes: 'shell:tagsRail.notes',
  zip: 'importExport:exportProgress.zipStep',
};

interface Props {
  /** Human-readable status from the export pipeline. Empty once an export
   *  finishes whole; a finished export whose file lacks a picture or a file
   *  its notes refer to carries the sentence that says so. */
  status: string;
  /** True once the export has finished (downloaded or errored). */
  done: boolean;
  /** Optional error message if the export failed. */
  error?: string;
  /** Where a native save put the file. Desktop offers Show in folder for it;
   *  a phone's path is a document URI no file manager opens. */
  savedPath?: string;
  /** The steps of the running export, in order, and the one it is on. */
  steps?: readonly ExportStepName[];
  step?: ExportStep;
  /** Closes the window. While the export runs, it cancels the export too. */
  onClose: () => void;
}

export function ExportProgressModal({ status, done, error, savedPath, steps, step, onClose }: Props) {
  const { t } = useTranslation('importExport');
  useEscapeToClose(onClose);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // The file was saved, short of something. It never reads as complete.
  const incomplete = done && !error && status !== '';

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 dark:bg-black/70"
      onClick={(e) => { if (done && e.target === overlayRef.current) onClose(); }}
    >
      <div
        className="w-[360px] bg-surface-2 rounded-lg border border-divider flex flex-col overflow-hidden text-pn"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-divider flex items-center justify-between gap-2">
          <h2 className="text-heading font-semibold">
            {error
              ? t('exportProgress.failedTitle')
              : incomplete
                ? t('exportProgress.incompleteTitle')
                : done ? t('exportProgress.completeTitle') : t('exportProgress.exportingTitle')}
          </h2>
          {/* Always there. While the export runs, the X cancels it, like
              Escape and the Cancel button: an export that hangs on a slow
              download can never trap the reader. */}
          <CloseButton onClick={onClose} />
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {error ? (
            <Callout tone="danger">{error}</Callout>
          ) : (
            <>
              {/* While it runs, the step and its count. A clean finish has
                  no status, and the title and the full green bar say it is
                  done; an incomplete one keeps the sentence that says what
                  the file lacks. */}
              {!done && step ? (
                <p className="text-body text-pn-muted mb-3 flex justify-between gap-3">
                  <span>{t(STEP_LABELS[step.step])}</span>
                  {step.total !== undefined && (
                    <span className="tabular-nums">{t('media:viewer.position', { index: step.done, count: step.total })}</span>
                  )}
                </p>
              ) : (!done || incomplete) && (
                <p className="text-body text-pn-muted mb-3">
                  {status || t('exportProgress.preparing')}
                </p>
              )}
              {/* A step that counts fills the bar; one that cannot count
                  shows the running state rather than a made-up percentage. */}
              <ProgressBar
                label={incomplete ? t('exportProgress.incompleteTitle') : done ? t('exportProgress.completeTitle') : t('exportProgress.exportingTitle')}
                value={done ? 1 : step?.total ? (step.done ?? 0) / step.total : undefined}
                tone={incomplete ? 'warning' : done ? 'success' : 'info'}
              />
              {!done && steps && (
                <ol className="mt-3 flex flex-wrap items-center gap-x-1.5 text-small text-pn-muted">
                  {steps.map((name, i) => {
                    const at = step ? steps.indexOf(step.step) : -1;
                    return (
                      <li key={name} className="flex items-center gap-1.5">
                        {i > 0 && <span aria-hidden="true">·</span>}
                        <span
                          className={`flex items-center gap-0.5 ${i < at ? 'text-success' : i === at ? 'text-pn font-medium' : ''}`}
                          aria-current={i === at ? 'step' : undefined}
                        >
                          {i < at && <Check size={12} aria-hidden="true" />}
                          {t(STEP_LABELS[name])}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-divider flex justify-end gap-2">
          {done || error ? (
            <>
              {savedPath && !error && detectPlatform() === 'desktop' && (
                <Button
                  icon={<FolderOpen aria-hidden="true" />}
                  onClick={() => void import('@tauri-apps/plugin-opener').then(({ revealItemInDir }) => revealItemInDir(savedPath)).catch(() => {})}
                >
                  {t('exportProgress.showInFolder')}
                </Button>
              )}
              <Button action="done" onClick={onClose} />
            </>
          ) : (
            <Button action="cancel" onClick={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}
