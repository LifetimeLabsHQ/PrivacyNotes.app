import type { ImportSource } from '../adminEvents';
import { textMatcher } from '../textMatch';
import type {
  ImporterAlias,
  ImporterEntry,
  ImporterGroup,
  ImporterIcon,
  ImporterId,
} from './types';
import { standardNotesImporter } from './standardNotes';
import { googleKeepImporter } from './googleKeep';
import { parseMarkdown } from './markdown';
import { parseObsidian, parseObsidianCanvas } from './obsidian';
import { parseNotion } from './notion';
import { parseNotesnook } from './notesnook';
import { parseJoplin } from './joplin';
import { parseAnytype } from './anytype';
import { parseSiyuan } from './siyuan';
import { parseOneNote } from './onenote';
import { parseCapacities } from './capacities';
import { parseBear } from './bear';
import { parseUpNote } from './upnote';
import { parseAppleNotes } from './appleNotes';
import { parseAppleJournal } from './appleJournal';
import { parseDayOne } from './dayOne';
import { parseDaylio } from './daylio';
import { parseDiaro } from './diaro';
import { parseDiarium } from './diarium';
import { parseGoogleJournal } from './googleJournal';
import { parseEvernote } from './evernote';
import { parseSamsungNotes } from './samsungNotes';
import { parseMicrosoftToDo } from './microsoftToDo';
import { parseTodoist } from './todoist';
import { parsePrivacyNotesBackup } from './privacynotes';
import { bitwardenImporter } from './bitwarden';
import { keepassImporter, keepassxcImporter, passwordCsvImporter } from './passwordCsv';
import { lastpassImporter, nordpassImporter, protonPassImporter } from './passwordManagers';
import { onePasswordImporter } from './onePassword';
import { enpassImporter } from './enpass';
import { msecureImporter } from './msecure';
import { dashlaneImporter } from './dashlane';
import { simplenoteImporter } from './simplenote';
import { parseBrowserBookmarks } from './browserBookmarks';
import { parseRaindrop } from './raindrop';
import { parseVcard } from './vcard';
import { parseGoogleCalendar } from './googleCalendar';
import { parseExcalidraw } from './excalidraw';

/** Display names for the markdown-app aliases below. Brand names, so they are
 *  not translated; the row's DESCRIPTION comes from the catalog. */
const MARKDOWN_APP_LABEL = {
  'typora': 'Typora',
  'ia-writer': 'iA Writer',
  'zettlr': 'Zettlr',
  'nextcloud-notes': 'Nextcloud Notes',
} as const;

/** Their marks, from the /help/import guides. */
const MARKDOWN_APP_ICON = {
  'typora': '/help/icons/typora.webp',
  'ia-writer': '/help/icons/ia-writer.webp',
  'zettlr': '/help/icons/zettlr.svg',
  'nextcloud-notes': '/help/icons/nextcloud-notes.svg',
} as const;

const MARKDOWN_ACCEPT = '.md,.markdown,.mdown,.mkd,.txt,.zip';

const MARKDOWN_APP_DESCRIPTION =
  'These notes are already Markdown files in a folder. Drop that folder in as a .zip and its subfolders, images, and #tags come with it.';

/** Browser brand cards shared by Browser bookmarks and Browser passwords.
 *  Safari wraps its export in a `.zip`; the other browsers export bare `.html` or `.csv`. */
const BROWSER_BRANDS = [
  { key: 'brave', label: 'Brave', src: '/help/icons/brave.svg' },
  { key: 'chrome', label: 'Chrome', src: '/help/icons/chrome.svg' },
  { key: 'edge', label: 'Edge', src: '/help/icons/edge.svg' },
  { key: 'firefox', label: 'Firefox', src: '/help/icons/firefox.svg' },
  { key: 'safari', label: 'Safari', src: '/help/icons/safari.webp' },
  { key: 'vivaldi', label: 'Vivaldi', src: '/help/icons/vivaldi.svg' },
] as const;

function browserAliases(bareExt: '.html' | '.csv', safariTypes: string): ImporterAlias[] {
  return BROWSER_BRANDS.map((b) => ({
    key: b.key,
    label: b.label,
    icon: { src: b.src },
    fileTypes: b.key === 'safari' ? safariTypes : bareExt,
  }));
}

/**
 * Registry of available importers, keyed by id at every call site. Each entry
 * carries the facts its card shows (`ImporterCard` in `types.ts`), its picker
 * group, any brand/browser alias cards, and whether it records an anonymous
 * telemetry count. An entry with `enabled: false` renders disabled.
 */
