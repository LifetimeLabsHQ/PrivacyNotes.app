/**
 * Settings > Extension: the browser extension in three steps (install it,
 * choose what it can do, connect it with a one-time code), then the browsers
 * that are connected, each with Remove. The code works once, for 10 minutes;
 * a switch changed after it was shown asks for a new one. While a code shows,
 * the pane checks for the browser that used it and then names it in place of
 * the code, so a browser the owner did not connect is seen at once (beta
 * issue 15); a browser connected in the last day carries a New badge. The demo has no
 * account to connect, so it says how to get one instead.
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3.2 and 6)
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SupabaseClient } from '@notes/shared';
import { ArrowsClockwise, DownloadSimple, Link, Password, PuzzlePiece, Scissors, SlidersHorizontal, UserPlus } from './icons';
import { Badge, Button, Callout, CopyButton, DeleteButton, FIELD_CLASS, FieldLabel, SETTINGS_BTN_PRIMARY, SETTINGS_HELP, Spinner, Switch } from './ui';
import { ROW_TITLE, SectionEyebrow, SETTINGS_CARD, SETTINGS_CARD_ON, SETTINGS_CARD_REST, SETTINGS_GROUP, SettingsCardIcon } from './settingsUI';
import { useAuth } from './auth';
import { marketingHomeHref } from './siteLinks';
import { isTouchOnly } from './touchOnly';
import { isDemoMode, DEMO_APP_URL } from './demo';
import { ExtensionCallError, loadExtensionState, removeExtension, type ExtensionRow } from './extensionApi';
import { EXTENSION_STORES, STORE_NAME, type ExtensionBrowser } from './extensionStores';
import { hasUnpushedSettings, syncUserSettings } from './userSettings';
import type { ExtensionKeys } from './extensionKeys';
import type { DeviceRow } from './devices';
import { DeviceRowLabel } from './SyncOptionsModal';
import { formatRelative } from './intlFormat';

/** What the pane needs from the signed-in app. */
export interface ExtensionAccess {
  supabase: SupabaseClient;
  pubkey: string;
  phrase: string;
  contentKey: Uint8Array;
  readKeys: () => ExtensionKeys;
  saveKeys: (update: (keys: ExtensionKeys) => ExtensionKeys) => void;
}

/** Push the synced settings now; true once the server holds every local
 *  change, the extension's key entries included. */
async function pushSettingsNow(access: ExtensionAccess): Promise<boolean> {
  if (isDemoMode()) return false;
  try {
    await syncUserSettings(access.supabase, access.pubkey, access.contentKey);
  } catch {
    return false;
  }
  return !hasUnpushedSettings();
}

const ERROR_KEY: Record<string, string> = {
  too_many_codes: 'extensionConnect.tooManyCodes',
  too_many_extensions: 'extensionConnect.tooManyExtensions',
  key_elsewhere: 'extensionConnect.keyElsewhere',
  key_conflict: 'extensionConnect.keyElsewhere',
};

/** How often the pane checks for the browser that used the shown code, and
 *  for how long: the code's own life. */
const WATCH_MS = 4000;
const CODE_LIFE_MS = 10 * 60 * 1000;
/** A connected browser counts as new for one day. */
const NEW_MS = 24 * 60 * 60 * 1000;

