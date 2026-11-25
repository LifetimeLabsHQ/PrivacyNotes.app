import { ProtectedNoteGate } from './ProtectedNoteGate';
import type { Icon } from './icons';
import type { UserSettings } from './userSettings';
import type { View } from './views';
import { ListNav } from './notesView/ListNav';
import { ListPaneHeader } from './ui';

/**
 * A shut section's one pane. There is nothing to list, so the list column
 * steps aside and this takes the wide pane, as the Markdown entry state does;
 * its title row is the list's own, which carries the section switcher and the
 * phone's drawer button. The gate is the protected note's own, worded for a
 * section.
 * Spec: docs/internal/specs/section-lock.md (section 7)
 */
export function SectionGate({
  view,
  label,
  icon: Glyph,
  phrase,
  removing,
  onUnlock,
  onRemoveProtection,
  onExitRemove,
  onSelectView,
  hiddenViews,
  onOpenDrawer,
  userSettings,
  onSettingsChange,
}: {
  view: View;
  /** The section's name, the pane's title. */
  label: string;
  icon: Icon;
  phrase: string;
  /** Open in its remove form: "Protect {section}" was switched off. */
  removing: boolean;
  onUnlock: () => void;
  onRemoveProtection: () => void;
  onExitRemove: () => void;
  onSelectView: (next: View) => void;
  hiddenViews: View[] | undefined;
  onOpenDrawer: () => void;
  userSettings: UserSettings;
  onSettingsChange: (next: UserSettings, base: UserSettings) => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* The title row `NotesList` uses, so the header is the same control. */}
      <ListPaneHeader
        className="px-4"
        leading={
          <ListNav
            view={view}
            hiddenViews={hiddenViews}
            onSelectView={onSelectView}
            onOpenDrawer={onOpenDrawer}
            icon={<Glyph size={26} className="text-accent shrink-0" aria-hidden="true" />}
            title={label}
          />
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-8">
        <ProtectedNoteGate
          section
          phrase={phrase}
          initialIntent={removing ? 'remove' : 'unlock'}
          onUnlock={onUnlock}
          onRemoveProtection={onRemoveProtection}
          onExitRemove={onExitRemove}
          userSettings={userSettings}
          onSettingsChange={onSettingsChange}
        />
      </div>
    </div>
  );
}
