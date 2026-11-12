/**
 * The place on a note, in the editor's tag row: a chip after the folder chip,
 * and the popover it opens to set, change, open or remove the place.
 *
 * The chip shows only when the note has a place, or while the popover is open
 * from the note menu's "Add location" (it is the popover's anchor then). The
 * place is written through `onPatch`, the trackers patch that merges against
 * the stored row and refuses a read-only note; a read-only note's popover
 * shows the place with no edit actions.
 *
 * Nothing here calls a server. "Use my current location" asks the phone's own
 * location service, and only when tapped (currentPosition.ts).
 * Spec: docs/internal/plans/note-location.md (section 4)
 */
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowsInSimple, ArrowsOutSimple, Crosshair, MapPin, PencilSimple, ShieldCheck } from '../icons';
import { Button, Callout, CopyButton, DeleteButton, FeedbackButton, IconButton, Modal, Popover, RowChip, SETTINGS_HELP, StatusLine, TextField } from '../ui';
import { lazyPart } from '../chunkLoad';
import { useTheme } from '../theme';
import { activeLocale } from '../i18n';
import { openExternal } from '../openExternal';
import {
  formatCoordinates,
  LOCATION_KEY,
  MAP_HEIGHT_DEFAULT,
  makeLocation,
  mapSource,
  osmUrl,
  parseLocationInput,
  readLocation,
  type LocationParse,
  type NoteLocation,
} from '../noteLocation';
import { canReadPosition, readCurrentPosition, type PositionResult } from '../currentPosition';
import { turnAutoLocation, useAutoLocation, type AutoLocationType } from '../autoLocation';
import { Switch } from '../Switch';
import { ROW_TITLE } from '../settingsUI';
import { loadPlaces, searchPlaces, type PlaceHit, type PlaceRow } from '../placeSearch';

// MapLibre and the map style load with the first map, never on the boot path.
const NoteLocationMapLazy = lazyPart(() => import('./NoteLocationMap').then((m) => m.default));

type ParseError = Extract<LocationParse, { ok: false }>['error'];
type FixError = Extract<PositionResult, { ok: false }>['error'];

const PARSE_ERROR: Record<ParseError, string> = {
  unreadable: 'location.errorUnreadable',
  shortLink: 'location.errorShortLink',
  range: 'location.errorRange',
};
const FIX_ERROR: Record<FixError, string> = {
  denied: 'location.errorDenied',
  off: 'location.errorOff',
  timeout: 'location.errorTimeout',
};

