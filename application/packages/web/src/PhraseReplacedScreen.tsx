import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth, type OAuthProvider } from './auth';
import { ConfirmModal } from './ConfirmModal';
import { db } from './db';
import { BoxArrowUp, Key, QrCode, SignOut, UserCircle } from './icons';
import { listNotes } from './notesRepo';
import { PROVIDER_CONTINUE_KEY, PROVIDER_ICON, PROVIDER_ORDER } from './providerIcons';
import { QrScannerModal } from './QrScannerModal';
import { isTrustedDevice } from './trustStorage';
import { Button, Callout, Divider, Modal, RowTitle, SETTINGS_HELP, SETTINGS_ROW, TextField } from './ui';
import { loadLocalSettings } from './userSettings';

/**
 * The screen of a phrase the account replaced (`auth.status ===
 * 'phrase_replaced'`): the recovery phrase was changed on another device,
 * and this device holds an earlier one. Sync is stopped and nothing is
 * wiped. The ways on, in the order the spec gives them:
 * - enter the new phrase, or scan its QR. It must be the current phrase of
 *   the account whose notes are here; a phrase of another account gets
 *   today's account-switch question first;
 * - a custodial account signs in with its provider and gets the new phrase
 *   from custody;
 * - export the notes on this device: the encrypted full backup, sealed under
 *   the replaced phrase's sync key, which a restore opens with the new phrase
 *   through the key ring. Encrypted on purpose: like every encrypted backup it
 *   passes the note gate, because nobody reads it without a phrase. It holds
 *   the notes, the folders and the pictures and files this device keeps; the
 *   account's other settings stay with the account. The blobs come from the
 *   device's own cache, so no blob store (and none of the notes view) loads
 *   with this screen;
 * - sign out, which keeps the unsynced changes for a later sign-in here.
 * Unreachable until an account can change its phrase (step 5).
 * Spec: docs/internal/plans/phrase-change.md (2.4, section 7)
 */
