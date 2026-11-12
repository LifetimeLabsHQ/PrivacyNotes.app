/**
 * The keyboard shortcuts, explained: the commands with the keys this
 * browser has for them now, the `pn` address-bar keyword, and a button to
 * the browser's own page where the keys change. `useShortcuts` feeds the
 * same keys to the popup's tooltips and hints.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.5)
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Kbd } from '@web/ui/misc';
import { SETTINGS_HELP } from '@web/settingsUI';
import { openShortcutSettings, readShortcuts, SHORTCUT_COMMANDS, type ShortcutCommand, type Shortcuts } from '../../src/shortcuts';

/** The browser's keys for the commands; empty until read. */
export function useShortcuts(): Shortcuts {
  const [keys, setKeys] = useState<Shortcuts>({});
  useEffect(() => {
    void readShortcuts().then(setKeys);
  }, []);
  return keys;
}

const LABELS: Record<ShortcutCommand, string> = {
  _execute_action: 'manifest.commandOpen',
  'copy-login': 'manifest.commandCopyLogin',
  'save-note': 'manifest.commandSaveNote',
  'lock-vault': 'manifest.commandLock',
  'generate-password': 'manifest.commandGenerate',
  'save-bookmark': 'manifest.commandSaveBookmark',
  'new-note': 'manifest.commandNewNote',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-divider last:border-b-0">
      <span className="text-body text-pn">{label}</span>
      <span dir="ltr" className="flex shrink-0 gap-1">{children}</span>
    </div>
  );
}

export function ShortcutsView() {
  const { t } = useTranslation('extension');
  const keys = useShortcuts();
  return (
    <div className="p-3 space-y-3">
      <div>
        {SHORTCUT_COMMANDS.map((c) => (
          <Row key={c} label={t(LABELS[c])}>
            {keys[c] ? <Kbd>{keys[c]}</Kbd> : <span className="text-meta text-pn-muted">{t('shortcuts.notSet')}</span>}
          </Row>
        ))}
        <Row label={t('shortcuts.addressBar')}>
          <Kbd>pn</Kbd>
          <Kbd>Space</Kbd>
        </Row>
      </div>
      <p className={SETTINGS_HELP}>{t('shortcuts.changeHint')}</p>
      <Button variant="primary" icon={<Keyboard aria-hidden="true" />} onClick={() => void openShortcutSettings()} className="w-full">
        {t('shortcuts.change')}
      </Button>
    </div>
  );
}
