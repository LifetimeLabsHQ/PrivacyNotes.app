import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DetailAction, DetailCopyAction, DetailRow } from './detailPane';
import { FIELD_BUTTON, FIELD_CLASS } from './formFields';
import { HoverLabel } from './HoverLabel';
import { CheckSquare, Eye, EyeSlash, Hash, Lock, Tag, Trash, X } from './icons';
import { isPublicField, type LoginField } from './loginExtras';
import { PasswordField } from './PasswordText';
import { IconButton } from './ui/Button';
import { Checkbox } from './ui/Checkbox';
import { VaultFieldAction } from './ui/VaultFieldAction';

/**
 * The custom field, in its two states: the row a view draws and the box a
 * form edits. A login's custom fields and a contact's own sections (#757)
 * both draw these, so a hidden value is masked the same way everywhere.
 * Spec: docs/internal/specs/contacts-pillar.md (section 5, sections)
 */

/** The reveal cell a secret row carries. */
export function RevealAction({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const { t } = useTranslation('shell');
  return (
    <DetailAction label={shown ? t('common:sshKeyForm.hide') : t('vaultItem.reveal')} onClick={onToggle}>
      {shown ? <EyeSlash /> : <Eye />}
    </DetailAction>
  );
}

/** A custom field in a view. A hidden value is masked until revealed and is
 *  not in the DOM at all while masked. */
export function CustomFieldRow({ field, copy, copied }: {
  field: LoginField;
  copy: (text: string, label: string) => void;
  copied: string | null;
}) {
  const { t } = useTranslation('shell');
  const [shown, setShown] = useState(false);
  const secret = !isPublicField(field);
  const id = `field-${field.id}`;
  const name = field.label || t('vaultItem.customField');
  const tip = copied === id ? t('vaultItem.copied') : t('vaultItem.copyField', { label: name });
  if (field.type === 'yesno') {
    return (
      <DetailRow label={<span dir="auto">{name}</span>} icon={<CheckSquare />}>
        {field.value === 'yes' ? t('trackers:custom.yes') : t('trackers:custom.no')}
      </DetailRow>
    );
  }
  return (
    <DetailRow
      label={<span dir="auto">{name}</span>}
      icon={secret ? <Lock /> : field.type === 'number' ? <Hash /> : <Tag />}
      actions={
        field.value ? (
          <>
            {secret && <RevealAction shown={shown} onToggle={() => setShown(!shown)} />}
            <DetailCopyAction value={field.value} id={id} copied={copied} onCopy={copy} label={tip} />
          </>
        ) : undefined
      }
    >
      {secret && !shown ? (
        <span dir="ltr" className="font-mono tracking-wider" /* rtl-ok: a mask, symbols only */>{field.value ? '••••••••' : ''}</span>
      ) : (
        <span dir="auto" className="whitespace-pre-wrap break-all">{field.value}</span>
      )}
    </DetailRow>
  );
}

/** The type picker's text for each type a form offers. */
const TYPE_LABEL: Record<string, string> = {
  text: 'loginForm.fieldTypeText',
  number: 'trackers:custom.typeLabels.number',
  yesno: 'trackers:custom.typeLabels.yesno',
  hidden: 'loginForm.fieldTypeHidden',
};

/**
 * One custom field in a form: name, type and remove on the first line, the
 * value under it. `types` is what this form offers; a stored type outside it
 * shows as hidden, the type it is treated as. `copy` adds a copy button
 * (the login form has one on every field; the contact form has none).
 */
export function CustomFieldEditor({ field, types, locked, onChange, onRemove, copy, copied, nameMax, valueMax, plain = false }: {
  field: LoginField;
  /** No box of its own and an X to remove it: the field sits in a card that
   *  already frames it (a contact section), whose own remove is the trash. */
  plain?: boolean;
  types: readonly string[];
  locked: boolean;
  onChange: (patch: Partial<LoginField>) => void;
  onRemove: () => void;
  copy?: (text: string, label: string) => void;
  copied?: string | null;
  nameMax?: number;
  valueMax?: number;
}) {
  const { t } = useTranslation('auth');
  const [revealed, setRevealed] = useState(false);
  const hidden = !isPublicField(field);
  const type = types.includes(field.type) ? field.type : 'hidden';
  const changeType = (next: string) => {
    // A yes-or-no field holds `yes` or `no` only, so a switch to or from one
    // starts its value again rather than keeping text it cannot show.
    if (next === 'yesno') onChange({ type: next, value: 'no' });
    else if (field.type === 'yesno') onChange({ type: next, value: '' });
    else onChange({ type: next });
  };
  let valueControl: React.ReactNode;
  if (field.type === 'yesno') {
    valueControl = (
      <Checkbox
        label={t('trackers:custom.yes')}
        checked={field.value === 'yes'}
        onChange={(e) => onChange({ value: e.target.checked ? 'yes' : 'no' })}
        disabled={locked}
        className="flex-1 px-1 py-1.5"
      />
    );
  } else if (hidden && !revealed) {
    valueControl = (
      <PasswordField
        value={field.value}
        onChange={(e) => onChange({ value: e.target.value })}
        revealed={false}
        disabled={locked}
        placeholder={t('loginForm.fieldValuePlaceholder')}
        fieldClass={FIELD_CLASS}
      />
    );
  } else if (field.type === 'number') {
    valueControl = (
      <input
        value={field.value}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder={t('loginForm.fieldValuePlaceholder')}
        aria-label={t('loginForm.fieldValuePlaceholder')}
        disabled={locked}
        maxLength={valueMax}
        inputMode="decimal"
        autoComplete="off"
        dir="ltr"
        className={FIELD_CLASS}
      />
    );
  } else {
    valueControl = (
      <textarea
        value={field.value}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder={t('loginForm.fieldValuePlaceholder')}
        aria-label={t('loginForm.fieldValuePlaceholder')}
        disabled={locked}
        maxLength={valueMax}
        rows={1}
        spellCheck={!hidden}
        dir="auto"
        className={`${FIELD_CLASS} resize-y`}
      />
    );
  }
  return (
    <div className={`flex flex-col gap-1.5 ${plain ? 'py-2' : 'rounded-md border border-divider p-2'}`}>
      <div className="flex gap-1.5">
        <input
          type="text"
          dir="auto"
          value={field.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder={t('loginForm.fieldNamePlaceholder')}
          aria-label={t('loginForm.fieldNamePlaceholder')}
          disabled={locked}
          maxLength={nameMax}
          autoComplete="off"
          className={`${FIELD_CLASS} min-w-0 flex-1`}
        />
        <select
          value={type}
          onChange={(e) => changeType(e.target.value)}
          disabled={locked}
          aria-label={t('loginForm.fieldTypeLabel')}
          className={`${FIELD_CLASS.replace('w-full', 'w-auto')} shrink-0`}
        >
          {types.map((ty) => <option key={ty} value={ty}>{t(TYPE_LABEL[ty] ?? 'loginForm.fieldTypeText')}</option>)}
        </select>
        {!locked && (plain ? (
          // Muted like the section's own trash beside it, so the card's two
          // removes differ only in their glyph.
          <IconButton label={t('loginForm.removeField')} tone="danger" position="start" onClick={onRemove}>
            <X />
          </IconButton>
        ) : (
          <HoverLabel label={t('loginForm.removeField')} position="start">
            <button type="button" onClick={onRemove} aria-label={t('loginForm.removeField')} className={FIELD_BUTTON}>
              <Trash />
            </button>
          </HoverLabel>
        ))}
      </div>
      <div className="flex gap-1.5">
        {valueControl}
        {hidden && (
          <VaultFieldAction kind="reveal" active={revealed} title={revealed ? t('loginForm.hidePassword') : t('loginForm.showPassword')} onClick={() => setRevealed(!revealed)} />
        )}
        {copy && field.type !== 'yesno' && (
          <VaultFieldAction kind="copy" onClick={() => copy(field.value, `field-${field.id}`)} active={copied === `field-${field.id}`} title={t('loginForm.copyField')} />
        )}
      </div>
    </div>
  );
}
