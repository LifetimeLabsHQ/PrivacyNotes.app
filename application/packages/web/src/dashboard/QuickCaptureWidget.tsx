/**
 * Home Quick capture widget: append a thought or task straight into today's
 * journal, Quick Tasks, or a new note, or record a quick encrypted voice note
 * in one tap. Reuses the AudioRecorder format strategy (MP4/AAC, OGG/Opus
 * fallback) and Ninja's safe append path.
 * Spec: docs/internal/specs/dashboard.md (section 5)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton, StatusLine, TextField } from '../ui';
import { Microphone, Record } from '../icons';
import { formatDuration, recordingStamp } from '../formatDuration';
import { useDashboardEnv, type QuickCaptureMode } from './env';

/** Same 15-minute safety cap as AudioRecorder.tsx. */
const MAX_RECORDING_SECONDS = 15 * 60;

type CaptureStatus = 'idle' | 'saving' | 'recording' | 'uploading';

export function QuickCaptureWidget({ mode }: { mode: QuickCaptureMode }) {
  const { t } = useTranslation(['shell', 'notes', 'common', 'editor']);
  const env = useDashboardEnv();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; title: string } | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationRef = useRef(0);
  const discardRef = useRef(false);
  const modeRef = useRef<QuickCaptureMode>(mode);
  modeRef.current = mode;

  // Release the microphone if Home unmounts mid-recording.
  useEffect(() => () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      discardRef.current = true;
      rec.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Fade the brief saved link out after a few seconds.
  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(null), 6000);
    return () => window.clearTimeout(id);
  }, [saved]);

  const submitText = useCallback(async () => {
    const clean = text.trim();
    if (!clean || status !== 'idle') return;
    setError(null);
    setStatus('saving');
    try {
      const res = await env.quickCapture(clean, mode);
      if (res) {
        setText('');
        setSaved(res);
      } else {
        setError(t('shell:dashboard.quickCapture.failed'));
      }
    } finally {
      setStatus('idle');
    }
  }, [env, mode, status, t, text]);

  const stopRecording = useCallback((discard: boolean) => {
    discardRef.current = discard;
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    if (discard) {
      setStatus('idle');
      setDuration(0);
    }
  }, []);

  const startVoice = useCallback(async () => {
    if (status !== 'idle') return;
    setError(null);
    setSaved(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(t('shell:dashboard.quickCapture.micUnavailable'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
      const candidates = ['audio/mp4', 'audio/ogg;codecs=opus'];
      const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      recorderRef.current = recorder;
      chunksRef.current = [];
      discardRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        const actualMime = recorder.mimeType || 'audio/mp4';
        const blob = new Blob(chunksRef.current, { type: actualMime });
        recorderRef.current = null;
        if (discardRef.current || blob.size === 0) {
          setStatus('idle');
          setDuration(0);
          return;
        }
        setStatus('uploading');
        const ext = actualMime.includes('mp4') ? 'm4a' : 'ogg';
        const filename = `recording-${recordingStamp(new Date())}.${ext}`;
        const file = new File([blob], filename, { type: actualMime });
        void env.quickVoiceCapture(file, modeRef.current).then((res) => {
          if (res) setSaved(res);
          else setError(t('shell:dashboard.quickCapture.failed'));
        }).finally(() => {
          setStatus('idle');
          setDuration(0);
        });
      };

      recorder.start(1000);
      durationRef.current = 0;
      setDuration(0);
      setStatus('recording');
      timerRef.current = setInterval(() => {
        durationRef.current += 1;
        setDuration(durationRef.current);
        if (durationRef.current >= MAX_RECORDING_SECONDS) stopRecording(false);
      }, 1000);
    } catch {
      setError(t('shell:dashboard.quickCapture.micDenied'));
    }
  }, [env, status, stopRecording, t]);

  const placeholder = mode === 'task'
    ? t('shell:dashboard.quickCapture.placeholderTask')
    : mode === 'note'
      ? t('shell:dashboard.quickCapture.placeholderNote')
      : t('shell:dashboard.quickCapture.placeholderJournal');

  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-1.5">
      {status === 'recording' ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-1.5">
          <Record weight="fill" aria-hidden="true" className="shrink-0 animate-pulse text-danger" />
          <span className="min-w-0 flex-1 truncate text-compact font-medium tabular-nums text-pn">
            {t('shell:dashboard.quickCapture.recording', { duration: formatDuration(duration) })}
          </span>
          <Button action="cancel" onClick={() => stopRecording(true)} />
          <Button action="save" onClick={() => stopRecording(false)} />
        </div>
      ) : status === 'uploading' ? (
        <div className="flex items-center py-1">
          <StatusLine busy>{t('shell:dashboard.quickCapture.savingVoice')}</StatusLine>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitText();
          }}
          className="flex flex-wrap items-center gap-1.5"
        >
          <TextField
            size="sm"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            placeholder={placeholder}
            aria-label={t('shell:dashboard.w.quickCapture.name')}
            disabled={status === 'saving'}
            className="min-w-[9rem] flex-1"
          />
          <div className="ms-auto flex shrink-0 items-center gap-1.5">
            <IconButton
              label={t('shell:dashboard.quickCapture.voice')}
              tone="accent"
              disabled={status === 'saving'}
              onClick={() => void startVoice()}
            >
              <Microphone aria-hidden="true" />
            </IconButton>
            <Button
              type="submit"
              action="add"
              disabled={!text.trim() || status === 'saving'}
            />
          </div>
        </form>
      )}

      {saved && (
        <button
          type="button"
          onClick={() => env.open(saved.id)}
          className="self-start truncate text-meta font-medium text-accent hover:underline"
        >
          {t('shell:dashboard.quickCapture.savedTo', { title: saved.title })}
        </button>
      )}

      {error && <StatusLine tone="danger">{error}</StatusLine>}
    </div>
  );
}
