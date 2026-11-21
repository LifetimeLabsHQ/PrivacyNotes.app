import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Waveform } from '../icons';
import { useCopyToClipboard } from '../clipboard';
import { detectPlatform } from '../devices';
import { FIELD_CLASS, FieldLabel } from '../formFields';
import { activeLocale, SUPPORTED_LOCALES } from '../i18n';
import { Button, Modal, ProgressBar, Select, StatusLine } from '../ui';
import { audioSeconds, MAX_AUDIO_S } from './decodeAudio';
import { cancelJob, dropJob, memoryLooksLow, onJobGone, startJob, useJobs, watchJob } from './jobs';
import { checkKeptPlugin } from './pluginManager';
import { pluginFlagOn, pluginState } from './pluginState';
import { pluginEntry } from './registry';
import { timeLeft } from './timeLeft';
import { transcribe, type VoiceProgress } from './voice';
import type { VoiceRequest } from './pluginDoors';

/**
 * The Voice to text sheet: the language ("Auto" for Whisper; SpeechAnalyzer
 * needs one and starts on the app language), then the progress with the time
 * left and Cancel, then the text, editable, with Copy and "Add text to note".
 * It runs as a job: a closed sheet leaves it running, and "Text is ready"
 * comes when it ends (PluginSheetHost). Free (D25): no Pro door.
 * Spec: docs/internal/plans/plugins.md (section 6.6)
 */

/**
 * Each job's insert action, so "Show" after a closed sheet can still add the
 * text. A job that leaves the store (Cancel, its note gone, the lock,
 * sign-out, or used) takes its entry with it.
 */
const jobInserts = new Map<string, VoiceRequest['insert']>();
onJobGone((id) => jobInserts.delete(id));

/** Above this, a phone says the work takes about as long as the recording (D20). */
const LONG_ON_PHONE_S = 120;

const AUTO = 'auto';


