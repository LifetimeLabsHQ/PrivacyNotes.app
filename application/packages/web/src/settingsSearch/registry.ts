/**
 * The index of the settings search: one entry per setting a reader can look
 * for, pointing at the catalog keys its pane already shows. Every language
 * gets its index from its own catalogs, so nothing here is translated.
 *
 * `id` is also the `data-setting` marker on the rendered row; the anchor test
 * (tests/settingsSearch.test.ts) holds the two lists together. A key is
 * written `namespace:path`. `brand` marks a label that is a product name and
 * reads the same in every language. `keywords` says the entry has a list under
 * `settingsSearch:keywords.<id with dots as underscores>`. `shownOn` names the
 * pane's own rule for a row some devices never show; the search reads it
 * through `isShown` in SettingsSearchResults.tsx, which keeps this file data.
 * Spec: docs/internal/design/ui-patterns.md (section 114, settings search)
 */
export type SectionId =
  | 'stats'
  | 'import'
  | 'backup'
  | 'plan'
  | 'storage'
  | 'security'
  | 'me'
  | 'design'
  | 'editor'
  | 'formatBar'
  | 'lists'
  | 'trackers'
  | 'language'
  | 'date'
  | 'hotkeys'
  | 'system'
  | 'browser'
  | 'commandLine'
  | 'about'
  | 'help';

export type SettingEntry = {
  id: string;
  section: SectionId;
  /** The inner tab the row lives on, handed to the pane as its first tab. */
  tab?: string;
  label: string;
  brand?: true;
  options?: readonly string[];
  keywords?: true;
  shownOn?: 'storeBuild' | 'keyboard' | 'paneLayout' | 'realAccount' | 'desktopApp' | 'captureBlock' | 'commandLine' | 'phoneApp';
  /** An entry for a whole section: it opens the pane and flashes nothing. */
  isSection?: true;
};

/** Each section's name, the key the rail already shows. */
export const SECTION_LABEL: Record<SectionId, string> = {
  stats: 'notes:settings.statsLabel',
  import: 'notes:settings.importLabel',
  backup: 'notes:settings.backupLabel',
  plan: 'notes:settings.planLabel',
  storage: 'notes:settings.storageLabel',
  security: 'notes:settings.securityLabel',
  me: 'notes:settings.accountLabel',
  design: 'notes:settings.appearanceLabel',
  editor: 'notes:settings.editorLabel',
  formatBar: 'notes:settings.formatBarLabel',
  lists: 'notes:settings.listsLabel',
  trackers: 'notes:settings.trackersLabel',
  language: 'notes:settings.languageLabel',
  date: 'notes:settings.dateLabel',
  hotkeys: 'landing:about.tabs.hotkeys',
  system: 'settings:system.railLabel',
  browser: 'shell:apps.railLabel',
  commandLine: 'shell:cli.railLabel',
  about: 'notes:settings.aboutLabel',
  help: 'notes:settings.helpLabel',
};

/** The label of each inner tab, shown after a result's name. */
export const TAB_LABEL: Record<string, string> = {
  'stats/wellness': 'notes:settings.trackersLabel',
  'stats/writing': 'stats:tabs.writing',
  'stats/medication': 'stats:wellness.subTabs.medication',
  'stats/mood': 'stats:wellness.mood.heading',
  'import/import': 'importExport:shell.tabImport',
  'import/export': 'importExport:shell.tabExport',
  'backup/manual': 'importExport:shell.tabManual',
  'backup/automatic': 'importExport:shell.tabAutomatic',
  'backup/restore': 'importExport:shell.tabRestore',
  'import/wellness': 'notes:settings.trackersLabel',
  'security/pin': 'security:modal.tabPin',
  'security/biometric': 'security:modal.tabBiometricShort',
  'security/phrase': 'security:modal.tabPhrase',
  'security/twoFactor': 'security:modal.tabTwoFactor',
  'plan/connectedAccounts': 'security:accountTabs.accounts',
  'plan/keyCustody': 'security:accountTabs.keyCustody',
  'plan/overview': 'security:accountTabs.overview',
  'date/format': 'notes:settings.dateTabFormat',
  'date/calendar': 'notes:settings.calendarLabel',
  'editor/display': 'settings:appearance.editorTabDisplay',
  'editor/behavior': 'settings:appearance.editorTabBehavior',
  'lists/general': 'settings:appearance.listsTabGeneral',
  'lists/sidebar': 'settings:appearance.listsTabSidebar',
  'trackers/trackers': 'settings:appearance.listsTabGeneral',
  'trackers/questions': 'settings:appearance.listsTabGeneral',
  'trackers/checkIn': 'settings:appearance.listsTabGeneral',
  'trackers/factors': 'trackers:labels.factors',
  'trackers/medications': 'trackers:labels.medication',
  'trackers/custom': 'trackers:config.tabCustom',
  'about/about': 'landing:about.tabs.about',
  'hotkeys/typing': 'settings:appearance.toolbarTabTyping',
  'hotkeys/drawing': 'notes:newMenu.drawing',
  'about/rating': 'landing:about.tabs.rating',
};