export const IMPORTERS: ImporterEntry[] = [
  {
    id: 'privacynotes',
    label: 'PrivacyNotes full backup',
    description:
      'Restore a full backup (.zip) including notes, journals, vault, tasks, images, audio, and files.',
    accept: '.zip',
    enabled: true,
    sourceTag: '',
    parse: parsePrivacyNotesBackup,
    group: null,
    icon: null,
    labelKey: 'sourceLabel.privacynotes',
    descKey: null,
    fileTypes: '',
    guide: null,
    counted: true,
    restore: true,
  },
  {
    ...googleKeepImporter,
    group: 'notes',
    icon: { src: '/help/icons/google-keep.svg' },
    labelKey: null,
    descKey: 'sourceDesc.googleKeep',
    fileTypes: '.zip, .json',
    guide: 'google-keep',
    counted: true,
  },
  {
    id: 'browser-bookmarks',
    label: 'Browser bookmarks',
    // Deliberately no sourceTag: the recreated folder tree already answers
    // "where did this come from", so an auto tag would only add noise.
    // Spec: docs/internal/specs/bookmarks-pillar.md (import mapping)
    description:
      'Chrome, Firefox, Safari, or Edge - the bookmarks .html file from "Export bookmarks", or the .zip Safari writes. Folders come along, dates survive, and re-importing the same file skips what you already have.',
    accept: '.html,.htm,.zip',
    enabled: true,
    sourceTag: '',
    parse: parseBrowserBookmarks,
    group: 'bookmarks',
    icon: null,
    labelKey: 'sourceLabel.browserBookmarks',
    descKey: 'sourceDesc.browserBookmarks',
    fileTypes: '.html, .zip',
    guide: 'browser-bookmarks',
    aliases: browserAliases('.html', '.html, .zip'),
    counted: true,
  },
  {
    id: 'raindrop',
    label: 'Raindrop.io',
    description:
      'In Raindrop.io, open All bookmarks and choose Export > Get backup, then the CSV under Settings > Backups. One collection exports from its own Export > CSV. Collections become folders, and notes, excerpts and highlights come along.',
    accept: '.csv,.zip',
    enabled: true,
    sourceTag: 'raindrop',
    parse: parseRaindrop,
    group: 'bookmarks',
    icon: { src: '/help/icons/raindrop.svg' },
    labelKey: null,
    descKey: 'sourceDesc.raindrop',
    fileTypes: '.csv, .zip',
    guide: 'raindrop',
  },
  {
    id: 'vcard',
    label: 'Contacts (vCard)',
    // No sourceTag: the groups on the phone arrive as tags already.
    // Spec: docs/internal/specs/contacts-pillar.md (section 7.3, CATEGORIES become tags)
    description:
      'The .vcf file your phone or address book exports: iPhone and Mac through iCloud or Contacts, Android, Google Contacts. Every card comes across, photos included, and importing the same file twice skips the people you already have.',
    accept: '.vcf,.vcard',
    enabled: true,
    sourceTag: '',
    parse: parseVcard,
    group: 'contacts',
    icon: { glyph: 'address-book' },
    labelKey: 'sourceLabel.vcard',
    descKey: 'sourceDesc.vcard',
    fileTypes: '.vcf',
    guide: 'contacts',
    counted: true,
  },
  {
    id: 'google-calendar',
    label: 'Google Calendar',
    // No sourceTag: each calendar arrives as a folder already.
    // Spec: docs/internal/specs/google-calendar-import.md (section 4)
    description:
      'The .zip from Settings > Import & export, or one .ics file. Events keep their times, repeats and reminders.',
    accept: '.ics,.zip',
    enabled: true,
    sourceTag: '',
    parse: parseGoogleCalendar,
    group: 'calendar',
    icon: { src: '/help/icons/google-calendar.svg' },
    labelKey: null,
    descKey: 'sourceDesc.googleCalendar',
    fileTypes: '.ics, .zip',
    guide: 'google-calendar',
    aliases: [
      {
        key: 'apple-calendar',
        label: 'Apple Calendar',
        icon: { src: '/help/icons/apple-calendar.webp' },
        fileTypes: '.ics',
        descKey: 'sourceDesc.appleCalendar',
        guide: 'apple-calendar',
      },
    ],
  },
  {
    id: 'excalidraw',
    label: 'Excalidraw',
    description:
      'Drawings saved from excalidraw.com: one .excalidraw file, or several zipped together. Drawings from Obsidian\'s Excalidraw plugin work too, as .excalidraw.md files. Pictures inside a drawing come along.',
    accept: '.excalidraw,.md,.zip',
    enabled: true,
    sourceTag: 'excalidraw',
    parse: parseExcalidraw,
    group: 'drawings',
    icon: { glyph: 'drawing' },
    labelKey: null,
    descKey: 'sourceDesc.excalidraw',
    fileTypes: '.excalidraw, .zip',
    guide: null,
  },
  {
    id: 'obsidian-canvas',
    label: 'Obsidian Canvas',
    description:
      'One .canvas file from your Obsidian vault, or the whole vault as a .zip to bring in every canvas. Each canvas becomes a drawing: cards, groups, arrows and colors come along, and pictures do too when they are in the .zip.',
    accept: '.canvas,.zip',
    enabled: true,
    sourceTag: 'obsidian',
    parse: parseObsidianCanvas,
    group: 'drawings',
    icon: { src: '/help/icons/obsidian.svg' },
    labelKey: null,
    descKey: 'sourceDesc.obsidianCanvas',
    fileTypes: '.canvas, .zip',
    guide: null,
  },
  {
    id: 'evernote',
    label: 'Evernote',
    description:
      'One .enex on its own, or several zipped together. Keeps formatting, tags, attachments, note links, and notebooks. Evernote leaves tasks out of .enex.',
    accept: '.enex,.zip',
    enabled: true,
    sourceTag: 'evernote',
    parse: parseEvernote,
    group: 'notes',
    icon: { src: '/help/icons/evernote.svg' },
    labelKey: null,
    descKey: 'sourceDesc.evernote',
    fileTypes: '.enex, .zip',
    guide: 'evernote',
  },
  {
    id: 'apple-notes',
    label: 'Apple Notes',
    description:
      'Import from Apple Notes via the free Exporter app. Export as Markdown, then drop the .zip here.',
    accept: '.zip',
    enabled: true,
    sourceTag: 'apple',
    parse: parseAppleNotes,
    group: 'notes',
    icon: { src: '/help/icons/apple-notes.svg' },
    labelKey: null,
    descKey: 'sourceDesc.appleNotes',
    fileTypes: '.zip',
    guide: 'apple-notes',
    counted: true,
  },
  {
    id: 'apple-journal',
    label: 'Apple Journal',
    description:
      'Export from Journal on Mac or iPhone, compress the AppleJournalEntries folder, and drop the .zip. Entries import as journal entries with their photos, videos, voice memos, and locations.',
    accept: '.zip',
    enabled: true,
    sourceTag: 'apple-journal',
    parse: parseAppleJournal,
    group: 'journal',
    icon: { src: '/help/icons/apple-journal.webp' },
    labelKey: null,
    descKey: 'sourceDesc.appleJournal',
    fileTypes: '.zip',
    guide: 'apple-journal',
    counted: true,
  },
  {
    id: 'day-one',
    label: 'Day One',
    description:
      'In Day One, choose Edit Journal > Journal Settings > Export Journal > Export journal JSON file (with media) on the web, or File > Export > JSON on Mac or iOS. Drop the .zip or .json here. Entries keep their day, tags, stars, place, weather, and media.',
    accept: '.zip,.json',
    enabled: true,
    sourceTag: 'day-one',
    parse: parseDayOne,
    group: 'journal',
    icon: { src: '/help/icons/day-one.webp' },
    labelKey: null,
    descKey: 'sourceDesc.dayOne',
    fileTypes: '.zip, .json',
    guide: 'day-one',
  },
  {
    id: 'microsoft-to-do',
    label: 'Microsoft To Do',
    description:
      'Export your Microsoft To Do account with our free browser-only tool at todo.privacynotes.app, then drop the .zip or .json here. Each list becomes a task list with completed tasks, subtasks, priorities, due dates, repeats, categories, notes, and attachments.',
    accept: '.zip,.json',
    enabled: true,
    sourceTag: 'microsoft-to-do',
    parse: parseMicrosoftToDo,
    group: 'tasks',
    icon: { src: '/help/icons/microsoft-to-do.svg' },
    labelKey: null,
    descKey: 'sourceDesc.microsoftToDo',
    fileTypes: '.zip, .json',
    guide: 'microsoft-to-do',
  },
  {
    id: 'todoist',
    label: 'Todoist',
    description:
      'In Todoist, download a backup .zip from Settings > Backups (Pro), or open a project and choose ... > Import & export > Export as CSV. Each project becomes a task list with its sections, subtasks, priorities, due dates, labels, descriptions, and comments.',
    accept: '.zip,.csv',
    enabled: true,
    sourceTag: 'todoist',
    parse: parseTodoist,
    group: 'tasks',
    icon: { src: '/help/icons/todoist.svg' },
    labelKey: null,
    descKey: 'sourceDesc.todoist',
    fileTypes: '.zip, .csv',
    guide: 'todoist',
  },
  {
    id: 'daylio',
    label: 'Daylio',
    description:
      'In Daylio choose More > Backup & Restore > Advanced Options > Export, then drop the .daylio file here. Each entry imports as a journal entry with its mood, activities, scales, photos and voice memos. The CSV from More > Export Entries works too, without photos.',
    accept: '.daylio,.csv,.zip',
    enabled: true,
    sourceTag: 'daylio',
    parse: parseDaylio,
    group: 'journal',
    icon: { src: '/help/icons/daylio.webp' },
    labelKey: null,
    descKey: 'sourceDesc.daylio',
    fileTypes: '.daylio, .csv',
    guide: 'daylio',
  },
  {
    id: 'diaro',
    label: 'Diaro',
    description:
      'In Diaro, choose Settings > Data > Backup & restore, tap +, leave encryption off and attachments on, and drop the .zip backup here. A bare DiaroBackup.xml works too, without photos. Entries keep their day, folders, tags, moods, places, weather and photos.',
    accept: '.zip,.xml,.drxml,.denc',
    enabled: true,
    sourceTag: 'diaro',
    parse: parseDiaro,
    group: 'journal',
    icon: { src: '/help/icons/diaro.webp' },
    labelKey: null,
    descKey: 'sourceDesc.diaro',
    fileTypes: '.zip, .xml',
    guide: 'diaro',
    sortKey: 'diar0',
  },
  {
    id: 'diarium',
    label: 'Diarium',
    description:
      'In Diarium choose Export, pick JSON with Attachments on, and save to local storage; drop the .zip or .json here. Entries import as journal entries with their rating as mood, tags, people, trackers, place and attachments.',
    accept: '.zip,.json',
    enabled: true,
    sourceTag: 'diarium',
    parse: parseDiarium,
    group: 'journal',
    icon: { src: '/help/icons/diarium.webp' },
    labelKey: null,
    descKey: 'sourceDesc.diarium',
    fileTypes: '.zip, .json',
    guide: 'diarium',
  },
  {
    id: 'google-journal',
    label: 'Google Journal',
    description:
      'Turn on Back up your journal in Journal on your Pixel, then export Journal from Google Takeout and drop the .zip here. Entries keep their day, title, text, photos and videos.',
    accept: '.zip',
    enabled: true,
    sourceTag: 'google-journal',
    parse: parseGoogleJournal,
    group: 'journal',
    icon: { src: '/help/icons/google-journal.webp' },
    labelKey: null,
    descKey: 'sourceDesc.googleJournal',
    fileTypes: '.zip',
    guide: 'google-journal',
  },
  {
    id: 'samsung-notes',
    label: 'Samsung Notes',
    description:
      'Export from Samsung Notes as Word (.docx) for rich formatting, or as Text (.txt) for plain text. Zip multiple files for bulk import.',
    accept: '.zip,.txt,.docx',
    enabled: true,
    sourceTag: 'samsung',
    parse: parseSamsungNotes,
    group: 'notes',
    icon: { src: '/help/icons/samsung-notes.webp' },
    labelKey: null,
    descKey: 'sourceDesc.samsungNotes',
    fileTypes: '.docx, .txt, .zip',
    guide: 'samsung-notes',
    counted: true,
  },
  {
    ...simplenoteImporter,
    group: 'notes',
    icon: { src: '/help/icons/simplenote.svg' },
    labelKey: null,
    descKey: 'sourceDesc.simplenote',
    fileTypes: '.zip, .json',
    guide: 'simplenote',
    counted: true,
  },
  {
    ...standardNotesImporter,
    group: 'notes',
    icon: { src: '/help/icons/standard-notes.webp' },
    labelKey: null,
    descKey: 'sourceDesc.standardNotes',
    fileTypes: '.zip, .txt',
    guide: 'standard-notes',
    counted: true,
  },
  {
    ...bitwardenImporter,
    group: 'passwords',
    icon: { src: '/help/icons/bitwarden.svg' },
    labelKey: null,
    descKey: 'sourceDesc.bitwarden',
    fileTypes: '.json, .zip',
    guide: 'bitwarden',
  },
  {
    ...passwordCsvImporter,
    group: 'passwords',
    icon: null,
    labelKey: 'sourceLabel.browserPasswords',
    descKey: 'sourceDesc.browserPasswords',
    fileTypes: '.csv, .zip',
    guide: 'browser-passwords',
    aliases: [
      {
        key: 'apple-passwords',
        label: 'Apple Passwords',
        icon: { src: '/help/icons/apple-passwords.webp' },
        fileTypes: '.csv',
        sortKey: '0-apple-passwords',
      },
      ...browserAliases('.csv', '.csv, .zip'),
    ],
    counted: true,
  },
  {
    ...keepassxcImporter,
    group: 'passwords',
    icon: { src: '/help/icons/keepassxc.svg' },
    labelKey: null,
    descKey: 'sourceDesc.keepassxc',
    fileTypes: '.xml, .csv',
    guide: 'keepassxc',
  },
  {
    ...keepassImporter,
    group: 'passwords',
    icon: { src: '/help/icons/keepass.webp' },
    labelKey: null,
    descKey: 'sourceDesc.keepass',
    fileTypes: '.xml, .csv',
    guide: 'keepass',
  },
  {
    ...lastpassImporter,
    group: 'passwords',
    icon: { src: '/help/icons/lastpass.svg' },
    labelKey: null,
    descKey: 'sourceDesc.lastpass',
    fileTypes: '.csv',
    guide: 'lastpass',
  },
  {
    ...nordpassImporter,
    group: 'passwords',
    icon: { src: '/help/icons/nordpass.webp' },
    labelKey: null,
    descKey: 'sourceDesc.nordpass',
    fileTypes: '.csv',
    guide: 'nordpass',
  },
  {
    ...protonPassImporter,
    group: 'passwords',
    icon: { src: '/help/icons/proton-pass.svg' },
    labelKey: null,
    descKey: 'sourceDesc.protonPass',
    fileTypes: '.zip, .csv',
    guide: 'proton-pass',
  },
  {
    ...onePasswordImporter,
    group: 'passwords',
    icon: { src: '/help/icons/1password.webp' },
    labelKey: null,
    descKey: 'sourceDesc.onePassword',
    fileTypes: '.1pux, .csv',
    guide: '1password',
  },
  {
    ...enpassImporter,
    group: 'passwords',
    icon: { src: '/help/icons/enpass.svg' },
    labelKey: null,
    descKey: 'sourceDesc.enpass',
    fileTypes: '.json',
    guide: 'enpass',
  },
  {
    ...dashlaneImporter,
    group: 'passwords',
    icon: { src: '/help/icons/dashlane.svg' },
    labelKey: null,
    descKey: 'sourceDesc.dashlane',
    fileTypes: '.zip, .csv',
    guide: 'dashlane',
  },
  {
    ...msecureImporter,
    group: 'passwords',
    icon: { src: '/help/icons/msecure.svg' },
    labelKey: null,
    descKey: 'sourceDesc.msecure',
    fileTypes: '.csv',
    guide: 'msecure',
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    description:
      'Import an Obsidian vault (.zip). Preserves tags, note-links, folder structure, inline #tags, and embedded images and files. Canvases and Excalidraw drawings become drawings, and one .canvas file imports on its own too.',
    accept: '.zip,.canvas',
    enabled: true,
    sourceTag: 'obsidian',
    parse: parseObsidian,
    group: 'notes',
    icon: { src: '/help/icons/obsidian.svg' },
    labelKey: null,
    descKey: 'sourceDesc.obsidian',
    fileTypes: '.zip, .canvas',
    guide: 'obsidian',
    counted: true,
  },
  {
    id: 'notesnook',
    label: 'Notesnook',
    description:
      'Export all notes from Notesnook as HTML (.zip). Preserves notebooks as folders, tags, internal links, attachments, and formatting.',
    accept: '.zip,.nnbackupz',
    enabled: true,
    sourceTag: 'notesnook',
    parse: parseNotesnook,
    group: 'notes',
    icon: { src: '/help/icons/notesnook.svg' },
    labelKey: null,
    descKey: 'sourceDesc.notesnook',
    fileTypes: '.zip',
    guide: 'notesnook',
    counted: true,
  },
  {
    id: 'notion',
    label: 'Notion',
    description:
      'In Notion, choose Settings > General > Export > Workspace content (or a page menu > More > Export), pick "Markdown & CSV" with subpages and folders on, then drop the .zip here. Strips Notion IDs from titles and folders, keeps subpages as folders, converts callouts and internal links to note-links, and brings images, files, and database row pages along.',
    accept: '.zip',
    enabled: true,
    sourceTag: 'notion',
    parse: parseNotion,
    group: 'notes',
    icon: { src: '/help/icons/notion.webp' },
    labelKey: null,
    descKey: 'sourceDesc.notion',
    fileTypes: '.zip',
    guide: 'notion',
  },
  {
    id: 'joplin',
    label: 'Joplin',
    description:
      'In Joplin: File > Export all > "JEX - Joplin Export File", then drop the .jex file here. Keeps notebooks as folders, tags, to-dos, note links, and attachments.',
    accept: '.jex,.zip',
    enabled: true,
    sourceTag: 'joplin',
    parse: parseJoplin,
    group: 'notes',
    icon: { src: '/help/icons/joplin.svg' },
    labelKey: null,
    descKey: 'sourceDesc.joplin',
    fileTypes: '.jex, .zip',
    guide: 'joplin',
  },
  {
    id: 'anytype',
    label: 'Anytype',
    description:
      'In Anytype: space settings > Export > Any-Block v1, file format JSON, with zip, files and archived objects on. Drop the .zip here. Keeps tags, collections as folders, tasks, callouts, toggles, tables, note-links, and files.',
    accept: '.zip',
    enabled: true,
    sourceTag: 'anytype',
    parse: parseAnytype,
    group: 'notes',
    icon: { src: '/help/icons/anytype.webp' },
    labelKey: null,
    descKey: 'sourceDesc.anytype',
    fileTypes: '.zip',
    guide: 'anytype',
  },
  {
    id: 'capacities',
    label: 'Capacities',
    description:
      'In Capacities: Settings > Full Export > Manual Full Export, with media included, then drop the .zip here. Keeps object types as folders, tags, properties, dates, links between objects as note-links, tables, images, and files.',
    accept: '.zip',
    enabled: true,
    sourceTag: 'capacities',
    parse: parseCapacities,
    group: 'notes',
    icon: { src: '/help/icons/capacities.svg' },
    labelKey: null,
    descKey: 'sourceDesc.capacities',
    fileTypes: '.zip',
    guide: 'capacities',
  },
  {
    id: 'siyuan',
    label: 'SiYuan',
    description:
      'In SiYuan: main menu > Data migration > Data.zip > Export, then drop the .zip here. A notebook exported as SiYuan .sy.zip works too. Keeps notebooks and nested documents as folders, tags, block references as note-links, callouts, math, tables, and assets.',
    accept: '.zip',
    enabled: true,
    sourceTag: 'siyuan',
    parse: parseSiyuan,
    group: 'notes',
    icon: { src: '/help/icons/siyuan.svg' },
    labelKey: null,
    descKey: 'sourceDesc.siyuan',
    fileTypes: '.zip',
    guide: 'siyuan',
  },
  {
    id: 'onenote',
    label: 'OneNote',
    description:
      'In OneNote for Windows: File > Export > Notebook > OneNote Package (*.onepkg), then drop the .onepkg file here. A section file (.one) or a zipped notebook folder works too. Keeps sections and section groups as folders, subpages, to-dos, note tags, tables, page links as note-links, pictures and attached files.',
    accept: '.onepkg,.one,.zip',
    enabled: true,
    sourceTag: 'onenote',
    parse: parseOneNote,
    group: 'notes',
    icon: { src: '/help/icons/onenote.webp' },
    labelKey: null,
    descKey: 'sourceDesc.onenote',
    fileTypes: '.onepkg, .one, .zip',
    guide: 'onenote',
  },
  {
    id: 'bear',
    label: 'Bear',
    description:
      'In Bear: File > Backup Notes..., then drop the .bear2bk file here. Keeps tags, nested tags, pins, the archive, the trash, highlights, note-links, and attachments. A zipped Markdown or Text Bundle export works too.',
    accept: '.bear2bk,.zip',
    enabled: true,
    sourceTag: 'bear',
    parse: parseBear,
    group: 'notes',
    icon: { src: '/help/icons/bear.webp' },
    labelKey: null,
    descKey: 'sourceDesc.bear',
    fileTypes: '.bear2bk, .zip',
    guide: 'bear',
  },
  {
    id: 'upnote',
    label: 'UpNote',
    description:
      'In UpNote: Settings > Backup > Backup now, then zip everything in the backup folder. Keeps notebooks, tags, pins, note links, formatting, and attachments. Per-note exports from the phone apps work too - pick "Export to HTML".',
    accept: '.md,.html,.zip',
    enabled: true,
    sourceTag: 'upnote',
    parse: parseUpNote,
    group: 'notes',
    icon: { src: '/help/icons/upnote.svg' },
    labelKey: null,
    descKey: 'sourceDesc.upnote',
    fileTypes: '.zip, .html, .md',
    guide: 'upnote',
  },
  // Aliases of markdown-folder: one parser, four rows. `parse` is deliberately
  // the same function rather than a wrapper - there is nothing app-specific to
  // do, and a wrapper would invite one to grow. What differs is what the user
  // sees: the app's name, its icon, its guide, and the tag its notes arrive
  // with.
  ...(['typora', 'ia-writer', 'zettlr', 'nextcloud-notes'] as const).map((id) => ({
    id,
    label: MARKDOWN_APP_LABEL[id],
    description: MARKDOWN_APP_DESCRIPTION,
    accept: MARKDOWN_ACCEPT,
    enabled: true,
    sourceTag: id,
    parse: parseMarkdown,
    group: 'notes' as const,
    icon: { src: MARKDOWN_APP_ICON[id] },
    labelKey: null,
    // One shared line for the four: the parser is the same, so four
    // near-identical descriptions would be four copies to keep in step
    // across every locale. What differs per app is in its guide.
    descKey: 'sourceDesc.markdownApp',
    fileTypes: '.zip',
    guide: id,
  })),
  {
    id: 'markdown-folder',
    label: 'Markdown files',
    description:
      'Import .md or .txt files individually or as a .zip. A zipped folder keeps its subfolders and brings its images and attachments along. Works with PrivacyNotes exports, Obsidian vaults, or any plain markdown.',
    accept: MARKDOWN_ACCEPT,
    enabled: true,
    sourceTag: 'markdown',
    parse: parseMarkdown,
    group: 'notes',
    icon: { src: '/help/icons/markdown.svg' },
    labelKey: 'sourceLabel.markdownFolder',
    descKey: 'sourceDesc.markdownFolder',
    fileTypes: '.md, .txt, .zip',
    guide: 'markdown',
    counted: true,
  },
];

