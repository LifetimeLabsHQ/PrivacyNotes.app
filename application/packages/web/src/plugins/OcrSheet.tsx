import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Scan } from '../icons';
import { proUnlocked } from '../demo';
import { useCopyToClipboard } from '../clipboard';
import { FIELD_CLASS } from '../formFields';
import { Button, PluginSheet, StatusLine } from '../ui';
import { cancelJob, dropJob, memoryLooksLow, onJobGone, startJob, useJobs, watchJob } from './jobs';
import { checkKeptPlugin } from './pluginManager';
import { pluginFlagOn, pluginState } from './pluginState';
import { pluginEntry } from './registry';
import { ocrImage } from './ocr';
import type { OcrRequest } from './pluginDoors';

/**
 * The Text in pictures sheet: the progress with Cancel, then the text,
 * editable, with Copy and "Add text to note". The work runs as a job, so
 * closing the sheet does not stop it; a job that ends while the sheet is
 * closed says "Text is ready" (PluginSheetHost). Nothing is written into the
 * note without a tap (D15), and the text is never stored anywhere else (D16).
 * Spec: docs/internal/plans/plugins.md (sections 3.1 and 6.4)
 */

/** Apple Vision prepares its model once per app install: the first call takes 12 to 28 s. Spec: docs/internal/specs/plugins-apple.md (section 5.1) */
const WARM_KEY = 'privacynotes.plugin.ocr.warm';

function isWarm(): boolean {
  try {
    return localStorage.getItem(WARM_KEY) === '1';
  } catch {
    return true;
  }
}

/**
 * Each job's insert action and main button, so "Show" after a closed sheet
 * can still add the text. A job that leaves the store (Cancel, its note
 * gone, the lock, sign-out, or used) takes its entry with it.
 */
const jobRequests = new Map<string, Pick<OcrRequest, 'insert' | 'primary'>>();
onJobGone((id) => jobRequests.delete(id));

/** A job's result: the text, and for a PDF longer than one run reads, how far it got. */
type OcrResult = { text: string; read?: number; pages?: number };

/** The work of one request: every page's text, joined. A page with a text layer needs no OCR. */
function ocrRun(request: OcrRequest, engine: 'apple' | 'web') {
  return async ({ signal, progress }: { signal: AbortSignal; progress: (p: { done: number; total: number }) => void }): Promise<OcrResult> => {
    const bytes = await request.load();
    if (!bytes) throw new Error('read-failed');
    const result: OcrResult = { text: '' };
    if (request.source === 'picture') {
      progress({ done: 0, total: 1 });
      result.text = await ocrImage(bytes.slice().buffer, engine, signal);
    } else {
      const { readPdfForOcr } = await import('../PdfPages');
      const pages: string[] = [];
      for await (const page of readPdfForOcr(bytes.slice())) {
        signal.throwIfAborted();
        progress({ done: page.page - 1, total: page.total });
        if (page.text !== null) pages.push(page.text);
        else if (page.png) pages.push(await ocrImage(page.png, engine, signal));
        if (page.pages > page.total) Object.assign(result, { read: page.total, pages: page.pages });
      }
      result.text = pages.filter(Boolean).join('\n\n');
    }
    if (engine === 'apple') {
      try {
        localStorage.setItem(WARM_KEY, '1');
      } catch {
        // A private window: the next first call says it again.
      }
    }
    return result;
  };
}

