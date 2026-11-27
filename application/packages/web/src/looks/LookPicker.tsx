/**
 * The look picker of a folder, a tag or a note: a color, an icon, and the one
 * switch that decides whether an open note takes its color as its background.
 * A note target shows the icon grid alone: its color keeps the note menu's
 * own view, which knows "take the tag's or folder's color" and "no color".
 *
 * Tabs: Icon, Logo and Color (a note and a tracker have no Color tab). Icon
 * comes first, because the icon search needs the room: with the colors above
 * it, a phone keyboard left the hits no space at all. Logo is the same grid
 * and search over the brand logos, a catalog of its own that loads with the
 * tab (section 3.6).
 *
 * A window in the middle of the screen; a bottom sheet under `lg`, where the
 * sidebar is a drawer. While a soft keyboard is up, the sheet spans the
 * visible viewport from its top to the keyboard, so the hits stay in view
 * whether or not the browser resizes the page for the keyboard. A pick saves at once and keeps the picker open, so a
 * color and an icon can be set in one visit. Cancel puts back what the
 * picker found; Done, the close button, Escape and a click outside keep the
 * picks, because they are already saved. Picks happen on a
 * click, never on pointer-down, so a finger that starts a scroll in the sheet
 * never picks. Hovering an icon shows it, with its name, in the header: the
 * grid scrolls, and a hover label above a cell would be clipped by it. A
 * query in the search field swaps the groups for one list of hits; with no
 * query, the icons the folders and tags already wear lead as one row.
 * Spec: docs/internal/specs/folder-tag-icons.md (section 6)
 */
import { useContext, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type UIEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AppWindow, ArrowCounterClockwise, Check, File, Folder, Globe, Hash, Heartbeat, Image, Palette, Shapes, Star, Trash, Upload, X } from '../icons';
import { keepTabInside, useWindowFocus } from '../ui/Modal';
import { ColorSwatchRow } from '../ColorSwatch';
import { useEscapeToClose } from '../useEscapeToClose';
import { useIsMobile } from '../useIsMobile';
import {
  folderLookKey,
  isLookColor,
  lookOf,
  NOTES_ON,
  NOTE_COLOR_CHOICES,
  NOTE_COLOR_LABEL,
  type ItemStyles,
  type LookAttr,
  type LookColor,
  type NoteColorChoice,
} from '../itemStyles';
import { inkStyle, LooksContext, PathGlyph } from './LookGlyph';
import { NoteColorExample } from './NoteColorExample';
import {
  CUSTOM_ICON_MAX,
  customIconDataUrl,
  customIconLookId,
  deleteCustomIcon,
  isCustomIconId,
  liveCustomIcons,
  newCustomIconId,
  saveCustomIcon,
} from '../customIcons';
import { emojiChar, isEmojiId, isLogoId, preloadLookEmojis, preloadLookLogos, useLogoIndex, useLogoPaths, useLookEmojis, useLookIcons, useLookLogos, useLookPaths } from './lookIconsLoader';
import { recentLookIcons, searchLookIcons } from './lookIconSearch';
import i18n, { activeLocale, ensureLooksLoaded } from '../i18n';
import { isImeComposing } from '../imeComposing';
import { isSoftKeyboardDevice } from '../softKeyboard';
import { HeadlineRule, SETTINGS_HELP, SETTINGS_TRACK, SettingsTabStrip, settingsSegClass, settingsTabClass } from '../settingsUI';
import { useKeyboardRect } from '../useKeyboardOpen';
import { Switch } from '../Switch';
import { useProgressiveReveal } from '../useProgressiveReveal';
import { ListSearchInput } from '../ListSearchInput';
import { Button, CloseButton, ModalFooter } from '../ui';

/** The hits from all logos shown under the curated ones; each row of them
 *  may load another shard, so the list stops here. */
const MORE_LOGO_HITS = 48;
/** Cap emoji search hits so a one-letter query stays instant. */
const EMOJI_SEARCH_CAP = 120;
/** First frame of the Emoji tab before the next animation frame commits all groups. */
const EMOJI_FIRST_FRAME = 240;
/** Phosphor bold Smiley path kept as data so importing Smiley in this lazy
 *  chunk never splits it out of the boot chunks (folder-tag-icons.md sec. 8). */
const EMOJI_TAB_PATHS = ['M178.39,158c-11,19.06-29.39,30-50.39,30s-39.36-10.93-50.39-30a12,12,0,0,1,20.78-12c3.89,6.73,12.91,18,29.61,18s25.72-11.28,29.61-18a12,12,0,1,1,20.78,12ZM236,128A108,108,0,1,1,128,20,108.12,108.12,0,0,1,236,128Zm-24,0a84,84,0,1,0-84,84A84.09,84.09,0,0,0,212,128ZM92,124a16,16,0,1,0-16-16A16,16,0,0,0,92,124Zm72-32a16,16,0,1,0,16,16A16,16,0,0,0,164,92Z'] as const;

/** Icon id from LOOK_ICONS for each emoji group's jump button (zero extra imports). */
const EMOJI_GROUP_ICON: Record<string, string> = {
  emojiSmileys: 'smiley',
  emojiPeople: 'users',
  emojiAnimals: 'paw-print',
  food: 'fork-knife',
  travel: 'airplane',
  emojiActivities: 'soccer-ball',
  emojiObjects: 'lightbulb',
  emojiSymbols: 'heart',
  emojiFlags: 'flag',
};

