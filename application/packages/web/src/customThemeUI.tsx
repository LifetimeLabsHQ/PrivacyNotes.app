import { toggleQuickTheme } from './quickThemes';
import { NO_TEXT_ASSIST } from './formFields';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { parseThemeCode, resolveTheme, serializeThemeCode, themePasses, withoutAuthor, type CustomTheme } from './themeCode';
import { canSaveCustomTheme, CUSTOM_THEME_MAX, deleteCustomTheme, liveCustomThemes, newCustomThemeId, saveCustomTheme, type CustomThemes } from './customThemes';
import { deleteCustomIcon, isValidCustomIconDataUrl, themeIconDataUrl, type CustomIcons } from './customIcons';
import { TEAM_THEMES } from './teamThemes';
import { COMMUNITY_THEMES, THEME_DISCUSSIONS_URL } from './communityThemes';
import { openExternal } from './openExternal';
import { textMatcher } from './textMatch';
import { clearCustomThemeId, customChoice, isFreeTheme, peekThemeMode, previewCustomTheme, type ColorTheme, type CustomSnapshot, type Theme, type ThemeChoice } from './theme';
import { BUILTIN_THEME_CODES } from './builtinThemeCodes';
import type { ContextMenuItem } from './ContextMenu';
import type { ThemeBuilderTarget } from './notesView/useThemeBuilder';
import { ConfirmModal } from './ConfirmModal';
import { CardMenuButton, QuickStarButton } from './ThemeCardMenuButton';
import { ArrowSquareOut, CaretDown, CaretUp, Copy, PencilSimple, Trash } from './icons';
import { Button, IconUpgrade, TextField, ThemeSwatchCard } from './ui';

/**
 * The team and custom theme UI of Settings > Design and of
 * the footer popover: the extra cards of each gallery with their menus, and
 * the Paste theme code field. A lazy chunk, with the theme code module in it,
 * so none of it is on the boot path: the built-in cards show first and these
 * join them a moment later.
 * Spec: docs/contrib/color-themes.md (section 6)
 */

export interface CustomThemeEntry {
  id: string;
  theme: CustomTheme;
  snapshot: CustomSnapshot;
  /** A theme the app ships (the team's or the community's), which a person
   *  copies but never edits or deletes; absent on a theme of your own. */
  team?: boolean;
  /** One of the community themes, credited by its code's `by=`. */
  community?: boolean;
  /** A community theme's discussion thread. */
  discussion?: number;
}

/** The extra cards a gallery shows before Show all: with the row of built-in
 *  palettes, three rows of four.
 *  Spec: docs/contrib/color-themes.md (section 6) */
const EXTRA_COLLAPSED = 8;

/** What a slot paints for a theme: its resolved colors, under its id. */
export function snapshotOf(id: string, theme: CustomTheme, icon?: string | null): CustomSnapshot {
  const resolved = resolveTheme(theme);
  const colors: Record<string, string> = { ...resolved.colors, label: resolved.label, paper: resolved.paper };
  const validIcon = icon && isValidCustomIconDataUrl(icon) ? icon : undefined;
  return {
    id,
    code: serializeThemeCode(theme),
    mode: resolved.mode,
    colors,
    ...(theme.logo ? { logo: theme.logo } : {}),
    ...(validIcon ? { icon: validIcon } : {}),
  };
}

/** The themes the app ships: the team's, then the community's, each in the
 *  order of its list. A build takes in every community theme added before it;
 *  /themes may list newer ones. An entry is never removed: a slot that names
 *  a theme this version does not list goes back to Default (reconcileCustomSlots). */
export function teamThemeEntries(): CustomThemeEntry[] {
  const read = (list: { id: string; code: string; discussion?: number }[], community: boolean) =>
    list.flatMap(({ id, code, discussion }) => {
      const theme = parseThemeCode(code);
      return theme
        ? [{ id, theme, snapshot: snapshotOf(id, theme), team: true, ...(community ? { community, discussion } : {}) }]
        : [];
    });
  // Community themes newest first.
  const community = [...COMMUNITY_THEMES].sort((a, b) => b.added.localeCompare(a.added));
  return [...read(TEAM_THEMES, false), ...read(community, true)];
}

/** The name of a custom, team or community theme, by its id. */
export function themeNameOf(id: string, themes: CustomThemes): string | null {
  const entry = [...customThemeEntries(themes), ...teamThemeEntries()].find((e) => e.id === id);
  return entry?.theme.name ?? null;
}

/** The listed themes this version can paint, sorted by name. */
export function customThemeEntries(themes: CustomThemes, themeIcons?: CustomIcons): CustomThemeEntry[] {
  return liveCustomThemes(themes)
    .flatMap(({ id, code }) => {
      const theme = parseThemeCode(code);
      return theme ? [{ id, theme, snapshot: snapshotOf(id, theme, themeIconDataUrl(themeIcons, id)) }] : [];
    })
    .sort((a, b) => a.theme.name.localeCompare(b.theme.name));
}

