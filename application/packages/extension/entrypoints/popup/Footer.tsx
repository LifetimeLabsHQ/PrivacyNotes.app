/**
 * The popup's footer, on every screen, and the one place a short message
 * shows: after a copy or a save, for 4 seconds the footer row says what
 * happened (the tone's glyph in a small IconTile, a title, one muted line)
 * and a 2px line under the words runs out, the shape of the 2FA bar. Then
 * the footer's own row comes back. Hover holds the message. A second message
 * takes the place of the first and starts the 4 seconds again. A copied
 * secret's line counts down to the clipboard clear. Nothing above it moves.
 * Spec: docs/internal/design/patterns/171-180.md (pattern 177); picture mockups/browser-extension-redesign-11nov2026.html (rounds 3 and 5)
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, CloudArrowUp, WarningCircle } from '@web/icons';
import { IconTile } from '@web/ui/misc';

export interface Notice {
  /** success: done; info: waiting to send; danger: it failed. */
  tone?: 'success' | 'info' | 'danger';
  title: string;
  detail?: string;
  /** When the clipboard clears: the line under the title counts down to it. */
  clearsAt?: number;
}

interface Shown extends Notice {
  id: number;
}

// Spec: docs/internal/design/patterns/171-180.md (pattern 177, 4 seconds)
const LIFE_MS = 4000;
const OUT_MS = 180;

const NotifyContext = createContext<(notice: Notice) => void>(() => undefined);

/** Shows a message in the footer, from any view inside the popup. */
export function useNotify(): (notice: Notice) => void {
  return useContext(NotifyContext);
}

/** The popup's message state: App owns it and passes `notify` down. */
export function useNotices() {
  const [shown, setShown] = useState<Shown | null>(null);
  const next = useRef(0);
  const notify = useCallback((notice: Notice) => setShown({ ...notice, id: ++next.current }), []);
  const clear = useCallback(() => setShown(null), []);
  return { shown, notify, clear };
}

export function NotifyProvider({ notify, children }: { notify: (notice: Notice) => void; children: ReactNode }) {
  return <NotifyContext.Provider value={notify}>{children}</NotifyContext.Provider>;
}

const GLYPH = { success: CheckCircle, info: CloudArrowUp, danger: WarningCircle } as const;
const LINE = { success: 'bg-success', info: 'bg-accent', danger: 'bg-danger' } as const;

export function Footer({ notice, onGone, children }: { notice: Shown | null; onGone: () => void; children?: ReactNode }) {
  const { t } = useTranslation('extension');
  const [held, setHeld] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const left = useRef(LIFE_MS);
  const id = notice?.id;

  // A new message gets the full 4 seconds.
  useEffect(() => {
    left.current = LIFE_MS;
    setLeaving(false);
  }, [id]);

  // The clock runs while the pointer is away; hover keeps what is left.
  useEffect(() => {
    if (id === undefined || held || leaving) return;
    const started = Date.now();
    const timer = window.setTimeout(() => setLeaving(true), left.current);
    return () => {
      window.clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - started));
    };
  }, [id, held, leaving]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onGone, OUT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onGone]);

  // A copied secret's countdown.
  const clearsAt = notice?.clearsAt;
  useEffect(() => {
    if (!clearsAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [clearsAt, id]);

  const tone = notice?.tone ?? 'success';
  const Glyph = GLYPH[tone];
  const detail = clearsAt ? t('notice.clearsIn', { seconds: Math.max(0, Math.ceil((clearsAt - now) / 1000)) }) : notice?.detail;
  const showing = !!notice && !leaving;

  return (
    <footer
      className="pn-foot sticky bottom-0 z-[60] h-12 shrink-0 overflow-hidden border-t border-divider bg-surface-1"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
    >
      <div className={`pn-foot-rest absolute inset-0 flex items-center gap-2 px-3${showing ? ' is-away' : ''}`} inert={showing || undefined}>
        {children}
      </div>
      {notice && (
        <div key={notice.id} role="status" className={`pn-foot-msg absolute inset-0 flex items-center gap-2.5 px-3 pb-2${held ? ' is-held' : ''}${leaving ? ' is-out' : ''}${tone === 'danger' ? ' is-danger' : ''}`}>
          <span className="pn-foot-tile">
            <IconTile tone={tone} size="sm"><Glyph aria-hidden="true" /></IconTile>
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-small font-semibold text-pn">{notice.title}</span>
            {detail && <span className="truncate text-meta text-pn-muted tabular-nums">{detail}</span>}
          </span>
          <span aria-hidden="true" className="absolute bottom-[5px] start-[3.125rem] end-3 h-0.5 overflow-hidden rounded-full bg-divider">
            <span className={`pn-foot-line block h-full rounded-full ${LINE[tone]}`} />
          </span>
        </div>
      )}
    </footer>
  );
}
