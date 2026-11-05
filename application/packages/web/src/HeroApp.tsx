import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Book, Bookmarks, CalendarDots, Cake, Check, CheckCircle, CreditCard, Envelope, Eye, EyeSlash, FileAudio, FileImage, FilePdf, FileText, Folder, Key, LockSimple, Moon, Phone, Pill, Scissors, Shield, TerminalWindow, TrendUp, UserCheck } from './icons';
import { moodColor } from './moodColors';
import { formatInstant, weekdayDate, weekdayLabel } from './intlFormat';

/** The window's sidebar, in the order of the pillar grid. */
// Each tab's label is the key the app's own sidebar shows, where one exists.
const PILLARS = [
  { key: 'notes', Icon: FileText, label: 'shell:tagsRail.notes' },
  { key: 'tasks', Icon: CheckCircle, label: 'shell:tagsRail.tasks' },
  { key: 'vault', Icon: Shield, label: 'importExport:shell.tabVault' },
  { key: 'journal', Icon: Book, label: 'pillars.journalName' },
  { key: 'files', Icon: Folder, label: 'shell:tagsRail.files' },
  { key: 'calendar', Icon: CalendarDots, label: 'shell:tagsRail.calendar' },
  { key: 'contacts', Icon: UserCheck, label: 'shell:tagsRail.contacts' },
  { key: 'bookmarks', Icon: Bookmarks, label: 'pillars.bookmarksName' },
] as const;
type Pillar = (typeof PILLARS)[number]['key'];

/** The hero's rotating words that are a feature inside a pillar, not a
 *  pillar: the window opens that pillar and marks the row the word names. */
const WORD_PILLAR: Record<string, Pillar> = { sshKeys: 'vault', cards: 'vault', mood: 'journal', medication: 'journal', clipper: 'bookmarks', markdown: 'notes' };

function pillarOf(word: string): Pillar {
  return WORD_PILLAR[word] ?? (PILLARS.some((p) => p.key === word) ? (word as Pillar) : 'tasks');
}

/** A day `offset` days from today, so the calendar, the birthday and the mood
 *  week always read as this week, in the reader's language. */
function dayFrom(offset: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}

const kicker = 'font-mono text-meta font-semibold uppercase tracking-[0.18em] text-[var(--wl-sub)]';
const title = 'mt-1.5 text-heading font-extrabold leading-snug text-[var(--wl-ink)]';

/** A span of the note in Markdown source: the marks around it are muted. */
function Wrap({ mark, end, className, children }: { mark: string; end?: string; className: string; children?: ReactNode }) {
  return (
    <span className={className}>
      <span className="font-normal text-[var(--wl-muted)]">{mark}</span>
      {children}
      <span className="font-normal text-[var(--wl-muted)]">{end ?? mark}</span>
    </span>
  );
}