export function PhraseReplacedScreen() {
  const { t } = useTranslation(['auth', 'settings']);
  const { auth, adoptNewPhrase, adoptWithProvider, completeDesktopOAuth, signOut } = useAuth();
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // The phrase waiting for the account-switch answer.
  const [switchFor, setSwitchFor] = useState<string | null>(null);
  // Non-null once a desktop provider sign-in waits for the code the browser shows.
  const [pastedCode, setPastedCode] = useState<string | null>(null);
  const [exported, setExported] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const [askSignOut, setAskSignOut] = useState(false);
  if (auth.status !== 'phrase_replaced') return null;
  const { pubkey, encryptionKey, isCustodial } = auth;

  async function enter(value: string, switchConfirmed = false) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await adoptNewPhrase(value, isTrustedDevice(), { switchConfirmed });
    setBusy(false);
    // A success replaces this screen with the vault.
    if (result.ok) return;
    if (result.reason === 'switch') {
      setSwitchFor(value);
      return;
    }
    setError(
      result.reason === 'invalid'
        ? (result.error ?? t('importPhrase.invalidPhrase'))
        : result.reason === 'replaced'
          ? t('phraseReplaced.replacedAgain')
          : t('phraseReplaced.failed'),
    );
  }

  async function withProvider(provider: OAuthProvider) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await adoptWithProvider(provider);
    setBusy(false);
    // On the web the browser leaves for the provider. A desktop stops on our
    // return page and the person carries the code across.
    if (!result.ok) setError(result.error);
    else if (result.awaitPastedCode) setPastedCode('');
  }

  async function finishProvider() {
    if (busy || !pastedCode?.trim()) return;
    setBusy(true);
    setError(null);
    const result = await completeDesktopOAuth(pastedCode);
    setBusy(false);
    if (!result.ok) setError(result.error);
  }

  async function exportNotes() {
    if (!pubkey || !encryptionKey || exported === 'busy') return;
    setExported('busy');
    try {
      const { exportEncryptedFullBackup } = await import('./export');
      // What this device holds, opened by its own local key.
      const images = { getImage: async (uuid: string) => (await db.imageCache.get(uuid))?.data ?? null };
      const files = {
        getAttachment: async (uuid: string) => {
          const cached = await db.attachmentCache.get(uuid);
          return cached ? { meta: cached.meta, data: cached.data } : null;
        },
      };
      await exportEncryptedFullBackup(await listNotes(), images, files, encryptionKey, undefined, loadLocalSettings().folders);
      setExported('done');
    } catch {
      setExported('failed');
    }
  }

  return (
    <Modal title={t('phraseReplaced.title')} icon={<Key />} className="max-w-lg p-6 space-y-5 max-h-[90vh] overflow-y-auto">
      <p className="text-body text-pn-muted leading-relaxed">
        {t('phraseReplaced.body')}
        {pubkey && <> {t('phraseReplaced.kept')}</>}
      </p>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void enter(phrase);
        }}
      >
        <TextField
          label={t('phraseReplaced.phraseLabel')}
          icon={<Key />}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
        />
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" action="next" disabled={busy || !phrase.trim()}>
            {t('continue')}
          </Button>
          <Button icon={<QrCode aria-hidden="true" />} disabled={busy} onClick={() => setScanning(true)}>
            {t('importPhrase.scanQr')}
          </Button>
        </div>
      </form>

      {/* Each Divider sits in its own block: its my-1 would otherwise win over
          this stack's gap and put the next heading on the line. */}
      {isCustodial && (
        <div>
          <Divider />
          <div className="space-y-3 pt-4">
            <div>
              <RowTitle icon={UserCircle}>{t('phraseReplaced.providerTitle')}</RowTitle>
              <p className={SETTINGS_HELP}>{t('phraseReplaced.providerBody')}</p>
            </div>
            <div className="flex flex-col gap-2">
              {PROVIDER_ORDER.map((p) => {
                const Icon = PROVIDER_ICON[p];
                return (
                  <Button key={p} icon={<Icon />} disabled={busy} onClick={() => void withProvider(p)}>
                    {t(PROVIDER_CONTINUE_KEY[p])}
                  </Button>
                );
              })}
            </div>
            {pastedCode !== null && (
              <div className="space-y-2">
                <TextField
                  label={t('chooseMode.desktopCodeTitle')}
                  hint={t('chooseMode.desktopCodeHint')}
                  placeholder={t('chooseMode.desktopCodePlaceholder')}
                  value={pastedCode}
                  onChange={(e) => setPastedCode(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
                <Button action="next" disabled={busy || !pastedCode.trim()} onClick={() => void finishProvider()}>
                  {t('chooseMode.resumeAction')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <div>
        <Divider />
        <div className="divide-y divide-divider pt-1">
          {pubkey && encryptionKey && (
            <div className={SETTINGS_ROW}>
              <div className="min-w-0 flex-1">
                <RowTitle icon={BoxArrowUp}>{t('phraseReplaced.exportTitle')}</RowTitle>
                <p className={SETTINGS_HELP}>{t('phraseReplaced.exportBody')}</p>
              </div>
              <Button action="export" className="self-start lg:self-auto" disabled={exported === 'busy'} onClick={() => void exportNotes()}>
                {t('phraseReplaced.exportAction')}
              </Button>
              {exported === 'done' && <div className="basis-full"><Callout tone="success">{t('phraseReplaced.exportDone')}</Callout></div>}
              {exported === 'failed' && <div className="basis-full"><Callout tone="danger">{t('phraseReplaced.exportFailed')}</Callout></div>}
            </div>
          )}
          <div className={SETTINGS_ROW}>
            <div className="min-w-0 flex-1">
              <RowTitle icon={SignOut}>{t('phraseReplaced.signOutRowTitle')}</RowTitle>
              <p className={SETTINGS_HELP}>{t('phraseReplaced.signOutRowHelp')}</p>
            </div>
            <Button icon={<SignOut aria-hidden="true" />} className="self-start lg:self-auto" disabled={busy} onClick={() => setAskSignOut(true)}>
              {t('settings:account.signOut')}
            </Button>
          </div>
        </div>
      </div>

      {scanning && (
        <QrScannerModal
          onScanned={(scanned) => {
            setScanning(false);
            setPhrase(scanned);
            void enter(scanned);
          }}
          onClose={() => setScanning(false)}
        />
      )}
      {switchFor !== null && (
        <ConfirmModal
          title={t('signIn.switchTitle')}
          confirmLabel={t('signIn.switchConfirm')}
          variant="info"
          onConfirm={() => {
            const value = switchFor;
            setSwitchFor(null);
            void enter(value, true);
          }}
          onClose={() => setSwitchFor(null)}
        >
          {t('signIn.switchBody')}
        </ConfirmModal>
      )}
      {askSignOut && (
        <ConfirmModal
          title={t('phraseReplaced.signOutTitle')}
          confirmLabel={t('settings:account.signOut')}
          onConfirm={() => void signOut({ keepUnsyncedNotes: true })}
          onClose={() => setAskSignOut(false)}
        >
          {t('phraseReplaced.signOutBody')}
        </ConfirmModal>
      )}
    </Modal>
  );
}