/** What the extra cards and the paste field need from the gallery around them. */
export interface ThemeGalleryCtx {
  customThemes: CustomThemes;
  themeIcons?: CustomIcons;
  isPro: boolean;
  /** Pro, or the demo. */
  canSave: boolean;
  lightTheme: ThemeChoice;
  darkTheme: ThemeChoice;
  /** The mode painted now. */
  painted: Theme;
  /** A card click: save it in its slot, or preview it on a free account. */
  pick: (mode: Theme, choice: ThemeChoice, snapshot?: CustomSnapshot) => void;
  openMenu: (e: MouseEvent<HTMLButtonElement>, items: ContextMenuItem[]) => void;
  /** "<name> copy", short enough for a name. */
  copyName: (name: string) => string;
  onCopied: (name: string) => void;
  setColorTheme: (mode: Theme, choice: ThemeChoice) => void;
  openUpgrade: () => void;
  /** The themes marked for the Design quick menu, and the menu row's action. */
  quickMarks: Record<Theme, ThemeChoice[]>;
  /** The card's star: add the theme to the quick menu or take it out. */
  star: (mode: Theme, choice: ThemeChoice) => void;
  /** Embedded pane only. */
  onChange?: (update: (prev: CustomThemes) => CustomThemes) => void;
  onThemeIconsChange?: (update: (prev: CustomIcons) => CustomIcons) => void;
  openBuilder?: (target: ThemeBuilderTarget) => void;
}

/** Your own themes, the team's and the community's of one mode, as gallery
 *  cards: the first EXTRA_COLLAPSED and the one the slot shows, every one
 *  after Show all, or the ones a search finds by name or author. */
export function ExtraThemeCards({ mode, compact, ctx, query = '', builtinCount = 0, expanded = false, onExpand, only }: {
  mode: Theme;
  compact: boolean;
  ctx: ThemeGalleryCtx;
  /** The gallery's search, trimmed; it finds a name or an author. */
  query?: string;
  /** The built-in cards the gallery draws before these, for the Show all count. */
  builtinCount?: number;
  expanded?: boolean;
  /** Draws the Show all button and takes its click. */
  onExpand?: (open: boolean) => void;
  /** One theme by id, for the quick menu; it draws nothing when the theme is gone. */
  only?: string;
}) {
  const { t } = useTranslation('settings');
  const team = useMemo(() => teamThemeEntries(), []);
  const own = useMemo(() => customThemeEntries(ctx.customThemes, ctx.themeIcons), [ctx.customThemes, ctx.themeIcons]);
  const [deleting, setDeleting] = useState<CustomThemeEntry | null>(null);
  const active = mode === 'dark' ? ctx.darkTheme : ctx.lightTheme;
  // Your own first: they are the ones a person looks for.
  const all = useMemo(() => [...own, ...team].filter((e) => e.snapshot.mode === mode), [own, team, mode]);
  const entries = useMemo(() => {
    if (only !== undefined) return [...team, ...own].filter((e) => e.id === only);
    if (query) {
      const match = textMatcher(query);
      return all.filter((e) => match(e.theme.name) || (e.theme.author && match(e.theme.author)));
    }
    if (expanded) return all;
    return all.filter((e, i) => i < EXTRA_COLLAPSED || active === customChoice(e.id));
  }, [team, own, all, only, query, expanded, active]);

  function copyCode(entry: CustomThemeEntry) {
    void navigator.clipboard?.writeText(entry.snapshot.code).then(() => ctx.onCopied(entry.theme.name));
  }

  function openMenu(e: MouseEvent<HTMLButtonElement>, entry: CustomThemeEntry) {
    const copyItems: ContextMenuItem[] = [
      {
        label: t('shell:contextMenu.duplicate'),
        icon: <PencilSimple />,
        onSelect: () => ctx.openBuilder?.({
          code: serializeThemeCode({ ...entry.theme, name: ctx.copyName(entry.theme.name) }),
          ...(entry.snapshot.icon ? { icon: entry.snapshot.icon } : {}),
        }),
      },
      { label: t('appearance.custom.copyCode'), icon: <Copy />, onSelect: () => copyCode(entry) },
    ];
    // The credit heads the menu, in the case its author wrote it.
    const credit: ContextMenuItem[] = entry.theme.author
      ? [{ type: 'header', label: t('appearance.custom.madeBy', { author: entry.theme.author }), keepCase: true }]
      : [];
    if (entry.team) {
      const thread = entry.discussion;
      ctx.openMenu(
        e,
        thread
          ? [
              ...credit,
              ...copyItems,
              { type: 'separator' },
              {
                label: t('appearance.custom.vote'),
                icon: <ArrowSquareOut />,
                onSelect: () => openExternal(`${THEME_DISCUSSIONS_URL}/${thread}`),
              },
            ]
          : [...credit, ...copyItems],
      );
      return;
    }
    ctx.openMenu(e, [
      ...credit,
      {
        label: t('common:actions.edit'),
        icon: <PencilSimple />,
        onSelect: () => ctx.openBuilder?.({ id: entry.id, code: entry.snapshot.code }),
      },
      ...copyItems,
      { type: 'separator' },
      { label: t('common:actions.delete'), icon: <Trash />, destructive: true, onSelect: () => setDeleting(entry) },
    ]);
  }

  function remove(entry: CustomThemeEntry) {
    ctx.onChange?.((prev) => deleteCustomTheme(prev, entry.id));
    ctx.onThemeIconsChange?.((prev) => deleteCustomIcon(prev, entry.id));
    if (ctx.quickMarks[mode].includes(customChoice(entry.id))) toggleQuickTheme(mode, customChoice(entry.id));
    clearCustomThemeId(mode, entry.id);
  }

  return (
    <>
      {entries.map((entry) => (
        <CustomThemeCard
          key={entry.id}
          entry={entry}
          active={active === customChoice(entry.id)}
          compact={compact}
          locked={!ctx.isPro}
          marked={!compact && ctx.quickMarks[mode].includes(customChoice(entry.id))}
          onStar={!compact && ctx.openBuilder ? () => ctx.star(mode, customChoice(entry.id)) : undefined}
          onPick={() => ctx.pick(mode, customChoice(entry.id), entry.snapshot)}
          onMenu={!compact && ctx.openBuilder ? (e) => openMenu(e, entry) : undefined}
        />
      ))}
      {onExpand && !query && all.length > EXTRA_COLLAPSED && (
        <Button
          icon={expanded ? <CaretUp aria-hidden="true" /> : <CaretDown aria-hidden="true" />}
          aria-expanded={expanded}
          onClick={() => onExpand(!expanded)}
          className="col-span-full justify-self-center"
        >
          {expanded ? t('editor:codeBlock.showLess') : t('appearance.showAllThemes', { count: builtinCount + all.length })}
        </Button>
      )}
      {deleting && (
        <ConfirmModal
          title={t('appearance.custom.deleteTitle', { name: deleting.theme.name })}
          confirmLabel={t('common:actions.delete')}
          variant="danger"
          onConfirm={() => { remove(deleting); setDeleting(null); }}
          onClose={() => setDeleting(null)}
        >
          {t('appearance.custom.deleteBody')}
        </ConfirmModal>
      )}
    </>
  );
}

