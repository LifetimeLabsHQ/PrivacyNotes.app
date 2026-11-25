import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Translate } from '../icons';
import { proUnlocked } from '../demo';
import { useCopyToClipboard } from '../clipboard';
import { formatBytes } from '../formatBytes';
import { FieldLabel } from '../formFields';
import { activeLocale } from '../i18n';
import { prepareRender, renderMarkdownSafe } from '../markdownRender';
import { Button, PluginSheet, ProgressBar, Select, StatusLine } from '../ui';
import { cancelJob, dropJob, startJob, useJobs } from './jobs';
import { checkKeptPlugin, downloadPlugin, setPluginOn } from './pluginManager';
import { usePluginStates, type PluginKey } from './pluginState';
import { PluginStateLine } from './PluginStateLine';
import { modelLanguageName, translateFiles } from './registry';
import { detectLanguage, languagesOnDevice, modelOfDetected, modelOfLocale, TRANSLATE_LANGUAGES, translateMarkdown, type Translation } from './translate';
import type { TranslateRequest } from './pluginDoors';

/**
 * The Translate sheet: "From" (found by eld, editable), "To" (the app
 * language, or the last one used when the note is already in it), then the
 * translation, read-only, rendered as Markdown, with Copy and "Save as new
 * note". A language that is not on this device shows its download in the
 * sheet, and one whose switch is off its "Turn on". A job stopped from
 * outside (the note went, or was locked) closes the sheet. The note is never
 * changed (D15), and the translation exists only in memory until it is
 * saved (D16).
 * Spec: docs/internal/plans/plugins.md (section 6.5)
 */

/** The last "To" language, for a note already in the app language. A language code, never note text. */
const LAST_TO_KEY = 'privacynotes.plugin.translateTo';

function lastTo(): string | null {
  try {
    return localStorage.getItem(LAST_TO_KEY);
  } catch {
    return null;
  }
}

const keyOf = (m: string): PluginKey => `translate.${m}`;

/** Ready on this device: downloaded and switched on. A language switched off in Settings is not used (beta #239 item 13). */
const isHere = (status: string) => status === 'on';

