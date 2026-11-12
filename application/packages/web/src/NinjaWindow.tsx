import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NinjaIcon } from './NinjaIcon';
import { morph, pathOf } from './ninjaMorph';
import { NINJA_KEYS, type NinjaFrame, type NinjaInput, type NinjaKey, type NinjaNote, type NinjaNoteResult, type NinjaPointer, isNinjaDragHandle } from './ninjaHost';
import { QuickNoteView, type QuickNoteDraft } from './QuickNoteView';
import type { QuickNoteAnswer } from './quickNoteQueue';
import { APP_KEYS, matchesKey } from './shortcutMatch';
import { isImeComposing } from './imeComposing';
import { Button } from './ui';

/**
 * The Ninja box (GitHub #694): the page of the small `ninja` window that the
 * global key shows above any app (ninja.rs). main.tsx routes here on
 * ?ninja-window=1, with no sign-in and no data. It draws the Ninja that the
 * main window runs hidden (ninjaHost.ts): each frame patches its copy of the
 * dialog, and its own field stays in place, so the caret and the typing are
 * never interrupted. What the person does goes back: the value, the keys
 * Ninja reads, a click or a pointer move on a node named by its path.
 * Its note mode (QuickNoteView) is its own view, not the mirror's: Mod+N or
 * the row "Write a note" opens it, and a locked app that can keep a note
 * opens it at once. Only the finished note goes to the main window.
 * Spec: docs/internal/plans/ninja-anywhere-694.md (section 3); docs/internal/plans/quick-note-694.md (section 5)
 */

async function send(event: string, payload?: unknown): Promise<void> {
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo('main', event, payload);
}

async function dismiss(reveal: boolean): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('ninja_dismiss', { reveal });
}

/** The notes sent and not yet answered, by their number. */
const waiting = new Map<number, (status: QuickNoteAnswer) => void>();
let noteSeq = 0;
/** With no answer in this time the main window is not there to save it. */
const ANSWER_MS = 10_000;

function sendNote(draft: QuickNoteDraft): Promise<QuickNoteAnswer> {
  const seq = ++noteSeq;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      waiting.delete(seq);
      resolve('failed');
    }, ANSWER_MS);
    waiting.set(seq, (status) => {
      window.clearTimeout(timer);
      waiting.delete(seq);
      resolve(status);
    });
    void send('pn-ninja-note', { seq, ...draft } satisfies NinjaNote);
  });
}

const EMPTY_DRAFT: QuickNoteDraft = { title: '', markdown: '' };