const SECTION_ENTRIES: SettingEntry[] = (Object.keys(SECTION_LABEL) as SectionId[]).map((section) => ({
  id: `section.${section}`,
  section,
  label: SECTION_LABEL[section],
  keywords: true,
  isSection: true,
  // Touch-only devices have no Hotkeys pane.
  ...(section === 'hotkeys' ? { shownOn: 'keyboard' as const } : {}),
  // Settings > System is how the desktop app runs on the computer.
  ...(section === 'system' ? { shownOn: 'desktopApp' as const } : {}),
  // Settings > Command line shows where `privacynotes` can be installed (cliRelease.ts).
  ...(section === 'commandLine' ? { shownOn: 'commandLine' as const } : {}),
}));

/** An importer row, named by its product. */
const importer = (id: string, name: string): SettingEntry => ({
  id: `import.source.${id}`,
  section: 'import',
  tab: 'import',
  label: name,
  brand: true,
});

/** An importer row whose name is translated. */
const keyedImporter = (id: string, key: string): SettingEntry => ({
  id: `import.source.${id}`,
  section: 'import',
  tab: 'import',
  label: key,
});

const ROW_ENTRIES: SettingEntry[] = [
  // Statistics
  { id: 'stats.writing', section: 'stats', tab: 'writing', label: 'stats:tabs.writing', keywords: true },
  { id: 'stats.streak', section: 'stats', label: 'stats:writing.currentStreak', options: ['stats:writing.longestStreak'], keywords: true },
  { id: 'stats.milestones', section: 'stats', label: 'stats:milestones.heading', keywords: true },
  { id: 'stats.wellness', section: 'stats', tab: 'wellness', label: 'stats:home.trackers', keywords: true },
  { id: 'stats.overview', section: 'stats', label: 'stats:tabs.overview', keywords: true },
  { id: 'stats.medication', section: 'stats', tab: 'medication', label: 'stats:wellness.subTabs.medication', keywords: true },
  { id: 'stats.patterns', section: 'stats', tab: 'wellness', label: 'stats:home.standsOut', keywords: true },
  { id: 'stats.moodTrend', section: 'stats', tab: 'wellness', label: 'stats:wellness.mood.heading' },
  { id: 'stats.yearInPixels', section: 'stats', tab: 'mood', label: 'common:ninja.features.yearInPixels.label' },

  // Journals
  { id: 'journals.titles', section: 'date', tab: 'format', label: 'settings:journals.titlesTitle', keywords: true },
  { id: 'journals.suffix', section: 'date', tab: 'format', label: 'settings:journals.suffixTitle', keywords: true },

  // Import & Export
  { id: 'import.import', section: 'import', tab: 'import', label: 'importExport:shell.tabImport' },
  keyedImporter('browser-bookmarks', 'importExport:sourceLabel.browserBookmarks'),
  keyedImporter('vcard', 'importExport:sourceLabel.vcard'),
  importer('apple-journal', 'Apple Journal'),
  importer('apple-notes', 'Apple Notes'),
  importer('bear', 'Bear'),
  importer('evernote', 'Evernote'),
  importer('excalidraw', 'Excalidraw'),
  importer('google-calendar', 'Google Calendar'),
  { id: 'import.webcal', section: 'import', tab: 'import', label: 'importExport:webcal.title' },
  importer('google-keep', 'Google Keep'),
  importer('ia-writer', 'iA Writer'),
  importer('joplin', 'Joplin'),
  keyedImporter('markdown-folder', 'importExport:sourceLabel.markdownFolder'),
  importer('nextcloud-notes', 'Nextcloud Notes'),
  importer('notesnook', 'Notesnook'),
  importer('obsidian', 'Obsidian'),
  importer('obsidian-canvas', 'Obsidian Canvas'),
  importer('samsung-notes', 'Samsung Notes'),
  importer('simplenote', 'Simplenote'),
  importer('standard-notes', 'Standard Notes'),
  importer('typora', 'Typora'),
  importer('upnote', 'UpNote'),
  importer('zettlr', 'Zettlr'),
  { id: 'import.export', section: 'import', tab: 'export', label: 'importExport:shell.tabExport', keywords: true },
  { id: 'export.zipBackup', section: 'backup', tab: 'manual', label: 'importExport:export.zipBackupTitle', keywords: true },
  { id: 'export.encryptedZip', section: 'backup', tab: 'manual', label: 'importExport:export.encryptedZipBackupTitle' },
  { id: 'export.encryptedBackup', section: 'backup', tab: 'manual', label: 'importExport:export.encryptedBackupTitle' },
  { id: 'export.notesMarkdown', section: 'import', tab: 'export', label: 'importExport:export.notesMarkdownTitle' },
  { id: 'export.htmlArchive', section: 'import', tab: 'export', label: 'importExport:export.htmlArchiveTitle' },
  { id: 'export.textBackup', section: 'import', tab: 'export', label: 'importExport:export.textBackupTitle' },
  { id: 'export.bookmarks', section: 'import', tab: 'export', label: 'importExport:export.bookmarksExportTitle' },
  { id: 'export.contacts', section: 'import', tab: 'export', label: 'importExport:export.contactsExportTitle' },
  { id: 'export.calendar', section: 'import', tab: 'export', label: 'importExport:export.calendarExportTitle' },
  { id: 'export.drawings', section: 'import', tab: 'export', label: 'importExport:export.drawingsExportTitle' },
  { id: 'export.vault', section: 'import', tab: 'export', label: 'importExport:export.vaultExportTitle' },
  { id: 'backup.manual', section: 'backup', tab: 'manual', label: 'importExport:shell.tabManual' },
  { id: 'import.automatic', section: 'backup', tab: 'automatic', label: 'importExport:auto.title', keywords: true },
  { id: 'import.restore', section: 'backup', tab: 'restore', label: 'importExport:shell.tabRestore' },
  { id: 'restore.fullBackup', section: 'backup', tab: 'restore', label: 'importExport:restorePick.fullBackupTitle' },
  { id: 'restore.encryptedBackup', section: 'backup', tab: 'restore', label: 'importExport:restorePick.encryptedBackupTitle' },
  { id: 'import.wellness', section: 'import', tab: 'wellness', label: 'stats:wellness.export.openExport', keywords: true },
  { id: 'wellness.aiPrompt', section: 'import', tab: 'wellness', label: 'stats:wellness.export.copyAIPrompt' },
  { id: 'wellness.doctorReport', section: 'import', tab: 'wellness', label: 'stats:wellness.export.doctorPDF' },
  { id: 'wellness.json', section: 'import', tab: 'wellness', label: 'stats:wellness.export.downloadJSON' },
  { id: 'wellness.csv', section: 'import', tab: 'wellness', label: 'stats:wellness.export.downloadCSV' },
  importer('bitwarden', 'Bitwarden'),
  // The Passwords tab's search words, kept on the row that took its place (#608).
  { ...keyedImporter('browser-passwords', 'importExport:sourceLabel.browserPasswords'), keywords: true },

  // Account (the plan pane)
  { id: 'plan.devices', section: 'plan', label: 'settings:devices.heading', keywords: true },
  { id: 'plan.upgrade', section: 'plan', label: 'settings:plan.upgradeToPro', keywords: true },
  { id: 'plan.restorePurchases', section: 'plan', label: 'settings:plan.restore.heading', shownOn: 'storeBuild' },
  { id: 'plan.signOut', section: 'plan', label: 'settings:account.signOut', keywords: true },
  { id: 'plan.dangerZone', section: 'plan', label: 'settings:danger.heading', keywords: true },

  // Storage
  { id: 'storage.quota', section: 'storage', label: 'settings:storage.quotaLabel', keywords: true },
  { id: 'storage.addon', section: 'storage', label: 'settings:storage.addonHeading', keywords: true },

  // Images, a tab of Storage since 2026-10-22
  { id: 'storage.images', section: 'storage', tab: 'images', label: 'notes:settings.imagesLabel', keywords: true },
  { id: 'images.spaceSaver', section: 'storage', tab: 'images', label: 'settings:images.spaceSaverTitle', keywords: true },
  { id: 'images.contactPhotos', section: 'storage', tab: 'images', label: 'settings:images.contactTitle' },
  { id: 'images.removeLocation', section: 'storage', tab: 'images', label: 'settings:images.removeLocationTitle', keywords: true },

  { id: 'account.connectedAccounts', section: 'plan', tab: 'connectedAccounts', label: 'security:connectedAccounts.title', options: ['security:connectedAccounts.providers.google', 'security:connectedAccounts.providers.apple', 'security:connectedAccounts.providers.github'], shownOn: 'realAccount' },

  // Security
  { id: 'security.pin', section: 'security', tab: 'pin', label: 'security:modal.tabPin', keywords: true },
  { id: 'security.setPin', section: 'security', tab: 'pin', label: 'security:pinTab.setPin', options: ['security:pinTab.updatePin'] },
  { id: 'security.removePin', section: 'security', tab: 'pin', label: 'security:pinTab.removePin' },
    { id: 'security.biometric', section: 'security', tab: 'biometric', label: 'security:modal.tabBiometricShort', keywords: true },
  { id: 'security.enableBiometric', section: 'security', tab: 'biometric', label: 'security:biometricTab.enable' },
  { id: 'security.biometricSetUpAgain', section: 'security', tab: 'biometric', label: 'security:biometricTab.setUpAgain' },
  { id: 'security.appLock', section: 'security', tab: 'biometric', label: 'security:biometricTab.lockOnOpen', keywords: true },
  { id: 'security.relockAfter', section: 'security', tab: 'biometric', label: 'security:biometricTab.relockAgainAfter', keywords: true },
  { id: 'security.reaskAfter', section: 'security', tab: 'biometric', label: 'security:biometricTab.reaskAfter', keywords: true },
  { id: 'security.blockCapture', section: 'security', tab: 'biometric', label: 'security:biometricTab.blockCapture', keywords: true, shownOn: 'captureBlock' },
  { id: 'security.phrase', section: 'security', tab: 'phrase', label: 'security:modal.tabPhrase', keywords: true },
  { id: 'security.twoFactor', section: 'security', tab: 'twoFactor', label: 'security:modal.tabTwoFactor', options: ['security:twoFactor.title', 'security:twoFactor.backupKey', 'security:twoFactor.start'], shownOn: 'realAccount' },
  { id: 'security.qrCode', section: 'security', tab: 'phrase', label: 'security:phraseView.showQr', options: ['security:phraseView.saveQr'] },
  { id: 'security.copyPhrase', section: 'security', tab: 'phrase', label: 'security:phraseView.copyPhrase' },
  { id: 'security.custody', section: 'plan', tab: 'keyCustody', label: 'security:accountTabs.keyCustody', keywords: true, shownOn: 'realAccount' },

  // ID & Sync
  { id: 'me.thisDevice', section: 'me', label: 'settings:devices.thisDevice', options: ['settings:syncPanel.syncNow'] },
  { id: 'me.pauseSync', section: 'me', label: 'settings:syncPanel.pauseSync', keywords: true },
  { id: 'me.filesWifiOnly', section: 'me', label: 'settings:syncPanel.filesWifiOnly', keywords: true },
  { id: 'me.where', section: 'me', label: 'settings:syncPanel.whereTitle', keywords: true },
  { id: 'me.accountId', section: 'me', label: 'settings:accountId.heading', keywords: true },
  { id: 'me.activity', section: 'me', label: 'settings:syncPanel.activity', keywords: true },
  { id: 'me.dms', section: 'me', tab: 'dms', label: 'settings:dms.tab', keywords: true },

  // Appearance
  { id: 'appearance.openInTabs', section: 'lists', label: 'settings:appearance.openInTabsTitle', keywords: true, shownOn: 'paneLayout' },
  { id: 'appearance.mode', section: 'design', label: 'settings:appearance.modeTitle', options: ['settings:appearance.modeAuto', 'settings:appearance.light', 'settings:appearance.dark'], keywords: true },
  { id: 'appearance.theme', section: 'design', label: 'settings:appearance.lightThemes', options: ['settings:appearance.darkThemes'], keywords: true },
  { id: 'appearance.customThemes', section: 'design', label: 'settings:appearance.custom.builderNew', options: ['settings:appearance.custom.pasteCode', 'settings:appearance.themeSearch', 'settings:appearance.madeBy.more'], keywords: true },
  { id: 'appearance.appZoom', section: 'system', label: 'settings:appearance.appZoomTitle', keywords: true, shownOn: 'desktopApp' },
  { id: 'appearance.tintNotes', section: 'design', label: 'settings:appearance.noteColorsTitle', options: ['settings:appearance.custom.seed.background', 'settings:appearance.noteColorsAccent', 'settings:appearance.noteColorsOff'], keywords: true },
  { id: 'appearance.textSize', section: 'editor', label: 'settings:appearance.textSizeTitle', options: ['settings:appearance.textSizeSmallest', 'settings:appearance.textSizeSmall', 'settings:appearance.textSizeDefault', 'settings:appearance.textSizeLarge', 'settings:appearance.textSizeLargest'], keywords: true },
  { id: 'appearance.lineSpacing', section: 'editor', label: 'settings:appearance.lineSpacingTitle', options: ['settings:appearance.lineSpacingTight', 'settings:appearance.lineSpacingCompact', 'settings:appearance.lineSpacingNormal'], keywords: true },
  { id: 'appearance.contentWidth', section: 'editor', label: 'settings:appearance.contentWidthTitle', options: ['settings:appearance.contentWidthWide', 'settings:appearance.contentWidthFull'], keywords: true },
  { id: 'appearance.editor', section: 'editor', label: 'notes:settings.editorLabel', options: ['settings:appearance.editorFormatted', 'settings:appearance.editorMarkdown'], keywords: true },
  { id: 'appearance.copyFormat', section: 'editor', tab: 'behavior', label: 'settings:appearance.copyFormatTitle', options: ['settings:appearance.copyFormatMarkdown', 'settings:appearance.copyFormatPlain'], keywords: true },
  { id: 'appearance.pasteFormat', section: 'editor', tab: 'behavior', label: 'settings:appearance.pasteFormatTitle', options: ['settings:appearance.pasteFormatFormatted', 'settings:appearance.copyFormatPlain'], keywords: true },
  { id: 'appearance.invisibles', section: 'editor', label: 'settings:appearance.invisiblesTitle', keywords: true },
  { id: 'appearance.linkModifier', section: 'editor', tab: 'behavior', label: 'settings:appearance.linkModifierTitle', keywords: true },
  { id: 'appearance.typedSymbols', section: 'editor', tab: 'behavior', label: 'settings:appearance.typedSymbolsTitle', keywords: true },
  { id: 'appearance.noteFont', section: 'editor', label: 'settings:appearance.noteFontTitle', keywords: true },
  { id: 'appearance.nestedNumbers', section: 'editor', label: 'settings:appearance.nestedNumbersTitle', options: ['settings:appearance.nestedNumbersFlat', 'settings:appearance.nestedNumbersOutline'], keywords: true },
  { id: 'appearance.favicons', section: 'lists', label: 'settings:appearance.faviconsTitle', keywords: true },
  { id: 'appearance.formatBar', section: 'formatBar', label: 'notes:settings.formatBarLabel', keywords: true },
  { id: 'appearance.startView', section: 'lists', label: 'settings:appearance.startViewTitle', keywords: true },
  { id: 'appearance.view', section: 'lists', label: 'settings:appearance.viewTitle', options: ['settings:appearance.viewList', 'settings:appearance.viewGrid'], keywords: true },
  { id: 'appearance.confirmTrash', section: 'editor', tab: 'behavior', label: 'settings:appearance.confirmTrashTitle', keywords: true },
  { id: 'appearance.confirmArchive', section: 'editor', tab: 'behavior', label: 'settings:appearance.confirmArchiveTitle', keywords: true },
  { id: 'appearance.autoLocationNotes', section: 'editor', tab: 'behavior', label: 'settings:appearance.autoLocationTitle', keywords: true, shownOn: 'phoneApp' },
  { id: 'appearance.autoLocationJournal', section: 'editor', tab: 'behavior', label: 'settings:appearance.autoLocationJournal', keywords: true, shownOn: 'phoneApp' },
  { id: 'appearance.taskConfetti', section: 'editor', tab: 'behavior', label: 'settings:appearance.taskConfettiTitle', keywords: true },
  { id: 'appearance.sinkChecked', section: 'editor', tab: 'behavior', label: 'settings:appearance.sinkCheckedTitle', keywords: true },
  { id: 'appearance.defaultApps', section: 'system', label: 'settings:appearance.defaultAppsTitle', keywords: true, shownOn: 'desktopApp' },
  { id: 'system.openAtLogin', section: 'system', label: 'settings:system.openAtLoginTitle', keywords: true, shownOn: 'desktopApp' },
  { id: 'system.startMinimized', section: 'system', label: 'settings:system.startMinimizedTitle', shownOn: 'desktopApp' },
  { id: 'appearance.tray', section: 'system', label: 'settings:appearance.trayTitle', keywords: true, shownOn: 'desktopApp' },
  { id: 'appearance.ninjaKey', section: 'system', label: 'settings:appearance.ninjaKeyTitle', keywords: true, shownOn: 'desktopApp' },
  { id: 'trackers.setup', section: 'trackers', tab: 'trackers', label: 'shell:checkIn.chooseTrackers', keywords: true },
  { id: 'trackers.habitQuestions', section: 'trackers', tab: 'questions', label: 'trackers:config.habitQuestions', keywords: true },
  { id: 'trackers.ownHabits', section: 'trackers', tab: 'questions', label: 'trackers:config.addHabit' },
  { id: 'trackers.custom', section: 'trackers', tab: 'custom', label: 'trackers:config.customTrackers', keywords: true },
  { id: 'trackers.factors', section: 'trackers', tab: 'factors', label: 'trackers:config.factorsTitle', keywords: true },
  { id: 'trackers.medications', section: 'trackers', tab: 'medications', label: 'trackers:config.medicationsTitle', keywords: true },
  { id: 'trackers.medicationCard', section: 'trackers', tab: 'medications', label: 'trackers:config.medicationCard' },
  { id: 'appearance.spaces', section: 'lists', label: 'settings:appearance.spacesTitle', keywords: true },
  { id: 'appearance.sidebar', section: 'lists', tab: 'sidebar', label: 'settings:appearance.sidebarTitle', options: ['settings:appearance.custom.seed.sidebar', 'shell:tagsRail.allItems'], keywords: true },

  // Language
  { id: 'language.spellCheck', section: 'language', label: 'settings:appearance.spellCheckTitle', keywords: true },
  { id: 'language.language', section: 'language', label: 'notes:settings.languageLabel', keywords: true },
  { id: 'language.dateFormat', section: 'date', tab: 'format', label: 'settings:language.dateFormat', options: ['settings:language.dayFirst', 'settings:language.monthFirst', 'settings:language.yearFirst'], keywords: true },
  { id: 'language.clock', section: 'date', tab: 'format', label: 'settings:language.clock', options: ['settings:language.hour24', 'settings:language.hour12'], keywords: true },
  { id: 'language.reportMistake', section: 'language', label: 'settings:language.reportMistake' },

  // Calendar
  { id: 'calendar.alertTimed', section: 'date', tab: 'calendar', label: 'settings:calendar.alertTimed', keywords: true },
  { id: 'calendar.alertAllDay', section: 'date', tab: 'calendar', label: 'settings:calendar.alertAllDay', keywords: true },
  { id: 'calendar.alertBirthday', section: 'date', tab: 'calendar', label: 'shell:calendar.birthdays', keywords: true },
  { id: 'calendar.reminderTitles', section: 'date', tab: 'calendar', label: 'settings:calendar.reminderTitles', keywords: true },
  { id: 'calendar.where', section: 'date', tab: 'calendar', label: 'settings:calendar.whereTitle', keywords: true },
  { id: 'calendar.checkInReminder', section: 'trackers', tab: 'checkIn', label: 'settings:calendar.checkInReminder', keywords: true },
  { id: 'calendar.weekStart', section: 'date', tab: 'calendar', label: 'settings:calendar.weekStart', keywords: true },
  { id: 'calendar.weekNumbers', section: 'date', tab: 'calendar', label: 'settings:calendar.weekNumbers', keywords: true },
  { id: 'calendar.hours', section: 'date', tab: 'calendar', label: 'settings:calendar.hours', keywords: true },

  // Hotkeys
  { id: 'hotkeys.typing', section: 'hotkeys', tab: 'typing', label: 'settings:appearance.toolbarTabTyping', shownOn: 'keyboard' },
  { id: 'hotkeys.singleKeys', section: 'hotkeys', tab: 'typing', label: 'landing:about.singleKeysTitle', keywords: true, shownOn: 'keyboard' },
  { id: 'hotkeys.drawing', section: 'hotkeys', tab: 'drawing', label: 'notes:drawing.hotkeysTitle', shownOn: 'keyboard' },

  // Browser
  { id: 'browser.install', section: 'browser', label: 'shell:apps.stepInstall' },
  { id: 'browser.features', section: 'browser', label: 'shell:apps.stepFeatures', options: ['shell:extensionConnect.clips', 'shell:tagsRail.vault'], shownOn: 'realAccount' },
  { id: 'browser.connect', section: 'browser', label: 'shell:apps.makeCode', shownOn: 'realAccount' },

  // About
  { id: 'about.about', section: 'about', tab: 'about', label: 'landing:about.tabs.about' },
  { id: 'about.version', section: 'about', tab: 'about', label: 'landing:about.versionHeading', keywords: true },
  { id: 'about.roadmap', section: 'about', tab: 'about', label: 'landing:header.roadmap' },
  { id: 'about.openSource', section: 'about', tab: 'about', label: 'landing:trust.openSourceHeading', keywords: true },
  { id: 'about.feedback', section: 'about', tab: 'about', label: 'landing:about.feedbackHeading', keywords: true },
  { id: 'about.dataStorage', section: 'about', tab: 'about', label: 'landing:trust.dataStorageHeading', keywords: true },
  { id: 'about.favicons', section: 'about', tab: 'about', label: 'landing:trust.faviconsHeading' },
  { id: 'about.legal', section: 'about', tab: 'about', label: 'landing:about.legalHeading', options: ['landing:about.privacyPolicy', 'landing:about.termsOfService'] },
  { id: 'about.changelog', section: 'about', tab: 'about', label: 'common:updateToast.changelog', keywords: true },
  { id: 'about.rating', section: 'about', tab: 'rating', label: 'landing:about.tabs.rating', keywords: true },
];

/** Sections first, so a section's own name ties ahead of a row with the same word. */
export const SETTING_ENTRIES: readonly SettingEntry[] = [...SECTION_ENTRIES, ...ROW_ENTRIES];

/** The keyword key of an entry. */
export function keywordKey(entry: SettingEntry): string {
  return `settingsSearch:keywords.${entry.id.replace(/\./g, '_')}`;
}
