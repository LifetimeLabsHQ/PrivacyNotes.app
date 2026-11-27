import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { paintedSlot, peekThemeMode, previewCustomTheme, useTheme, type Theme } from './theme';
import { BUILTIN_THEME_CODES } from './builtinThemeCodes';
import { CUSTOM_THEME_MAX, newCustomThemeId } from './customThemes';
import { THEME_ICON_PX } from './customIcons';
import { snapshotOf } from './customThemeUI';
import { NO_TEXT_ASSIST } from './formFields';
import { ensureLooksLoaded } from './i18n';
import type { ThemeBuilderTarget } from './notesView/useThemeBuilder';
import * as tc from './themeCode';
import type { CheckId, CustomTheme, MoreKey, SeedKey, ThemeCheck } from './themeCode';
import { useEscapeToClose } from './useEscapeToClose';
import { HoverLabel } from './HoverLabel';
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
  Check,
  Copy,
  Eye,
  FloppyDisk,
  MagicWand,
  Moon,
  Sun,
  Trash,
  Upload,
  Warning,
} from './icons';
import {
  Badge,
  Button,
  Callout,
  CloseButton,
  FIELD_CLASS,
  IconButton,
  IconUpgrade,
  SETTINGS_TRACK,
  settingsSegClass,
  TextField,
} from './ui';

/**
 * The theme builder: a floating panel over the app while the app itself is the
 * live preview, repainted on every change. Settings is closed while it is open.
 * Nothing is stored until Save; Cancel, Escape and closing put the saved slots
 * back.
 *
 * The panel keeps the colors the app had when it opened, so an experiment that
 * makes the app unreadable never hides Save or Cancel: it sets the resolved
 * `--color-*` values, which every color utility reads, on itself.
 * Spec: docs/contrib/color-themes.md (section 6)
 */

const PINNED = [
  '--color-accent', '--color-accent-hover', '--color-accent-strong', '--color-accent-fill',
  '--color-accent-fill-hover', '--color-danger', '--color-warning', '--color-success', '--color-pro',
  '--color-warm', '--color-surface-0', '--color-surface-1', '--color-surface-2', '--color-divider',
  '--color-track', '--color-pn-soft', '--color-pn', '--color-pn-muted',
];

const ICON_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.ico';

// The tile order. The accent leads, because every suggestion and Fill the
// rest start from it; a code still writes the seeds in SEED_KEYS order.
const SEEDS: SeedKey[] = ['accent', 'background', 'sidebar', 'border', 'text', 'muted'];
const MORE: MoreKey[] = ['list', 'paper', 'well', 'soft', 'hover', 'fill', 'fillhover', 'danger', 'warning', 'success', 'label'];

/** The exact code of the theme on screen in a mode, as a starting point. */
function paintedCode(mode: Theme): string {
  const { choice, snapshot } = paintedSlot(mode);
  return snapshot?.code ?? BUILTIN_THEME_CODES[mode][choice] ?? BUILTIN_THEME_CODES[mode]['default']!;
}

/** `#abc123`, `abc123` or `ABC123` as `#ABC123`; anything else is null. */
function readHex(input: string): string | null {
  const m = /^#?([0-9A-Fa-f]{6})$/.exec(input.trim());
  return m ? `#${m[1]!.toUpperCase()}` : null;
}

