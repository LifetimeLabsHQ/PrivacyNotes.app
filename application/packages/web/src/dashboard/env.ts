/**
 * What Home reads from the app shell: the notes every widget reads, the
 * handlers that open things, and the prebuilt cards. NotesView builds it
 * once per render; the widgets never reach into NotesView.
 * Spec: docs/internal/specs/dashboard.md (section 5)
 */
import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';
import type { LocalNote } from '../db';
import type { LinkIndex } from '../connectionsIndex';
import type { FolderDef } from '../folders';
import type { ItemStyles } from '../itemStyles';
import type { ListPrefs } from '../listPrefs';
import type { DayIndex } from '../notesViewUtils';
import type { FileItem } from '../FilesList';
import type { TaskItem } from '../tasks';
import type { TrackerSetupTab } from '../TrackerConfig';
import type { FactorDef, JournalTrackerData, MedicationTemplate, TrackerSettings } from '../trackerTypes';
import type { View } from '../views';

export type QuickCaptureMode = 'journal' | 'task' | 'note';

export interface DashboardEnv {
  /** Live, not archived, the open space, with the Global list's two "Other"
   *  switches applied. */
  pool: LocalNote[];
  /** Live, not archived, the open space, no list switch applied: whether a
   *  target still exists here, and whether today's entry does. */
  listed: LocalNote[];
  /** Every live item in every space: tells a target that is gone from one in
   *  the other space. */
  everywhere: LocalNote[];
  /** Changes when a PIN window opens or closes; every memo that reads a body
   *  keys on it. */
  gatedKey: string;
  isNoteLocked: (n: LocalNote) => boolean;
  /** The files in these items, newest first. Handed in, not imported: the
   *  Files list module lives on the boot path, and an import from this lazy
   *  pane would split it out of the shell's chunk. */
  fileItemsOf: (notes: LocalNote[]) => FileItem[];
  /** The task lines in these items, and a birthday's date in a year:
   *  handed in for the same reason. */
  tasksOf: (notes: LocalNote[]) => TaskItem[];
  birthdayIn: (year: number, month: number, day: number) => string | null;
  listPrefs: ListPrefs;
  selectedId: string | null;
  /** Opens an item beside Home, as a row click does. */
  open: (id: string) => void;
  /** Standard note context menu for rows rendered inside Home list widgets. */
  onNoteContextMenu?: (e: MouseEvent, note: LocalNote) => void;
  /** Home canvas right-click shell controls (Quick add, Zen, sidebar, widths, Settings). */
  shellMenu?: {
    onQuickAdd: () => void;
    zenMode: boolean;
    onToggleZen: () => void;
    sidebarCollapsed: boolean;
    onToggleSidebar: () => void;
    onResetPaneWidths: () => void;
    onOpenSettings: () => void;
  };
  openCalendarItem: (id: string, occurrence?: string) => void;
  calendarDays: DayIndex;
  /** The month, check-in and medication cards, each its own grid item. */
  calendarCard: ReactNode;
  checkInCard: ReactNode;
  medicationCard: ReactNode;
  toggleTask: (task: TaskItem, checked: boolean) => void;
  openTaskSource: (task: TaskItem) => void;
  /** Append a quick task to Quick Tasks without leaving Home. */
  addQuickTask: (text: string) => Promise<boolean>;
  /** Capture a typed thought into today's journal, Quick Tasks, or a new note. */
  quickCapture: (text: string, mode: QuickCaptureMode) => Promise<{ id: string; title: string } | null>;
  /** Encrypt and save a recorded audio clip into today's journal or a new voice note. */
  quickVoiceCapture: (file: File, mode: QuickCaptureMode) => Promise<{ id: string; title: string } | null>;
  /** Merge a tracker patch into `day`'s journal entry (for Counter on Home). */
  saveCheckIn: (day: string, patch: JournalTrackerData) => Promise<void>;
  /** Open or start a journal entry for `day`. */
  openJournalDay: (day: string) => void;
  /** Open Settings > Trackers at a tab. */
  openTrackers: (tab: TrackerSetupTab) => void;
  /** Makes today's journal entry and opens it. */
  startToday: () => void;
  goTo: (view: View) => void;
  /** All, filtered to a tag or a folder: a tag or folder widget's link. */
  openTag: (tag: string) => void;
  openFolder: (id: string) => void;
  openStats: () => void;
  openGraph: (lens: 'graph' | 'places') => void;
  openStorage: () => void;
  refreshStorage: () => Promise<void>;
  storageUsedBytes: number;
  storageMaxBytes: number;
  storageNoteCount: number;
  storageFileCount: number;
  linkIndex: LinkIndex;
  itemStyles: ItemStyles;
  folders: FolderDef[];
  includeSubfolders: boolean;
  trackerSettings: TrackerSettings;
  medications: MedicationTemplate[];
  factors: FactorDef[];
  notesCreated: number;
  firstSeenAt: string | null;
  isPro: boolean;
  /** Pro or the demo. */
  unlocked: boolean;
  onUpgrade: () => void;
  /** The settings are a read made while the sealed part was locked: nothing
   *  may write the layout. */
  locked: boolean;
}

export const DashboardEnvContext = createContext<DashboardEnv | null>(null);

export function useDashboardEnv(): DashboardEnv {
  const env = useContext(DashboardEnvContext);
  if (!env) throw new Error('Home widget outside the dashboard');
  return env;
}
