import type { FormatBarBoardProps } from '../FormatBarBoard';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { lazyModal } from '../chunkLoad';
import type { TFunction } from 'i18next';
import type { AuthState } from '../auth';
import type { AttachmentStore } from '../attachmentStore';
import type { LocalNote } from '../db';
import { journalOn } from '../notesViewUtils';
import type { FolderDef } from '../folders';
import type { ImportTarget } from '../import/destination';
import type { ImportTab } from '../import/ImportModal';
import type { ImageStore } from '../imageStore';
import type { AppearancePane } from '../AppearanceSheet';
import { exemptOpts } from '../i18nExempt';
import { appZoomSupported } from '../appZoom';
import { Archive, Calendar, ChartBar, CreditCard, Database, Desktop, Info, Keyboard, Question, Repeat, ListBullets, Palette, Heartbeat, PencilLine, Plug, PuzzlePiece, Shield, TerminalWindow, Toolbox, Translate, User, type Icon } from '../icons';
import { proUnlocked } from '../demo';
import { commandLineShown } from '../cliRelease';
import { pluginsShown } from '../onDeviceAi';
import { setPairHidden } from '../dismissedSuggestions';
import { suggestionPairKey } from '../relatedLoader';
import { isTouchOnly } from '../touchOnly';
import { activeLocale } from '../languages';
import { helpPath } from '../localeRoutes';
import { updateNote } from '../notesRepo';
import { endExpiredPinWindow } from '../pin';
import { weekReflectionFor } from '../notesViewUtils';
import type { View } from '../views';
import type { SettingsCategory } from '../SettingsShell';
import { StoragePane } from './StoragePane';
import type { SectionId } from '../settingsSearch/registry';
import { siteHref } from '../siteLinks';
import { loadLocalSettings, settingsBinder, withCredentialChanges, type UserSettings } from '../userSettings';
import { applyNoteColorChoice, noteColorChoice } from '../itemStyles';
import type { ViewMode } from '../viewMode';
import { setDeviceLabel } from '../deviceLabels';
import type { ThemeBuilderTarget } from './useThemeBuilder';
import type { UpgradeTrigger } from '../UpgradeModal';
import type { FeedsControl } from '../calendarFeedUI';

export const StatsModal = lazyModal(() => import('../StatsModal').then((m) => m.StatsModal));
export const AboutModal = lazyModal(() => import('../AboutModal').then((m) => m.AboutModal));
const HotkeysPane = lazyModal(() => import('../HotkeysPane').then((m) => m.HotkeysPane));
export const FeedbackModal = lazyModal(() => import('../FeedbackModal').then((m) => m.FeedbackModal));
const BrowserPane = lazyModal(() => import('../BrowserPane').then((m) => m.BrowserPane));
const CommandLinePane = lazyModal(() => import('../CommandLinePane').then((m) => m.CommandLinePane));
export const SecurityModal = lazyModal(() => import('../SecurityModal').then((m) => m.SecurityModal));
export const PasswordGeneratorModal = lazyModal(() => import('../PasswordGenerator').then((m) => m.PasswordGeneratorModal));
export const SyncOptionsModal = lazyModal(() => import('../SyncOptionsModal').then((m) => m.SyncOptionsModal));
export const ClipPageModal = lazyModal(() => import('../ClipPageModal').then((m) => m.default));
export const NoteHistoryModal = lazyModal(() => import('../NoteHistoryModal').then((m) => m.NoteHistoryModal));
export const ImportModal = lazyModal(() => import('../import/ImportModal').then((m) => m.ImportModal));
export const MediaViewer = lazyModal(() => import('../MediaViewer').then((m) => m.MediaViewer));
export const PicturePicker = lazyModal(() => import('../PicturePicker').then((m) => m.PicturePicker));
// The settings window itself, so a failed load is retried as a whole.
export const SettingsShell = lazyModal(() => import('../SettingsWindow').then((m) => m.SettingsWindow));
export const AppearanceSheet = lazyModal(() => import('../AppearanceSheet').then((m) => m.AppearanceSheet));
const ImagesSheet = lazyModal(() => import('../ImagesSheet').then((m) => m.ImagesSheet));
const LanguageSheet = lazyModal(() => import('../LanguageSheet').then((m) => m.LanguageSheet));
const DateSheet = lazyModal(() => import('../LanguageSheet').then((m) => m.DateSheet));
const CalendarSettings = lazyModal(() => import('../CalendarSettings').then((m) => m.CalendarSettings));
const DateTimePane = lazyModal(() => import('../DateTimePane').then((m) => m.DateTimePane));
const SystemPane = lazyModal(() => import('../SystemPane').then((m) => m.SystemPane));
const PluginsPane = lazyModal(() => import('../plugins/PluginsPane').then((m) => m.PluginsPane));
const TrackerSettingsPane = lazyModal(() => import('../TrackerConfig').then((m) => m.TrackerSettingsPane));

