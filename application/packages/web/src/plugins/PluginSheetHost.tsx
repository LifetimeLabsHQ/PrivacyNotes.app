import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Snackbar } from '../ui';
import { onJobReady, type Job } from './jobs';
import { closePluginSheet, usePluginRequest } from './pluginDoors';

const OcrSheet = lazy(() => import('./OcrSheet').then((m) => ({ default: m.OcrSheet })));
const TranslateSheet = lazy(() => import('./TranslateSheet').then((m) => ({ default: m.TranslateSheet })));
const VoiceSheet = lazy(() => import('./VoiceSheet').then((m) => ({ default: m.VoiceSheet })));

/** How long "Text is ready" stays before it goes; the result stays in memory until the note goes or the app locks. */
const READY_MS = 10_000;

/**
 * The host of the plugin sheets, in NotesView: it opens the sheet a note's
 * door asked for (Text in pictures, Translate notes, Voice to text; Remove noise
 * has no sheet), and says "Text is ready" with "Show" when a job ends while
 * its sheet is closed. Light: every sheet loads on first use.
 * Spec: docs/internal/plans/plugins.md (section 3.1)
 */
export function PluginSheetHost({ noteId, isPro, onUpgrade, onOpenCard }: {
  /** The note open in the editor, where every door sits. */
  noteId: string | null;
  isPro: boolean | undefined;
  /** The upgrade window, opened on the gate of the plugin asked for. */
  onUpgrade: (trigger: 'ocr' | 'translate' | 'cleanup') => void;
  /** Opens Settings > Plugins on a plugin's card. */
  onOpenCard: (setting: string) => void;
}) {
  const { t } = useTranslation('media');
  const request = usePluginRequest();
  // A finished job shown again: its id, and the plugin whose sheet shows it.
  const [resume, setResume] = useState<{ id: string; plugin: 'ocr' | 'voice' } | null>(null);
  const [ready, setReady] = useState<Job | null>(null);

  // Only a text can be shown again: a translation stops when its sheet closes.
  useEffect(() => onJobReady((job) => (job.pluginId === 'ocr' || job.pluginId === 'voice') && setReady(job)), []);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setReady(null), READY_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  // Remove noise has no sheet: the tap starts the job, or opens the upgrade
  // window or the plugin's card first. The chip shows the job.
  useEffect(() => {
    if (request?.kind !== 'cleanup') return;
    closePluginSheet();
    void import('./cleanup')
      .then((m) => m.startCleanup(request, noteId ?? '', isPro))
      .then((door) => {
        if (door === 'upgrade') onUpgrade('cleanup');
        else if (door === 'card') onOpenCard('plugins.cleanup');
      });
    // One run per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const ocrOpen = request?.kind === 'ocr' || resume?.plugin === 'ocr';
  const voiceOpen = request?.kind === 'voice' || resume?.plugin === 'voice';
  return (
    <>
      {ocrOpen && (
        <Suspense fallback={null}>
          <OcrSheet
            key={resume?.id ?? 'new'}
            request={resume || request?.kind !== 'ocr' ? null : request}
            noteId={noteId ?? ''}
            resumeJob={resume?.id ?? null}
            isPro={isPro}
            onUpgrade={() => onUpgrade('ocr')}
            onOpenCard={() => onOpenCard('plugins.ocr')}
            onClose={() => {
              setResume(null);
              closePluginSheet();
            }}
          />
        </Suspense>
      )}
      {request?.kind === 'translate' && (
        <Suspense fallback={null}>
          <TranslateSheet
            key={request.noteId}
            request={request}
            noteId={request.noteId}
            isPro={isPro}
            onUpgrade={() => onUpgrade('translate')}
            onClose={closePluginSheet}
          />
        </Suspense>
      )}
      {voiceOpen && (
        <Suspense fallback={null}>
          <VoiceSheet
            key={resume?.id ?? 'new'}
            request={resume || request?.kind !== 'voice' ? null : request}
            noteId={noteId ?? ''}
            resumeJob={resume?.id ?? null}
            isPro={isPro}
            onOpenCard={() => onOpenCard('plugins.voice')}
            onClose={() => {
              setResume(null);
              closePluginSheet();
            }}
          />
        </Suspense>
      )}
      {ready && !ocrOpen && !voiceOpen && (
        <Snackbar
          actionLabel={t('show')}
          onAction={() => {
            setResume({ id: ready.id, plugin: ready.pluginId === 'voice' ? 'voice' : 'ocr' });
            setReady(null);
          }}
        >
          {t('textReady')}
        </Snackbar>
      )}
    </>
  );
}