export function TranslateSheet({ request, noteId, isPro, onUpgrade, onClose }: {
  request: TranslateRequest;
  noteId: string;
  isPro: boolean | undefined;
  onUpgrade: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('notes');
  const ui = activeLocale();
  const ids = { from: useId(), to: useId() };
  const name = (m: string) => modelLanguageName(m, ui);
  const languages = useMemo(() => [...TRANSLATE_LANGUAGES].sort((a, b) => name(a).localeCompare(name(b), ui)), [ui]);
  // undefined: still reading the note; null: a language with no model.
  const [from, setFrom] = useState<string | null | undefined>(undefined);
  const [unknown, setUnknown] = useState('');
  const [to, setTo] = useState<string>('');
  // The note holds no words: only code, pictures or math.
  const [nothing, setNothing] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The jobs this sheet ended itself; any other job that leaves the store was stopped from outside.
  const ended = useRef(new Set<string>());
  const { copy, copied } = useCopyToClipboard();
  const job = useJobs().find((j) => j.id === jobId);
  const needed = [from, to].filter((m): m is string => !!m && m !== 'en');
  const states = usePluginStates(needed.map(keyOf));
  const missing = needed.filter((_, i) => !isHere(states[i]!.status));
  const unlocked = proUnlocked(isPro);

  // The gate, then the language of the note and the default "To".
  useEffect(() => {
    if (!unlocked) {
      onUpgrade();
      onClose();
      return;
    }
    let live = true;
    void Promise.all([detectLanguage(request.body), languagesOnDevice(isPro === true)]).then(
      ([code, here]) => {
        if (!live) return;
        if (code === null) {
          setNothing(true);
          setFrom(null);
          return;
        }
        const found = modelOfDetected(code);
        if (!found) setUnknown(code);
        // The app language; for a note already in it, the last one used,
        // else English, else a language already on this device.
        const app = modelOfLocale(ui) ?? 'en';
        const last = lastTo();
        const pick =
          app !== found ? app
          : last && last !== found && TRANSLATE_LANGUAGES.includes(last) ? last
          : found !== 'en' ? 'en'
          : (here[0] ?? languages.find((m) => m !== 'en')!);
        setTo(pick);
        setFrom(found);
      },
      () => live && setFrom(null),
    );
    return () => {
      live = false;
    };
    // Once per sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whether each language this pair needs is on this device.
  useEffect(() => {
    for (const m of needed) void checkKeptPlugin(keyOf(m), isPro === true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  // The translation, once the pair is here; a new pair starts again.
  const ready = !nothing && !!from && !!to && from !== to && missing.length === 0;
  useEffect(() => {
    if (!ready || !from) return;
    try {
      localStorage.setItem(LAST_TO_KEY, to);
    } catch {
      // A private window: the next sheet starts on the app language.
    }
    const id = startJob('translate', noteId, async ({ signal, progress }) => {
      const out = await translateMarkdown(request.body, from, to, signal, (done, total) => progress({ done, total }));
      // Math and code need their renderers before the preview draws them.
      await prepareRender(out.markdown).catch(() => {});
      return out;
    });
    setJobId(id);
    return () => {
      ended.current.add(id);
      cancelJob(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, from, to]);

  const done = job?.status === 'done' ? (job.result as Translation) : null;
  const result = done ? done.markdown : null;
  const html = useMemo(() => (result === null ? '' : renderMarkdownSafe(result)), [result]);

  const close = () => {
    if (jobId) {
      ended.current.add(jobId);
      cancelJob(jobId);
      dropJob(jobId);
    }
    onClose();
  };

  // A job stopped from outside (its note deleted, trashed or gated) leaves
  // the store: the sheet goes with it rather than wait for ever (beta #239 item 11).
  useEffect(() => {
    if (jobId && !job && !ended.current.has(jobId)) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job]);

  const save = async () => {
    if (result === null || !to || saving) return;
    // One save per click: a second click while the first runs would make a second note (beta #239 item 10).
    setSaving(true);
    try {
      // A note with no title of its own keeps none, so the copy's title follows its first line.
      await request.save(request.title ? t('translate.newTitle', { title: request.title, language: name(to) }) : '', result);
      close();
    } finally {
      setSaving(false);
    }
  };

  if (!unlocked) return null;
  const progress = job?.progress;
  const hasActiveFlow = from !== undefined && !nothing && from !== null && missing.length === 0 && job?.status !== 'error';
  const footer = !hasActiveFlow ? undefined : result === null ? (
    <Button action="cancel" onClick={close} />
  ) : (
    <>
      <Button action="copy" variant="secondary" onClick={() => copy(result, 'translate')}>
        {copied ? t('auth:createPhrase.copied') : undefined}
      </Button>
      <Button action="save" disabled={saving} onClick={() => void save()}>
        {t('translate.saveAsNote')}
      </Button>
    </>
  );
  return (
    <PluginSheet title={t('translate.action')} icon={<Translate />} onClose={close} maxWidth="max-w-2xl" footer={footer}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor={ids.from}>{t('translate.from')}</FieldLabel>
          <Select id={ids.from} value={from ?? ''} disabled={from === undefined || nothing} onChange={(e) => {
              const next = e.target.value || null;
              setFrom(next);
              if (next === to) setTo(next === 'en' ? languages.find((m) => m !== 'en')! : 'en');
            }}>
            {from === null && <option value="">{unknown ? modelLanguageName(unknown, ui) : ''}</option>}
            {languages.map((m) => (
              <option key={m} value={m}>
                {name(m)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel htmlFor={ids.to}>{t('translate.to')}</FieldLabel>
          <Select id={ids.to} value={to} disabled={from === undefined || nothing} onChange={(e) => setTo(e.target.value)}>
            {languages
              .filter((m) => m !== from)
              .map((m) => (
                <option key={m} value={m}>
                  {name(m)}
                </option>
              ))}
          </Select>
        </div>
      </div>

      {from === undefined ? (
        <StatusLine busy>{t('settings:plugins.loading', { name: t('settings:plugins.translate.title') })}</StatusLine>
      ) : nothing ? (
        <p className="text-body text-pn-soft">{t('translate.nothing')}</p>
      ) : from === null ? (
        <p className="text-body text-pn-soft">{t('translate.noModel')}</p>
      ) : missing.length > 0 ? (
        <div className="flex flex-col gap-2">
          {missing.map((m) => {
            const state = states[needed.indexOf(m)]!;
            return state.status === 'downloading' || state.status === 'error' || state.status === 'unavailable' ? (
              <PluginStateLine key={m} state={state} name={name(m)} />
            ) : state.status === 'kept' ? (
              <div key={m}>
                <Button variant="secondary" icon={<Translate aria-hidden="true" />} onClick={() => setPluginOn(keyOf(m), true)}>
                  {t('translate.turnOn', { language: name(m) })}
                </Button>
              </div>
            ) : (
              <div key={m}>
                <Button action="download" variant="secondary" onClick={() => void downloadPlugin(keyOf(m))}>
                  {t('translate.needPair', { language: name(m), size: formatBytes(translateFiles(m).reduce((s, f) => s + f.bytes, 0)) })}
                </Button>
              </div>
            );
          })}
        </div>
      ) : job?.status === 'error' ? (
        <StatusLine tone="danger">{t(job.error === 'worker-died' ? 'media:lowMemory' : 'translate.failed')}</StatusLine>
      ) : result === null ? (
        <ProgressBar value={progress ? progress.done / Math.max(progress.total, 1) : undefined} label={t('translate.action')} />
      ) : (
        <>
          {done!.untranslated > 0 && <StatusLine>{t('translate.untranslated', { count: done!.untranslated })}</StatusLine>}
          <div
            className="prose prose-pn max-w-none max-h-[50vh] overflow-y-auto rounded-md border border-divider p-3"
            dir="auto"
            // Rendered by markdownRender.ts, which sanitizes every link and HTML block.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </>
      )}
    </PluginSheet>
  );
}
