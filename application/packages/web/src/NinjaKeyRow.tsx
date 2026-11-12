import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyBinding } from './commandKeys';
import { detectDeviceOs } from './deviceFingerprint';
import { NinjaIcon } from './NinjaIcon';
import { DEFAULT_NINJA_KEY, bindingFromPress, pauseNinjaKey, resumeNinjaKey, setNinjaKey, useNinjaKey } from './ninjaShortcut';
import { ROW_TITLE, SETTINGS_HELP } from './settingsUI';
import { KEY_OS } from './shortcutMatch';
import { Switch } from './Switch';
import { useTrayMode } from './trayMode';
import { useOpenAtLogin } from './openAtLogin';
import { Callout, HotkeyField, TerminalBlock } from './ui';

/** Each system names the launcher its people know. */
const DESC = KEY_OS === 'mac' ? 'appearance.ninjaKeyDescMac' : detectDeviceOs() === 'Linux' ? 'appearance.ninjaKeyDescLinux' : 'appearance.ninjaKeyDescWindows';

/**
 * Settings > System: the Ninja hotkey (GitHub #694). The switch
 * turns it on and off; the field takes the next key pressed in it, and the
 * old key lets go while it listens. A key the system refuses, and the
 * command a Linux Wayland session binds instead, show under it. With the
 * tray off, a line says the key stops when the window closes; with Open at
 * login off, a line says it stops after a restart.
 * Spec: docs/internal/plans/ninja-anywhere-694.md (section 2)
 */
export function NinjaKeyRow() {
  const { t } = useTranslation('settings');
  const { binding, taken, wayland } = useNinjaKey();
  const tray = useTrayMode();
  const atLogin = useOpenAtLogin();
  const [invalid, setInvalid] = useState(false);
  // The switch turned on again brings back the key it had.
  const last = useRef<KeyBinding>(binding ?? DEFAULT_NINJA_KEY);
  if (binding) last.current = binding;

  return (
    <div className="py-3">
      <Switch
        setting="appearance.ninjaKey"
        icon={<NinjaIcon className="text-accent" />}
        labelClassName={ROW_TITLE}
        label={t('appearance.ninjaKeyTitle')}
        description={t(DESC)}
        checked={!!binding}
        onChange={(on) => setNinjaKey(on ? last.current : null)}
        className="gap-x-5"
      />
      {binding && (
        <div className="mt-2 flex flex-col items-start gap-2">
          <HotkeyField
            value={binding}
            os={KEY_OS}
            read={(e) => bindingFromPress(e)}
            onChange={(next) => {
              setInvalid(false);
              setNinjaKey(next);
            }}
            onInvalid={() => setInvalid(true)}
            onFocusChange={(focused) => {
              setInvalid(false);
              if (focused) pauseNinjaKey();
              else resumeNinjaKey();
            }}
            label={t('appearance.ninjaKeyTitle')}
          />
          <p className={SETTINGS_HELP}>
            {invalid ? t(KEY_OS === 'mac' ? 'appearance.ninjaKeyInvalidMac' : 'appearance.ninjaKeyInvalid') : t('appearance.ninjaKeyHelp')}
          </p>
          {!tray && <p className={SETTINGS_HELP}>{t('appearance.ninjaKeyTray')}</p>}
          {!atLogin && <p className={SETTINGS_HELP}>{t('appearance.ninjaKeyLogin')}</p>}
          {taken && <Callout tone="warning">{t('appearance.ninjaKeyTaken')}</Callout>}
          {wayland && (
            <>
              <p className={SETTINGS_HELP}>{t('appearance.ninjaKeyWayland')}</p>
              <TerminalBlock value={wayland} copyLabel={t('common:actions.copy')} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