export default function NinjaWindow() {
  const { t } = useTranslation(['common', 'settings']);
  const host = useRef<HTMLDivElement>(null);
  const [locked, setLocked] = useState(false);
  // Locked, and the main window can seal a note for the next unlock.
  const [queue, setQueue] = useState(false);
  const [noteMode, setNoteMode] = useState(false);
  // The draft lives as long as the app: the window is hidden, never closed.
  const [draft, setDraft] = useState<QuickNoteDraft>(EMPTY_DRAFT);
  // A new view each time note mode opens, so the caret goes where it should.
  const [noteKey, setNoteKey] = useState(0);
  const fieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset.ninjaWindow = '';
    const root = host.current!;
    // The box's own field: made once, put where the main window's field is.
    const input = document.createElement('input');
    fieldRef.current = input;
    let seq = 0;
    // The text typed, without the "+" of a quick add, is the title line.
    const openNote = (title: string) => {
      const line = title.replace(/^\+\s*/, '');
      setDraft((d) => (line.trim() ? { ...d, title: line } : d));
      setNoteKey((k) => k + 1);
      setNoteMode(true);
    };
    let shown = '';

    const caret = () => ({ start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 });
    input.addEventListener('input', () => {
      seq += 1;
      void send('pn-ninja-input', { value: input.value, ...caret(), seq } satisfies NinjaInput);
    });
    input.addEventListener('keydown', (e) => {
      if (isImeComposing(e)) return;
      if (matchesKey(e, APP_KEYS.quickSwitcher, true)) {
        e.preventDefault();
        void dismiss(false);
        return;
      }
      if (matchesKey(e, APP_KEYS.newNote, true)) {
        e.preventDefault();
        openNote(input.value);
        return;
      }
      if (!NINJA_KEYS.has(e.key)) return;
      if (e.key === 'Backspace' && input.value) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') e.preventDefault();
      const { key, code, shiftKey, altKey, ctrlKey, metaKey } = e;
      void send('pn-ninja-key', { key, code, shiftKey, altKey, ctrlKey, metaKey, ...caret() } satisfies NinjaKey);
    });

    const apply = (frame: NinjaFrame) => {
      if (frame.locked || !frame.html) {
        root.replaceChildren();
        setLocked(true);
        setQueue(!!frame.queue);
        return;
      }
      setLocked(false);
      setQueue(false);
      const template = document.createElement('template');
      template.innerHTML = frame.html;
      const next = template.content.firstElementChild;
      if (!next) return;
      const current = root.firstElementChild;
      if (!current || current.tagName !== next.tagName) {
        root.replaceChildren(next);
        // The box's field takes the look of the field it stands in for, or the
        // first frame shows a bare input with the system focus ring.
        const mirrored = next.querySelector('input');
        if (mirrored) {
          for (const { name, value } of [...mirrored.attributes]) if (name !== 'value') input.setAttribute(name, value);
          mirrored.replaceWith(input);
        }
        input.focus();
      } else {
        morph(current, next, (el) => el === input);
      }
      // The value and caret come back only when the main window has seen the last typing.
      if (frame.ack === seq && frame.value !== undefined && input.value !== frame.value) {
        input.value = frame.value;
        input.setSelectionRange(frame.start ?? frame.value.length, frame.end ?? frame.value.length);
      }
      const active = input.getAttribute('aria-activedescendant') ?? '';
      if (active !== shown) {
        shown = active;
        if (active) document.getElementById(active)?.scrollIntoView({ block: 'nearest' });
      }
    };

    // Pointer: the main window's Ninja reacts to the same node. Links and
    // buttons do nothing here; the field keeps the focus.
    const dialog = () => root.firstElementChild;
    const pointer = (kind: NinjaPointer['kind'], e: MouseEvent) => {
      const from = dialog();
      const path = from && e.target instanceof Element ? pathOf(from, e.target) : null;
      if (!path) return;
      void send('pn-ninja-pointer', { kind, path, x: e.clientX, y: e.clientY, altKey: e.altKey, shiftKey: e.shiftKey } satisfies NinjaPointer);
    };
    // The box has no frame: a press on anything that is not a control moves
    // it. The next show places it again, so the place is never kept.
    const onDown = (e: MouseEvent) => {
      if (e.target === input) return;
      e.preventDefault();
      if (e.button === 0 && isNinjaDragHandle(e.target)) {
        void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().startDragging());
      }
    };
    const onClick = (e: MouseEvent) => {
      if (e.target === input) return;
      e.preventDefault();
      pointer('click', e);
    };
    let moving = false;
    const onMove = (e: MouseEvent) => {
      if (moving) return;
      moving = true;
      requestAnimationFrame(() => {
        moving = false;
        pointer('move', e);
      });
    };
    root.addEventListener('mousedown', onDown);
    root.addEventListener('click', onClick);
    root.addEventListener('mousemove', onMove);

    // Each show is a new Ninja: the next frame builds the box again, and the mark plays.
    const fresh = () => {
      setNoteMode(false);
      root.replaceChildren();
      input.value = '';
      seq = 0;
      shown = '';
      void send('pn-ninja-sync');
    };
    const onFocus = () => input.focus();
    window.addEventListener('focus', onFocus);

    let stop = () => {};
    void import('@tauri-apps/api/event').then(({ listen }) =>
      Promise.all([
        listen<NinjaFrame>('pn-ninja-frame', (e) => apply(e.payload)),
        listen('pn-ninja-shown', fresh),
        // Cleared as it hides, so the next show never flashes the last box before the new one.
        listen('pn-ninja-hidden', () => {
          root.replaceChildren();
          input.value = '';
        }),
        listen<{ title: string }>('pn-ninja-note-mode', (e) => openNote(typeof e.payload?.title === 'string' ? e.payload.title : '')),
        listen<NinjaNoteResult>('pn-ninja-note-result', (e) => waiting.get(e.payload.seq)?.(e.payload.status)),
      ]).then((offs) => {
        stop = () => offs.forEach((off) => off());
        void send('pn-ninja-sync');
      }),
    );
    return () => {
      stop();
      window.removeEventListener('focus', onFocus);
      root.removeEventListener('mousedown', onDown);
      root.removeEventListener('click', onClick);
      root.removeEventListener('mousemove', onMove);
    };
  }, []);

  // Locked, signed out, or starting: Enter opens the main window, where the PIN is typed.
  useEffect(() => {
    if (!locked || queue) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') void dismiss(true);
      else if (e.key === 'Escape' || matchesKey(e, APP_KEYS.quickSwitcher, true)) void dismiss(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, queue]);

  const writing = noteMode || (locked && queue);
  const backToSearch = () => {
    if (locked) return void dismiss(false);
    setNoteMode(false);
    requestAnimationFrame(() => fieldRef.current?.focus());
  };

  return (
    <>
      <div ref={host} hidden={locked || writing} className="h-full" />
      {writing && (
        <QuickNoteView
          key={noteKey}
          draft={draft}
          onDraft={setDraft}
          locked={locked}
          onSave={sendNote}
          onBack={backToSearch}
          onSaved={() => {
            setDraft(EMPTY_DRAFT);
            setNoteMode(false);
            void dismiss(false);
          }}
          onOpenApp={() => void dismiss(true)}
        />
      )}
      {locked && !writing && (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
          <NinjaIcon size={40} tone="real" />
          <h1 className="mt-2 text-heading font-semibold text-pn">{t('common:quickSwitcher.ninjaLockedTitle')}</h1>
          <p className="max-w-sm text-compact text-pn-muted">{t('common:quickSwitcher.ninjaLockedBody')}</p>
          <Button action="open" variant="primary" autoFocus onClick={() => void dismiss(true)} className="mt-3">
            {t('settings:appearance.trayOpen')}
          </Button>
        </div>
      )}
    </>
  );
}