const COUNTED_SOURCE_IDS: ReadonlySet<string> = new Set(
  IMPORTERS.filter((i) => i.counted).map((i) => i.id),
);

/** The source key an import from this importer records in `admin_events`, or `null` when uncounted. */
export function importerIdToSource(id: string): ImportSource | null {
  return COUNTED_SOURCE_IDS.has(id) ? (id as ImportSource) : null;
}

/** An importer's name in the reader's language, or its brand name unchanged. */
export function sourceLabel(
  imp: Pick<ImporterEntry, 'label' | 'labelKey'>,
  t: (key: string) => string,
): string {
  return imp.labelKey ? t(imp.labelKey) : imp.label;
}

export type PickerSectionKey = 'notes' | 'tasks' | 'drawings' | 'calendar' | 'bookmarks' | 'passwords';

/** Structured picker tile identity (`aliasKey` is `null` for direct importer and Webcal cards). */
export interface PickerCardKey {
  importerId: ImporterId | 'webcal';
  aliasKey: string | null;
}

export type PickerCard =
  | {
      kind: 'importer';
      importerId: ImporterId;
      aliasKey: string | null;
      importer: ImporterEntry;
      /** Entry passed to `onPick` (carries the alias's brand `label` when `aliasKey` is set). */
      pickImporter: ImporterEntry;
      label: string;
      fileTypes: string;
      desc: string;
      icon: ImporterIcon;
      guide: string | null;
      /** Settings-search marker override for aliases with their own description (`import.alias.<key>`). */
      aliasSetting: string | null;
      sortKey: string;
    }
  | {
      kind: 'webcal';
      importerId: 'webcal';
      aliasKey: null;
      label: string;
      fileTypes: string;
      desc: string;
      sortKey: string;
    };

