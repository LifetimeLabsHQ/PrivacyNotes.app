import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, Globe } from './icons';
import { Button, Modal, Spinner, TextField } from './ui';
import { SubscribedFeeds, useFeedSubscribe, type FeedsControl } from './calendarFeedUI';

/**
 * The calendar's own way to subscribe (GitHub #619): the Globe button in its
 * top row opens this window, so a subscription needs no trip to Settings.
 * The address field and Subscribe, then the subscribed calendars with
 * Remove, the same parts as the Webcal panel in Settings > Import. A new
 * calendar joins the list and the field empties; the window stays open.
 * Loaded on demand.
 * Spec: docs/internal/specs/calendar-pillar-spec.md (section 14)
 */
export default function CalendarSubscribeModal({ feeds, onClose }: { feeds: FeedsControl; onClose: () => void }) {
  const { t } = useTranslation('importExport');
  const [address, setAddress] = useState('');
  const sub = useFeedSubscribe(feeds);
  return (
    <Modal
      onClose={onClose}
      escape={!sub.busy}
      closeOnBackdrop={!sub.busy}
      title={t('webcal.subscribeTitle')}
      icon={<Globe />}
      className="max-w-md p-6 space-y-4"
    >
      <p className="text-small text-pn-soft">{t('webcal.subscribeDesc')}</p>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void sub.subscribe(address).then((ok) => ok && setAddress(''));
        }}
        className="flex flex-wrap items-start gap-2"
      >
        <div className="min-w-48 flex-1">
          <TextField
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-label={t('webcal.fieldLabel')}
            placeholder="webcal://"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              sub.setError(null);
            }}
            error={sub.error ?? undefined}
            className="w-full"
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          icon={sub.busy ? <Spinner size={15} className="text-current" /> : <CalendarPlus aria-hidden="true" />}
          disabled={sub.busy || !address.trim()}
        >
          {sub.busy ? t('webcal.downloading') : t('webcal.subscribe')}
        </Button>
      </form>
      <SubscribedFeeds feeds={feeds} />
    </Modal>
  );
}
