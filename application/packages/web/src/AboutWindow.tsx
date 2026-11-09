import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { VERSION } from './version';
import { LogoIcon } from './LogoIcon';
import { Brand } from './Brand';
import { useEscapeToClose } from './useEscapeToClose';
import { marketingHomeHref, siteHref } from './siteLinks';
import { activeLocale } from './languages';
import { helpPath } from './localeRoutes';
import { matchesKey } from './shortcutMatch';

/**
 * Custom About window content (desktop only). The macOS "About PrivacyNotes"
 * menu item opens a small fixed-size window whose URL carries ?about-window=1;
 * main.tsx routes here instead of mounting the app. Replaces the unstylable
 * system About panel. See desktop/src-tauri/src/lib.rs (open_about_window).
 *
 * Links must call the opener plugin directly: this window renders outside
 * App.tsx, so its target="_blank" interceptor is not active here.
 */

async function closeWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

async function openExternal(url: string) {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

const buttonClass =
  'w-full rounded-lg border border-divider py-1.5 text-compact text-pn-soft transition hover:bg-pn/10';

export default function AboutWindow() {
  const { t } = useTranslation('landing');
  useEscapeToClose(() => void closeWindow());
  // Cmd+W closes this window. The menu's Close Window is Shift+Cmd+W in this
  // app, because Cmd+W in the main window closes a tab.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!matchesKey(e, [{ mod: true, key: 'w' }])) return;
      e.preventDefault();
      void closeWindow();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-dvh select-none flex-col items-center gap-1 bg-surface-1 px-6 pb-6 pt-8 text-center">
      <LogoIcon size={88} className="mb-1" />
      <h1 className="text-heading text-pn">
        <Brand />
      </h1>
      <p className="select-text text-small text-pn-muted">
        {t('about.windowVersion', { version: VERSION })}
      </p>
      <p className="text-small text-pn-muted">© 2026 Lifetime Labs LLC</p>
      {/* Labels reuse the site header keys. /changelog and /themes are
          English-only pages, so only the homepage and the help hub take a
          locale slug. */}
      <div className="mt-4 flex w-full max-w-[210px] flex-col gap-2">
        <button onClick={() => void openExternal(marketingHomeHref())} className={buttonClass}>
          PrivacyNotes.app
        </button>
        <button onClick={() => void openExternal(`${marketingHomeHref()}#downloads`)} className={buttonClass}>
          {t('header.downloads')}
        </button>
        <button onClick={() => void openExternal(siteHref('/themes'))} className={buttonClass}>
          {t('header.themes')}
        </button>
        <button onClick={() => void openExternal(siteHref('/changelog'))} className={buttonClass}>
          {t('header.changelog')}
        </button>
        <button onClick={() => void openExternal(siteHref(helpPath(activeLocale())))} className={buttonClass}>
          {t('about.windowHelp')}
        </button>
      </div>
    </div>
  );
}