type Authed = Extract<AuthState, { status: 'authenticated' }>;

/** Each section's rail icon. The quick switcher draws it beside a setting. */
export const SETTINGS_SECTION_ICONS: Record<SectionId, Icon> = {
  stats: ChartBar,
  import: Repeat,
  backup: Archive,
  plan: CreditCard,
  storage: Database,
  security: Shield,
  me: User,
  design: Palette,
  editor: PencilLine,
  plugins: Plug,
  formatBar: Toolbox,
  lists: ListBullets,
  trackers: Heartbeat,
  language: Translate,
  date: Calendar,
  hotkeys: Keyboard,
  system: Desktop,
  browser: PuzzlePiece,
  commandLine: TerminalWindow,
  about: Info,
  help: Question,
};

function railIcon(id: SectionId) {
  const RailIcon = SETTINGS_SECTION_ICONS[id];
  return <RailIcon size={18} aria-hidden="true" />;
}

/**
 * Build the SettingsShell categories array. Called inline where the array
 * literal used to sit - fresh on every render, deliberately NOT memoized:
 * the renders close over live view state, and a memoized array would hold
 * stale closures (same rule as contextMenus).
 */
export function buildSettingsCategories({
  t,
  notes,
  openNotesFromSettings,
  allNotes,
  isNoteLocked,
  userSettings,
  mutateSettings,
  onEditorModeChange,
  viewMode,
  onViewModeChange,
  onToggleHiddenView,
  auth,
  settingsAutoVerify,
  settingsSecurityReason,
  onOpenNote,
  setShowSettings,
  setShowUpgrade,
  setImportToast,
  handleSignOutClick,
  mergeImportedFolders,
  importTarget,
  createImportFolder,
  undoImportedFolders,
  mergeRestoredSettings,
  applyImportedTagColors,
  exportAllMarkdownZip,
  exportAllHtmlZip,
  exportAllJson,
  exportEncryptedBackup,
  exportEncryptedFullBackup,
  decryptFullBackup,
  exportVault,
  exportBookmarks,
  exportContacts,
  exportCalendar,
  exportDrawings,
  exportNotesMarkdownZip,
  importEncryptedBackup,
  imageStoreRef,
  attachmentStoreRef,
  refresh,
  runSync,
  saveWeekReflection,
  statsTracker,
  onShowTrackerEntries,
  onShowTrackerInCalendar,
  openThemeBuilder,
  formatBarBoard,
  calendarFeeds,
}: {
  t: TFunction;
  notes: LocalNote[];
  /** Find duplicates' Open both: side by side as tabs where tabs show, else the first. */
  openNotesFromSettings: (ids: string[]) => void;
  /** Every item, the ones of a shut section too: the import duplicate check
   *  and the exports read the whole store (the exports ask for the PIN). */
  allNotes: LocalNote[];
  /** The view's lock predicate, for the readers of a journal's trackers. */
  isNoteLocked: (n: LocalNote) => boolean;
  userSettings: UserSettings;
  mutateSettings: (updater: (prev: UserSettings) => UserSettings) => void;
  /** Sets userSettings.editorMode AFTER flushing buffered body edits -
   *  the mode swap remounts the open note's editor from selected.body.
   *  Built in NotesView; never write editorMode through mutateSettings. */
  onEditorModeChange: (m: 'formatted' | 'markdown') => void;
  /** This device's layout choice (`viewMode.ts`), never the synced value. */
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  /** Switches one view off, or back on, in the sidebar or in the All list.
   *  Built in NotesView because hiding the OPEN view also leaves it, which
   *  this module cannot do; never write hiddenViews/hiddenInAll through
   *  mutateSettings. Spec: docs/internal/specs/sidebar-views.md */
  onToggleHiddenView: (field: 'hiddenViews' | 'hiddenInAll', key: View) => void;
  auth: Authed;
  settingsAutoVerify: boolean;
  /** Why Security opened, when Protect sent the user to set a PIN. */
  settingsSecurityReason?: 'protect';
  /** ID & Sync's "Open" for a note the last pass could not push. */
  onOpenNote: (id: string) => void;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  setShowUpgrade: (next: { trigger: UpgradeTrigger }) => void;
  setImportToast: Dispatch<SetStateAction<string | null>>;
  handleSignOutClick: () => void;
  mergeImportedFolders: (
    incoming: FolderDef[],
    originalIds?: ReadonlyMap<string, string>,
    rootParent?: string | null,
  ) => { idMap: Map<string, string>; created: string[] };
  importTarget: ImportTarget | undefined;
  createImportFolder: (name: string) => { id: string; created: boolean } | null;
  undoImportedFolders: (ids: readonly string[]) => void;
  applyImportedTagColors: (colors: Map<string, string>) => void;
  mergeRestoredSettings: (
    settings: { itemStyles?: unknown; customThemes?: unknown; factors?: unknown; customHabits?: unknown },
    savedToFinal: ReadonlyMap<string, string>,
  ) => void;
  exportAllMarkdownZip: (ns: LocalNote[]) => Promise<void>;
  exportAllHtmlZip: (ns: LocalNote[]) => Promise<void>;
  exportAllJson: (ns: LocalNote[]) => Promise<void>;
  exportEncryptedBackup: (ns: LocalNote[]) => Promise<void>;
  exportEncryptedFullBackup: (ns: LocalNote[]) => Promise<void>;
  decryptFullBackup: (file: File) => Promise<File>;
  exportVault: (ns: LocalNote[]) => Promise<void>;
  exportBookmarks: (ns: LocalNote[]) => Promise<void>;
  exportContacts: (ns: LocalNote[]) => Promise<void>;
  exportCalendar: (ns: LocalNote[]) => Promise<void>;
  /** The gated drawings export; without it the Drawings card is not drawn. */
  exportDrawings?: (ns: LocalNote[]) => Promise<void>;
  exportNotesMarkdownZip: (ns: LocalNote[]) => Promise<void>;
  importEncryptedBackup: (file: File) => Promise<{ imported: number; updated: number; unchanged: number }>;
  imageStoreRef: MutableRefObject<ImageStore | null>;
  attachmentStoreRef: MutableRefObject<AttachmentStore | null>;
  refresh: () => Promise<LocalNote[]>;
  runSync: () => Promise<void>;
  /** Writes the weekly reflection, creating the Monday entry if needed. */
  saveWeekReflection: (text: string) => Promise<void>;
  /** The tracker page Statistics opens on (a door from Journals or the Calendar). */
  statsTracker: string | null;
  /** A tracker page's "See entries" and "Show in Calendar". */
  onShowTrackerEntries: (id: string) => void;
  onShowTrackerInCalendar: (id: string) => void;
  /** Closes Settings and opens the theme builder. */
  openThemeBuilder: (target: ThemeBuilderTarget) => void;
  formatBarBoard: FormatBarBoardProps;
  /** The subscribed calendars, with each one's space (#772): the one control
   *  NotesView builds, so Settings writes what the calendar writes. */
  calendarFeeds: FeedsControl;
}): SettingsCategory[] {
  const bind = settingsBinder(userSettings, mutateSettings);
  // Design, Editor and Lists are three panes of one sheet, one Settings
  // entry each. Spec: docs/internal/design/ui-patterns.md (section 135)
  const appearancePane = (pane: AppearancePane, initialTab?: string, onOpenPlugins?: () => void) => (
    <AppearanceSheet
      onOpenPlugins={onOpenPlugins}
      embedded
      pane={pane}
      initialTab={initialTab}
      isPro={auth.isPro ?? false}
      viewMode={viewMode}
      onViewModeChange={onViewModeChange}
      editorMode={userSettings.editorMode}
      onEditorModeChange={onEditorModeChange}
      formatBar={formatBarBoard}
      bind={bind}
      hiddenViews={userSettings.hiddenViews}
      hiddenInAll={userSettings.hiddenInAll}
      archivedInAll={userSettings.archivedInAll}
      onToggleHidden={onToggleHiddenView}
      onViewOrderChange={bind('viewOrder').onChange}
      noteColors={noteColorChoice(userSettings.tintNotes, userSettings.noteColorStyle)}
      onNoteColorsChange={(next) => mutateSettings((prev) => applyNoteColorChoice(prev, next))}
      onOpenUpgrade={(trigger) => { setShowSettings(false); setShowUpgrade({ trigger: trigger ?? 'theme' }); }}
      onClose={() => setShowSettings(false)}
      customThemes={userSettings.customThemes}
      onCustomThemesChange={(update) => mutateSettings((prev) => ({ ...prev, customThemes: update(prev.customThemes) }))}
      onOpenThemeBuilder={openThemeBuilder}
    />
  );

  // The browser extension's key entries, for the device list and Apps.
  const extensionKeys = {
    readKeys: () => loadLocalSettings().extensionKeys,
    saveKeys: (update: (keys: UserSettings['extensionKeys']) => UserSettings['extensionKeys']) =>
      mutateSettings((prev) => ({ ...prev, extensionKeys: update(prev.extensionKeys) })),
  };

  // Transfer and Backup are two pages of one window, each with its own tabs.
  const importPane = (section: 'transfer' | 'backup', initialTab?: string) => (
    <ImportModal
      // Both pages draw this component in the same place: without the key,
      // React keeps one page's open tab when the other opens.
      key={section}
      embedded
      onClose={() => setShowSettings(false)}
      section={section}
      initialTab={initialTab as ImportTab | undefined}
      notes={allNotes}
      calendarFeeds={calendarFeeds}
      onImportFolders={mergeImportedFolders}
      importTarget={importTarget}
      onCreateImportFolder={createImportFolder}
      onUndoImportFolders={undoImportedFolders}
      onImportSettings={mergeRestoredSettings}
      onImportTagColors={applyImportedTagColors}
      onExportAllMdZip={(ns) => void exportAllMarkdownZip(ns)}
      onExportAllHtmlZip={(ns) => void exportAllHtmlZip(ns)}
      onExportAllJson={exportAllJson}
      onExportEncrypted={exportEncryptedBackup}
      onExportEncryptedZip={(ns) => void exportEncryptedFullBackup(ns)}
      decryptFullBackup={decryptFullBackup}
      onExportVault={exportVault}
      onExportBookmarks={exportBookmarks}
      onExportContacts={exportContacts}
      onExportCalendar={exportCalendar}
      onExportDrawings={exportDrawings && ((ns) => void exportDrawings(ns))}
      onExportNotesMdZip={(ns) => void exportNotesMarkdownZip(ns)}
      wellness={{
        isNoteLocked,
        trackerSettings: userSettings.trackerSettings,
        factors: userSettings.factors,
        medications: userSettings.medications,
        isPro: auth.isPro,
        onOpenUpgrade: () => { setShowSettings(false); setShowUpgrade({ trigger: null }); },
      }}
      onImportEncrypted={importEncryptedBackup}
      onBlobsRestored={() => {
        imageStoreRef.current?.processPendingUploads().catch((err) =>
          console.warn('[imageStore] post-restore processPendingUploads failed:', err),
        );
        attachmentStoreRef.current?.processPendingUploads().catch((err) =>
          console.warn('[attachmentStore] post-restore processPendingUploads failed:', err),
        );
      }}
      onImported={async (count, skippedDuplicates, repaired) => {
        // A restore of our own backup mostly matches what the
        // vault already holds, so "imported N" would be true and
        // useless. Say what it did to the notes it recognised.
        setImportToast(
          repaired && (repaired.updated > 0 || repaired.unchanged > 0)
            ? t('toast.restoreSummary', { added: count, updated: repaired.updated, unchanged: repaired.unchanged })
            : skippedDuplicates
              ? `${t('toast.importedSyncing', { count })} ${t('shell:bookmarks.importSkipped', { count: skippedDuplicates })}`
              : t('toast.importedSyncing', { count }),
        );
        mutateSettings((prev) =>
          prev.importHintDismissed ? prev : { ...prev, importHintDismissed: true },
        );
        await refresh();
        void runSync();
        window.setTimeout(() => setImportToast(null), 4000);
      }}
    />
  );

  return [
            {
              id: 'stats',
              label: t('settings.statsLabel'),
              group: t('settings.groupYourNotes'),
              icon: railIcon('stats'),
              render: ({ initialTab, navigate }) => (
                <StatsModal
                  onOpenWellnessExport={() => navigate('import', 'wellness')}
                  embedded
                  initialTab={initialTab === 'wellness' || initialTab === 'writing' || initialTab === 'medication' || initialTab === 'mood' ? initialTab : 'overview'}
                  {...(statsTracker ? { initialTracker: statsTracker } : {})}
                  onShowEntries={onShowTrackerEntries}
                  onShowInCalendar={onShowTrackerInCalendar}
                  notes={notes}
                  isNoteLocked={isNoteLocked}
                  // Deleted medications included on purpose: their log
                  // entries already count toward adherence, and without the
                  // template nothing can resolve the id back into a name.
                  medications={userSettings.medications}
                  notesCreated={userSettings.notesCreated}
                  firstSeenAt={userSettings.firstSeenAt}
                  trackerSettings={userSettings.trackerSettings}
                  factors={userSettings.factors}
                  onOpenDay={(date) => {
                    const entry = journalOn(notes, date);
                    if (!entry) return;
                    setShowSettings(false);
                    onOpenNote(entry.id);
                  }}
                  isPro={auth.isPro}
                  onOpenUpgrade={() => { setShowSettings(false); setShowUpgrade({ trigger: null }); }}
                  onClose={() => setShowSettings(false)}
                  {...weekReflectionFor(notes, isNoteLocked, (text) => void saveWeekReflection(text))}
                />
              ),
            },
            {
              id: 'import',
              label: t('settings.importLabel'),
              group: t('settings.groupYourNotes'),
              icon: railIcon('import'),
              render: ({ initialTab }) => importPane('transfer', initialTab),
            },
            {
              id: 'backup',
              label: t('settings.backupLabel'),
              group: t('settings.groupYourNotes'),
              icon: railIcon('backup'),
              render: ({ initialTab }) => importPane('backup', initialTab),
            },
            {
              id: 'storage',
              label: t('settings.storageLabel'),
              group: t('settings.groupYourNotes'),
              icon: railIcon('storage'),
              render: ({ initialTab }) => (
                <StoragePane
                  initialTab={initialTab}
                  storage={(openImages) => (
                    <SyncOptionsModal
                      embedded
                      tab="storage"
                      onSyncNow={runSync}
                      onOpenNote={onOpenNote}
                      onOpenImageSettings={openImages}
                      onClose={() => setShowSettings(false)}
                      onOpenUpgrade={() => { setShowSettings(false); setShowUpgrade({ trigger: 'storage' }); }}
                      onSignOut={handleSignOutClick}
                    />
                  )}
                  images={
                    <ImagesSheet
                      spaceSaver={userSettings.imageSpaceSaver}
                      stripMetadata={userSettings.imageStripMetadata}
                      contactCeiling={userSettings.imageContactCeiling}
                      onChange={(field, value) => mutateSettings((prev) => ({ ...prev, [field]: value }))}
                    />
                  }
                />
              ),
            },
            {
              id: 'design',
              label: t('settings.appearanceLabel'),
              group: t('settings.groupPreferences'),
              icon: railIcon('design'),
              render: () => appearancePane('design'),
            },
            {
              id: 'editor',
              label: t('settings.editorLabel'),
              group: t('settings.groupPreferences'),
              icon: railIcon('editor'),
              render: ({ initialTab, navigate }) => appearancePane('editor', initialTab, () => navigate('plugins')),
            },
            // Spec: docs/internal/plans/plugins.md (section 5)
            ...(pluginsShown() ? [{
              id: 'plugins',
              label: t('settings.pluginsLabel'),
              group: t('settings.groupPreferences'),
              icon: railIcon('plugins'),
              render: () => (
                <PluginsPane
                  isPro={auth.isPro}
                  onUpgrade={(trigger: UpgradeTrigger) => { setShowSettings(false); setShowUpgrade({ trigger }); }}
                  linkSuggestions={userSettings.linkSuggestions}
                  onLinkSuggestionsChange={bind('linkSuggestions').onChange}
                  notes={notes}
                  folders={userSettings.folders}
                  dismissed={userSettings.dismissedSuggestions}
                  onNotDuplicates={(a: string, b: string) => mutateSettings((prev) => ({ ...prev, dismissedSuggestions: setPairHidden(prev.dismissedSuggestions, suggestionPairKey(a, b), true) }))}
                  onOpenNotes={(ids: string[]) => { setShowSettings(false); openNotesFromSettings(ids); }}
                />
              ),
            }] : []),
            {
              id: 'formatBar',
              label: t('settings.formatBarLabel'),
              group: t('settings.groupPreferences'),
              icon: railIcon('formatBar'),
              render: () => appearancePane('formatBar'),
            },
            {
              id: 'lists',
              label: t('settings.listsLabel'),
              group: t('settings.groupPreferences'),
              icon: railIcon('lists'),
              render: ({ initialTab }) => appearancePane('lists', initialTab),
            },
            {
              id: 'trackers',
              label: t('settings.trackersLabel'),
              group: t('settings.groupPreferences'),
              icon: railIcon('trackers'),
              render: ({ initialTab }) => (
                <TrackerSettingsPane
                  initialTab={initialTab}
                  settings={userSettings.trackerSettings}
                  onChange={bind('trackerSettings').onChange}
                  factors={userSettings.factors}
                  onFactorsChange={bind('factors').onChange}
                  customHabits={userSettings.customHabits}
                  onCustomHabitsChange={bind('customHabits').onChange}
                  medications={userSettings.medications}
                  onMedicationsChange={bind('medications').onChange}
                  isPro={auth.isPro}
                  onOpenUpgrade={() => { setShowSettings(false); setShowUpgrade({ trigger: null }); }}
                />
              ),
            },
            {
              id: 'language',
              label: t('settings.languageLabel'),
              // No shell description: the language grid's subtitle sits
              // inside LanguageSheet, directly above the grid it describes.
              group: t('settings.groupPreferences'),
              icon: railIcon('language'),
              render: () => <LanguageSheet embedded onClose={() => setShowSettings(false)} />,
            },
            {
              id: 'date',
              label: t('settings.dateLabel'),
              group: t('settings.groupPreferences'),
              icon: railIcon('date'),
              render: ({ initialTab }) => (
                <DateTimePane
                  initialTab={initialTab}
                  format={
                    <DateSheet
                      journal={{
                        format: userSettings.journalTitleFormat,
                        onFormatChange: bind('journalTitleFormat').onChange,
                        suffix: userSettings.journalTitleSuffix,
                        onSuffixChange: bind('journalTitleSuffix').onChange,
                        pattern: userSettings.journalTitlePattern,
                        onPatternChange: bind('journalTitlePattern').onChange,
                      }}
                      dateOrder={userSettings.dateOrder}
                      onDateOrderChange={bind('dateOrder').onChange}
                      clock={userSettings.clock}
                      onClockChange={bind('clock').onChange}
                    />
                  }
                  calendar={
                    <CalendarSettings
                      value={userSettings.calendar}
                      onChange={bind('calendar').onChange}
                      weekStart={userSettings.weekStart}
                      onWeekStartChange={bind('weekStart').onChange}
                      alertsUnlocked={proUnlocked(auth.isPro)}
                      showPro={!auth.isPro}
                      onUpgrade={() => setShowUpgrade({ trigger: 'alerts' })}
                      feeds={calendarFeeds}
                    />
                  }
                />
              ),
            },
            {
              id: 'plan',
              label: t('settings.planLabel'),
              group: t('settings.planLabel'),
              icon: railIcon('plan'),
              render: ({ navigate, initialTab }) => (
                <SyncOptionsModal
                  embedded
                  tab="plan"
                  initialSection={initialTab === 'connectedAccounts' || initialTab === 'keyCustody' ? initialTab : 'overview'}
                  custodySettings={{ hasPin: Boolean(userSettings.pinHash && userSettings.pinSalt), pinCredential: `${userSettings.pinHash ?? ''}:${userSettings.pinSalt ?? ''}`, pinTimeoutMinutes: userSettings.pinTimeoutMinutes,
                    userSettings, onSettingsChange: (next, base) => mutateSettings((prev) => withCredentialChanges(prev, base, next)) }}
                  onOpenPhrase={() => navigate('security', 'phrase')}
                  deviceLabels={userSettings.deviceLabels}
                  onRenameDevice={(deviceId, name, serverName) =>
                    mutateSettings((prev) => ({
                      ...prev,
                      deviceLabels: setDeviceLabel(prev.deviceLabels, deviceId, name, serverName),
                    }))
                  }
                  onOpenRating={() => navigate('about', 'rating')}
                  onSyncNow={runSync}
                  onOpenNote={onOpenNote}
                  onClose={() => setShowSettings(false)}
                  onOpenUpgrade={() => { setShowSettings(false); setShowUpgrade({ trigger: null }); }}
                  onSignOut={handleSignOutClick}
                />
              ),
            },
            {
              id: 'security',
              label: t('settings.securityLabel'),
              group: t('settings.planLabel'),
              icon: railIcon('security'),
              render: ({ initialTab, navigate }) => (
                <SecurityModal
                  embedded
                  phrase={auth.phrase}
                  defaultTab={initialTab === 'biometric' || initialTab === 'phrase' || initialTab === 'twoFactor' || initialTab === 'passkeys' ? initialTab : 'pin'}
                  reason={settingsSecurityReason}
                  pinTimeoutMinutes={userSettings.pinTimeoutMinutes}
                  onPinTimeoutChange={(minutes) => {
                    endExpiredPinWindow(userSettings.pinTimeoutMinutes);
                    mutateSettings((prev) => ({ ...prev, pinTimeoutMinutes: minutes }));
                  }}
                  appLockTimeoutMinutes={userSettings.appLockTimeoutMinutes}
                  onAppLockTimeoutChange={(minutes) => {
                    mutateSettings((prev) => ({ ...prev, appLockTimeoutMinutes: minutes }));
                  }}
                  userSettings={userSettings}
                  onSettingsChange={(next, base) => {
                    mutateSettings((prev) => withCredentialChanges(prev, base, next));
                  }}
                  onClose={() => setShowSettings(false)}
                  onOpenCustody={() => navigate('plan', 'keyCustody')}
                  pubkey={auth.pubkey}
                />
              ),
            },
            {
              id: 'me',
              label: t('settings.accountLabel', exemptOpts('notes:settings.accountLabel')),
              group: t('settings.planLabel'),
              icon: railIcon('me'),
              render: ({ initialTab }) => (
                <SyncOptionsModal
                  embedded
                  tab="me"
                  initialMeSection={initialTab === 'dms' ? 'dms' : undefined}
                  onSyncNow={runSync}
                  onOpenNote={onOpenNote}
                  autoVerify={settingsAutoVerify}
                  onClose={() => setShowSettings(false)}
                  onOpenUpgrade={() => { setShowSettings(false); setShowUpgrade({ trigger: null }); }}
                  onSignOut={handleSignOutClick}
                />
              ),
            },
            // A touch-only device has no keyboard, so no Hotkeys pane.
            ...(isTouchOnly() ? [] : [{
              id: 'hotkeys',
              label: t('landing:about.tabs.hotkeys'),
              group: t('settings:devices.thisDevice'),
              icon: railIcon('hotkeys'),
              render: ({ initialTab }: { initialTab?: string }) => <HotkeysPane initialTab={initialTab} />,
            }]),
            // How the desktop app runs on this computer: login, tray, the Ninja hotkey, Open with.
            // Spec: docs/internal/plans/ninja-anywhere-694.md (section 7)
            ...(appZoomSupported() ? [{
              id: 'system',
              label: t('settings:system.railLabel'),
              group: t('settings:devices.thisDevice'),
              icon: railIcon('system'),
              render: () => <SystemPane />,
            }] : []),
            // Spec: docs/internal/plans/browser-extension-build.md (section 6)
            {
              id: 'browser',
              label: t('shell:apps.railLabel'),
              title: t('shell:apps.title'),
              group: t('settings.groupBrand'),
              icon: railIcon('browser'),
              render: () => <BrowserPane extensionKeys={extensionKeys} isPro={auth.isPro} onUpgrade={() => setShowUpgrade({ trigger: 'browsers' })} />,
            },
            // Spec: docs/internal/plans/agent-cli.md (sections 3.6, C2, C9)
            ...(commandLineShown() ? [{
              id: 'commandLine',
              label: t('shell:cli.railLabel'),
              title: t('shell:cli.title'),
              group: t('settings.groupBrand'),
              icon: railIcon('commandLine'),
              render: () => (
                <CommandLinePane
                  extensionKeys={extensionKeys}
                  settings={userSettings}
                  mutateSettings={mutateSettings}
                  createFolder={createImportFolder}
                  isPro={auth.isPro}
                  onUpgrade={() => setShowUpgrade({ trigger: 'cli' })}
                />
              ),
            }] : []),
            {
              id: 'about',
              label: t('settings.aboutLabel'),
              group: t('settings.groupBrand'),
              icon: railIcon('about'),
              render: ({ initialTab }) => (
                <AboutModal
                  embedded
                  onClose={() => setShowSettings(false)}
                  initialTab={initialTab === 'rating' ? initialTab : 'about'}
                />
              ),
            },
            {
              // Link row, not a pane: the static /help site is the only FAQ
              // renderer, so this opens the browser rather than duplicating
              // it in-app. Spec: docs/contrib/bundle-size.md (in-app FAQ tab)
              id: 'help',
              label: t('settings.helpLabel'),
              group: t('settings.groupBrand'),
              icon: railIcon('help'),
              href: siteHref(helpPath(activeLocale())),
            },
          ] satisfies SettingsCategory[];
}
