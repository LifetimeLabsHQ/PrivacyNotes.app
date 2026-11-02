import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CheckCircle } from './icons';

/** The loop the tile plays by itself: [view, second task ticked, ms]. */
const SCRIPT = [
  ['preview', false, 2200],
  ['preview', true, 1700],
  ['source', true, 2600],
  ['source', false, 1500],
] as const;

/**
 * The Markdown slab's window, live: one file seen two ways. In Preview the
 * tasks tick; in Markdown the same file shows as the text on disk, so a tick
 * turns `- [ ]` into `- [x]` on the line it belongs to, and the footer saves.
 * Until the visitor touches it the window plays that loop by itself (paused
 * off screen, still under reduced motion); the first click hands it over.
 * Spec: docs/internal/design/patterns/151-160.md section 151
 */
export function MarkdownDemo() {
  const { t } = useTranslation('landing');
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [done, setDone] = useState([true, false]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const manual = useRef(false);
  const doneRef = useRef(done);
  doneRef.current = done;

  function save(line: number) {
    setSaving(true);
    setFlash(line);
    window.setTimeout(() => setSaving(false), 700);
    window.setTimeout(() => setFlash(null), 1200);
  }
  function toggle(i: number, by: 'user' | 'script') {
    if (by === 'user') manual.current = true;
    setDone((d) => d.map((v, j) => (j === i ? !v : v)));
    save(i + 1);
  }

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer = 0;
    let step = 0;
    const run = () => {
      if (manual.current) return;
      const [v, second, ms] = SCRIPT[step % SCRIPT.length]!;
      setView(v);
      if (doneRef.current[1] !== second) save(2);
      setDone([true, second]);
      step++;
      timer = window.setTimeout(run, ms);
    };
    const io = new IntersectionObserver(([e]) => {
      window.clearTimeout(timer);
      if (e?.isIntersecting) timer = window.setTimeout(run, 900);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  const tasks = [t('mdEditor.sampleTask1'), t('mdEditor.sampleTask2')];
  const lines = [
    <><span className="text-[var(--wl-muted)]"># </span><span className="font-bold">{t('mdEditor.sampleTitle')}</span></>,
    ...tasks.map((task, i) => <><span className="text-[var(--wl-muted)]">- [</span><span className={done[i] ? 'font-bold text-[var(--wl-emerald)]' : ''}>{done[i] ? 'x' : ' '}</span><span className="text-[var(--wl-muted)]">] </span>{task}</>),
    <span className="text-accent">{t('mdEditor.sampleTag')}</span>,
  ];
  const tab = (v: 'preview' | 'source') =>
    `cursor-pointer rounded-md px-2 py-0.5 text-meta font-bold transition ${view === v ? 'bg-[var(--wl-ink)] text-[var(--wl-bg)]' : 'text-[var(--wl-sub)] hover:text-[var(--wl-ink)]'}`;
  return (
    <div ref={root} className="overflow-hidden rounded-xl border-2 border-[var(--wl-edge)] bg-[var(--wl-card)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--wl-line)] px-3.5 py-2">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-red-400" />
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
        <span dir="ltr" className="ms-2 hidden min-w-0 truncate font-mono text-meta text-[var(--wl-muted)] min-[360px]:inline">~/notes/ideas.md</span> {/* rtl-ok: file path stays LTR */}
        <span className="ms-auto flex shrink-0 gap-0.5 rounded-lg bg-[var(--wl-tint)] p-0.5">
          {(['preview', 'source'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => { manual.current = true; setView(v); }} className={tab(v)}>
              {t(v === 'preview' ? 'importExport:preview.previewLabel' : 'shell:markdown.modeSource')}
            </button>
          ))}
        </span>
      </div>
      <div className="h-[132px] px-4 py-3.5">
        {view === 'preview' ? (
          <div key="p" className="pn-hero-in">
            <div className="text-title font-extrabold tracking-tight text-[var(--wl-ink)]">{t('mdEditor.sampleTitle')}</div>
            <div className="mt-2 space-y-1 text-body text-[var(--wl-sub)]">
              {tasks.map((task, i) => (
                <button key={i} type="button" aria-pressed={done[i]} onClick={() => toggle(i, 'user')} className="flex cursor-pointer items-center gap-1.5 text-start">
                  <span className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[3px] border-[1.5px] transition ${done[i] ? 'border-[var(--wl-emerald)] bg-[var(--wl-emerald)] text-[var(--wl-card)]' : 'border-[var(--wl-muted)]'}`}>
                    {done[i] && <Check size={10} weight="bold" />}
                  </span>
                  <span className={`transition-colors ${done[i] ? 'line-through decoration-[var(--wl-muted)]' : 'text-[var(--wl-ink)]'}`}>{task}</span>
                </button>
              ))}
            </div>
            <span className="mt-2.5 inline-block rounded bg-[var(--wl-tint-blue)] px-1.5 py-0.5 text-meta font-semibold text-accent dark:text-blue-300">
              {t('mdEditor.sampleTag')}
            </span>
          </div>
        ) : (
          <div key="s" dir="ltr" className="pn-hero-in font-mono text-small leading-[1.9] text-[var(--wl-ink)]"> {/* rtl-ok: Markdown source is shown as typed */}
            {lines.map((line, i) => (
              <div key={i} className={`-mx-1.5 flex gap-2.5 rounded px-1.5 transition-colors duration-500 ${flash === i ? 'bg-[var(--wl-tint-amber)]' : ''}`}>
                <span className="w-3 shrink-0 select-none text-end text-[var(--wl-muted)]">{i + 1}</span>
                <span className="min-w-0 truncate">{line}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-[var(--wl-line)] px-3.5 py-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-meta uppercase tracking-[0.08em] text-[var(--wl-muted)]">
          {saving ? (
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          ) : (
            <CheckCircle weight="fill" className="text-[var(--wl-emerald)]" />
          )}
          {t(saving ? 'mdEditor.saving' : 'shell:markdown.savedToDisk')}
        </span>
        <span className="rounded-full bg-amber-500 px-2 py-0.5 text-meta font-extrabold uppercase tracking-[0.08em] text-[var(--wl-slab)]">{t('shell:markdown.bannerFree')}</span>
      </div>
    </div>
  );
}