export interface PickerGroup {
  key: PickerSectionKey;
  title: string;
  cards: PickerCard[];
}

const SECTION_OF_GROUP: ReadonlyMap<ImporterGroup, PickerSectionKey> = new Map<ImporterGroup, PickerSectionKey>([
  ['notes', 'notes'],
  ['journal', 'notes'],
  ['files', 'notes'],
  ['tasks', 'tasks'],
  ['drawings', 'drawings'],
  ['calendar', 'calendar'],
  ['contacts', 'calendar'],
  ['bookmarks', 'bookmarks'],
  ['passwords', 'passwords'],
]);

const PICKER_SECTIONS: readonly { key: PickerSectionKey; titleKey: string }[] = [
  { key: 'notes', titleKey: 'shell:tagsRail.notes' },
  { key: 'tasks', titleKey: 'shell:tagsRail.tasks' },
  { key: 'drawings', titleKey: 'shell:tagsRail.drawings' },
  { key: 'calendar', titleKey: 'importPick.groupCalendar' },
  { key: 'bookmarks', titleKey: 'shell:tagsRail.bookmarks' },
  { key: 'passwords', titleKey: 'shell.tabVault' },
];

const WEBCAL_TYPES = 'webcal://';

/**
 * Build the ordered picker sections and cards from `IMPORTERS` (plus the Webcal
 * card in the Calendar section). Sources are grouped by destination pillar and
 * sorted deterministically within each section; Obsidian appears under Notes
 * for full vaults and under Drawings for standalone canvases.
 */