export function VoiceSheet({ request, noteId, resumeJob, isPro, onOpenCard, onClose }: {
  request: VoiceRequest | null;
  /** The note the recording is in: its job stops when the note goes (section 3.1). */
  noteId: string;
  /** A finished job to show again ("Show" on the snackbar). */
  resumeJob: string | null;
  isPro: boolean | undefined;
  /** Opens Settings > Plugins on the Voice to text card. */
  onOpenCard: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('media');
  const ui = activeLocale();
  const id = useId();
  const engine = pluginEntry('voice').engine();
  const [language, setLanguage] = useState(engine === 'apple' ? ui : AUTO);
  const [jobId, setJobId] = useState<string | null>(resumeJob);
  const [text, setText] = useState<string | null>(null);
  const [model, setModel] = useState<number | null>(null);
  /** When the audio work began, and how far it was then: the rate excludes the model load. */
  const started = useRef<{ at: number; done: number } | null>(null);
  const { copy, copied } = useCopyToClipboard();
  const job = useJobs().find((j) => j.id === jobId);
  const insert = request?.insert ?? (resumeJob ? jobInserts.get(resumeJob) : undefined);
  // Whether "Add text to note" can still place the text: its chip, or its
  // editor, can be gone by the time the job ends (beta #240 item 1).
  const [canAdd, setCanAdd] = useState(!!insert);
  const names = useMemo(() => new Intl.DisplayNames([ui], { type: 'language' }), [ui]);

  // The plugin must be on this device (Whisper) or switched on (Apple).
  useEffect(() => {
    if (!request || resumeJob) return;
    let live = true;
    void (async () => {
      if (engine === 'web') {
        if (pluginState('voice').status !== 'on') await checkKeptPlugin('voice', isPro === true);
        if (live && pluginState('voice').status !== 'on') {
          onOpenCard();
          onClose();
        }
      } else if (!pluginFlagOn('voice')) {
        onOpenCard();
        onClose();
      }
    })();
    return () => {
      live = false;
    };
    // Once per sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!jobId) return;
    watchJob(jobId, true);
    return () => watchJob(jobId, false);
  }, [jobId]);

  useEffect(() => {
    if (job?.status === 'done' && text === null) setText(String(job.result ?? ''));
  }, [job?.status, job?.result, text]);

  const start = () => {
    if (!request) return;
    const lang = language === AUTO ? null : language;
    started.current = null;
    const next = startJob('voice', noteId, async ({ signal, progress }) => {
      const bytes = await request.load();
      if (!bytes) throw new Error('failed');
      // Over an hour is refused before the decode, on every engine (beta #240 item 13).
      if ((await audioSeconds(bytes, request.mimetype)) > MAX_AUDIO_S) throw new Error('audio-too-long');
      signal.throwIfAborted();
      return transcribe(bytes.slice().buffer, lang, engine, signal, (p: VoiceProgress) => {
        if (p.kind === 'apple-model') {
          setModel(p.fraction);
          return;
        }
        setModel(null);
        if (started.current === null) started.current = { at: performance.now(), done: p.done };
        progress({ done: p.done, total: p.total });
      });
    });
    jobInserts.set(next, request.insert);
    setJobId(next);
  };

  // A job stopped from outside (its note deleted, trashed or gated) leaves
  // the store: the sheet goes with it (beta #240 item 4).
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
      // The place is gone (another note, a merge, the chip deleted): the
      // button goes and the line points to Copy.
      setCanAdd(false);
      return;
    }
    close();
  };

  const p = job?.progress;
  const seconds = p ? p.total / 16_000 : 0;
  const phone = detectPlatform() === 'ios' || detectPlatform() === 'android' || /Android|iPhone|iPad/.test(navigator.userAgent);
  const s0 = started.current;
  const left = p && s0 && p.done > s0.done ? (((performance.now() - s0.at) / (p.done - s0.done)) * (p.total - p.done)) / 1000 : null;
  const failure = {
    'audio-format': 'audioFormat',
    'audio-too-long': 'audioTooLong',
    'apple-no-language': 'appleNoLanguage',
    'apple-too-many': 'appleTooMany',
    'worker-died': 'lowMemory',
  }[job?.error ?? ''] ?? 'transcribeFailed';

  return (
    <Modal title={t('transcribe')} icon={<Waveform />} onClose={close} layer="z-[60]" className="max-w-lg w-full p-6 space-y-4">
      {!job ? (
        <>
          <div>
            <FieldLabel htmlFor={id}>{t('notes:settings.languageLabel')}</FieldLabel>
            <Select id={id} value={language} onChange={(e) => setLanguage(e.target.value)}>
              {engine === 'web' && <option value={AUTO}>{t('settings:appearance.modeAuto')}</option>}
              {[...SUPPORTED_LOCALES]
                .map((l) => [l, names.of(l) ?? l] as const)
                .sort((a, b) => a[1].localeCompare(b[1], ui))
                .map(([l, name]) => (
                  <option key={l} value={l}>
                    {name}
                  </option>
                ))}
            </Select>
          </div>
          {engine === 'web' && memoryLooksLow() && <p className="text-small text-pn-muted">{t('lowMemoryWarn')}</p>}
          <div className="flex justify-end">
            <Button action="next" onClick={start} disabled={!request}>
              {t('transcribe')}
            </Button>
          </div>
        </>
      ) : job.status === 'error' ? (
        <>
          <StatusLine tone="danger">{t(failure)}</StatusLine>
          <div className="flex justify-end">
            <Button action="done" onClick={close} />
          </div>
        </>
      ) : job.status === 'waiting' || job.status === 'running' ? (
        <>
          {model !== null ? (
            <>
              <StatusLine busy>{t('appleLanguage')}</StatusLine>
              <ProgressBar value={model} label={t('appleLanguage')} />
            </>
          ) : (
            <>
              <ProgressBar value={job.status === 'waiting' || !p ? undefined : p.done / Math.max(p.total, 1)} label={t('transcribe')} />
              <StatusLine busy>
                {job.status === 'waiting' ? t('importExport:upload.statusWaiting') : left !== null ? t('timeLeft', { time: timeLeft(left, ui) }) : t('transcribe')}
              </StatusLine>
              {phone && seconds > LONG_ON_PHONE_S && <p className="text-small text-pn-muted">{t('longAudio')}</p>}
            </>
          )}
          <div className="flex justify-end">
            <Button action="cancel" onClick={cancel} />
          </div>
        </>
      ) : !text ? (
        <>
          <p className="text-body text-pn-soft">{t('transcribeFailed')}</p>
          <div className="flex justify-end">
            <Button action="done" onClick={close} />
          </div>
        </>
      ) : (
        <>
          <textarea rows={10} className={`${FIELD_CLASS} resize-y`} value={text} dir="auto" onChange={(e) => setText(e.target.value)} />
          {insert && !canAdd && <p className="text-small text-pn-muted">{t('addTextGone')}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button action="copy" variant={canAdd ? 'secondary' : 'primary'} onClick={() => copy(text, 'voice')}>
              {copied ? t('auth:createPhrase.copied') : undefined}
            </Button>
            {canAdd && (
              <Button action="add" onClick={add}>
                {t('addText')}
              </Button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