// Search keywords per language, from Unicode CLDR (tools/gen-look-keywords.mjs).
// Only the reader's language and English load, with the picker.
const keywordModules = import.meta.glob<{ default: Record<string, string> }>('./keywords/*.gen.json');
// Emoji names and search keywords per language (tools/gen-look-emojis.mjs).
// Loaded only when the Emoji tab opens.
const emojiKeywordModules = import.meta.glob<{ default: { entries: readonly string[] } }>('./emojiKeywords/*.gen.json');

async function loadKeywords(): Promise<{ local: Record<string, string>; en: Record<string, string> }> {
  const read = async (lng: string) => (await keywordModules[`./keywords/${lng}.gen.json`]?.())?.default ?? {};
  const [local, en] = await Promise.all([read(activeLocale()), read('en')]);
  return { local, en };
}

async function loadEmojiKeywords(): Promise<{ local: readonly string[]; en: readonly string[] }> {
  const read = async (lng: string) => (await emojiKeywordModules[`./emojiKeywords/${lng}.gen.json`]?.())?.default?.entries ?? [];
  const [local, en] = await Promise.all([read(activeLocale()), read('en')]);
  return { local, en };
}

function splitEmojiMeta(raw: string | undefined): [name: string, words: string] {
  if (!raw) return ['', ''];
  const bar = raw.indexOf('|');
  return bar === -1 ? [raw, ''] : [raw.slice(0, bar), raw.slice(bar + 1)];
}

export interface LookTarget {
  /** A tracker is icon-only, as a note is: its color has its own swatches.
   *  `insert` puts the pick into a note's text (Insert > Icons & logos): no
   *  look of its own, so no "Use default". */
  kind: 'folder' | 'tag' | 'note' | 'tracker' | 'insert' | 'calendar';
  /** `folderLookKey(id)`, `tagLookKey(tag)`, `noteLookKey(id)` or, for a
   *  subscribed calendar (#811), `feedLookKey(id)`: an icon and a color its
   *  events wear, with no switch for notes and no note color setting. */
  lookKey: string;
  /** The folder id, for a folder target. */
  folderId?: string;
  name: string;
  favorite?: boolean;
}