/** Steps 2 and 3: the two switches, then the one-time code with Copy. */
function ConnectSteps({ access, rows, reload }: { access: ExtensionAccess; rows: ExtensionRow[]; reload: () => void }) {
  const { t } = useTranslation('shell');
  const [clips, setClips] = useState(true);
  const [logins, setLogins] = useState(true);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The browsers connected when the code was made; one more is the one that used it.
  const [known, setKnown] = useState<Set<string> | null>(null);
  const [usedBy, setUsedBy] = useState<string | null>(null);

  // Load the code builder and its crypto while the reader picks the switches.
  useEffect(() => {
    void import('./extensionPairing');
  }, []);

  useEffect(() => {
    if (!code) return;
    const until = Date.now() + CODE_LIFE_MS;
    const id = window.setInterval(() => {
      if (Date.now() > until) window.clearInterval(id);
      else if (!document.hidden) reload();
    }, WATCH_MS);
    return () => window.clearInterval(id);
  }, [code, reload]);

  useEffect(() => {
    if (!code || !known) return;
    const added = rows.find((r) => !known.has(r.id));
    if (!added) return;
    setCode(null);
    setKnown(null);
    setUsedBy(added.label);
  }, [code, known, rows]);

  const change = (set: (on: boolean) => void) => (on: boolean) => {
    set(on);
    setCode(null);
    setError(null);
  };

  const make = async () => {
    if (!clips && !logins) {
      setError(t('extensionConnect.pickOne'));
      return;
    }
    setBusy(true);
    setError(null);
    setUsedBy(null);
    try {
      const { makePairingCode } = await import('./extensionPairing');
      const pushKeys = () => pushSettingsNow(access);
      setCode(await makePairingCode({ ...access, clips, logins, pushKeys }));
      setKnown(new Set(rows.map((r) => r.id)));
    } catch (err) {
      const reason = err instanceof ExtensionCallError ? ERROR_KEY[err.code] : undefined;
      setError(t(reason ?? 'extensionConnect.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="min-w-0 space-y-3">
        <SectionEyebrow icon={SlidersHorizontal} setting="browser.features">{t('apps.stepFeatures')}</SectionEyebrow>
        <div className={SETTINGS_GROUP}>
          <div className="px-3 py-2.5">
            <Switch labelClassName={ROW_TITLE} icon={<Scissors className="text-accent" />} label={t('extensionConnect.clips')} description={t('extensionConnect.clipsHint')} checked={clips} onChange={change(setClips)} />
          </div>
          <div className="px-3 py-2.5">
            <Switch labelClassName={ROW_TITLE} icon={<Password className="text-accent" />} label={t('tagsRail.vault')} description={t('extensionConnect.loginsHint')} checked={logins} onChange={change(setLogins)} />
          </div>
        </div>
      </section>
      <section className="min-w-0 space-y-3">
        <SectionEyebrow icon={Link} setting="browser.connect">{t('apps.stepConnect')}</SectionEyebrow>
        {code ? (
          <div className="space-y-1.5">
            <FieldLabel>{t('extensionConnect.codeLabel')}</FieldLabel>
            <div className="flex items-start gap-2">
              <textarea
                readOnly
                value={code}
                rows={4}
                dir="ltr"
                aria-label={t('extensionConnect.codeLabel')}
                onFocus={(e) => e.currentTarget.select()}
                className={`${FIELD_CLASS} font-mono resize-none`}
              />
              <CopyButton value={code} label={t('common:actions.copy')} />
            </div>
            <p className={SETTINGS_HELP}>{t('extensionConnect.oneUse')}</p>
            <Button icon={busy ? <Spinner size={15} /> : <ArrowsClockwise aria-hidden="true" />} onClick={make} disabled={busy}>
              {t('extensionConnect.newCode')}
            </Button>
          </div>
        ) : (
          <>
            {usedBy ? <Callout tone="success">{t('extensionConnect.usedBy', { name: usedBy })}</Callout> : <p className={SETTINGS_HELP}>{t('apps.connectHint')}</p>}
            <Button variant="primary" icon={busy ? <Spinner size={15} /> : <Link aria-hidden="true" />} onClick={make} disabled={busy}>
              {t('apps.makeCode')}
            </Button>
          </>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </section>
    </>
  );
}

/**
 * The connected browsers: the device row, the scopes and the last clip under
 * the name, Remove in place. An extension takes no device slot. Remove
 * deletes its token, its PIN checker and its half of the logins key at once.
 */
function ConnectedBrowsers({ rows, onRemoved }: { rows: ExtensionRow[]; onRemoved: (id: string) => void }) {
  const { t } = useTranslation('settings');
  const { supabase, auth } = useAuth();
  const pubkey = auth.status === 'authenticated' ? auth.pubkey : '';
  const [failed, setFailed] = useState(false);
  const remove = async (id: string) => {
    setFailed(false);
    try {
      await removeExtension(supabase, pubkey, id);
      onRemoved(id);
    } catch {
      setFailed(true);
    }
  };
  return (
    <section className="space-y-2">
      <SectionEyebrow icon={PuzzlePiece}>{t('devices.extensionsHeading')}</SectionEyebrow>
      <p className={SETTINGS_HELP}>{t('devices.extensionsNoSlot')}</p>
      <ul className="space-y-2">
        {rows.map((r) => {
          const fresh = Date.now() - Date.parse(r.created_at) < NEW_MS;
          const scopes = [r.clips && t('devices.extensionClips'), r.logins && t('notes:vaultFilter.logins')].filter(Boolean).join(', ');
          const row: DeviceRow = {
            device_id: r.id, device_name: r.label, platform: 'web', created_at: r.created_at,
            last_seen_at: r.last_used_at ?? r.created_at, revoked_at: null, device_group: null, app_version: r.version,
          };
          return (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-md border border-divider px-3 py-2">
              <DeviceRowLabel
                row={row}
                isSelf={false}
                label={null}
                badge={fresh && <Badge tone="info">{t('devices.extensionNew')}</Badge>}
                meta={
                  <>
                    {scopes}
                    {` · ${t('devices.added', { time: formatRelative(r.created_at) })}`}
                    {r.last_clip_at && ` · ${t('devices.lastClip', { time: formatRelative(r.last_clip_at) })}`}
                  </>
                }
              />
              <DeleteButton kind="remove" label={`${t('common:actions.remove')} ${r.label}`} onConfirm={() => void remove(r.id)} />
            </li>
          );
        })}
      </ul>
      {failed && <Callout tone="danger">{t('devices.removeFailed')}</Callout>}
    </section>
  );
}

export function BrowserPane({ extensionKeys }: { extensionKeys: Pick<ExtensionAccess, 'readKeys' | 'saveKeys'> }) {
  const { t } = useTranslation('shell');
  const { auth, supabase } = useAuth();
  const access: ExtensionAccess | null = isDemoMode() || auth.status !== 'authenticated'
    ? null
    : { supabase, pubkey: auth.pubkey, phrase: auth.phrase, contentKey: auth.encryptionKey, ...extensionKeys };
  const pubkey = access?.pubkey ?? '';
  const [rows, setRows] = useState<ExtensionRow[]>([]);
  const load = useCallback(() => {
    if (!pubkey) return;
    loadExtensionState(supabase, pubkey).then((s) => setRows(s.extensions)).catch(() => {});
  }, [supabase, pubkey]);
  useEffect(load, [load]);
  // The code is redeemed in the extension, so the list catches up when the
  // reader comes back to this window.
  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);
  const stores = Object.entries(EXTENSION_STORES) as [ExtensionBrowser, string | null][];
  const mine = currentBrowser();

  return (
    <div className="@container flex-1 min-h-0 overflow-y-auto p-6 space-y-6 text-pn">
      <p className={SETTINGS_HELP}>{t('apps.subtitle')}</p>
      {isTouchOnly() && <Callout>{t('apps.extensionComputersOnly')}</Callout>}

      <section className="space-y-3">
        <SectionEyebrow icon={DownloadSimple} setting="browser.install">{t('apps.stepInstall')}</SectionEyebrow>
        {/* Three cards only, so they share the row instead of the 9.5rem
            columns a long source list takes; one column on a phone. */}
        <div className="grid gap-1.5 @md:grid-cols-3">
          {stores.map(([browser, url]) => {
            const body = (
              <>
                <SettingsCardIcon src={`/help/icons/${browser.toLowerCase()}.svg`} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-body font-medium">
                    {browser}
                    {browser === mine && <Badge tone="info">{t('apps.thisBrowser')}</Badge>}
                  </span>
                  <span className="block truncate text-small text-pn-soft">{url ? STORE_NAME[browser] : t('noteOptionsMenu.comingSoon')}</span>
                </span>
              </>
            );
            const look = `${SETTINGS_CARD} ${browser === mine ? SETTINGS_CARD_ON : url ? SETTINGS_CARD_REST : 'border-divider'}`;
            return url ? (
              <a key={browser} href={url} target="_blank" rel="noopener noreferrer" className={look}>{body}</a>
            ) : (
              <div key={browser} className={look}>{body}</div>
            );
          })}
        </div>
      </section>

      {access ? (
        <div className="grid gap-6 @2xl:grid-cols-2">
          <ConnectSteps access={access} rows={rows} reload={load} />
        </div>
      ) : (
        <a href={DEMO_APP_URL} className={`${SETTINGS_BTN_PRIMARY} inline-flex`}>
          <UserPlus aria-hidden="true" />
          {t('apps.demoSignUp')}
        </a>
      )}

      {rows.length > 0 && <ConnectedBrowsers rows={rows} onRemoved={(id) => setRows((all) => all.filter((r) => r.id !== id))} />}

      <p className={SETTINGS_HELP}>
        {t('apps.otherApps')}{' '}
        <a href={`${marketingHomeHref()}#downloads`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
          {t('apps.desktopAll')}
        </a>
      </p>
    </div>
  );
}

/** The browser this page runs in, when it is one the extension supports. */
function currentBrowser(): ExtensionBrowser | null {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  return null;
}
