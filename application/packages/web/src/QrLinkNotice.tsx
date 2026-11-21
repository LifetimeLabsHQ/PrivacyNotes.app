import { useTranslation } from 'react-i18next';
import { Modal } from './ui';

/**
 * Shown on the sign-in screen when the page opened with a `#phrase=`
 * fragment that held a valid phrase: an old sign-in QR read by a phone's
 * camera app. The link no longer signs in, and the browser history already
 * holds it, so this says what to delete and which door to use instead. It
 * never says "your phrase": anyone can make such a link. An information
 * window: the X, Escape and a click outside close it.
 * Spec: docs/internal/plans/qr-signin-content.md (3.3)
 */
export function QrLinkNotice({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('auth');
  return (
    <Modal onClose={onClose} title={t('qrLinkNotice.title')} className="max-w-md p-6 space-y-4">
      <p className="text-body text-pn-soft leading-relaxed">
        {t('qrLinkNotice.body', { scanQr: t('importPhrase.scanQr') })}
      </p>
    </Modal>
  );
}