export function OcrSheet({ request, noteId, resumeJob, isPro, onUpgrade, onOpenCard, onClose }: {
  request: OcrRequest | null;
  /** The note the request came from: its jobs stop when it goes (section 3.1). */
  noteId: string;
  /** A finished job to show again ("Show" on the snackbar). */
  resumeJob: string | null;
  isPro: boolean | undefined;
  onUpgrade: () => void;
  /** Opens Settings > Plugins on the Text in pictures card. */
  onOpenCard: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('media');
  const [jobId, setJobId] = useState<string | null>(resumeJob);
  const [text, setText] = useState<string | null>(null);
  const { copy, copied } = useCopyToClipboard();
  const engine = pluginEntry('ocr').engine();
  const firstRun = useRef(engine === 'apple' && !isWarm());
  const job = useJobs().find((j) => j.id === jobId);
  const saved = request ?? (resumeJob ? jobRequests.get(resumeJob) : undefined);
  const insert = saved?.insert;
  // Whether "Add text to note" can still place the text: its picture or
  // file, or its editor, can be gone by the time the job ends (beta #240 item 1).
  const [canAdd, setCanAdd] = useState(!!insert);
  const primary = saved?.primary ?? 'add';
  // The web engine on a device that says it has little memory: a warning first (section 3.1).
  const [go, setGo] = useState(engine === 'apple' || !memoryLooksLow());

  useEffect(() => {
    if (!request || jobId || !go) return;
    let live = true;
    void (async () => {
      if (!proUnlocked(isPro)) {
        onUpgrade();
        onClose();
        return;
      }
      if (engine === 'web') {
        if (pluginState('ocr').status !== 'on') await checkKeptPlugin('ocr', true);
        if (pluginState('ocr').status !== 'on') {
          onOpenCard();
          onClose();
          return;
        }
      } else if (!pluginFlagOn('ocr')) {
        onOpenCard();
        onClose();
        return;
      }
      if (!live) return;
      const id = startJob('ocr', noteId, ocrRun(request, engine));
      jobRequests.set(id, { insert: request.insert, primary: request.primary });
      setJobId(id);
    })();
    return () => {
      live = false;
    };
    // One job per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, go]);

  // A closed sheet leaves the job running; it says so when it ends.
  useEffect(() => {
    if (!jobId) return;
    watchJob(jobId, true);
    return () => watchJob(jobId, false);
  }, [jobId]);

  useEffect(() => {
    if (job?.status === 'done' && text === null) setText((job.result as OcrResult | undefined)?.text ?? '');
  }, [job?.status, job?.result, text]);

  // A job stopped from outside (its note deleted, trashed or gated) leaves
  // the store: the sheet goes with it rather than wait for ever (beta #240 item 4).
  useEffect(() => {
    if (jobId && !job) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job]);

  const close = () => {
    if (job && (job.status === 'done' || job.status === 'error')) dropJob(job.id);
    onClose();
  };
  const cancel = () => {
    if (jobId) cancelJob(jobId);
    onClose();
  };
  const add = () => {
    if (!insert || !canAdd) return;
    try {
      insert(text ?? '');
    } catch {
      // The place is gone (another note, a merge, the picture deleted): the
      // button goes and the line points to Copy.
      setCanAdd(false);
      return;
    }
    close();
  };

  const busy = !job || job.status === 'running' || job.status === 'waiting';
  const page = job?.progress;
  const done = job?.status === 'done' ? (job.result as OcrResult | undefined) : undefined;
  // A long PDF: the pages this run read (beta #240 item 12).
  const partLine = done?.read ? <p className="text-small text-pn-muted">{t('pdfPartRead', { read: done.read, total: done.pages })}</p> : null;
  const footer = !go ? (
    <>
      <Button action="cancel" onClick={onClose} />
      <Button action="next" onClick={() => setGo(true)} />
    </>
  ) : job?.status === 'error' ? (
    <Button action="done" onClick={close} />
  ) : busy ? (
    <Button action="cancel" onClick={cancel} />
  ) : !text ? (
    <Button action="done" onClick={close} />
  ) : (
    <>
      <Button action="copy" variant={primary === 'copy' || !canAdd ? 'primary' : 'secondary'} onClick={() => copy(text ?? '', 'ocr')}>
        {copied ? t('auth:createPhrase.copied') : undefined}
      </Button>
      {canAdd && (
        <Button action="add" variant={primary === 'copy' ? 'secondary' : 'primary'} onClick={add}>
          {t('addText')}
        </Button>
      )}
    </>
  );
  return (
    <PluginSheet title={t('settings:plugins.ocr.title')} icon={<Scan />} onClose={close} footer={footer}>
      {!go ? (
        <p className="text-body text-pn-soft">{t('lowMemoryWarn')}</p>
      ) : job?.status === 'error' ? (
        <StatusLine tone="danger">{t(job.error === 'worker-died' ? 'lowMemory' : 'readFailed')}</StatusLine>
      ) : busy ? (
        <StatusLine busy>
          {job?.status === 'waiting'
            ? t('importExport:upload.statusWaiting')
            : firstRun.current
              ? t('firstRun')
              : t('readingPage', { page: Math.min((page?.done ?? 0) + 1, page?.total ?? 1), total: page?.total ?? 1 })}
        </StatusLine>
      ) : !text ? (
        <>
          <p className="text-body text-pn-soft">{t('noText')}</p>
          {partLine}
        </>
      ) : (
        <>
          <textarea
            rows={10}
            className={`${FIELD_CLASS} resize-y`}
            value={text}
            dir="auto"
            onChange={(e) => setText(e.target.value)}
          />
          {partLine}
          {insert && !canAdd && <p className="text-small text-pn-muted">{t('addTextGone')}</p>}
        </>
      )}
    </PluginSheet>
  );
}