function NotesPanel({ word }: { word: string }) {
  const { t } = useTranslation('landing');
  const [raw, setRaw] = useState(word === 'markdown');
  useEffect(() => setRaw(word === 'markdown'), [word]);
  const mark = 'text-[var(--wl-muted)]';
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className={kicker}>{t('heroApp.notes.meta')}</div>
        <button
          type="button"
          aria-pressed={raw}
          onClick={() => setRaw((r) => !r)}
          className={`cursor-pointer rounded-md border px-1.5 py-0.5 font-mono text-meta font-bold transition ${raw ? 'border-accent bg-accent text-white' : 'border-[var(--wl-line)] text-[var(--wl-sub)] hover:border-[var(--wl-edge)]'}`}
        >
          {t('heroApp.notes.markdown')}
        </button>
      </div>
      {raw ? (
        <div dir="ltr" className="mt-3 space-y-2 font-mono text-small leading-relaxed text-[var(--wl-ink)]"> {/* rtl-ok: Markdown source is shown as typed */}
          <div className="font-bold"><span className={mark}># </span>{t('settings:appearance.noteColorsExampleTitle')}</div>
          <div className="font-bold"><span className={mark}>## </span>{t('heroApp.notes.day')}</div>
          <div className="text-[var(--wl-sub)]">
            <Trans
              i18nKey="landing:heroApp.notes.body"
              components={{
                b: <Wrap mark="**" className="font-bold text-[var(--wl-ink)]" />,
                ref: <Wrap mark="[[" end="]]" className="text-accent" />,
              }}
            />
          </div>
          <div className="text-accent">{t('heroApp.notes.tag1')} {t('heroApp.notes.tag2')}</div>
        </div>
      ) : (
        <div>
          <div className={title}>{t('settings:appearance.noteColorsExampleTitle')}</div>
          <div className="mt-3 text-compact font-bold text-[var(--wl-ink)]">{t('heroApp.notes.day')}</div>
          <p className="mt-1 text-compact leading-relaxed text-[var(--wl-sub)]">
            <Trans
              i18nKey="landing:heroApp.notes.body"
              components={{
                b: <strong className="font-semibold text-[var(--wl-ink)]" />,
                ref: <span className="rounded bg-[var(--wl-tint-blue)] px-1 font-semibold text-accent dark:text-blue-300" />,
              }}
            />
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(['tag1', 'tag2'] as const).map((k) => (
              <span key={k} className="rounded bg-[var(--wl-tint-blue)] px-1.5 py-0.5 text-meta font-semibold text-accent dark:text-blue-300">{t(`heroApp.notes.${k}`)}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const TASKS = ['taskPassport', 'taskInsurance', 'taskChargers', 'taskHotel'] as const;

function TasksPanel() {
  const { t } = useTranslation('landing');
  const [done, setDone] = useState([true, true, false, false]);
  const count = done.filter(Boolean).length;
  return (
    <div>
      <div className={kicker}>{t('heroCard.today')}</div>
      <div className={title}>{t('heroCard.tripTitle')}</div>
      <div className="mt-2 flex items-center gap-2">
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--wl-line)]">
          <span className="block h-full rounded-full bg-accent transition-[width] duration-500 ease-[cubic-bezier(.22,1,.36,1)]" style={{ width: `${(count / TASKS.length) * 100}%` }} />
        </span>
        <span className="font-mono text-meta text-[var(--wl-sub)]">{t('media:viewer.position', { index: count, count: TASKS.length })}</span>
      </div>
      <div className="mt-3 space-y-1 text-body text-[var(--wl-ink)]">
        {TASKS.map((k, i) => (
          <button
            key={k}
            type="button"
            aria-pressed={done[i]}
            onClick={() => setDone((d) => d.map((v, j) => (j === i ? !v : v)))}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 text-start transition hover:bg-[var(--wl-tint)]"
          >
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border-[1.5px] transition ${done[i] ? 'border-accent bg-accent text-white' : 'border-[var(--wl-muted)]/60'}`}>
              {done[i] && <Check size={11} weight="bold" />}
            </span>
            <span className={`transition-colors ${done[i] ? 'text-[var(--wl-sub)] line-through' : ''}`}>{t(`heroCard.${k}`)}</span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <span className="rounded-full bg-[var(--wl-tint-teal)] px-2.5 py-1 text-meta font-semibold text-[var(--wl-teal)]">{t('heroCard.flight')}</span>
        <span className="rounded-full bg-[var(--wl-tint-green)] px-2.5 py-1 text-meta font-semibold text-[var(--wl-emerald)]">{t('heroCard.encrypted')}</span>
      </div>
    </div>
  );
}

function VaultPanel({ word }: { word: string }) {
  const { t } = useTranslation('landing');
  const [shown, setShown] = useState(false);
  const focus = word === 'sshKeys' ? 'ssh' : word === 'cards' ? 'card' : 'login';
  const row = (on: boolean) => `rounded-lg border-[1.5px] px-2.5 py-2 transition-colors duration-300 ${on ? 'border-accent bg-[var(--wl-tint-blue)]' : 'border-[var(--wl-line)]'}`;
  return (
    <div>
      <div className={kicker}>{t('heroApp.vault.meta')}</div>
      <div className="mt-3 space-y-1.5">
        <div className={row(focus === 'login')}>
          <div className="flex items-center gap-2">
            <Key weight="duotone" className="shrink-0 text-accent" />
            <span className="text-compact font-bold text-[var(--wl-ink)]">{t('security:connectedAccounts.providers.github')}</span>
            <button type="button" onClick={() => setShown((s) => !s)} aria-label={t(shown ? 'auth:loginForm.hidePassword' : 'auth:loginForm.showPassword')} className="ms-auto cursor-pointer text-[var(--wl-sub)] hover:text-[var(--wl-ink)]">
              {shown ? <EyeSlash /> : <Eye />}
            </button>
          </div>
          <div dir="ltr" className="mt-0.5 truncate font-mono text-meta text-[var(--wl-sub)]">{shown ? t('heroApp.vault.password') : '•'.repeat(14)}</div> {/* rtl-ok: a password stays LTR */}
          <div className="mt-1.5 flex items-center gap-1.5 font-mono text-meta text-[var(--wl-ink)]">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 -rotate-90" aria-hidden="true">
              <circle cx="8" cy="8" r="6" fill="none" stroke="var(--wl-line)" strokeWidth="2.5" />
              <circle cx="8" cy="8" r="6" fill="none" stroke="rgb(var(--pn-accent))" strokeWidth="2.5" pathLength="1" strokeDasharray="1" className="pn-hero-totp" />
            </svg>
            <span dir="ltr" className="font-bold tracking-wider">481 920</span> {/* rtl-ok: a code stays LTR */}
          </div>
        </div>
        <div className={row(focus === 'card')}>
          <div className="flex items-center gap-2">
            <CreditCard weight="duotone" className="shrink-0 text-accent" />
            <span className="text-compact font-bold text-[var(--wl-ink)]">{t('heroApp.vault.card')}</span>
          </div>
          <div dir="ltr" className="mt-0.5 font-mono text-meta text-[var(--wl-sub)]">{'••••'} 4242 {'·'} 08/29</div> {/* rtl-ok: a card number stays LTR */}
        </div>
        <div className={row(focus === 'ssh')}>
          <div className="flex items-center gap-2">
            <TerminalWindow weight="duotone" className="shrink-0 text-accent" />
            <span className="text-compact font-bold text-[var(--wl-ink)]">{t('heroApp.vault.ssh')}</span>
          </div>
          <div dir="ltr" className="mt-0.5 truncate font-mono text-meta text-[var(--wl-sub)]">ed25519 {'·'} SHA256:9fQx2Lk</div> {/* rtl-ok: a key fingerprint stays LTR */}
        </div>
      </div>
    </div>
  );
}

function JournalPanel({ word }: { word: string }) {
  const { t } = useTranslation('landing');
  const [mood, setMood] = useState(8);
  const [taken, setTaken] = useState(true);
  const date = formatInstant(dayFrom(0), 'weekdayDate');
  const ring = (on: boolean) => `rounded-lg px-1.5 py-1 transition-shadow duration-300 ${on ? 'shadow-[0_0_0_1.5px_rgb(var(--pn-accent))]' : ''}`;
  return (
    <div>
      <div className={kicker}>{date}</div>
      <div className={ring(word === 'mood')}>
        <div className="mt-1 flex items-baseline justify-between">
          <span className="text-compact font-bold text-[var(--wl-ink)]">{t('shell:checkIn.prompt')}</span>
          <span className="font-mono text-meta font-bold" style={{ color: moodColor(mood) }}>{mood}/10</span>
        </div>
        <div className="mt-1.5 flex gap-[3px]">
          {Array.from({ length: 10 }, (_, i) => i + 1).map((v) => (
            <button
              key={v}
              type="button"
              aria-label={`${v}/10`}
              aria-pressed={v === mood}
              onClick={() => setMood(v)}
              className="h-4 flex-1 cursor-pointer rounded-[4px] transition-[transform,opacity] duration-200 hover:scale-y-125"
              style={{ background: moodColor(v), opacity: v === mood ? 1 : v < mood ? 0.45 : 0.18 }}
            />
          ))}
        </div>
      </div>
      <div className="mt-2.5 space-y-1 text-small text-[var(--wl-ink)]">
        <div className="flex items-center gap-2 px-1.5 py-0.5">
          <Moon weight="duotone" className="shrink-0 text-[var(--wl-sub)]" />
          {t('trackers:labels.sleep')}
          <span dir="ltr" className="ms-auto font-mono text-meta text-[var(--wl-sub)]">7.5 h</span> {/* rtl-ok: a duration stays LTR */}
        </div>
        <button type="button" aria-pressed={taken} onClick={() => setTaken((v) => !v)} className={`flex w-full cursor-pointer items-center gap-2 text-start ${ring(word === 'medication')}`}>
          <Pill weight="duotone" className="shrink-0 text-[var(--wl-sub)]" />
          {t('heroApp.journal.med')}
          <span className={`ms-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px] transition ${taken ? 'border-[var(--wl-emerald)] bg-[var(--wl-emerald)] text-[var(--wl-bg)]' : 'border-[var(--wl-line)]'}`}>
            {taken && <Check size={10} weight="bold" />}
          </span>
        </button>
      </div>
      <p className="mt-2.5 border-s-2 border-[var(--wl-line)] ps-2 text-small italic leading-relaxed text-[var(--wl-sub)]">{t('heroApp.journal.entry')}</p>
    </div>
  );
}

const FILES = [
  { key: 'file1', Icon: FilePdf, color: '#DC2626', size: '1.2 MB' },
  { key: 'file2', Icon: FileImage, color: '#0B604A', size: '3.4 MB' },
  { key: 'file3', Icon: FileAudio, color: '#B45309', size: '640 KB' },
  { key: 'file4', Icon: FilePdf, color: '#DC2626', size: '220 KB' },
] as const;

function FilesPanel() {
  const { t } = useTranslation('landing');
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div>
      <div className={kicker}>{t('heroApp.files.meta')}</div>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {FILES.map(({ key, Icon, color, size }, i) => (
          <button
            key={key}
            type="button"
            aria-pressed={open === i}
            onClick={() => setOpen((o) => (o === i ? null : i))}
            className={`relative cursor-pointer rounded-lg border-[1.5px] bg-[var(--wl-bg)] p-2 text-start transition ${open === i ? 'border-accent' : 'border-[var(--wl-line)] hover:border-[var(--wl-edge)]'}`}
          >
            <Icon size={20} weight="duotone" style={{ color }} />
            <LockSimple size={10} weight="fill" className="absolute end-2 top-2 text-[var(--wl-emerald)]" />
            <div className="mt-1 truncate text-meta font-semibold text-[var(--wl-ink)]">{t(`heroApp.files.${key}`)}</div>
            <div dir="ltr" className="font-mono text-meta text-[var(--wl-sub)]">{size}</div> {/* rtl-ok: a size stays LTR */}
          </button>
        ))}
      </div>
      <div className="mt-3">
        <div className="h-1 overflow-hidden rounded-full bg-[var(--wl-line)]"><span className="block h-full w-[9%] rounded-full bg-accent" /></div>
        <div className="mt-1 font-mono text-meta text-[var(--wl-sub)]">{t('heroApp.files.storage')}</div>
      </div>
    </div>
  );
}

/** Events by day offset from today: the time and the label key (the app's demo calendar words where they exist). */
const EVENTS: Record<number, readonly (readonly [string, string])[]> = {
  0: [['09:30', 'shell:calendar.seedDemo.dentist'], ['18:00', 'shell:calendar.seedDemo.yoga']],
  1: [['08:40', 'shell:calendar.seedDemo.flight']],
  3: [['', 'heroApp.calendar.ev4']],
};

function CalendarPanel() {
  const { t } = useTranslation('landing');
  const [day, setDay] = useState(0);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => dayFrom(i - 1)), []);
  const month = formatInstant(dayFrom(0), 'monthYear');
  const events = EVENTS[day] ?? [];
  return (
    <div>
      <div className={kicker}>{month}</div>
      <div className="mt-3 grid grid-cols-7 gap-0.5 text-center">
        {days.map((d, i) => {
          const off = i - 1;
          const on = off === day;
          return (
            <button key={off} type="button" aria-pressed={on} onClick={() => setDay(off)} className="cursor-pointer rounded-md py-1 transition hover:bg-[var(--wl-tint)]">
              <span className="block text-meta font-semibold text-[var(--wl-sub)]">{weekdayLabel(weekdayDate(d.getDay()), 'narrow')}</span>
              <span className={`mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-meta font-bold transition ${on ? 'bg-[var(--wl-teal)] text-[var(--wl-tint-teal)]' : off === 0 ? 'text-[var(--wl-teal)]' : 'text-[var(--wl-ink)]'}`}>{d.getDate()}</span>
              <span className={`mx-auto mt-0.5 block h-1 w-1 rounded-full ${EVENTS[off] ? 'bg-[var(--wl-teal)]' : 'bg-transparent'}`} />
            </button>
          );
        })}
      </div>
      <div key={day} className="pn-hero-in mt-3 space-y-1.5">
        {events.length ? events.map(([time, k]) => (
          <div key={k} className="flex items-center gap-2 rounded-md border-s-[3px] border-[var(--wl-teal)] bg-[var(--wl-tint-teal)] px-2 py-1.5 text-small">
            <span dir="ltr" className="font-mono text-meta text-[var(--wl-teal)]">{time || t('shell:calendar.allDay')}</span> {/* rtl-ok: a clock time stays LTR */}
            <span className="truncate font-semibold text-[var(--wl-ink)]">{t(k)}</span>
          </div>
        )) : <div className="py-1.5 text-small text-[var(--wl-sub)]">{t('heroApp.calendar.empty')}</div>}
      </div>
    </div>
  );
}

function ContactsPanel() {
  const { t } = useTranslation('landing');
  const birthday = formatInstant(dayFrom(3), 'dayMonth');
  const row = 'flex items-center gap-2 border-t border-[var(--wl-line)] py-1.5 text-small text-[var(--wl-ink)]';
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--wl-tint-teal)] text-body font-extrabold text-[var(--wl-teal)]">{t('heroApp.contacts.initials')}</span>
        <div className="min-w-0">
          <div className="truncate text-title font-extrabold text-[var(--wl-ink)]">{t('heroApp.contacts.name')}</div>
          <div className="text-meta text-[var(--wl-sub)]">{t('heroApp.contacts.place')}</div>
        </div>
      </div>
      <div className="mt-3">
        <div className={row}><Phone className="shrink-0 text-[var(--wl-sub)]" /><span dir="ltr" className="font-mono text-meta">+351 912 000 000</span></div> {/* rtl-ok: a phone number stays LTR */}
        <div className={row}><Envelope className="shrink-0 text-[var(--wl-sub)]" /><span dir="ltr" className="truncate font-mono text-meta">ana@example.com</span></div> {/* rtl-ok: an address stays LTR */}
        <div className={row}><Cake className="shrink-0 text-[var(--wl-sub)]" />{t('heroApp.contacts.birthday', { date: birthday })}</div>
      </div>
    </div>
  );
}

const MARKS = [
  { key: 'bm1', folder: 'travel', host: 'wikipedia.org', color: '#1C1917' },
  { key: 'bm2', folder: 'travel', host: 'openstreetmap.org', color: '#0B604A', clipped: false },
  { key: 'bm3', folder: 'travel', host: 'recipes.example', color: '#B45309', clipped: true },
  { key: 'bm4', folder: 'reading', host: 'markdownguide.org', color: '#1E40AF' },
  { key: 'bm5', folder: 'reading', host: 'github.com', color: '#1C1917' },
] as const;

function BookmarksPanel({ word }: { word: string }) {
  const { t } = useTranslation('landing');
  const [folder, setFolder] = useState<'travel' | 'reading'>('travel');
  return (
    <div>
      <div className="flex gap-1.5">
        {(['travel', 'reading'] as const).map((f) => (
          <button key={f} type="button" aria-pressed={folder === f} onClick={() => setFolder(f)} className={`cursor-pointer rounded-full px-2.5 py-1 text-meta font-bold transition ${folder === f ? 'bg-[var(--wl-ink)] text-[var(--wl-bg)]' : 'border border-[var(--wl-line)] text-[var(--wl-sub)] hover:text-[var(--wl-ink)]'}`}>
            {t(f === 'travel' ? 'shell:folders.seedTravel' : 'heroApp.bookmarks.reading')}
          </button>
        ))}
      </div>
      <div key={folder} className="pn-hero-in mt-3 space-y-1">
        {MARKS.filter((m) => m.folder === folder).map((m) => {
          const clipped = 'clipped' in m && m.clipped;
          return (
            <div key={m.key} className={`flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-shadow duration-300 ${clipped && word === 'clipper' ? 'shadow-[0_0_0_1.5px_rgb(var(--pn-accent))]' : ''}`}>
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-meta font-black text-white" style={{ background: m.color }}>{m.host[0]?.toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small font-semibold text-[var(--wl-ink)]">{t(`heroApp.bookmarks.${m.key}`)}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span dir="ltr" className="truncate font-mono text-meta text-[var(--wl-sub)]">{m.host}</span> {/* rtl-ok: a host name stays LTR */}
                  {clipped && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--wl-tint-amber)] px-1.5 text-meta font-bold text-[var(--wl-amber-text)]">
                      <Scissors weight="bold" />{t('heroApp.bookmarks.clipped')}
                    </span>
                  )}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The mood card's week, 1 to 10, oldest first; today is the last. */
const WEEK = [6, 7, 4, 6, 8, 8, 9];

/**
 * The card over the window's corner: a week of mood as a curve that draws
 * itself in, each day a dot in the color the app paints that score, today
 * pulsing, and the one line the Patterns view would say about it. Hovering a
 * day shows its score.
 */
function MoodWeek() {
  const { t } = useTranslation('landing');
  const [at, setAt] = useState<number | null>(null);
  const W = 224;
  const H = 62;
  const pts = WEEK.map((v, i) => [8 + (i * (W - 16)) / (WEEK.length - 1), 8 + ((10 - v) / 9) * (H - 16)] as const);
  // Catmull-Rom through the points, as cubic Beziers.
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1] ?? pts[i]!, pts[i]!, pts[i + 1]!, pts[i + 2] ?? pts[i + 1]!];
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  const area = `${d} L${pts[pts.length - 1]![0]},${H} L${pts[0]![0]},${H} Z`;
  return (
    <div onMouseLeave={() => setAt(null)}>
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-meta font-semibold uppercase tracking-[0.18em] text-[var(--wl-emerald)]">{t('heroCard.moodWeek')}</div>
        <div className="font-mono text-meta font-bold text-[var(--wl-ink)]">{at === null ? '' : `${WEEK[at]}/10`}</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 block w-full overflow-visible">
        <defs>
          <linearGradient id="pn-hero-mood-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--wl-emerald)" stopOpacity=".22" />
            <stop offset="1" stopColor="var(--wl-emerald)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#pn-hero-mood-fill)" className="pn-hero-mood-area" />
        <path d={d} fill="none" stroke="var(--wl-emerald)" strokeWidth="2" strokeLinecap="round" pathLength="1" className="pn-hero-mood-line" />
        {pts.map(([x, y], i) => (
          <g key={i} onMouseEnter={() => setAt(i)} className="cursor-default">
            <rect x={x - 14} y={0} width={28} height={H} fill="transparent" />
            {at === i && <line x1={x} x2={x} y1={y} y2={H} stroke="var(--wl-line)" strokeDasharray="2 2" />}
            {i === WEEK.length - 1 && <circle cx={x} cy={y} r="7" fill={moodColor(WEEK[i]!)} className="pn-hero-mood-pulse" />}
            <circle cx={x} cy={y} r={at === i ? 5.5 : 4.5} fill={moodColor(WEEK[i]!)} stroke="var(--wl-card)" strokeWidth="2" className="pn-hero-mood-dot" style={{ animationDelay: `${0.15 + i * 0.1}s` }} />
          </g>
        ))}
      </svg>
      <div className="mt-1 flex justify-between px-[4px] font-mono text-meta font-semibold text-[var(--wl-sub)]">
        {WEEK.map((_, i) => <span key={i} className={`w-3 text-center ${i === WEEK.length - 1 ? 'text-[var(--wl-ink)]' : ''}`}>{weekdayLabel(weekdayDate(dayFrom(i - WEEK.length + 1).getDay()), 'narrow')}</span>)}
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-[var(--wl-tint-green)] px-2 py-1.5 text-meta font-semibold text-[var(--wl-emerald)]">
        <TrendUp weight="bold" className="shrink-0" />
        <span>{t('heroApp.mood.insight')}</span>
      </div>
    </div>
  );
}

/**
 * The hero's small copy of the app. The sidebar names every pillar and each
 * one opens its own live panel: tick a task, reveal a password, pick a mood,
 * step through the week. Until the visitor picks a pillar, the window follows
 * the heading's rotating noun (`word`, a `HERO_WORDS` key), so "Your SSH
 * keys." opens the vault on the SSH key row; after a pick it stays put.
 * Spec: docs/internal/design/patterns/145-150.md section 150
 */
export function HeroApp({ word }: { word: string }) {
  const { t } = useTranslation('landing');
  const [picked, setPicked] = useState<Pillar | null>(null);
  const pillar = picked ?? pillarOf(word);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKey(e: KeyboardEvent, i: number) {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = (i + step + PILLARS.length) % PILLARS.length;
    setPicked(PILLARS[n]!.key);
    tabs.current[n]?.focus();
  }
  const panel = {
    notes: <NotesPanel word={word} />,
    tasks: <TasksPanel />,
    vault: <VaultPanel word={picked ? '' : word} />,
    journal: <JournalPanel word={picked ? '' : word} />,
    files: <FilesPanel />,
    calendar: <CalendarPanel />,
    contacts: <ContactsPanel />,
    bookmarks: <BookmarksPanel word={picked ? '' : word} />,
  }[pillar];
  return (
    <>
      <div className="absolute inset-x-0 top-0 grid h-[410px] grid-cols-[160px_minmax(0,1fr)] overflow-hidden rounded-2xl border-2 border-[var(--wl-edge)] bg-[var(--wl-card)]">
        <div role="tablist" aria-orientation="vertical" aria-label={t('heroApp.label')} className="space-y-0.5 border-e border-[var(--wl-line)] p-2">
          {PILLARS.map(({ key, Icon, label }, i) => (
            <button
              key={key}
              ref={(el) => { tabs.current[i] = el; }}
              type="button"
              role="tab"
              id={`pn-hero-tab-${key}`}
              aria-selected={key === pillar}
              aria-controls="pn-hero-panel"
              tabIndex={key === pillar ? 0 : -1}
              onClick={() => setPicked(key)}
              onKeyDown={(e) => onKey(e, i)}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-[7px] text-start text-small font-semibold transition-colors duration-200 ${key === pillar ? 'bg-[var(--wl-tint-blue)] text-accent' : 'text-[var(--wl-sub)] hover:bg-[var(--wl-tint)] hover:text-[var(--wl-ink)]'}`}
            >
              <Icon weight="duotone" className="shrink-0" />
              <span className="truncate">{t(label)}</span>
            </button>
          ))}
        </div>
        <div id="pn-hero-panel" role="tabpanel" aria-labelledby={`pn-hero-tab-${pillar}`} className="min-w-0 p-5">
          <div key={pillar} className="pn-hero-in">{panel}</div>
        </div>
      </div>
      <div aria-hidden="true" className="pn-fx-straighten absolute inset-x-0 bottom-0 mx-auto w-64 -rotate-2 rounded-2xl border-2 border-[var(--wl-edge)] bg-[var(--wl-card)] p-4">
        <MoodWeek />
      </div>
    </>
  );
}