export function buildPickerGroups(
  t: (key: string) => string,
  importers: readonly ImporterEntry[] = IMPORTERS,
): PickerGroup[] {
  const buckets = new Map<PickerSectionKey, PickerCard[]>(
    PICKER_SECTIONS.map((s) => [s.key, []]),
  );

  for (const imp of importers) {
    if (!imp.group || imp.restore) continue;
    const section = SECTION_OF_GROUP.get(imp.group);
    const bucket = section ? buckets.get(section) : undefined;
    if (!bucket) continue;

    if (imp.icon) {
      bucket.push({
        kind: 'importer',
        importerId: imp.id,
        aliasKey: null,
        importer: imp,
        pickImporter: imp,
        label: sourceLabel(imp, t),
        fileTypes: imp.fileTypes,
        desc: imp.descKey ? t(imp.descKey) : imp.description,
        icon: imp.icon,
        guide: imp.guide,
        aliasSetting: null,
        sortKey: imp.sortKey ?? imp.label.toLowerCase(),
      });
    }

    for (const alias of imp.aliases ?? []) {
      bucket.push({
        kind: 'importer',
        importerId: imp.id,
        aliasKey: alias.key,
        importer: imp,
        pickImporter: { ...imp, label: alias.label },
        label: alias.label,
        fileTypes: alias.fileTypes,
        desc: alias.descKey ? t(alias.descKey) : imp.descKey ? t(imp.descKey) : imp.description,
        icon: alias.icon,
        guide: alias.guide !== undefined ? alias.guide : alias.descKey ? null : imp.guide,
        aliasSetting: alias.descKey ? `import.alias.${alias.key}` : null,
        sortKey: alias.sortKey ?? alias.label.toLowerCase(),
      });
    }
  }

  buckets.get('calendar')?.push({
    kind: 'webcal',
    importerId: 'webcal',
    aliasKey: null,
    label: t('webcal.title'),
    fileTypes: WEBCAL_TYPES,
    desc: t('webcal.desc'),
    sortKey: 'webcal',
  });

  return PICKER_SECTIONS.map((s) => {
    const cards = [...(buckets.get(s.key) ?? [])].sort((a, b) =>
      a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
    );
    return { key: s.key, title: t(s.titleKey), cards };
  }).filter((g) => g.cards.length > 0);
}

/**
 * Filter picker groups by a user search query against card label, file
 * extensions, or group heading (so searching `"bookmarks"` retains every
 * browser card in the Bookmarks group).
 */
export function filterPickerCards(
  groups: readonly PickerGroup[],
  query: string,
): PickerGroup[] {
  const match = query.trim() ? textMatcher(query) : null;
  if (!match) return groups.filter((g) => g.cards.length > 0);
  return groups
    .map((g) => ({
      ...g,
      cards: g.cards.filter(
        (c) => Boolean(match(c.label) || match(c.fileTypes) || match(g.title)),
      ),
    }))
    .filter((g) => g.cards.length > 0);
}
