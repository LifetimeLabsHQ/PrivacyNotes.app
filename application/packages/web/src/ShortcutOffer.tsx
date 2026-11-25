import { useTranslation } from 'react-i18next';
import { Monitor } from './icons';
import { desktopShortcutUrl, dismissDesktopOffer, type ShortcutTarget } from './noteShortcut';
import { Banner, Button, FeedbackButton, Modal, ModalFooter, SETTINGS_BTN_PRIMARY } from './ui';

/**
 * The offer to open a shortcut in the desktop app, in a computer browser.
 * Loaded only when a shortcut is waiting, so the boot path does not carry it.
 *
 * Spec: docs/internal/specs/note-shortcuts.md (6)
 */

/** The bar over a note a shortcut opened in a computer browser. "Open in
 *  app" hides it for this tab; the x hides it on this browser for good. */
export function ShortcutDesktopBar({ target, onClose }: { target: ShortcutTarget; onClose: () => void }) {
  const { t } = useTranslation('shell');
  function dismiss() {
    dismissDesktopOffer();
    onClose();
  }
  return (
    <Banner
      tone="info"
      icon={Monitor}
      action={
        <FeedbackButton action="open" href={desktopShortcutUrl(target)} onClick={onClose}>
          {t('shortcut.offerOpen')}
        </FeedbackButton>
      }
      onDismiss={dismiss}
      dismissLabel={t('shortcut.offerDismiss')}
    >
      {t('shortcut.offerText')}
    </Banner>
  );
}

/** The card over the sign-in form when a shortcut is waiting. "Sign in here"
 *  closes it and leaves the shortcut waiting for the vault. */
export function ShortcutSignInCard({ target, onSignIn }: { target: ShortcutTarget; onSignIn: () => void }) {
  const { t } = useTranslation('shell');
  return (
    <Modal
      onClose={onSignIn}
      title={t('shortcut.cardTitle')}
      icon={<Monitor />}
      className="max-w-sm p-6 space-y-4"
    >
      <p className="text-body text-pn-muted">{t('shortcut.cardBody')}</p>
      <ModalFooter>
        <Button action="next" variant="secondary" onClick={onSignIn}>
          {t('shortcut.cardSignIn')}
        </Button>
        <a href={desktopShortcutUrl(target)} className={SETTINGS_BTN_PRIMARY}>
          <Monitor aria-hidden="true" className="shrink-0" />
          {t('shortcut.cardOpen')}
        </a>
      </ModalFooter>
      <p className="text-small text-pn-muted">{t('shortcut.cardAfter')}</p>
    </Modal>
  );
}
