import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { HelpChip } from '../HelpChip';
import { Check, Copy, Fire } from '../icons';
import { createBurnLink } from '../burnShare';
import { useLocalOnly } from '../localOnly';
import { LocalOnlyNotice } from '../LocalOnlyNotice';
import type { VaultField } from '../vaultFields';
import { Button, Callout, Modal, ModalFooter, Select, TextField } from '../ui';
import {
  BURN_LIFETIME_HOURS,
  BURN_READ_SECONDS,
  DEFAULT_BURN_LIFETIME_HOURS,
  DEFAULT_BURN_READ_SECONDS,
} from '../burnOptions';

/**
 * The "Burn after reading" modal. The sender picks the reading time and the
 * link lifetime, and one button creates the link and hands it over: copied
 * on desktop, the share sheet on a phone. The choices lock once the link
 * exists, because they are sealed into it.
 */
export function BurnShareModal({
  title,
  body,
  fields,
  imagesStripped,
  isMobile,
  onCreated,
  onClose,
  onOpenSync,
}: {
  title: string;
  body: string;
  fields?: VaultField[];
  imagesStripped: boolean;
  isMobile: boolean;
  onCreated: () => void;
  onClose: () => void;
  /** Opens Settings > ID & Sync from the local-only notice. */
  onOpenSync?: () => void;
}) {
  const { t } = useTranslation('notesChrome');
  const localOnly = useLocalOnly();
  const [readSeconds, setReadSeconds] = useState(DEFAULT_BURN_READ_SECONDS);
  const [lifetimeHours, setLifetimeHours] = useState(DEFAULT_BURN_LIFETIME_HOURS);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const share = isMobile && typeof navigator.share === 'function';

  if (localOnly) {
    return (
      <Modal onClose={onClose} title={t('burnShareModal.title')} icon={<Fire className="text-orange-500" />} className="max-w-md p-6 space-y-4">
        <LocalOnlyNotice feature="burnShare" onOpenSync={onOpenSync} />
      </Modal>
    );
  }

  async function create(): Promise<string> {
    const result = await createBurnLink(title, body, fields, readSeconds, lifetimeHours);
    if (!result.ok) throw new Error(result.error);
    onCreated();
    setUrl(result.url);
    return result.url;
  }

  async function handleShare(link: string) {
    try {
      await navigator.share({ title: title || t('notes:burn.shareTitle'), url: link });
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      await copyText(link);
    }
  }

  async function copyText(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch { /* clipboard blocked - the link is still selectable */ }
  }

  function handlePrimary() {
    setError(null);
    if (url) {
      void (share ? handleShare(url) : copyText(url));
      return;
    }
    setBusy(true);
    const pending = create();
    let copying = false;
    if (!share && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      // WebKit keeps a clipboard write only inside the click that asked for
      // it, and the link needs a server round trip first. Handing the write
      // a promise starts it inside the click and fills it when the link
      // arrives. Where that is refused, a plain write follows.
      copying = true;
      const blob = pending.then((link) => new Blob([link], { type: 'text/plain' }));
      // The failure is reported below; this copy of it has nobody to tell.
      blob.catch(() => undefined);
      navigator.clipboard
        .write([new ClipboardItem({ 'text/plain': blob })])
        .then(() => setCopied(true))
        .catch(() => pending.then(copyText).catch(() => undefined));
    }
    pending
      .then((link) => (share ? handleShare(link) : copying ? undefined : copyText(link)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t('burnShare.storeFailed')))
      .finally(() => setBusy(false));
  }

  return (
    <Modal onClose={onClose} title={t('burnShareModal.title')} icon={<Fire className="text-orange-500" />} className="max-w-md p-6 space-y-4">
        <p className="text-body text-pn-muted leading-relaxed">
          <Trans
            i18nKey="notesChrome:burnShareModal.body"
            components={{ lead: <strong className="text-pn" /> }}
          />
        </p>
        <HelpChip surface="burn" />
        {imagesStripped && (
          <Callout tone="warning">{t('burnShareModal.imagesStripped')}</Callout>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-compact">
            <span className="block mb-1">{t('burnShareModal.readTime')}</span>
            <Select
              value={readSeconds}
              disabled={url !== null || busy}
              onChange={(e) => setReadSeconds(Number(e.target.value))}
            >
              {BURN_READ_SECONDS.map((s) => (
                <option key={s} value={s}>
                  {s < 3600
                    ? t('burnShareModal.minutes', { count: s / 60 })
                    : t('burnShareModal.hours', { count: s / 3600 })}
                </option>
              ))}
            </Select>
            <span className="block mt-1 text-small text-pn-muted">{t('burnShareModal.readTimeHint')}</span>
          </label>
          <label className="block text-compact">
            <span className="block mb-1">{t('burnShareModal.lifetime')}</span>
            <Select
              value={lifetimeHours}
              disabled={url !== null || busy}
              onChange={(e) => setLifetimeHours(Number(e.target.value))}
            >
              {BURN_LIFETIME_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h < 72
                    ? t('burnShareModal.afterHours', { count: h })
                    : t('burnShareModal.afterDays', { count: h / 24 })}
                </option>
              ))}
            </Select>
            <span className="block mt-1 text-small text-pn-muted">{t('burnShareModal.lifetimeHint')}</span>
          </label>
        </div>
        {url && (
          <TextField
            type="text"
            readOnly
            value={url}
            dir="ltr"
            className="font-mono text-pn-soft truncate"
            onFocus={(e) => e.target.select()}
          />
        )}
        {error && <p className="text-compact text-danger">{error}</p>}
        <ModalFooter>
          {!url && <Button action="cancel" onClick={onClose} />}
          <Button
            variant="primary"
            icon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            onClick={handlePrimary}
            disabled={busy}
          >
            {copied
              ? t('auth:createPhrase.copied')
              : share
                ? t('burnShareModal.share')
                : url
                  ? t('common:actions.copy')
                  : t('burnShareModal.create')}
          </Button>
        </ModalFooter>
    </Modal>
  );
}