export function NoteLocationChip({ trackers, readOnly, open, onOpenChange, onPatch, autoType }: {
  trackers: Record<string, unknown> | undefined;
  /** The item's type when it can get a place on its own: the form shows its switch. */
  autoType?: AutoLocationType;
  readOnly: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Writes `{ location }`, or removes the key with `undefined`. Resolves false when nothing was written. */
  onPatch: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation('notes');
  const place = readLocation(trackers);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  // The place opens the way it was last shown on this device: the popup, or
  // the large map (owner, 2026-11-11). Edit from the large map drops back to
  // the popup's form for that one opening.
  const [expanded, setExpanded] = useState(readExpandedPref);
  const [editNow, setEditNow] = useState(false);
  useEffect(() => { if (!open) setEditNow(false); }, [open]);
  if (!place && !open) return null;
  const text = place ? (place.label ?? formatCoordinates(place, 2)) : t('location.title');
  const sheet = open && expanded && !!place && !editNow;
  const expand = (on: boolean) => { setExpanded(on); writeExpandedPref(on); };
  const panel = (layout: 'popup' | 'sheet') => (
    <LocationPanel
      // A fresh panel for each opening, so a draft never outlives it.
      key={`${open ? 'open' : 'closed'}-${editNow ? 'edit' : 'view'}`}
      place={place}
      readOnly={readOnly}
      layout={layout}
      startEditing={editNow}
      onExpand={() => expand(true)}
      onCollapse={() => expand(false)}
      {...(layout === 'sheet' ? { onEdit: () => setEditNow(true) } : {})}
      // Back to the view this device uses: the popup's map, or the large one.
      onSaved={() => setEditNow(false)}
      {...(autoType ? { autoType } : {})}
      onDone={() => onOpenChange(false)}
      onSave={(loc) => onPatch({ [LOCATION_KEY]: loc })}
      onRemove={() => onPatch({ [LOCATION_KEY]: undefined })}
    />
  );
  return (
    <>
      {/* Dashed while it has no place yet: the popover opened from the note
          menu needs the chip as its anchor. */}
      <RowChip
        ref={anchorRef}
        icon={<MapPin className="shrink-0" aria-hidden="true" />}
        empty={!place}
        onClick={() => onOpenChange(!open)}
        label={place ? t('location.chipLabel', { place: text }) : t('location.title')}
        expanded={open}
      >
        {text}
      </RowChip>
      <Popover open={open && !sheet} anchorRef={anchorRef} onClose={() => onOpenChange(false)} title={place?.label ?? t('location.title')} className="w-80">
        {panel('popup')}
      </Popover>
      {/* The large map: most of the window on a computer, the whole screen on
          a phone. In a portal, because the tag row's blur would make it the
          box a fixed window is placed in. */}
      {sheet && createPortal(
        <Modal
          title={place.label ?? t('location.title')}
          header="bar"
          onClose={() => onOpenChange(false)}
          className="flex h-[min(85vh,52rem)] max-w-5xl flex-col overflow-hidden max-sm:fixed max-sm:inset-0 max-sm:h-auto max-sm:max-w-none max-sm:rounded-none max-sm:border-0"
        >
          {panel('sheet')}
        </Modal>,
        document.body,
      )}
    </>
  );
}

/** Whether a place opens on the large map on this device (the last choice made here). */
const EXPANDED_PREF_KEY = 'privacynotes.location.expanded';
function readExpandedPref(): boolean {
  try { return localStorage.getItem(EXPANDED_PREF_KEY) === '1'; } catch { return false; }
}
function writeExpandedPref(on: boolean): void {
  try { localStorage.setItem(EXPANDED_PREF_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

/**
 * The place window's content: the place with its actions, or the form that
 * sets it. The chip saves into the note's trackers; Insert > Location saves a
 * map into the body (`onSave`). One form for both, so a town, a paste and the
 * phone's position work the same way in each.
 */
export function LocationPanel({ place, readOnly, onDone, onSave, onRemove, startEditing = false, saveText, layout = 'popup', onExpand, onCollapse, onEdit, onSaved, autoType }: {
  place: NoteLocation | undefined;
  readOnly: boolean;
  onDone: () => void;
  /** Resolves false when nothing was written. */
  onSave: (loc: NoteLocation) => Promise<boolean>;
  /** The chip's Remove; Insert > Location has none. */
  onRemove?: () => Promise<boolean>;
  /** Open on the form even with a place, prefilled (Insert > Location). */
  startEditing?: boolean;
  /** The submit label when it is not Save. */
  saveText?: string;
  /** The popup, or the large map in a window (the chip only). */
  layout?: 'popup' | 'sheet';
  /** The popup's expand button: opens the large map. */
  onExpand?: () => void;
  /** The large map's collapse button: back to the popup. */
  onCollapse?: () => void;
  /** Edit from the large map: the chip opens the popup's form instead. */
  onEdit?: () => void;
  /** After a save the window shows the place instead of closing (the chip). */
  onSaved?: () => void;
  /** The item's type when it can get a place on its own (the chip, on a phone). */
  autoType?: AutoLocationType;
}) {
  const { t } = useTranslation('notes');
  const [editing, setEditing] = useState((!place || startEditing) && !readOnly);
  const [input, setInput] = useState(place ? (place.label ?? formatCoordinates(place)) : '');
  const [name, setName] = useState(place?.label ?? '');
  // A town picked from the list, or the place the window opened with: its
  // coordinates stand until the field changes.
  const [picked, setPicked] = useState<{ lat: number; lng: number } | null>(place ? { lat: place.lat, lng: place.lng } : null);
  const [shown, setShown] = useState(false);
  const [fix, setFix] = useState<{ busy: boolean; error?: FixError }>({ busy: false });
  const [saveFailed, setSaveFailed] = useState(false);
  const [towns, setTowns] = useState<PlaceRow[] | 'loading' | 'failed'>('loading');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  // The place list starts loading as the form opens, so it is usually there
  // before the first letter.
  useEffect(() => {
    if (!editing) return;
    let live = true;
    loadPlaces(activeLocale()).then((rows) => { if (live) setTowns(rows); }, () => { if (live) setTowns('failed'); });
    return () => { live = false; };
  }, [editing]);

  const parsed = input.trim() && !picked ? parseLocationInput(input) : null;
  const typed = parsed && !parsed.ok && parsed.error === 'unreadable';
  const hits = typed && Array.isArray(towns) ? searchPlaces(towns, input) : [];
  const waiting = typed && towns === 'loading' && [...input.trim()].length >= 2;
  // An error waits for a pause in the typing (a blur or a save), but a good
  // reading shows at once, so the person sees the paste was understood.
  const error = parsed && !parsed.ok && shown && hits.length === 0 && !waiting ? t(PARSE_ERROR[parsed.error]) : undefined;
  const at = picked ?? (parsed?.ok ? parsed : null);
  const hint = at ? formatCoordinates(at) : undefined;
  const country = (cc: string) => {
    try { return new Intl.DisplayNames([activeLocale()], { type: 'region' }).of(cc) ?? cc; } catch { return cc; }
  };

  function pick(hit: PlaceHit) {
    setPicked({ lat: hit.lat, lng: hit.lng });
    setInput(hit.name);
    if (!name.trim()) setName(hit.name);
    setShown(false);
  }

  async function save() {
    setShown(true);
    if (!at) {
      if (hits[0]) pick(hits[0]);
      else if (!parsed) setInput('');
      return;
    }
    const next = makeLocation(at.lat, at.lng, name);
    const ok = next ? await onSave(next) : false;
    if (!ok) setSaveFailed(true);
    // The chip's window turns into the map of the place just saved (owner,
    // 2026-11-11); Insert > Location closes, its map is in the text.
    else if (onSaved) { setEditing(false); onSaved(); }
    else onDone();
  }

  async function remove() {
    if (onRemove && await onRemove()) onDone();
    else setSaveFailed(true);
  }

  async function useCurrent() {
    if (fix.busy) return;
    setFix({ busy: true });
    const r = await readCurrentPosition();
    if (r.ok) {
      setPicked(null);
      setInput(formatCoordinates({ lat: r.lat, lng: r.lng }, 5));
      setShown(false);
      setFix({ busy: false });
    } else {
      setFix({ busy: false, error: r.error });
    }
  }

  if (!editing && place) {
    const coordinates = (
      <div className="flex min-w-0 items-center gap-0.5">
        <p className="truncate font-mono text-small text-pn-muted">{formatCoordinates(place)}</p>
        <CopyButton value={formatCoordinates(place, 5)} label={t('location.copyCoordinates')} />
      </div>
    );
    const actions = (
      <>
        <Button
          action="open"
          className={layout === 'popup' ? 'flex-1 justify-center' : ''}
          aria-label={t('location.openOsm')}
          onClick={() => openExternal(osmUrl(place.lat, place.lng))}
        >
          OpenStreetMap
        </Button>
        {!readOnly && (
          <IconButton label={t('common:actions.edit')} onClick={() => (onEdit ? onEdit() : setEditing(true))}>
            <PencilSimple aria-hidden="true" />
          </IconButton>
        )}
        {!readOnly && onRemove && <DeleteButton kind="remove" label={t('location.remove')} onConfirm={() => void remove()} />}
      </>
    );
    const notice = (
      <p className={`flex items-start gap-1.5 ${SETTINGS_HELP}`}>
        <ShieldCheck className="mt-0.5 shrink-0" aria-hidden="true" />
        {t('location.mapNotice')}
      </p>
    );
    if (layout === 'sheet') {
      return (
        <>
          <div className="min-h-0 flex-1"><ShownMap place={place} scrollZoom bleed height="100%" /></div>
          <div className="flex shrink-0 flex-col gap-1.5 px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {/* On a phone the coordinates take their own line, so the actions stay one row. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="max-sm:w-full">{coordinates}</div>
              <span className="flex-1" />
              {actions}
              {onCollapse && (
                <IconButton label={t('shell:folders.collapse')} onClick={onCollapse}>
                  <ArrowsInSimple aria-hidden="true" />
                </IconButton>
              )}
            </div>
            {notice}
            {saveFailed && <StatusLine tone="danger">{t('location.saveFailed')}</StatusLine>}
          </div>
        </>
      );
    }
    return (
      <div className="flex flex-col gap-2 px-1.5 pb-1">
        {/* The name is the window's title (NoteLocationChip); the coordinates sit under it. */}
        <div className="-mt-1.5 flex items-center justify-between gap-1">
          {coordinates}
          {onExpand && (
            <IconButton label={t('shell:folders.expand')} onClick={onExpand}>
              <ArrowsOutSimple aria-hidden="true" />
            </IconButton>
          )}
        </div>
        {/* Edge to edge: out through the panel's padding and the popover's. */}
        <div className="-mx-3.5"><ShownMap place={place} scrollZoom bleed /></div>
        <div className="flex items-center gap-1.5">{actions}</div>
        {notice}
        {saveFailed && <StatusLine tone="danger">{t('location.saveFailed')}</StatusLine>}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 px-1.5 pb-1"
      onSubmit={(e) => { e.preventDefault(); void save(); }}
    >
      {canReadPosition() && (
        <>
          <Button icon={<Crosshair aria-hidden="true" />} onClick={() => void useCurrent()} aria-busy={fix.busy}>
            {t('location.useCurrent')}
          </Button>
          {fix.busy && <StatusLine busy>{t('location.locating')}</StatusLine>}
          {fix.error && <StatusLine tone="danger">{t(FIX_ERROR[fix.error])}</StatusLine>}
        </>
      )}
      <TextField
        ref={inputRef}
        label={t('location.inputLabel')}
        value={input}
        inputMode="text"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder={t('location.inputPlaceholder')}
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls="pn-town-list"
        onChange={(e) => { setInput(e.target.value); setPicked(null); setHighlight(0); setShown(false); setSaveFailed(false); }}
        onKeyDown={(e) => {
          if (!hits.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((i) => (i + 1) % hits.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((i) => (i - 1 + hits.length) % hits.length); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(hits[highlight] ?? hits[0]!); }
        }}
        onBlur={() => setShown(true)}
        hint={hint}
        error={error}
      />
      {hits.length > 0 && (
        <div>
          {/* The tag field's suggestion rows (TagInput.tsx): a click keeps the field's focus. */}
          <div id="pn-town-list" role="listbox" className="flex flex-col" onMouseDown={(e) => e.preventDefault()}>
            {hits.map((hit, i) => (
              <button
                key={`${hit.name}-${hit.lat}-${hit.lng}`}
                type="button"
                role="option"
                aria-selected={i === highlight}
                onClick={() => pick(hit)}
                className={`w-full text-start px-2 py-1.5 rounded-md transition-colors ${i === highlight ? 'bg-track' : 'hover:bg-pn/5'}`}
              >
                <span className="block text-body text-pn truncate" dir="auto">{hit.name}</span>
                <span className="block text-small text-pn-muted truncate" dir="auto">
                  {[hit.region, country(hit.country)].filter(Boolean).join(', ')}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {waiting && <StatusLine busy>{t('location.townsLoading')}</StatusLine>}
      <TextField
        label={t('location.nameLabel')}
        value={name}
        dir="auto"
        // A place name is a proper name: iOS autocorrect turned "Taishikan"
        // into "Tsushima" in the simulator.
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
      />
      {saveFailed && <StatusLine tone="danger">{t('location.saveFailed')}</StatusLine>}
      <div className="flex flex-wrap items-center gap-1.5">
        {saveText
          ? <Button type="submit" variant="primary" icon={<MapPin aria-hidden="true" />}>{saveText}</Button>
          : <Button action="save" type="submit" />}
        <Button action="cancel" onClick={() => (place && !startEditing ? setEditing(false) : onDone())} />
      </div>
      {/* Only the switch for this item's type, under a rule (owner, 2026-11-11). */}
      {autoType && canReadPosition() && (
        <AutoLocationSwitch
          type={autoType}
          label={t(autoType === 'note' ? 'location.autoNote' : 'location.autoJournal')}
          className="mt-1 border-t border-divider"
        />
      )}
    </form>
  );
}

/**
 * The map of a place with its credit line: in the place window after "Show
 * map", and in a note's body after Insert > Location (PlaceMapNode.tsx).
 */
export function ShownMap({ place, scrollZoom = false, bleed = false, height = MAP_HEIGHT_DEFAULT }: {
  place: NoteLocation;
  scrollZoom?: boolean;
  /** Edge to edge with no frame (the place window). */
  bleed?: boolean;
  /** In CSS pixels (a map in a note's text keeps its own), or '100%' to fill the large map. */
  height?: number | '100%';
}) {
  const { t } = useTranslation('notes');
  const fill = height === '100%';
  // A failed map says so and offers one more try: a fresh map, a new attempt
  // at the host (offline for a moment, a slow first draw).
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { theme } = useTheme();
  const credit = (href: string, name: string) => (
    <a href={href} draggable={false} className="underline" onClick={(e) => { e.preventDefault(); openExternal(href); }}>{name}</a>
  );
  if (failed) {
    return (
      <Callout
        tone="danger"
        className={bleed ? 'mx-3.5' : ''}
        action={
          <FeedbackButton
            action="retry"
            // Inside a note, the editor must not take the press (as a picture's retry).
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}
          >
            {t('auth:signIn.tryAgain')}
          </FeedbackButton>
        }
      >
        {t('location.mapFailed')}
      </Callout>
    );
  }
  return (
    <Suspense fallback={<StatusLine busy>{t('location.mapLoading')}</StatusLine>}>
      <div className={`relative${fill ? ' h-full' : ''}`}>
        <NoteLocationMapLazy
          key={attempt}
          lat={place.lat}
          lng={place.lng}
          dark={theme === 'dark'}
          lang={activeLocale()}
          source={mapSource()}
          label={t('location.mapLabel', { place: place.label ?? formatCoordinates(place, 2) })}
          scrollZoom={scrollZoom}
          bleed={bleed}
          height={height}
          onFail={() => setFailed(true)}
        />
        {/* The OpenStreetMap licence asks for this credit wherever the map
            shows: on the map's corner, inside its frame. A div, not a p:
            inside a note the editor sizes every p as body text. */}
        <div className={`absolute bottom-px rounded-ss-md bg-surface-2/85 px-1.5 text-meta text-pn-muted ${bleed ? 'end-0' : 'end-px rounded-ee-[5px]'}`}>
          © {credit('https://www.openstreetmap.org/copyright', 'OpenStreetMap')} · {credit('https://protomaps.com', 'Protomaps')}
        </div>
      </div>
    </Suspense>
  );
}

/**
 * "Automatically add my location" for one item type: the place window's form
 * shows the switch for the item it is on (owner, 2026-11-11), and Settings >
 * Editor shows one per type. Phones only; the parent checks.
 * Spec: docs/internal/plans/note-location.md (section 3c)
 */
export function AutoLocationSwitch({ type, label, icon, setting, className }: {
  type: AutoLocationType;
  label: string;
  icon?: ReactNode;
  setting?: string;
  className?: string;
}) {
  const { t } = useTranslation('notes');
  const prefs = useAutoLocation();
  const [error, setError] = useState<'denied' | 'off' | null>(null);
  return (
    <div className={className}>
      <Switch
        {...(setting ? { setting } : {})}
        {...(icon ? { icon } : {})}
        labelClassName={ROW_TITLE}
        label={label}
        checked={prefs[type]}
        onChange={(on) => { setError(null); void turnAutoLocation(type, on).then(setError); }}
        className="gap-x-5 py-3"
      />
      {error && <StatusLine tone="danger">{t(error === 'denied' ? 'location.autoDenied' : 'location.autoOff')}</StatusLine>}
    </div>
  );
}
