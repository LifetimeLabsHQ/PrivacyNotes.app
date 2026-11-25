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

import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Callout, ProgressBar, ProgressModal } from './ui';
import { Check, FolderOpen } from './icons';
import type { ReactNode } from 'react';
import type { ExportStep, ExportStepName } from './export';
import { detectPlatform } from './devices';

// The running export's step, outside React state. The HTML archive reports
// once per note, and as NotesView state every report rendered the whole app
// twice; in the Linux app such an export ended in React's "Maximum update
// depth exceeded" (#683). Only this window reads the step, so a report
// renders the window and nothing else (the syncingStore.ts pattern).
let runningStep: ExportStep | undefined;
const stepListeners = new Set<() => void>();

/** Report the running export's step; undefined before its first step. */
export function setExportStep(step: ExportStep | undefined): void {
  if (step === runningStep) return;
  runningStep = step;
  for (const listener of stepListeners) listener();
}

function subscribeStep(listener: () => void) {
  stepListeners.add(listener);
  return () => stepListeners.delete(listener);
}

const readStep = () => runningStep;

// Step names reuse labels the app already shows, already translated: the
// Files pane's filters and the Notes pillar. Only Zip is this window's own.
export const STEP_LABELS: Record<ExportStepName, string> = {
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
  /** The steps of the running export, in order. */
  steps?: readonly ExportStepName[];
  /** The step it is on. The app leaves it out, and the window reads the
   *  running export's step (`setExportStep`); the catalog fixture passes one. */
  step?: ExportStep;
  /** Closes the window. While the export runs, it cancels the export too. */
  onClose: () => void;
  /** Shown under a finished export that worked: the way to automatic backups. */
  afterDone?: ReactNode;
}

export function ExportProgressModal({ status, done, error, savedPath, steps, step: fixedStep, onClose, afterDone }: Props) {
  const { t } = useTranslation('importExport');
  const runningStepNow = useSyncExternalStore(subscribeStep, readStep);
  const step = fixedStep ?? runningStepNow;
  // The file was saved, short of something. It never reads as complete.
  const incomplete = done && !error && status !== '';
  const title = error
    ? t('exportProgress.failedTitle')
    : incomplete
      ? t('exportProgress.incompleteTitle')
      : done
        ? t('exportProgress.completeTitle')
        : t('exportProgress.exportingTitle');

  return (
    <ProgressModal
      title={title}
      onClose={onClose}
      canClose
      closeOnBackdrop={done || Boolean(error)}
      footer={
        done || error ? (
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
        )
      }
    >
      {error ? (
        <Callout tone="danger">{error}</Callout>
      ) : (
        <>
          {/* While it runs, the step and its count. A clean finish has
              no status, and the title and the full green bar say it is
              done; an incomplete one keeps the sentence that says what
              the file lacks. */}
          {!done && step ? (
            <p className="text-body text-pn-muted flex justify-between gap-3">
              <span>{t(STEP_LABELS[step.step])}</span>
              {step.total !== undefined && (
                <span className="tabular-nums">{t('media:viewer.position', { index: step.done, count: step.total })}</span>
              )}
            </p>
          ) : (!done || incomplete) && (
            <p className="text-body text-pn-muted">
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
          {!done && steps && step && (
            <ol className="flex flex-wrap items-center gap-x-1.5 text-small text-pn-muted">
              {steps.map((name, i) => {
                const at = steps.indexOf(step.step);
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
      {done && !error && afterDone}
    </ProgressModal>
  );
}