/**
 * The card of a team theme or of a theme a person made: the same three
 * stripes as a built-in card and the name. A theme whose code credits its
 * author carries a people mark on the swatch and names the author on hover.
 */
function CustomThemeCard({
  entry,
  active,
  compact,
  locked,
  marked,
  onStar,
  onPick,
  onMenu,
}: {
  entry: CustomThemeEntry;
  active: boolean;
  compact: boolean;
  /** Pro badge, keyed off isPro like every other card. */
  locked: boolean;
  /** Shown in the Design quick menu. */
  marked: boolean;
  /** The star quick action, in Settings > Design. */
  onStar?: () => void;
  onPick: () => void;
  onMenu?: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useTranslation('settings');
  const c = entry.snapshot.colors;
  const author = entry.theme.author;
  return (
    <ThemeSwatchCard
      name={entry.theme.name}
      colors={[c['surface-0'] ?? '', c.accent ?? '', c.text ?? '']}
      active={active}
      compact={compact}
      pro={locked}
      proLabel={t('appearance.custom.proTheme')}
      community={!!author}
      communityLabel={t('appearance.custom.communityTheme')}
      quick={marked && !onStar}
      quickLabel={t('appearance.quickMenuMarked')}
      onClick={onPick}
      actions={
        onStar || onMenu ? (
          <>
            {onStar && <QuickStarButton name={entry.theme.name} marked={marked} onToggle={onStar} />}
            {onMenu && <CardMenuButton name={entry.theme.name} onClick={onMenu} />}
          </>
        ) : undefined
      }
    />
  );
}

/** The built-in palette a code is the exact code of, if any. */
function builtinOf(code: string): { mode: Theme; choice: ColorTheme } | null {
  for (const mode of ['light', 'dark'] as const) {
    for (const [choice, builtinCode] of Object.entries(BUILTIN_THEME_CODES[mode])) {
      if (builtinCode === code) return { mode, choice: choice as ColorTheme };
    }
  }
  return null;
}

/**
 * Paste theme code: the field reads a code as it arrives and shows the theme
 * at once; Save keeps it. A code that is already a built-in, team or saved
 * theme picks that one. A code with colors that fail a check cannot be saved
 * from here, only opened in the builder, where Fix repairs it.
 */
export function ThemePasteField({ ctx, onClose }: { ctx: ThemeGalleryCtx; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const [text, setText] = useState('');
  const [full, setFull] = useState(false);
  const idRef = useRef(newCustomThemeId());
  const shown = useRef<CustomSnapshot | null>(null);
  const theme = text.trim() ? parseThemeCode(text) : null;
  const entry = theme ? { id: idRef.current, theme, snapshot: snapshotOf(idRef.current, theme) } : null;
  const passes = theme ? themePasses(theme) : false;
  const code = entry?.snapshot.code ?? null;
  const builtin = code ? builtinOf(code) : null;
  // Default is free, so its code is too.
  const savable = ctx.canSave || (builtin !== null && isFreeTheme(builtin.choice));

  // Show the pasted theme while it is in the field, and stop showing it when
  // the field changes or closes without a save. Only a code that passes is
  // painted: a failing one can make this pane unreadable, so it opens in the
  // builder, whose panel keeps its own colors.
  // The mode is asked for on every code, never compared with the mode the
  // pane was rendered in: the cleanup of the code before has just ended its
  // peek, so a second code of the same mode found the old value and showed
  // nothing.
  useEffect(() => {
    if (!entry || !passes) return;
    shown.current = entry.snapshot;
    peekThemeMode(entry.snapshot.mode);
    previewCustomTheme(entry.snapshot.mode, entry.snapshot);
    return () => {
      if (shown.current) {
        previewCustomTheme(shown.current.mode, null);
        peekThemeMode(null);
      }
      shown.current = null;
    };
    // Keyed on the canonical code, which carries every color.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, passes]);

  function save() {
    if (!entry) return;
    const painted = shown.current;
    shown.current = null;
    if (builtin) {
      // The preview showed the code; the pick is the palette itself.
      if (painted) previewCustomTheme(painted.mode, null);
      ctx.pick(builtin.mode, builtin.choice);
      onClose();
      return;
    }
    // The colors decide, not the credit: a shipped theme pasted without its
    // `by=` (or with another one) is still that theme, credit included.
    const colorsOf = (th: CustomTheme) => serializeThemeCode(withoutAuthor(th));
    const existing = [...teamThemeEntries(), ...customThemeEntries(ctx.customThemes)].find(
      (e) => colorsOf(e.theme) === colorsOf(entry.theme),
    );
    if (!existing && !canSaveCustomTheme(ctx.customThemes, entry.id)) {
      shown.current = painted;
      setFull(true);
      return;
    }
    const target = existing ?? entry;
    if (!existing) ctx.onChange?.((prev) => saveCustomTheme(prev, entry.id, entry.snapshot.code));
    ctx.pick(target.snapshot.mode, customChoice(target.id), target.snapshot);
    onClose();
  }

  return (
    <div className="mt-3 rounded-lg border border-divider bg-track p-3">
      <TextField
        id="pn-theme-code"
        label={t('appearance.custom.pasteLabel')}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('appearance.custom.pastePlaceholder')}
        error={text.trim() && !theme ? t('appearance.custom.pasteInvalid') : undefined}
        {...NO_TEXT_ASSIST}
        autoComplete="off"
        autoFocus
        dir="ltr"
        className="font-mono"
      />
      {full && <p className="mt-2 text-small text-danger" role="alert">{t('appearance.custom.themeLimit', { max: CUSTOM_THEME_MAX })}</p>}
      {entry && passes && (
        <p className="mt-2 text-small text-pn-soft">
          {t(entry.snapshot.mode === 'dark' ? 'appearance.custom.pasteDark' : 'appearance.custom.pasteLight', {
            name: entry.theme.name,
          })}
        </p>
      )}
      {entry && !passes && <p className="mt-1 text-small text-warning">{t('appearance.custom.pasteHard')}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {entry && passes && savable && (
          <Button action="save" variant="primary" onClick={save} />
        )}
        {entry && passes && !savable && (
          <Button variant="upgrade" icon={<IconUpgrade size={12} />} onClick={ctx.openUpgrade}>
            {t('appearance.custom.saveWithPro')}
          </Button>
        )}
        {entry && !passes && (
          <Button variant="primary" icon={<PencilSimple aria-hidden="true" />} onClick={() => ctx.openBuilder?.({ code: entry.snapshot.code })}>
            {t('appearance.custom.openInBuilder')}
          </Button>
        )}
        <Button action="cancel" onClick={onClose} />
      </div>
    </div>
  );
}
