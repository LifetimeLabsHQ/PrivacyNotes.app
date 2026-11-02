/**
 * The drawing canvas's own keys, in a window of their own: they work while
 * the canvas has the focus, so they stay out of the app's list. Opened from
 * the canvas's main menu and from `?` in the canvas; Settings > Hotkeys
 * shows the same rows on its Drawing tab. Lazy: a `lazyModal` from each door. The rows are English, as
 * the app's hotkey list is.
 * Spec: docs/internal/specs/drawing.md (section 0, Keys)
 */
import { useTranslation } from 'react-i18next';
import { Button, Modal } from '../ui';
import { openExternal } from '../openExternal';
import { HotkeyGroups } from '../HotkeyGroups';
import { DRAWING_HOTKEY_GROUPS } from '../hotkeysData';
import { Printer } from '../icons';
import { siteHref } from '../siteLinks';

export default function DrawingHotkeys({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('notes');
  const { t: tc } = useTranslation('common');
  return (
    <Modal
      title={t('drawing.hotkeysTitle')}
      header="bar"
      onClose={onClose}
      layer="z-[60]"
      className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col"
    >
      <div className="flex-1 overflow-y-auto p-6 text-body space-y-6">
        {/* The printed sheet's Drawing set, the same chip as the app's list. */}
        <div className="flex justify-end">
          <Button icon={<Printer aria-hidden="true" />} onClick={() => openExternal(siteHref('/help/keyboard-shortcuts/cheat-sheet?app=drawing'))}>
            {tc('hotkeys.cheatSheet')}
          </Button>
        </div>
        <HotkeyGroups groups={DRAWING_HOTKEY_GROUPS} />
      </div>
    </Modal>
  );
}