export function ThemeBuilder({
  target,
  initialIcon = null,
  canSave,
  hasRoom,
  onSave,
  onClose,
  onOpenUpgrade,
}: {
  target: ThemeBuilderTarget;
  /** Saved or duplicated custom sidebar app icon for this theme, if any. */
  initialIcon?: string | null;
  /** Pro, or the demo. */
  canSave: boolean;
  /** Whether a save under this id fits the limit of your own themes. */
  hasRoom: (id: string) => boolean;
  onSave: (id: string, code: string, icon: string | null) => void;
  onClose: () => void;
  /** Save with Pro: hands over the draft's code and icon, so it opens again after the upgrade. */
  onOpenUpgrade: (code: string, icon: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  const { t: tLooks } = useTranslation('looks');
  const { theme: paintedMode, pickTheme } = useTheme();
  const idRef = useRef(target.id ?? newCustomThemeId());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pinned] = useState<CSSProperties>(() => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(PINNED.map((v) => [v, cs.getPropertyValue(v).trim()])) as CSSProperties;
  });
  const [draft, setDraft] = useState<CustomTheme | null>(null);
  const [nameText, setNameText] = useState('');
  const [authorText, setAuthorText] = useState('');
  const [customIcon, setCustomIcon] = useState<string | null>(initialIcon);
  const [iconBusy, setIconBusy] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);
  const [iconDragOver, setIconDragOver] = useState(false);
  // The credit the opened code carried. A change of any color drops it from
  // the draft (withValue), and the field empties with it once: the colors are
  // the editor's now, and they may credit themselves.
  const inherited = useRef<string | undefined>(undefined);
  const [moreOpen, setMoreOpen] = useState(false);
  const [allChecks, setAllChecks] = useState(false);
  const [copied, setCopied] = useState(false);
  // Save keeps the builder open: the button shows a check for a moment, and
  // Cancel hides while nothing is unsaved.
  const [justSaved, setJustSaved] = useState(0);
  const [full, setFull] = useState(false);
  const [savedState, setSavedState] = useState<{ code: string; icon: string | null } | null>(null);
  const shownMode = useRef<Theme | null>(null);

  // Load `looks` strings lazily so custom-icon labels and errors reuse the shared catalog.
  useEffect(() => {
    void ensureLooksLoaded();
  }, []);

  // The draft starts from the theme being edited, copied or pasted, or as an
  // exact copy of the theme on screen, so opening the builder changes nothing
  // on screen until a color or icon does.
  useEffect(() => {
    if (draft) return;
    let start = target.code ? tc.parseThemeCode(target.code) : null;
    // A new theme starts with an empty name field: the placeholder shows the
    // name it gets when the person types none.
    const fresh = !start;
    // A new theme copies the colors on screen, never their credit.
    if (!start) start = { ...tc.withoutAuthor(tc.parseThemeCode(paintedCode(paintedMode))!), name: t('appearance.custom.namePlaceholder') };
    if (target.name) start = { ...start, name: target.name };
    setDraft(start);
    setNameText(fresh && !target.name ? '' : start.name);
    inherited.current = start.author;
    setAuthorText(start.author ?? '');
    // The target is fixed for the builder's life (NotesView keys it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  useEffect(() => {
    if (!draft || draft.author !== undefined || inherited.current === undefined) return;
    if (authorText === inherited.current) setAuthorText('');
    inherited.current = undefined;
    // Only a dropped credit matters here, not every keystroke in the field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const name = tc.cleanThemeName(nameText.trim() ? nameText : t('appearance.custom.namePlaceholder'));
  const authorRaw = authorText.trim().replace(/^@/, '');
  const authorOk = authorRaw === '' || tc.AUTHOR.test(authorRaw);
  const author = authorOk && authorRaw ? authorRaw : undefined;
  const theme = draft && name ? { ...tc.withoutAuthor(draft), name, ...(author ? { author } : {}) } : draft;
  const resolved = useMemo(() => (theme ? tc.resolveTheme(theme) : null), [theme]);
  const checks = useMemo(() => (theme ? tc.checkTheme(theme) : []), [theme]);
  const failing = checks.filter((c) => !c.pass);
  const snapshot = theme ? snapshotOf(idRef.current, theme, customIcon) : null;
  const code = snapshot?.code ?? '';

  // Paint the draft on every change, in the slot of its mode, without the
  // crossfade. A draft that changes mode leaves the slot it was in.
  useEffect(() => {
    if (!snapshot) return;
    if (shownMode.current && shownMode.current !== snapshot.mode) previewCustomTheme(shownMode.current, null);
    shownMode.current = snapshot.mode;
    if (snapshot.mode !== paintedMode) peekThemeMode(snapshot.mode);
    previewCustomTheme(snapshot.mode, snapshot);
    // The canonical code and custom icon carry everything the snapshot paints.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, customIcon]);

  // Closing in any way puts the saved slots and the stored mode back.
  useEffect(
    () => () => {
      if (shownMode.current) previewCustomTheme(shownMode.current, null);
      peekThemeMode(null);
    },
    [],
  );

  useEscapeToClose(onClose, true);

  if (!draft || !resolved || !snapshot) return null;

  const set = (key: SeedKey | MoreKey, hex: string) => setDraft((d) => (d ? tc.withValue(d, key, hex) : d));
  const reset = (key: MoreKey) =>
    setDraft((d) => {
      if (!d || d.overrides[key] === undefined) return d;
      const overrides = { ...d.overrides };
      delete overrides[key];
      return { ...tc.withoutAuthor(d), overrides };
    });
  const fix = (key: SeedKey | MoreKey) => setDraft((d) => (d ? tc.fixTheme(d, key) : d));
  const value = (key: SeedKey | MoreKey) =>
    (SEEDS as string[]).includes(key)
      ? draft.seeds[key as SeedKey]
      : draft.overrides[key as MoreKey] ?? resolved.suggested[key as MoreKey];
  const ready = name !== null && authorOk && failing.length === 0;
  const isCleanAfterSave = savedState !== null && savedState.code === code && savedState.icon === customIcon;

  async function handleIconFiles(files: FileList | File[] | null) {
    const file = files?.[0];
    if (!file || iconBusy) return;
    setIconBusy(true);
    setIconError(null);
    try {
      const { processCustomIcon, CustomIconError } = await import('./looks/customIconProcess');
      const dataUrl = await processCustomIcon(file, THEME_ICON_PX);
      setCustomIcon(dataUrl);
    } catch (err) {
      const { CustomIconError } = await import('./looks/customIconProcess');
      const errCode = err instanceof CustomIconError ? err.code : 'decodeFailed';
      setIconError(
        errCode === 'unsupported'
          ? tLooks('customErrorUnsupported')
          : errCode === 'tooLarge'
            ? tLooks('customErrorTooLarge')
            : tLooks('customErrorDecode'),
      );
    } finally {
      setIconBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function onIconDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIconDragOver(false);
    if (!iconBusy) void handleIconFiles(e.dataTransfer.files);
  }

  function save() {
    if (!ready || !snapshot) return;
    if (!hasRoom(idRef.current)) {
      setFull(true);
      return;
    }
    // The screen moves to the theme's mode, as a click on a theme card does.
    pickTheme(snapshot.mode, snapshot, target.space);
    shownMode.current = null;
    onSave(idRef.current, snapshot.code, customIcon);
    setSavedState({ code: snapshot.code, icon: customIcon });
    const at = Date.now();
    setJustSaved(at);
    window.setTimeout(() => setJustSaved((v) => (v === at ? 0 : v)), 1400);
  }

  function copy() {
    if (name === null || !authorOk) return;
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  const checkLabel = (id: CheckId) => t(`appearance.custom.check.${id}`);
  const advice = (c: ThemeCheck) =>
    c.id === 'sides'
      ? t('appearance.custom.sides')
      : resolved.mode === 'dark'
        ? t('appearance.custom.darker')
        : t('appearance.custom.lighter');

  const summary = tc.contrastSummary(checks);
  const isSeedKey = (k: SeedKey | MoreKey | null): k is SeedKey => k !== null && (SEEDS as string[]).includes(k);
  const moreFails = failing.some((c) => c.fix !== null && !isSeedKey(c.fix));
  const title = target.id ? t('appearance.custom.builderEdit') : t('appearance.custom.builderNew');

  // A tile is the color picker itself: the input covers the tile, so the
  // picker opens from a tap anywhere on it and anchors where the tile is.
  // The badge sits on a chip of the panel's own surface, where the success
  // and warning colors are measured, so it reads on a tile of any color.
  const tile = (key: SeedKey) => {
    const hex = draft.seeds[key];
    const label = t(`appearance.custom.seed.${key}`);
    const owned = checks.filter((c) => c.fix === key || (key === 'background' && c.fix === null));
    const fails = owned.some((c) => !c.pass);
    return (
      <div key={key} className="min-w-0">
        <label
          className={`relative block h-11 cursor-pointer rounded-lg border shadow-xs transition focus-within:ring-2 focus-within:ring-accent ${
            fails ? 'border-warning' : 'border-divider'
          }`}
          style={{ backgroundColor: hex }}
        >
          <input
            type="color"
            value={hex.toLowerCase()}
            onChange={(e) => set(key, e.target.value.toUpperCase())}
            aria-label={t('appearance.custom.colorField', { label })}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
          {owned.length > 0 && (
            <span className="pointer-events-none absolute top-1 end-1 flex rounded bg-surface-2/95 p-0.5 shadow-xs">
              {fails ? (
                <Warning weight="fill" className="text-warning" aria-hidden="true" />
              ) : (
                <Check weight="bold" className="text-success" aria-hidden="true" />
              )}
            </span>
          )}
        </label>
        <p className="mt-1 truncate text-meta font-medium text-pn-soft">{label}</p>
        <HexField value={hex} label={label} onChange={(h) => set(key, h)} wide />
      </div>
    );
  };

  // The eleven suggested colors keep the row layout: these are the advanced
  // ones, and Reset sits before the hex field so every hex field lines up.
  const row = (key: MoreKey, label: string, overridden: boolean) => (
    <div key={key} className="flex items-center gap-2 py-0.5">
      <input
        type="color"
        value={value(key).toLowerCase()}
        onChange={(e) => set(key, e.target.value.toUpperCase())}
        aria-label={t('appearance.custom.colorField', { label })}
        className="h-6 w-6 shrink-0 cursor-pointer rounded border border-divider bg-transparent p-0"
      />
      <span className="min-w-0 flex-1 truncate text-small text-pn-soft">{label}</span>
      <IconButton
        label={t('appearance.custom.reset')}
        tone="accent"
        onClick={() => reset(key)}
        disabled={!overridden}
        className="!h-6 !w-6 disabled:invisible"
      >
        <ArrowCounterClockwise aria-hidden="true" />
      </IconButton>
      <HexField value={value(key)} label={label} onChange={(hex) => set(key, hex)} />
    </div>
  );

  const summaryText =
    summary.state === 'pass'
      ? t('appearance.custom.contrastPass')
      : summary.state === 'one'
        ? t('appearance.custom.contrastOne', { label: checkLabel(summary.check.id) })
        : summary.state === 'many'
          ? t('appearance.custom.contrastMany', { count: summary.count })
          : advice(summary.check);

  return (
    <div
      role="dialog"
      aria-label={title}
      style={pinned}
      className="fixed z-50 inset-x-2 bottom-2 max-h-[70dvh] sm:inset-x-auto sm:bottom-4 sm:end-4 sm:w-[364px] sm:max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden rounded-xl border border-divider bg-surface-2 text-pn shadow-xl"
    >
      {/* Header */}
      <div className="shrink-0 border-b border-divider px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-title font-semibold">{title}</h2>
          <HoverLabel label={t('appearance.custom.modeHint')} position="below-end" multiline>
            <Badge>{resolved.mode === 'dark' ? t('common:ninja.themes.dark') : t('common:ninja.themes.light')}</Badge>
          </HoverLabel>
          <IconButton
            label={copied ? t('auth:createPhrase.copied') : t('appearance.custom.copyCode')}
            position="below-end"
            onClick={copy}
            disabled={name === null}
          >
            {copied ? <Check weight="bold" className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </IconButton>
          <CloseButton onClick={onClose} />
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-meta text-pn-muted">
          <Eye aria-hidden="true" className="shrink-0" />
          <span>{t('appearance.custom.previewHint')}</span>
        </p>
      </div>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5 space-y-3.5">
        {/* Accent palette helper */}
        <div className="flex items-center gap-2 rounded-lg border border-divider/70 bg-track/70 px-2.5 py-2">
          <MagicWand aria-hidden="true" className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 text-meta text-pn-soft">{t('appearance.custom.suggestTitle')}</span>
          <div className="flex shrink-0 items-center gap-1">
            {(['light', 'dark'] as const).map((m) => (
              <Button
                key={m}
                icon={m === 'light' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
                onClick={() => setDraft((d) => (d ? tc.suggestFromAccent(d, m) : d))}
                className="!px-2 !py-1 !text-meta"
              >
                {m === 'light' ? t('appearance.custom.suggestLight') : t('appearance.custom.suggestDark')}
              </Button>
            ))}
          </div>
        </div>

        {/* Six primary colors */}
        <div className="grid grid-cols-3 gap-2.5">{SEEDS.map(tile)}</div>

        {/* Advanced suggested colors */}
        <div className="rounded-lg border border-divider/80 bg-track/40">
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-small font-medium text-pn-soft hover:text-pn transition"
          >
            {moreOpen ? <CaretDown aria-hidden="true" /> : <CaretRight aria-hidden="true" />}
            <span>{t('appearance.custom.more')}</span>
            {!moreOpen && moreFails && <Warning weight="fill" className="ms-auto text-warning" aria-hidden="true" />}
          </button>
          {moreOpen && (
            <div className="border-t border-divider/70 px-3 pb-2.5 pt-2">
              <p className="text-meta text-pn-muted">{t('appearance.custom.moreHelp')}</p>
              <div className="mt-1.5 space-y-0.5">
                {MORE.map((k) => row(k, t(`appearance.custom.moreKey.${k}`), draft.overrides[k] !== undefined))}
              </div>
            </div>
          )}
        </div>

        {/* Logo style + single custom icon upload per theme */}
        <div
          className="rounded-lg border border-divider/80 bg-surface-2 p-3 space-y-2.5"
          onDragOver={(e) => {
            e.preventDefault();
            if (!iconBusy) setIconDragOver(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setIconDragOver(false);
          }}
          onDrop={onIconDrop}
        >
          <div>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-small font-semibold text-pn">{t('appearance.custom.logoTitle')}</span>
              <div role="group" aria-label={t('appearance.custom.logoTitle')} className={SETTINGS_TRACK}>
                {([undefined, 'original'] as const).map((v) => (
                  <button
                    key={v ?? 'tint'}
                    type="button"
                    aria-pressed={draft.logo === v}
                    onClick={() => setDraft((d) => (d ? tc.withLogo(d, v) : d))}
                    className={`${settingsSegClass(draft.logo === v)} !px-2.5 !py-0.5 !text-meta`}
                  >
                    {t(v === 'original' ? 'appearance.custom.logoOriginal' : 'settings:appearance.custom.seed.accent')}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1 text-meta text-pn-muted">{t('appearance.custom.logoHelp')}</p>
          </div>

          {customIcon ? (
            <div
              className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition ${
                iconDragOver ? 'border-accent bg-accent/10' : 'border-divider bg-track/60'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={ICON_ACCEPT}
                disabled={iconBusy}
                className="sr-only"
                onChange={(e) => void handleIconFiles(e.target.files)}
              />
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-divider bg-surface-2 p-1">
                <img
                  src={customIcon}
                  alt=""
                  width={32}
                  height={32}
                  aria-hidden="true"
                  className="h-full w-full rounded-[20%] object-contain"
                  draggable={false}
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-small font-medium text-pn">{tLooks('customIcon')}</p>
                <p className="text-meta text-pn-muted">{t('appearance.custom.customIconSynced')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <IconButton
                  label={t('appearance.custom.customIconReplace')}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={iconBusy}
                >
                  <Upload aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={tLooks('customRemoveAria')}
                  tone="danger"
                  onClick={() => {
                    setCustomIcon(null);
                    setIconError(null);
                  }}
                >
                  <Trash aria-hidden="true" />
                </IconButton>
              </div>
            </div>
          ) : (
            <label
              className={`flex w-full items-center gap-2.5 rounded-lg border border-dashed px-3 py-2.5 transition ${
                iconBusy
                  ? 'border-divider/60 bg-track/40 opacity-60 cursor-not-allowed'
                  : iconDragOver
                    ? 'border-accent bg-accent/10 cursor-pointer'
                    : 'border-divider bg-track/40 hover:border-accent/60 hover:bg-track/70 cursor-pointer focus-within:ring-2 focus-within:ring-accent/40'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={ICON_ACCEPT}
                disabled={iconBusy}
                className="sr-only"
                onChange={(e) => void handleIconFiles(e.target.files)}
              />
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent" aria-hidden="true">
                <Upload size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small font-medium text-pn">{t('appearance.custom.customIconUploadTitle')}</span>
                <span className="block text-meta text-pn-muted">{t('appearance.custom.customIconHint')}</span>
              </span>
            </label>
          )}

          {iconError && <Callout tone="danger">{iconError}</Callout>}
        </div>

        {/* Contrast summary */}
        <div className="rounded-lg border border-divider/80 bg-track/40 px-3 py-2">
          <div className="flex items-center gap-2 text-small">
            <span className={`flex min-w-0 flex-1 items-center gap-1.5 font-medium ${summary.state === 'pass' ? 'text-success' : 'text-warning'}`}>
              {summary.state === 'pass' ? (
                <Check weight="bold" aria-hidden="true" className="shrink-0" />
              ) : (
                <Warning weight="fill" aria-hidden="true" className="shrink-0" />
              )}
              <span className="min-w-0">{summaryText}</span>
            </span>
            {summary.state === 'one' && (
              <Button icon={<MagicWand aria-hidden="true" />} onClick={() => fix(summary.check.fix!)} className="!px-2 !py-0.5 !text-meta">
                {t('appearance.custom.fix')}
              </Button>
            )}
            {summary.state === 'many' && (
              <Button icon={<MagicWand aria-hidden="true" />} onClick={() => setDraft((d) => (d ? tc.fixAll(d) : d))} className="!px-2 !py-0.5 !text-meta">
                {t('appearance.custom.fixAll')}
              </Button>
            )}
            <button
              type="button"
              onClick={() => setAllChecks((o) => !o)}
              aria-expanded={allChecks}
              className="shrink-0 text-meta font-medium text-accent hover:underline"
            >
              {allChecks ? t('appearance.custom.hideDetails') : t('appearance.custom.details')}
            </button>
          </div>
          {allChecks && (
            <div className="mt-2 border-t border-divider/70 pt-2">
              <Callout className="mb-1.5">{t('appearance.custom.contrastHelp')}</Callout>
              <ul className="space-y-1">
                {checks.map((c) => (
                  <li key={c.id} className="text-small">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-pn-soft">{checkLabel(c.id)}</span>
                      {c.ratio !== null ? (
                        <span className={`tabular-nums ${c.pass ? 'text-success' : 'text-danger'}`}>
                          {c.ratio.toFixed(1)}:1
                        </span>
                      ) : (
                        c.pass && <Check weight="bold" aria-hidden="true" className="shrink-0 text-success" />
                      )}
                      {!c.pass && c.fix && (
                        <Button icon={<MagicWand aria-hidden="true" />} onClick={() => fix(c.fix!)} className="!px-2 !py-0.5 !text-meta">
                          {t('appearance.custom.fix')}
                        </Button>
                      )}
                    </div>
                    {!c.pass && !c.fix && <p className="mt-0.5 text-meta text-pn-muted">{advice(c)}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Sticky footer: Name, Credit, and full-width Cancel / Save actions */}
      <div className="shrink-0 border-t border-divider bg-surface-2 px-4 py-3">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2">
          <label htmlFor="pn-theme-name" className="text-small font-medium text-pn-muted">
            {t('shell:filesList.sortName')}
          </label>
          <TextField
            id="pn-theme-name"
            size="sm"
            value={nameText}
            onChange={(e) => setNameText(e.target.value)}
            maxLength={tc.THEME_NAME_INPUT_MAX}
            dir="auto"
            placeholder={t('appearance.custom.namePlaceholder')}
          />
          {/* Optional credit, written into the code as `by=`, so a code shared
              with friends names its maker and tells us how to credit it on
              /themes. A GitHub username, because that page links to it. */}
          <label htmlFor="pn-theme-credit" className="text-small font-medium text-pn-muted">
            {t('appearance.custom.credit')}
          </label>
          <div className="flex min-w-0 items-center rounded-md border border-divider bg-track ps-2.5 text-body text-pn focus-within:ring-2 focus-within:ring-accent/40" dir="ltr">
            <span className="text-pn-muted" aria-hidden="true">@</span>
            <input
              id="pn-theme-credit"
              value={authorText}
              onChange={(e) => setAuthorText(e.target.value)}
              maxLength={40}
              autoComplete="off"
              {...NO_TEXT_ASSIST}
              placeholder={t('appearance.custom.creditPlaceholder')}
              aria-invalid={!authorOk}
              className="min-w-0 flex-1 bg-transparent px-1 py-1.5 outline-none"
            />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 [&>:only-child]:col-span-2">
          {!isCleanAfterSave && (
            <Button action="cancel" onClick={onClose} className="w-full justify-center" />
          )}
          {canSave ? (
            <Button
              variant="primary"
              icon={
                justSaved ? (
                  <Check key={justSaved} weight="bold" aria-hidden="true" className="pn-pop" />
                ) : (
                  <FloppyDisk aria-hidden="true" />
                )
              }
              onClick={save}
              disabled={!ready}
              className="w-full justify-center"
            >
              {t('common:actions.save')}
            </Button>
          ) : (
            <Button
              variant="upgrade"
              icon={<IconUpgrade size={12} />}
              onClick={() => onOpenUpgrade(code, customIcon)}
              className="w-full justify-center"
            >
              {t('appearance.custom.saveWithPro')}
            </Button>
          )}
        </div>

        {!authorOk && <p className="mt-1.5 text-meta text-danger">{t('appearance.custom.creditInvalid')}</p>}
        {full && <Callout tone="danger" className="mt-2">{t('appearance.custom.themeLimit', { max: CUSTOM_THEME_MAX })}</Callout>}
        {name === null && <p className="mt-1.5 text-meta text-danger">{t('appearance.custom.nameInvalid')}</p>}
        {name !== null && canSave && !ready && <p className="mt-1.5 text-meta text-pn-muted">{t('appearance.custom.saveHint')}</p>}
      </div>
    </div>
  );
}

/** A hex field that takes what is typed and commits once it is a color. */
function HexField({ value, label, onChange, wide = false }: { value: string; label: string; onChange: (hex: string) => void; wide?: boolean }) {
  const { t } = useTranslation('settings');
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value);
  }, [value, focused]);
  return (
    <input
      value={focused ? text : value}
      onChange={(e) => {
        setText(e.target.value);
        const hex = readHex(e.target.value);
        if (hex) onChange(hex);
      }}
      onFocus={() => { setFocused(true); setText(value); }}
      onBlur={() => setFocused(false)}
      maxLength={7}
      autoComplete="off"
      {...NO_TEXT_ASSIST}
      dir="ltr"
      aria-label={t('appearance.custom.hexField', { label })}
      className={`${FIELD_CLASS} ${wide ? 'mt-0.5 w-full' : '!w-[76px]'} shrink-0 !bg-track !px-1.5 !py-0.5 font-mono !text-meta ${
        focused && !readHex(text) ? '!border-danger' : ''
      }`}
    />
  );
}