export function LookPicker({
  target,
  styles,
  subfolderIds = [],
  noteColors,
  onPick,
  onSubfoldersFollow,
  onNoteColors,
  onCancel,
  onClose,
}: {
  target: LookTarget;
  styles: ItemStyles;
  /** Every folder below a folder target; empty for a tag. */
  subfolderIds?: readonly string[];
  /** The "Note colors" control of Appearance, shown here because this is
   *  where a color is chosen. */
  noteColors: NoteColorChoice;
  onPick: (patch: Partial<Record<LookAttr, string | null>>) => void;
  /** The subfolder switch: on copies the folder's color to every folder
   *  below it, off clears those copies. */
  onSubfoldersFollow?: (on: boolean) => void;
  onNoteColors: (next: NoteColorChoice) => void;
  /** Undo every pick of this visit. The picker closes itself after it. */
  onCancel: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('looks');
  const { t: tShell } = useTranslation('shell');
  const { t: tEditor } = useTranslation('editor');
  const { t: tSettings } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const isSheet = useIsMobile();
  const catalog = useLookIcons(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { customIcons = {}, onCustomIconsChange } = useContext(LooksContext);
  const iconOnly = target.kind === 'note' || target.kind === 'tracker' || target.kind === 'insert';
  const showCustomTab = target.kind !== 'insert' && !!onCustomIconsChange;
  const [tab, setTab] = useState<'icon' | 'logo' | 'emoji' | 'custom' | 'color'>(() => {
    const current = lookOf(styles, target.lookKey).icon;
    if (showCustomTab && isCustomIconId(current)) return 'custom';
    return isEmojiId(current) ? 'emoji' : isLogoId(current) ? 'logo' : 'icon';
  });
  const [customBusy, setCustomBusy] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const [customRemoveMode, setCustomRemoveMode] = useState(false);
  const [customDragOver, setCustomDragOver] = useState(false);
  const customList = useMemo(() => liveCustomIcons(customIcons), [customIcons]);
  const atCustomCap = customList.length >= CUSTOM_ICON_MAX;
  const logoCatalog = useLookLogos(tab === 'logo');
  const emojiCatalog = useLookEmojis(tab === 'emoji');
  // The A to Z list of every other logo starts once the curated groups are
  // scrolled near their end, so opening the tab loads the curated set alone.
  const [browseAll, setBrowseAll] = useState(false);
  const reveal = useProgressiveReveal();
  // Commit the first slice on frame 0 and every remaining emoji group on the
  // next animation frame, so tall screens where 180 cells fit without overflow
  // never stall waiting for a scroll event.
  const [emojiAll, setEmojiAll] = useState(false);
  const wornOther = !!logoCatalog && recentLookIcons(styles, isLogoId).some((id) => !logoCatalog.LOOK_LOGO_PATHS[id]);
  const [query, setQuery] = useState('');
  const logoIndex = useLogoIndex(tab === 'logo' && (!!query.trim() || browseAll || wornOther));
  const keyboard = useKeyboardRect(isSheet);
  const [hoverIcon, setHoverIcon] = useState<string | null>(null);
  // The names load with the picker (i18n.ts, ensureLooksLoaded); the state
  // redraws it once they are in.
  const [namesReady, setNamesReady] = useState(false);
  const [keywords, setKeywords] = useState<{ local: Record<string, string>; en: Record<string, string> } | null>(null);
  const [emojiKeywords, setEmojiKeywords] = useState<{ local: readonly string[]; en: readonly string[] } | null>(null);
  useEffect(() => {
    let live = true;
    void ensureLooksLoaded().then(
      () => live && setNamesReady(true),
      () => {},
    );
    // Without keywords the search still finds names; a failed load leaves it so.
    void loadKeywords().then(
      (k) => live && setKeywords(k),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (tab !== 'emoji' || emojiKeywords) return;
    let live = true;
    void loadEmojiKeywords().then(
      (k) => live && setEmojiKeywords(k),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [tab, emojiKeywords]);
  useEffect(() => {
    if (tab !== 'emoji' || !emojiCatalog || emojiAll) return;
    const id = requestAnimationFrame(() => setEmojiAll(true));
    return () => cancelAnimationFrame(id);
  }, [tab, emojiCatalog, emojiAll]);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [tab]);

  // Escape clears a query first, and closes the picker after that.
  useEscapeToClose(() => (query ? setQuery('') : onClose()));
  useWindowFocus(panelRef, !isSheet);

  // A press that starts and ends on the backdrop closes the window, so a drag
  // that leaves the panel does not.
  const downOnBackdrop = useRef(false);
  const backdropProps = {
    onPointerDown: (e: React.PointerEvent) => {
      downOnBackdrop.current = e.target === e.currentTarget;
    },
    onClick: (e: React.MouseEvent) => {
      if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
    },
  };

  const look = lookOf(styles, target.lookKey);
  const ownColor: LookColor | null = isLookColor(look.color) ? look.color : null;
  // On when every folder below shows this folder's color (subfoldersFollow).
  const follow =
    ownColor !== null &&
    subfolderIds.length > 0 &&
    subfolderIds.every((id) => lookOf(styles, folderLookKey(id)).color === ownColor);

  // Straight into the search field where a keyboard is already out; a phone
  // would otherwise raise its keyboard over the icons on open.
  useEffect(() => {
    if (tab !== 'color' && tab !== 'custom' && !isSoftKeyboardDevice()) searchRef.current?.focus({ preventScroll: true });
    if (tab !== 'custom') setCustomRemoveMode(false);
  }, [tab]);

  async function handleCustomFiles(files: FileList | File[] | null) {
    if (!files || files.length === 0 || !onCustomIconsChange) return;
    const remaining = CUSTOM_ICON_MAX - customList.length;
    if (remaining <= 0) {
      setCustomError(t('customLimit', { max: CUSTOM_ICON_MAX }));
      return;
    }
    setCustomBusy(true);
    setCustomError(null);
    try {
      const { processCustomIcon, CustomIconError } = await import('./customIconProcess');
      const batch = [...files].slice(0, remaining);
      const added: { id: string; dataUrl: string }[] = [];
      let lastError: string | null = null;
      for (const file of batch) {
        try {
          const dataUrl = await processCustomIcon(file);
          added.push({ id: newCustomIconId(), dataUrl });
        } catch (err) {
          const code = err instanceof CustomIconError ? err.code : 'decodeFailed';
          lastError =
            code === 'unsupported'
              ? t('customErrorUnsupported')
              : code === 'tooLarge'
                ? t('customErrorTooLarge')
                : t('customErrorDecode');
        }
      }
      if (added.length > 0) {
        onCustomIconsChange((prev) => {
          let next = prev;
          for (const item of added) next = saveCustomIcon(next, item.id, item.dataUrl);
          return next;
        });
        onPick({ icon: customIconLookId(added[0]!.id) });
      }
      if (lastError) setCustomError(lastError);
    } finally {
      setCustomBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleRemoveCustom(id: string) {
    if (!onCustomIconsChange) return;
    onCustomIconsChange((prev) => deleteCustomIcon(prev, id));
    const removedLookId = customIconLookId(id);
    if (look.icon === removedLookId) onPick({ icon: null });
    if (hoverIcon === removedLookId) setHoverIcon(null);
    if (customList.length <= 1) setCustomRemoveMode(false);
  }

  function onCustomDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setCustomDragOver(false);
    if (!atCustomCap && !customBusy) void handleCustomFiles(e.dataTransfer.files);
  }

  function iconName(id: string): string {
    if (isCustomIconId(id)) return t('customIcon');
    if (isEmojiId(id)) {
      const idx = emojiCatalog?.LOOK_EMOJI_INDEX.get(id);
      if (idx !== undefined) {
        const [localName] = splitEmojiMeta(emojiKeywords?.local[idx]);
        const [enName] = splitEmojiMeta(emojiKeywords?.en[idx]);
        return localName || enName || emojiChar(id) || '';
      }
      return emojiChar(id) ?? '';
    }
    if (isLogoId(id)) return logoCatalog?.LOOK_LOGO_NAMES[id] ?? moreLogoNames.get(id) ?? '';
    const n = catalog?.lookIconNumber(id) ?? null;
    return n === null ? t(`icons.${id}`) : t('number', { n });
  }

  // Every icon with the texts a query may match: the name in the UI language,
  // then in English, so a German reader finds the heart by "herz" and by
  // "heart", then the emoji keywords in both, then the group name.
  // A logo's name is the brand's, the same in every language.
  const entries = useMemo(() => {
    if (tab === 'emoji') {
      if (!emojiCatalog || !namesReady) return [];
      return emojiCatalog.LOOK_EMOJI_GROUPS.flatMap((group) => {
        const groupLabel = t(`groups.${group.key}`);
        return group.ids.map((id) => {
          const idx = emojiCatalog.LOOK_EMOJI_INDEX.get(id) ?? -1;
          const [localName, localWords] = splitEmojiMeta(emojiKeywords?.local[idx]);
          const [enName, enWords] = splitEmojiMeta(emojiKeywords?.en[idx]);
          const ch = emojiChar(id) ?? '';
          const texts = [localName, enName, localWords, enWords, groupLabel, ch].filter(Boolean);
          return { id, texts };
        });
      });
    }
    if (tab === 'logo') {
      if (!logoCatalog || !namesReady) return [];
      return logoCatalog.LOOK_LOGO_GROUPS.flatMap((group) =>
        group.ids.map((id) => ({ id, texts: [logoCatalog.LOOK_LOGO_NAMES[id] ?? '', t(`groups.${group.key}`)] })),
      );
    }
    if (!catalog || !namesReady) return [];
    const tEn = i18n.getFixedT('en', 'looks');
    return catalog.LOOK_ICON_GROUPS.flatMap((group) =>
      group.ids.map((id) => {
        const n = catalog.lookIconNumber(id);
        const names = n === null ? [t(`icons.${id}`), tEn(`icons.${id}`)] : [t('number', { n }), tEn('number', { n })];
        const words = [keywords?.local[id], keywords?.en[id]].filter((w): w is string => !!w);
        return { id, texts: [...names, ...words, t(`groups.${group.key}`)] };
      }),
    );
  }, [tab, catalog, logoCatalog, emojiCatalog, namesReady, keywords, emojiKeywords, t]);
  // Every other Simple Icons logo, searched by name under the curated hits.
  const moreLogoEntries = useMemo(
    () => (logoIndex?.logos ?? []).map(([id, name]) => ({ id, texts: [name] })),
    [logoIndex],
  );
  const moreLogoNames = useMemo(() => new Map(logoIndex?.logos ?? []), [logoIndex]);
  const rawHits = query.trim() ? searchLookIcons(query, entries) : null;
  const hits = rawHits && tab === 'emoji' ? rawHits.slice(0, EMOJI_SEARCH_CAP) : rawHits;
  const moreHits = tab === 'logo' && query.trim() ? searchLookIcons(query, moreLogoEntries).slice(0, MORE_LOGO_HITS) : [];
  // The grid of the open tab, and its own recent row.
  const shown = tab === 'emoji' ? emojiCatalog : tab === 'logo' ? logoCatalog : catalog;
  const recent = shown
    ? recentLookIcons(styles, (id) =>
        tab === 'emoji' ? isEmojiId(id) : tab === 'logo' ? isLogoId(id) : !!catalog && id in catalog.LOOK_ICONS,
      )
    : [];
  const allLogos = browseAll && tab === 'logo' && !hits ? (logoIndex?.logos ?? []).slice(0, reveal.visible).map(([id]) => id) : [];
  const emojiGroups = useMemo(() => {
    if (tab !== 'emoji' || !emojiCatalog || hits) return [];
    if (emojiAll) return emojiCatalog.LOOK_EMOJI_GROUPS;
    const out: { key: string; ids: readonly string[] }[] = [];
    let left = EMOJI_FIRST_FRAME;
    for (const group of emojiCatalog.LOOK_EMOJI_GROUPS) {
      if (left <= 0) break;
      const slice = group.ids.length <= left ? group.ids : group.ids.slice(0, left);
      out.push({ key: group.key, ids: slice });
      left -= slice.length;
    }
    return out;
  }, [tab, emojiCatalog, hits, emojiAll]);
  const logoPaths = useLogoPaths(tab === 'logo' ? [...recent, ...moreHits, ...allLogos] : []);
  function onBodyScroll(e: UIEvent<HTMLDivElement>) {
    if (tab !== 'logo' || hits) return;
    const el = e.currentTarget;
    if (browseAll) reveal.onScroll(el, logoIndex?.logos.length ?? 0);
    else if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) setBrowseAll(true);
  }
  function jumpToEmojiGroup(key: string) {
    if (!emojiAll) setEmojiAll(true);
    requestAnimationFrame(() => {
      const targetEl = bodyRef.current?.querySelector<HTMLElement>(`[data-emoji-group="${key}"]`);
      targetEl?.scrollIntoView({ block: 'start' });
    });
  }
  const pathsOf = (id: string) => {
    const customUrl = customIconDataUrl(customIcons, id);
    if (customUrl) return { img: customUrl };
    return emojiChar(id) ?? (isLogoId(id) ? logoPaths(id) : catalog?.LOOK_ICONS[id]);
  };

  const previewIcon = hoverIcon ?? look.icon;
  const previewPaths = useLookPaths(previewIcon, customIcons);
  const DefaultGlyph = target.kind === 'folder' ? Folder : target.kind === 'note' ? File : target.kind === 'tracker' ? Heartbeat : target.kind === 'insert' ? Shapes : target.kind === 'calendar' ? Globe : target.favorite ? Star : Hash;
  const caption = hoverIcon
    ? iconName(hoverIcon)
    : target.kind === 'folder'
      ? t('captionFolder')
      : target.kind === 'note'
        ? t('notes:newMenu.note')
        : target.kind === 'tracker'
          ? t('captionTracker')
          : target.kind === 'insert'
            ? ''
            : target.kind === 'calendar'
              ? tShell('tagsRail.calendar')
              : t('captionTag');
  // A note's color belongs to the note menu, so its reset leaves the color.
  const reset: Partial<Record<LookAttr, null>> = iconOnly ? { icon: null } : { icon: null, color: null, notes: null };
  const resettable = iconOnly ? !!look.icon : !!look.icon || !!look.color;

  /** Arrow keys walk the grid by position, across the group headings. */
  function onGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const list = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-look-icon]') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) return;
    const rtl = document.documentElement.dir === 'rtl';
    let next: HTMLButtonElement | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      next = list[i + ((e.key === 'ArrowRight') !== rtl ? 1 : -1)];
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const here = list[i]!.getBoundingClientRect();
      const down = e.key === 'ArrowDown';
      let best: { el: HTMLButtonElement; dy: number; dx: number } | null = null;
      for (const el of list) {
        const r = el.getBoundingClientRect();
        const dy = down ? r.top - here.top : here.top - r.top;
        if (dy <= 4) continue;
        const dx = Math.abs(r.left - here.left);
        if (!best || dy < best.dy - 4 || (Math.abs(dy - best.dy) <= 4 && dx < best.dx)) {
          best = { el, dy, dx };
        }
      }
      next = best?.el;
      if (!next && !down) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
    } else if (e.key === 'Home') {
      next = list[0];
    } else if (e.key === 'End') {
      next = list[list.length - 1];
    } else {
      return;
    }
    e.preventDefault();
    next?.focus();
  }

  /** Down moves from the field into the icons; Enter takes the first hit. */
  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (isImeComposing(e)) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      gridRef.current?.querySelector<HTMLButtonElement>('[data-look-icon]')?.focus();
    } else if (e.key === 'Enter') {
      // The field hands its value up after a short pause, so the hits are
      // read from what is typed now, not from the last value handed up.
      const typed = e.currentTarget.value;
      const first = typed.trim()
        ? (searchLookIcons(typed, entries)[0] ?? (tab === 'logo' ? searchLookIcons(typed, moreLogoEntries)[0] : undefined))
        : undefined;
      if (!first) return;
      e.preventDefault();
      onPick({ icon: first });
    }
  }

  const searchPlaceholder = t(tab === 'logo' ? 'searchLogos' : tab === 'emoji' ? 'searchEmojis' : 'searchPlaceholder');
  const searchField = (
    <div className="mt-3 flex">
      <ListSearchInput
        inputRef={searchRef}
        value={query}
        onChange={setQuery}
        onKeyDown={onSearchKeyDown}
        placeholder={searchPlaceholder}
        ariaLabel={searchPlaceholder}
      />
    </div>
  );

  const header = (
    <div className="flex items-center gap-3">
      <span
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border border-divider bg-surface-2"
        style={ownColor ? { background: `var(--pn-label-${ownColor}-tint)` } : undefined}
      >
        {previewPaths ? (
          <PathGlyph
            paths={previewPaths}
            size={24}
            className={ownColor ? undefined : 'text-label'}
            style={inkStyle(ownColor)}
          />
        ) : (
          <DefaultGlyph
            size={24}
            weight={target.kind === 'tag' && target.favorite ? 'fill' : undefined}
            className={ownColor ? undefined : 'text-label'}
            style={inkStyle(ownColor)}
            aria-hidden="true"
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-pn truncate" dir="auto">
          {target.kind === 'tag' ? `#${target.name}` : target.name}
        </p>
        <p className="text-meta text-pn-muted truncate" aria-live="polite">{caption}</p>
      </div>
      {target.kind !== 'insert' && <button
        type="button"
        onClick={() => onPick(reset)}
        disabled={!resettable}
        className="shrink-0 inline-flex items-center gap-1 text-small font-medium px-2 py-1 rounded-md text-accent hover:bg-accent/10 disabled:opacity-40 disabled:hover:bg-transparent transition"
      >
        <ArrowCounterClockwise aria-hidden="true" />
        {t('useDefault')}
      </button>}
      <CloseButton onClick={onClose} className="shrink-0" />
    </div>
  );

  // A folder or tag icon can show on its notes: on the Icon and Logo tabs
  // only, pinned above the footer so the scrolling grid never hides it.
  // Off and greyed while there is no icon to show.
  // Spec: docs/internal/specs/folder-tag-icons.md (section 4.11)
  const onNotesSwitch = !iconOnly && target.kind !== 'calendar' && tab !== 'color' && (
    <Switch
      className="shrink-0 border-t border-divider px-4 py-2.5"
      label={t(target.kind === 'folder' ? 'applyToFolderItems' : 'applyToTagItems')}
      checked={!!look.icon && look.notes === NOTES_ON}
      disabled={!look.icon}
      onChange={(on) => onPick({ notes: on ? NOTES_ON : null })}
    />
  );

  const footer = (
    <div className="shrink-0 border-t border-divider px-4 pt-1">
      <ModalFooter>
        <Button
          action="cancel"
          onClick={() => {
            onCancel();
            onClose();
          }}
        />
        <Button action="done" onClick={onClose} />
      </ModalFooter>
    </div>
  );

  const tabIds: readonly ('icon' | 'logo' | 'emoji' | 'custom' | 'color')[] = iconOnly
    ? showCustomTab
      ? ['icon', 'logo', 'emoji', 'custom']
      : ['icon', 'logo', 'emoji']
    : showCustomTab
      ? ['icon', 'logo', 'emoji', 'custom', 'color']
      : ['icon', 'logo', 'emoji', 'color'];

  const tabs = (
    <SettingsTabStrip role="tablist" aria-label={tShell('looks.menu')} className="mt-3">
      {tabIds.map((id) => {
        const TabGlyph =
          id === 'icon'
            ? Shapes
            : id === 'logo'
              ? AppWindow
              : id === 'custom'
                ? Image
                : id === 'color'
                  ? Palette
                  : null;
        const preload = id === 'logo' ? preloadLookLogos : id === 'emoji' ? preloadLookEmojis : undefined;
        const label =
          id === 'logo'
            ? tSettings('appearance.custom.logoTitle')
            : t(id);
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            onPointerEnter={preload}
            onPointerDown={preload}
            onFocus={preload}
            className={settingsTabClass(tab === id)}
          >
            {TabGlyph ? <TabGlyph size={16} aria-hidden="true" /> : <PathGlyph paths={EMOJI_TAB_PATHS} size={16} />}
            <span>{label}</span>
          </button>
        );
      })}
    </SettingsTabStrip>
  );

  const colorSection = (
    <>
      <div className="mt-4">
        <ColorSwatchRow
          selected={ownColor ?? 'none'}
          noneLabel={tShell('noteOptionsMenu.colorNone')}
          colorLabel={(c) => tEditor(`color.names.${c}`)}
          labelSide="below"
          onPick={(c) => onPick({ color: c })}
        />
      </div>
      {/* A calendar's color marks its events only: no note setting. */}
      {target.kind !== 'calendar' && <div className="mt-3 border-t border-divider divide-y divide-divider">
        {onSubfoldersFollow && subfolderIds.length > 0 && (
          <Switch
            className="py-2.5"
            label={t('applyToSubfolders')}
            checked={follow}
            disabled={!ownColor}
            onChange={onSubfoldersFollow}
          />
        )}
        {/* One setting for every folder and tag, shown here because this is
            where a color is chosen. The heading says so, because inside one
            tag's picker it otherwise reads as a setting of that tag, and the
            example shows the picked color under the chosen option. */}
        <div className="py-2.5">
          <p className="text-body font-medium flex items-center gap-1.5">
            <Globe className="shrink-0 text-pn-muted" aria-hidden="true" />
            {tSettings('appearance.noteColorsPickerTitle')}
          </p>
          <p className={`${SETTINGS_HELP} mt-0.5`}>{tSettings('appearance.noteColorsDesc')}</p>
          {/* The options fill the narrow window at every width. */}
          <div className={`mt-2 ${SETTINGS_TRACK} [&>button]:flex-1`} role="group" aria-label={tSettings('appearance.noteColorsTitle')}>
            {NOTE_COLOR_CHOICES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onNoteColors(c)}
                aria-pressed={noteColors === c}
                className={settingsSegClass(noteColors === c)}
              >
                {tSettings(NOTE_COLOR_LABEL[c])}
              </button>
            ))}
          </div>
          {/* Always shown, so the choice can be seen before a color is
              picked: with no color yet, it draws the sample's own green. */}
          <div className="mt-2 rounded-md bg-track p-2">
            <NoteColorExample
              choice={noteColors}
              color={ownColor ?? 'green'}
              title={tSettings('appearance.noteColorsExampleTitle')}
              source={
                <>
                  {target.kind === 'folder' ? (
                    <Folder weight="fill" style={inkStyle(ownColor ?? 'green')} aria-hidden="true" />
                  ) : (
                    <Hash style={inkStyle(ownColor ?? 'green')} aria-hidden="true" />
                  )}
                  <span className="truncate">{target.name}</span>
                </>
              }
            />
          </div>
        </div>
      </div>}
    </>
  );

  function iconButton(id: string) {
    if (!shown) return null;
    const pressed = look.icon === id;
    return (
      <button
        key={id}
        type="button"
        data-look-icon
        aria-label={iconName(id)}
        aria-pressed={pressed}
        onClick={() => onPick({ icon: id })}
        onPointerEnter={(e) => e.pointerType === 'mouse' && setHoverIcon(id)}
        onPointerLeave={() => setHoverIcon(null)}
        onFocus={() => setHoverIcon(id)}
        onBlur={() => setHoverIcon(null)}
        className={`h-10 [@media(hover:none)]:h-11 rounded-md flex items-center justify-center transition ${
          pressed
            ? 'bg-accent/15 text-accent-strong ring-1 ring-inset ring-accent'
            : 'text-pn-soft hover:bg-pn/5'
        }`}
      >
        <PathGlyph paths={pathsOf(id) ?? []} size={24} />
      </button>
    );
  }

  const cellGrid = `grid gap-0.5 ${isSheet ? 'grid-cols-[repeat(auto-fill,minmax(44px,1fr))]' : 'grid-cols-8'}`;

  function section(key: string, heading: string, ids: readonly string[], emojiGroupKey?: string) {
    return (
      <section key={key} data-emoji-group={emojiGroupKey}>
        <h3 className={`mt-3 mb-1.5 flex items-center gap-2 ${SETTINGS_HELP}`}>
          <span className="shrink-0">{heading}</span>
          <HeadlineRule />
        </h3>
        <div className={cellGrid}>{ids.map(iconButton)}</div>
      </section>
    );
  }

  const emojiGroupBar = tab === 'emoji' && !hits && emojiCatalog && catalog && (
    <div className="mt-2 flex items-center justify-between gap-0.5 border-b border-divider pb-1.5" role="toolbar" aria-label={t('emoji')}>
      {emojiCatalog.LOOK_EMOJI_GROUPS.map((g) => {
        const paths = catalog.LOOK_ICONS[EMOJI_GROUP_ICON[g.key] ?? 'smiley'];
        const label = t(`groups.${g.key}`);
        return (
          <button
            key={g.key}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => jumpToEmojiGroup(g.key)}
            className="flex-1 h-8 [@media(hover:none)]:h-10 rounded-md flex items-center justify-center text-pn-muted hover:text-pn hover:bg-pn/5 transition"
          >
            {paths && <PathGlyph paths={paths} size={16} />}
          </button>
        );
      })}
    </div>
  );

  const grid = (
    <div ref={gridRef} role="group" aria-label={tab === 'logo' ? tSettings('appearance.custom.logoTitle') : tab === 'emoji' ? t('emoji') : t('icon')} onKeyDown={onGridKeyDown}>
      {!shown ? (
        // The catalog is a separate chunk. The sheet grows upward from
        // the bottom edge when it lands; the popover has a fixed height.
        <div className="h-64" aria-busy="true" />
      ) : hits ? (
        hits.length > 0 || moreHits.length > 0 ? (
          <>
            {hits.length > 0 && <div className={`mt-2 ${cellGrid}`}>{hits.map(iconButton)}</div>}
            {moreHits.length > 0 && section('more', t('moreLogos'), moreHits)}
          </>
        ) : (
          <p className="mt-4 text-center text-compact text-pn-muted" role="status">
            {tCommon('state.noResults')}
          </p>
        )
      ) : (
        <>
          {recent.length > 0 && section('recent', t('recent'), recent)}
          {tab === 'emoji'
            ? emojiGroups.map((group) => section(group.key, t(`groups.${group.key}`), group.ids, group.key))
            : tab === 'logo' && logoCatalog
              ? [
                  ...logoCatalog.LOOK_LOGO_GROUPS.map((group) => section(group.key, t(`groups.${group.key}`), group.ids)),
                  allLogos.length > 0 && section('all', t('allLogos'), allLogos),
                ]
              : catalog?.LOOK_ICON_GROUPS.map((group) => section(group.key, t(`groups.${group.key}`), group.ids))}
        </>
      )}
    </div>
  );

  const customGrid = `grid gap-2.5 ${isSheet ? 'grid-cols-[repeat(auto-fill,minmax(48px,1fr))]' : 'grid-cols-8'}`;
  const customSection = (
    <div
      className="mt-3"
      onDragOver={(e) => {
        e.preventDefault();
        if (!atCustomCap && !customBusy) setCustomDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setCustomDragOver(false);
      }}
      onDrop={onCustomDrop}
    >
      <label
        className={`flex items-center gap-3 rounded-lg border border-dashed px-3.5 py-3 transition ${
          customBusy || atCustomCap
            ? 'border-divider/60 bg-surface-2/40 opacity-60 cursor-not-allowed'
            : customDragOver
              ? 'border-accent bg-accent/10 cursor-pointer'
              : 'border-divider bg-surface-2/60 hover:border-accent/60 hover:bg-surface-2 cursor-pointer focus-within:ring-2 focus-within:ring-accent/40'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.ico"
          multiple
          disabled={customBusy || atCustomCap}
          className="sr-only"
          onChange={(e) => void handleCustomFiles(e.target.files)}
        />
        <span className="w-9 h-9 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0" aria-hidden="true">
          <Upload size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-semibold text-pn truncate">{t('uploadDropTitle')}</span>
          <span className="block text-meta text-pn-muted">{t('customHint')}</span>
        </span>
        <span className="shrink-0 text-small text-pn-muted tabular-nums">
          {customList.length} / {CUSTOM_ICON_MAX}
        </span>
      </label>
      {customError && (
        <p role="alert" className="mt-2 text-small text-danger">
          {customError}
        </p>
      )}
      {atCustomCap && (
        <p className="mt-2 text-small text-pn-muted">
          {t('customLimit', { max: CUSTOM_ICON_MAX })}
        </p>
      )}
      {customList.length > 0 && (
        <section className="mt-3.5">
          <div className="mb-2.5 flex items-center gap-2">
            <h3 className={`shrink-0 ${SETTINGS_HELP}`}>{t('customYourIcons')}</h3>
            <HeadlineRule />
            <Button
              icon={customRemoveMode ? <Check aria-hidden="true" /> : <Trash aria-hidden="true" />}
              onClick={() => setCustomRemoveMode((v) => !v)}
            >
              {customRemoveMode ? tCommon('actions.done') : tCommon('actions.remove')}
            </Button>
          </div>
          <div
            ref={gridRef}
            role="group"
            aria-label={t('custom')}
            onKeyDown={onGridKeyDown}
            className={customGrid}
          >
            {customList.map((item) => {
              const pressed = look.icon === item.lookId;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-look-icon
                  aria-label={customRemoveMode ? t('customRemoveAria') : t('customIcon')}
                  aria-pressed={!customRemoveMode && pressed}
                  onClick={() => (customRemoveMode ? handleRemoveCustom(item.id) : onPick({ icon: item.lookId }))}
                  onPointerEnter={(e) => e.pointerType === 'mouse' && setHoverIcon(item.lookId)}
                  onPointerLeave={() => setHoverIcon(null)}
                  onFocus={() => setHoverIcon(item.lookId)}
                  onBlur={() => setHoverIcon(null)}
                  className={`group relative w-full h-11 rounded-lg border flex items-center justify-center cursor-pointer transition ${
                    customRemoveMode
                      ? 'border-danger/50 bg-danger/5 hover:border-danger hover:bg-danger/15 active:scale-95'
                      : pressed
                        ? 'bg-accent/15 border-accent text-accent-strong ring-1 ring-inset ring-accent'
                        : 'border-divider/80 bg-surface-2 hover:border-accent/50 hover:bg-pn/5'
                  }`}
                >
                  <span className={customRemoveMode ? 'transition-opacity group-hover:opacity-70' : undefined}>
                    <PathGlyph paths={{ img: item.dataUrl }} size={24} />
                  </span>
                  {customRemoveMode && (
                    <span
                      aria-hidden="true"
                      className="absolute -top-1.5 -end-1.5 w-5 h-5 rounded-full bg-danger text-white flex items-center justify-center shadow-sm transition-transform group-hover:scale-110"
                    >
                      <X size={11} weight="bold" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );

  const dialogLabel = iconOnly ? t('icon') : tShell('looks.menu');
  const top = (
    <>
      {header}
      {tabs}
      {tab !== 'color' && tab !== 'custom' && searchField}
      {emojiGroupBar}
    </>
  );
  const body = tab === 'color' ? colorSection : tab === 'custom' ? customSection : grid;

  if (isSheet) {
    return createPortal(
      <>
        {/* Nearly the whole screen, and a fixed height, so a search with few
            hits does not shrink the sheet under the finger. */}
        <div className="fixed inset-0 z-[60] bg-black/30 dark:bg-black/50" {...backdropProps} />
        <div
          ref={panelRef}
          role="dialog"
          aria-label={dialogLabel}
          className={`fixed inset-x-0 z-[60] flex flex-col bg-surface-1 border-divider ${
            keyboard
              ? 'border-b rounded-b-xl pb-2'
              : 'bottom-0 h-[calc(100dvh-var(--pn-safe-top)-1rem)] border-t rounded-t-xl pb-[max(0.75rem,var(--pn-safe-bottom))]'
          }`}
          style={keyboard ? { top: keyboard.top, height: keyboard.height } : undefined}
        >
          {!keyboard && (
            <div className="w-8 h-1 bg-pn-muted/35 rounded-full mx-auto mt-3 mb-3 shrink-0" />
          )}
          <div className={`px-4 shrink-0 ${keyboard ? 'pt-3' : ''}`}>{top}</div>
          <div ref={bodyRef} className="px-4 pt-1 pb-2 overflow-y-auto min-h-0 flex-1 overscroll-contain" onScroll={onBodyScroll}>{body}</div>
          {/* Done is the close button, which stays in the header. */}
          {!keyboard && onNotesSwitch}
          {!keyboard && footer}
        </div>
      </>,
      document.body,
    );
  }

  // A fixed height, not a maximum: the icons land after the window opens and
  // must not make it jump. The grid is always taller than the panel.
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/30 dark:bg-black/50"
      {...backdropProps}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
        tabIndex={-1}
        onKeyDown={(e) => keepTabInside(e, panelRef.current)}
        className="w-[540px] max-w-[calc(100vw-32px)] h-[min(640px,calc(100dvh-32px))] flex flex-col bg-surface-1 border border-divider rounded-xl shadow-xl pb-3 outline-none"
      >
        <div className="px-4 pt-4 shrink-0">{top}</div>
        <div ref={bodyRef} className="px-4 pt-1 pb-3 overflow-y-auto min-h-0 flex-1 overscroll-contain" onScroll={onBodyScroll}>{body}</div>
        {onNotesSwitch}
        {footer}
      </div>
    </div>,
    document.body,
  );
}
