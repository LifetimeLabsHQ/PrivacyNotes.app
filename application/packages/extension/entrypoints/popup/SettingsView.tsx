/**
 * The extension's one Settings page, from the header's gear. Every choice
 * lives here (owner, 2026-11-11: settings spread over the
 * logo menu and this page confused). The page fits the 600 px with no scroll:
 * - Security: when the vault locks, fingerprint or face (where the computer
 *   has it; on asks the PIN once), and Change PIN or passcode (while unlocked).
 * - Keyboard shortcuts, in a card of its own.
 * - Display: the 2FA code lines, their moving countdown bar (calm for a
 *   person who finds it loud), and the website icons, which load through our
 *   favicon proxy as the app's do.
 * - Disconnect extension, last in a card of its own, which asks once more in
 *   its own row.
 * Each display choice stays in this browser.
 * Spec: docs/internal/plans/browser-extension-build.md (decision E17)
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDown, CaretRight, Fingerprint, Hourglass, Image, Keyboard, LockKey, Password, SignOut, Timer } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Switch } from '@web/Switch';
import { ROW_TITLE, SETTINGS_GROUP, SectionEyebrow } from '@web/settingsUI';
import type { Prefs } from '../../src/prefs';
import { TotpBar, useSecondTick } from './TotpBar';

export type ViewPrefs = Pick<Prefs, 'showTotp' | 'totpBar' | 'favicons'>;

const ViewPrefsContext = createContext<ViewPrefs>({ showTotp: true, totpBar: true, favicons: true });
export const ViewPrefsProvider = ViewPrefsContext.Provider;
/** What the rows show, as the settings have it. */
export const useViewPrefs = () => useContext(ViewPrefsContext);

const ROW = 'flex items-center gap-3 px-3 py-2.5';

/** A row that opens another screen, with the caret that says so. */
function SampleBar({ off }: { off: boolean }) {
  const now = useSecondTick(!off);
  return <TotpBar period={30} now={now} off={off} className="absolute start-3 end-[76px] bottom-[5px]" />;
}

function NavRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`${ROW} w-full text-start transition hover:bg-pn/5`}>
      {icon}
      <span className={`flex-1 min-w-0 ${ROW_TITLE}`}>{label}</span>
      <CaretRight className="shrink-0 text-pn-muted rtl:-scale-x-100" aria-hidden="true" />
    </button>
  );
}

export function SettingsView({ prefs, onChange, vault, onShortcuts, onDisconnect }: {
  prefs: ViewPrefs;
  onChange: (patch: Partial<ViewPrefs>) => void;
  /** The vault's lock time, its menu, and Change PIN while unlocked; none without the vault. */
  vault?: {
    lockLabel: string;
    openLock: (el: HTMLElement) => void;
    changeSecret?: { label: string; open: () => void };
    /** Fingerprint or face, where this computer has it: on opens the PIN step, off forgets it. */
    biometric?: { on: boolean; set: (on: boolean) => void };
  };
  onShortcuts: () => void;
  /** None before the browser is connected: then the row is not shown. */
  onDisconnect?: () => Promise<void>;
}) {
  const { t } = useTranslation('extension');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    // gap-2.5: the whole page fits 570 px with the vault, which the e2e test checks.
    <div className="flex flex-col gap-2.5 p-3">
      {vault && (
        <section className="flex flex-col gap-2">
          <SectionEyebrow className="px-1">{t('notes:settings.securityLabel')}</SectionEyebrow>
          <div className={SETTINGS_GROUP}>
            <div className={ROW}>
              <Timer className="shrink-0 text-accent" aria-hidden="true" />
              <span className={`flex-1 min-w-0 ${ROW_TITLE}`}>{t('vault.autoLock')}</span>
              <Button icon={<CaretDown aria-hidden="true" />} aria-haspopup="menu" onClick={(e) => vault.openLock(e.currentTarget)} className="shrink-0">
                {vault.lockLabel}
              </Button>
            </div>
            {vault.biometric && (
              <div className="px-3 py-2.5">
                <Switch labelClassName={ROW_TITLE} icon={<Fingerprint className="text-accent" />} label={t('settings.biometric')} checked={vault.biometric.on} onChange={vault.biometric.set} />
              </div>
            )}
            {vault.changeSecret && <NavRow icon={<LockKey className="shrink-0 text-accent" aria-hidden="true" />} label={vault.changeSecret.label} onClick={vault.changeSecret.open} />}
          </div>
        </section>
      )}
      {/* The shortcuts sit above Display, in a card of their own (owner, 2026-11-11). */}
      <div className={SETTINGS_GROUP}>
          <NavRow icon={<Keyboard className="shrink-0 text-accent" aria-hidden="true" />} label={t('common:palette.commands.help')} onClick={onShortcuts} />
      </div>
      <section className="flex flex-col gap-2">
        <SectionEyebrow className="px-1">{t('settings:appearance.editorTabDisplay')}</SectionEyebrow>
        <div className={SETTINGS_GROUP}>
          {vault && (
            <>
              <div className="px-3 py-2.5">
                <Switch labelClassName={ROW_TITLE} icon={<Password className="text-accent" />} label={t('settings.codes')} description={t('settings.codesHelp')} checked={prefs.showTotp} onChange={(on) => onChange({ showTotp: on })} />
              </div>
              <div className="relative px-3 py-2.5">
                <Switch labelClassName={ROW_TITLE} icon={<Hourglass className="text-accent" />} label={t('settings.bar')} description={t('settings.barHelp')} checked={prefs.totpBar} disabled={!prefs.showTotp} onChange={(on) => onChange({ totpBar: on })} />
                {/* A live sample of the bar: a 30-second code's, still and dim
                    while off. In the row's bottom padding, so the page keeps
                    its height and still fits the popup with no scroll. */}
                <SampleBar off={!prefs.totpBar || !prefs.showTotp} />
              </div>
            </>
          )}
          <div className="px-3 py-2.5">
            <Switch labelClassName={ROW_TITLE} icon={<Image className="text-accent" />} label={t('settings:appearance.faviconsTitle')} description={t('settings.iconsHelp')} checked={prefs.favicons} onChange={(on) => onChange({ favicons: on })} />
          </div>
        </div>
      </section>
      {/* Disconnect, last and in a card of its own, with no heading (owner, 2026-11-11). */}
      {onDisconnect && (
      <div className={SETTINGS_GROUP}>
        {asking ? (
          <div className={ROW}>
            <SignOut className="shrink-0 text-danger" aria-hidden="true" />
            <span className={`flex-1 min-w-0 ${ROW_TITLE}`}>{t('account.confirmDisconnect')}</span>
            <Button action="cancel" onClick={() => setAsking(false)} disabled={busy} className="shrink-0" />
            <Button
              variant="danger"
              icon={<SignOut aria-hidden="true" />}
              autoFocus
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onDisconnect?.().finally(() => setBusy(false));
              }}
              className="shrink-0"
            >
              {t('security:connectedAccounts.disconnect')}
            </Button>
          </div>
        ) : (
          <button type="button" onClick={() => setAsking(true)} className={`${ROW} w-full text-start text-danger transition hover:bg-danger/5`}>
            <SignOut className="shrink-0" aria-hidden="true" />
            <span className={`flex-1 min-w-0 ${ROW_TITLE} text-danger`}>{t('settings.disconnect')}</span>
          </button>
        )}
      </div>
      )}
    </div>
  );
}
