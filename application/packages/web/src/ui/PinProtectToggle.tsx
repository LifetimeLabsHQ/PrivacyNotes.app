import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from '../icons';
import { PinInfoModal } from '../PinInfoModal';
import { Checkbox } from './Checkbox';

/**
 * @catalog PinProtectToggle
 * use: the "Require PIN to view" checkbox with its info button, `PinInfoModal`, and missing-PIN helper line on item forms (logins, cards, SSH keys, contacts, bookmarks). Read-only locks content, not protection, and an already-protected item can still be untoggled.
 * never: a copy-pasted PIN checkbox block on an item form; disabling the toggle solely because the item is read-only.
 */
export function PinProtectToggle({
  checked,
  pinConfigured,
  onChange,
  bordered = true,
  className = '',
}: {
  checked: boolean;
  pinConfigured: boolean;
  onChange: (checked: boolean) => void;
  bordered?: boolean;
  className?: string;
}) {
  const { t } = useTranslation('common');
  const [showInfo, setShowInfo] = useState(false);
  const disabled = !pinConfigured && !checked;
  const rootClass = [bordered ? 'border-t border-divider pt-2' : '', className].filter(Boolean).join(' ');

  return (
    <div className={rootClass || undefined}>
      <div className="flex items-center gap-2">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          label={<span className="text-pn-muted">{t('cardForm.requirePin')}</span>}
        />
        <button
          type="button"
          aria-label={t('cardForm.whatDoesThisDo')}
          onClick={() => setShowInfo(true)}
          className="-m-1 p-1 text-accent/60 transition hover:text-accent"
        >
          <Info aria-hidden="true" />
        </button>
      </div>
      {showInfo && <PinInfoModal onClose={() => setShowInfo(false)} />}
      {!pinConfigured && !checked && (
        <p className="text-meta text-pn-muted mt-1">{t('cardForm.setUpPinFirst')}</p>
      )}
    </div>
  );
}
