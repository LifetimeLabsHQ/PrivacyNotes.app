/**
 * Settings > Hotkeys: the app's keys on the Typing tab, the drawing canvas's
 * keys on the Drawing tab, the same split as Settings > Toolbar. Touch-only
 * devices never show the pane. The rows stay in English.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Printer, Scribble, TextT } from './icons';
import { marketingHomeHref, siteHref } from './siteLinks';
import { DESKTOP_MORE_NOTE, DRAWING_HOTKEY_GROUPS, HOTKEY_GROUPS } from './hotkeysData';
import { HotkeyGroups } from './HotkeyGroups';
import { DESKTOP_APP } from './shortcutMatch';
import { setSingleKeys, useSingleKeys } from './singleKeys';
import { Switch } from './Switch';
import { ROW_TITLE, SettingsTabStrip, settingsTabClass } from './settingsUI';
import { usePaneTab } from './settingsPaneTab';
import { Button } from './ui';
import { openExternal } from './openExternal';

type Tab = 'typing' | 'drawing';

/** "Printable cheat sheet" chip: the static A4 sheet, rendered from the
 *  same hotkeysData.ts this pane reads, so the two can never drift. Shown
 *  above and below the list. The sheet is English-only by design, so the
 *  link carries no locale. */
function CheatSheetLink({ sheet, align = 'right' }: { sheet: 'app' | 'drawing'; align?: 'left' | 'right' }) {
  const { t } = useTranslation('common');
  const query = sheet === 'drawing' ? '?app=drawing' : DESKTOP_APP ? '?app=desktop' : '';
  return (
    <div className={`flex flex-wrap gap-2 ${align === 'left' ? 'justify-start' : 'justify-end'}`}>
      <Button icon={<Printer aria-hidden="true" />} onClick={() => openExternal(siteHref(`/help/keyboard-shortcuts/cheat-sheet${query}`))}>
        {t('hotkeys.cheatSheet')}
      </Button>
    </div>
  );
}

/** The keys of this OS and this app: a browser shows no desktop-only row. */
function TypingTab() {
  const { t } = useTranslation('landing');
  const singleKeys = useSingleKeys();
  return (
    <div className="space-y-6">
      <CheatSheetLink sheet="app" />
      <Switch
        setting="hotkeys.singleKeys"
        label={t('about.singleKeysTitle')}
        icon={<Keyboard className="text-accent" />}
        labelClassName={ROW_TITLE}
        description={t('about.singleKeysDesc')}
        checked={singleKeys}
        onChange={setSingleKeys}
      />
      <HotkeyGroups groups={HOTKEY_GROUPS} />

      <p className="text-help text-pn-soft">
        {t('common:hotkeys.typingNote')}
      </p>

      {/* English, like the rows above (the list keeps one layout). */}
      {!DESKTOP_APP && (
        <p className="text-help text-pn-soft">
          <a
            href={`${marketingHomeHref()}#downloads`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            {DESKTOP_MORE_NOTE}
          </a>
        </p>
      )}

      <CheatSheetLink sheet="app" align="left" />
    </div>
  );
}

/** The canvas's own keys: they work while the drawing has the focus. */
function DrawingTab() {
  return (
    <div className="space-y-6">
      <CheatSheetLink sheet="drawing" />
      <HotkeyGroups groups={DRAWING_HOTKEY_GROUPS} />
    </div>
  );
}

export function HotkeysPane({ initialTab }: { initialTab?: string }) {
  const { t } = useTranslation('notes');
  const [tab, setTab] = usePaneTab<Tab>('hotkeys', initialTab === 'drawing' ? 'drawing' : 'typing');
  const tabs: { id: Tab; setting: string; label: string; icon: ReactNode }[] = [
    { id: 'typing', setting: 'hotkeys.typing', label: t('settings:appearance.toolbarTabTyping'), icon: <TextT aria-hidden="true" /> },
    { id: 'drawing', setting: 'hotkeys.drawing', label: t('newMenu.drawing'), icon: <Scribble aria-hidden="true" /> },
  ];
  return (
    <div className="flex-1 min-h-0 flex flex-col text-pn">
      <SettingsTabStrip role="tablist" aria-label={t('landing:about.tabs.hotkeys')} className="shrink-0 px-4 sm:px-6">
        {tabs.map(({ id, setting, label, icon }) => (
          <button key={id} type="button" data-setting={setting} role="tab" aria-selected={tab === id}
            onClick={() => setTab(id)} className={settingsTabClass(tab === id)}>
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </SettingsTabStrip>
      <div className="flex-1 overflow-y-auto p-6 text-body">
        {tab === 'typing' ? <TypingTab /> : <DrawingTab />}
      </div>
    </div>
  );
}
