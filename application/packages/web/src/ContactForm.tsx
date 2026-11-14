import { Button, Callout } from './ui';
import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from './ContextMenu';
import { hasPin } from './pin';
import { PinInfoModal } from './PinInfoModal';
import {
  BIRTHDAY_LABEL,
  CONTACT_FIELD_TYPES,
  CONTACT_LABELS,
  contactInitialsFor,
  isAddressEmpty,
  newContactField,
  newContactSection,
  type Contact,
  type ContactAddress,
  type ContactField,
  type ContactLabelled,
  type ContactSection,
} from './contactBody';
import { CustomFieldEditor } from './CustomFields';
import { isPublicField } from './loginExtras';
import { DeleteButton } from './ui/DeleteButton';
import { ContactChip } from './NoteRow';
import { storePicture } from './EncryptedImage';
import { contactPhotoOptions } from './imageProcessing';
import { Camera, CaretDown, iconTrash, Info, Minus, NotePencil, Plus, Rows, Spinner, User } from './icons';
import { FIELD_CLASS, FieldLabel, GroupHeading } from './formFields';
import { isImeComposing } from './imeComposing';

/**
 * The contact form: the edit state of ContactItem, seated beside
 * LoginForm / CardForm / SshKeyForm and inheriting its width from the
 * wrapper like those three.
 *
 * Three tiers, one form. Name, phone and email are always on screen. The
 * rest of the modelled fields appear only once the contact carries them,
 * or once "Add field" adds them, so a contact with a name and a number is
 * four rows. Everything the file carried that the app does not model is
 * listed read-only under "Also in this file" and written back on export.
 * The owner's own sections (#757) come after the note: a name, then fields
 * in the login custom-field editor, with a blank field dropped on save.
 *
 * Each repeating group keeps one blank row at the end, so a second number
 * is typing rather than clicking Add first; the blank row is dropped on
 * save (buildContactBody skips rows without a value). The label control is
 * one component for every row kind: a button that opens the shared
 * ContextMenu with the suggested vocabulary plus a custom entry.
 *
 * Spec: docs/internal/specs/contacts-pillar.md (section 6) + contacts-mockups.html (sections 4 and 5)
 */

type RowKind = 'phones' | 'emails' | 'urls' | 'profiles' | 'dates' | 'related';

/** The label a new row of each kind starts with. */
const DEFAULT_LABEL: Record<RowKind, string> = {
  phones: 'mobile',
  emails: 'home',
  urls: 'homepage',
  profiles: '',
  dates: 'other',
  related: 'other',
};

/** The vocabulary the picker offers per row kind. Labels are stored as
 *  these lower-case words; the interface translates them for display and
 *  shows a custom label as typed. */
const VOCABULARY: Record<RowKind | 'addresses', readonly string[]> = {
  phones: CONTACT_LABELS,
  emails: ['home', 'work', 'other'],
  urls: ['homepage', 'work', 'blog', 'profile', 'other'],
  profiles: ['skype', 'whatsapp', 'signal', 'telegram', 'twitter', 'linkedin', 'instagram', 'facebook', 'github', 'mastodon', 'other'],
  dates: [BIRTHDAY_LABEL, 'anniversary', 'other'],
  related: ['mother', 'father', 'parent', 'spouse', 'partner', 'child', 'sibling', 'friend', 'assistant', 'manager', 'other'],
  addresses: ['home', 'work', 'other'],
};

/**
 * What one field may hold. A length cap and nothing else: a phone number is not
 * a number in every country, a postcode is not digits everywhere, and a name is
 * not letters in every language, so a format rule here refuses real data. The
 * one thing worth refusing is a runaway paste, because a note over 1 MB is one
 * the server will not take, and it then sits unsynced behind a pill the owner
 * has to notice.
 * Spec: docs/internal/design-decisions.md (contact field caps)
 */
const VALUE_MAX = 200;
const LABEL_MAX = 40;
const STREET_MAX = 500;
const NOTE_MAX = 10_000;

const fieldClass = FIELD_CLASS;

/** Append one blank row when the last row holds a value, and keep exactly one blank at the end. */
export function withTrailingBlank(rows: ContactLabelled[], defaultLabel: string): ContactLabelled[] {
  const out = rows.filter((r, i) => r.value.trim() !== '' || i === rows.length - 1);
  const last = out[out.length - 1];
  if (!last || last.value.trim() !== '') out.push({ label: defaultLabel, value: '' });
  return out;
}

function withTrailingBlankAddress(rows: ContactAddress[]): ContactAddress[] {
  const out = rows.filter((r, i) => !isAddressEmpty(r) || i === rows.length - 1);
  const last = out[out.length - 1];
  if (!last || !isAddressEmpty(last)) {
    out.push({ label: 'home', street: '', city: '', region: '', postal: '', country: '' });
  }
  return out;
}

type ContactFormProps = {
  noteId: string;
  title: string;
  draft: Contact;
  /** The React setter, so a picture that finishes storing after a
   *  keystroke patches the current draft rather than the one it started
   *  from. */
  onDraftChange: Dispatch<SetStateAction<Contact>>;
  locked: boolean;
  pinProtected: boolean;
  onPinProtectedChange: (value: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
  isNew: boolean;
  saveError: string;
};

export function ContactForm({
  title,
  draft,
  onDraftChange,
  locked,
  pinProtected,
  onPinProtectedChange,
  onSave,
  onCancel,
  isNew,
  saveError,
}: ContactFormProps) {
  const { t } = useTranslation('shell');
  // Never memoize this. Settings opens over a mounted form, so a PIN
  // can appear or vanish while the toggle below is on screen, and
  // localStorage fires nothing that would refresh a frozen value.
  const pinConfigured = hasPin();
  const [showPinInfo, setShowPinInfo] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState>(null);
  /** Singles the user added this session, so an empty field stays on screen. */
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  /** The row whose label is being typed as custom text: `kind:index`. */
  const [customLabel, setCustomLabel] = useState<string | null>(null);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const photoButtonRef = useRef<HTMLButtonElement | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  const labelText = (label: string) =>
    label ? t(`contacts.labels.${label}`, { defaultValue: label }) : t('contacts.labelNone');

  function update(patch: Partial<Contact>) {
    onDraftChange((prev) => ({ ...prev, ...patch }));
  }

  /**
   * Store a chosen picture as this contact's photo. The size goes in beside
   * the reference, because the row size and the size sort read it rather
   * than the blob. The picture the photo replaces is left to the blob
   * collector, which keeps a blob only while a note body still names it.
   */
  async function choosePhoto(file: File | undefined) {
    if (photoInputRef.current) photoInputRef.current.value = '';
    if (!file) return;
    setPhotoBusy(true);
    try {
      const stored = await storePicture(file, contactPhotoOptions());
      if (stored) update({ photo: `pn:img/${stored.uuid}`, photoBytes: stored.bytes });
    } finally {
      setPhotoBusy(false);
    }
  }

  /** The chip: a picker while the contact has no photo, a two-entry menu once
   *  it has one. */
  function openPhotoMenu() {
    if (!draft.photo) {
      photoInputRef.current?.click();
      return;
    }
    const rect = photoButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenu({
      x: rect.left,
      y: rect.bottom + 4,
      items: [
        { label: t('contacts.changePhoto'), icon: <Camera />, onSelect: () => photoInputRef.current?.click() },
        { label: t('contacts.removePhoto'), icon: iconTrash(), destructive: true, onSelect: () => update({ photo: '', photoBytes: 0 }) },
      ],
    });
  }

  function setRows(kind: RowKind, rows: ContactLabelled[]) {
    update({ [kind]: withTrailingBlank(rows, DEFAULT_LABEL[kind]) } as Partial<Contact>);
  }

  function setRow(kind: RowKind, index: number, patch: Partial<ContactLabelled>) {
    const rows = draft[kind].map((r, i) => (i === index ? { ...r, ...patch } : r));
    setRows(kind, rows);
  }

  function removeRow(kind: RowKind, index: number) {
    setRows(kind, draft[kind].filter((_, i) => i !== index));
  }

  function addRow(kind: RowKind, label = DEFAULT_LABEL[kind]) {
    // Make the blank row the one for this label, so "Birthday" from the
    // menu lands on a row already labelled birthday.
    const rows = draft[kind].slice();
    const last = rows[rows.length - 1];
    if (last && last.value.trim() === '') rows[rows.length - 1] = { ...last, label };
    else rows.push({ label, value: '' });
    update({ [kind]: rows } as Partial<Contact>);
  }

  function setSections(sections: ContactSection[]) {
    update({ sections });
  }

  function patchSection(id: string, patch: Partial<ContactSection>) {
    setSections(draft.sections.map((sec) => (sec.id === id ? { ...sec, ...patch } : sec)));
  }

  function patchSectionField(sectionId: string, fieldId: string, patch: Partial<ContactField>) {
    const sec = draft.sections.find((x) => x.id === sectionId);
    if (!sec) return;
    patchSection(sectionId, { fields: sec.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) });
  }

  function setAddress(index: number, patch: Partial<ContactAddress>) {
    const rows = draft.addresses.map((a, i) => (i === index ? { ...a, ...patch } : a));
    update({ addresses: withTrailingBlankAddress(rows) });
  }

  function removeAddress(index: number) {
    update({ addresses: withTrailingBlankAddress(draft.addresses.filter((_, i) => i !== index)) });
  }

  /** Open the label picker for one row, anchored to its button. */
  function openLabelMenu(e: React.MouseEvent<HTMLButtonElement>, kind: RowKind | 'addresses', index: number) {
    const rect = e.currentTarget.getBoundingClientRect();
    const choose = (label: string) => {
      if (kind === 'addresses') setAddress(index, { label });
      else setRow(kind, index, { label });
    };
    const items: ContextMenuItem[] = VOCABULARY[kind].map((label) => ({
      label: labelText(label),
      onSelect: () => choose(label),
    }));
    items.push({ type: 'separator' });
    items.push({ label: t('contacts.labelCustom'), onSelect: () => setCustomLabel(`${kind}:${index}`) });
    setMenu({ x: rect.left, y: rect.bottom + 4, items });
  }

  const hasBirthday = draft.dates.some((d) => d.label === BIRTHDAY_LABEL && d.value.trim() !== '');
  const showCompany = !!draft.org.trim() || !!draft.department.trim() || added.has('company');
  const showJobTitle = !!draft.jobTitle.trim() || added.has('jobTitle');
  const showNickname = !!draft.nickname.trim() || added.has('nickname');
  const showNameParts = !!(draft.middle.trim() || draft.prefix.trim() || draft.suffix.trim()) || added.has('nameParts');
  const showPhonetic = !!(draft.phonetic.first.trim() || draft.phonetic.middle.trim() || draft.phonetic.last.trim()) || added.has('phonetic');
  const showNotes = !!draft.notes.trim() || added.has('notes');
  const showAddresses = draft.addresses.length > 0;
  const showUrls = draft.urls.length > 0;
  const showProfiles = draft.profiles.length > 0;
  const showDates = draft.dates.length > 0;
  const showRelated = draft.related.length > 0;

  function openAddField(anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    const show = (key: string) => setAdded((prev) => new Set(prev).add(key));
    const items: ContextMenuItem[] = [
      { type: 'header', label: t('contacts.menuContact') },
      { label: t('shell:contacts.groupAddress'), onSelect: () => update({ addresses: withTrailingBlankAddress(draft.addresses) }) },
      { label: t('shell:contacts.groupWebsite'), onSelect: () => addRow('urls') },
      { label: t('shell:contacts.labels.profile'), onSelect: () => addRow('profiles') },
    ];
    if (!showCompany || !showJobTitle) {
      items.push({ type: 'header', label: t('contacts.menuWork') });
      if (!showCompany) items.push({ label: t('shell:contacts.company'), onSelect: () => show('company') });
      if (!showJobTitle) items.push({ label: t('shell:contacts.jobTitle'), onSelect: () => show('jobTitle') });
    }
    items.push({ type: 'header', label: t('contacts.menuPersonal') });
    if (!hasBirthday) items.push({ label: t('shell:contacts.labels.birthday'), onSelect: () => addRow('dates', BIRTHDAY_LABEL) });
    items.push({ label: t('contacts.itemDate'), onSelect: () => addRow('dates', 'anniversary') });
    items.push({ label: t('contacts.itemRelated'), onSelect: () => addRow('related') });
    if (!showNickname || !showNameParts || !showPhonetic) {
      items.push({ type: 'header', label: t('contacts.menuName') });
      if (!showNickname) items.push({ label: t('shell:contacts.nickname'), onSelect: () => show('nickname') });
      if (!showNameParts) items.push({ label: t('contacts.itemNameParts'), onSelect: () => show('nameParts') });
      if (!showPhonetic) items.push({ label: t('contacts.itemPhonetic'), onSelect: () => show('phonetic') });
    }
    if (!showNotes) {
      items.push({ type: 'header', label: t('contacts.menuText') });
      items.push({ label: t('contacts.itemNote'), onSelect: () => show('notes') });
    }
    setMenu({ x: rect.left, y: rect.bottom + 4, items });
  }

  /** The label control: a button into the picker, or a text field while a
   *  custom label is typed. A render helper rather than a component, so the
   *  inputs around it are not remounted (and unfocused) on every keystroke. */
  function labelControl(kind: RowKind | 'addresses', index: number, label: string) {
    const key = `${kind}:${index}`;
    if (customLabel === key) {
      return (
        <input
          autoFocus
          value={label}
          onChange={(e) => (kind === 'addresses' ? setAddress(index, { label: e.target.value }) : setRow(kind, index, { label: e.target.value }))}
          onBlur={() => setCustomLabel(null)}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === 'Escape') && !isImeComposing(e)) { e.preventDefault(); setCustomLabel(null); } }}
          placeholder={t('contacts.labelNone')}
          maxLength={LABEL_MAX}
          className="w-28 shrink-0 rounded-md border border-accent bg-surface-1 px-2 py-2 text-small focus:outline-none"
        />
      );
    }
    return (
      <button
        type="button"
        disabled={locked}
        onClick={(e) => openLabelMenu(e, kind, index)}
        className="w-28 shrink-0 inline-flex items-center justify-between gap-1 rounded-md border border-divider bg-surface-2 px-2 py-2 text-small text-pn-soft hover:border-accent transition disabled:opacity-60"
      >
        <span className="truncate">{labelText(label)}</span>
        <CaretDown className="shrink-0 text-pn-muted" aria-hidden="true" />
      </button>
    );
  }

  function removeButton(onClick: () => void, blank: boolean) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={locked || blank}
        aria-label={t('common:actions.remove')}
        className={`shrink-0 w-8 h-8 rounded-md inline-flex items-center justify-center text-accent/70 hover:text-red-600 dark:hover:text-red-400 transition ${blank ? 'opacity-35' : ''}`}
      >
        <Minus />
      </button>
    );
  }

  function labelledRows(kind: RowKind, heading: string, placeholder: string, inputMode?: 'tel' | 'email' | 'url' | 'text') {
    return (
      <div>
        <GroupHeading>{heading}</GroupHeading>
        <div className="flex flex-col gap-1.5">
          {draft[kind].map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              {labelControl(kind, i, row.label)}
              <input
                value={row.value}
                onChange={(e) => setRow(kind, i, { value: e.target.value })}
                placeholder={placeholder}
                disabled={locked}
                maxLength={VALUE_MAX}
                inputMode={inputMode}
                autoComplete="off"
                dir="auto"
                className={fieldClass}
              />
              {removeButton(() => removeRow(kind, i), row.value.trim() === '')}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex flex-col gap-5">
        {/* Hero: the chip the row draws, beside the two name fields. */}
        <div className="flex items-center gap-4">
          {/* The chip is the picture control: a camera badge over the avatar,
              which is where a person looks for one. ui-patterns.md section 120. */}
          <button
            ref={photoButtonRef}
            type="button"
            onClick={openPhotoMenu}
            disabled={locked || photoBusy}
            aria-label={draft.photo ? t('contacts.changePhoto') : t('contacts.addPhoto')}
            className="relative shrink-0 rounded-full group focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
          >
            <ContactChip name={title} initials={contactInitialsFor(title, draft)} photo={draft.photo} size={56} />
            <span className="absolute -bottom-0.5 -end-0.5 w-5 h-5 rounded-full bg-surface-1 border border-divider inline-flex items-center justify-center text-pn-soft group-hover:border-accent group-hover:text-accent transition">
              {photoBusy ? <Spinner className="animate-spin" /> : <Camera />}
            </span>
          </button>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void choosePhoto(e.target.files?.[0])}
          />
          <div className="flex-1 flex flex-col gap-1.5 min-w-0">
            <input
              value={draft.first}
              onChange={(e) => update({ first: e.target.value })}
              placeholder={t('contacts.firstName')}
              disabled={locked}
              maxLength={VALUE_MAX}
              autoFocus={isNew}
              autoComplete="off"
              dir="auto"
              className={fieldClass}
            />
            <input
              value={draft.last}
              onChange={(e) => update({ last: e.target.value })}
              placeholder={t('contacts.lastName')}
              disabled={locked}
              maxLength={VALUE_MAX}
              autoComplete="off"
              dir="auto"
              className={fieldClass}
            />
          </div>
        </div>

        {showNameParts && (
          <div>
            <GroupHeading>{t('shell:contacts.menuName')}</GroupHeading>
            <div className="grid grid-cols-3 gap-1.5">
              <input value={draft.prefix} onChange={(e) => update({ prefix: e.target.value })} placeholder={t('contacts.prefix')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
              <input value={draft.middle} onChange={(e) => update({ middle: e.target.value })} placeholder={t('contacts.middleName')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
              <input value={draft.suffix} onChange={(e) => update({ suffix: e.target.value })} placeholder={t('contacts.suffix')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
            </div>
          </div>
        )}

        {showNickname && (
          <div>
            <FieldLabel icon={<User />}>{t('contacts.nickname')}</FieldLabel>
            <input value={draft.nickname} onChange={(e) => update({ nickname: e.target.value })} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
          </div>
        )}

        {showPhonetic && (
          <div>
            <GroupHeading>{t('contacts.itemPhonetic')}</GroupHeading>
            <div className="grid grid-cols-2 gap-1.5">
              <input value={draft.phonetic.first} onChange={(e) => update({ phonetic: { ...draft.phonetic, first: e.target.value } })} placeholder={t('contacts.phoneticFirst')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
              <input value={draft.phonetic.last} onChange={(e) => update({ phonetic: { ...draft.phonetic, last: e.target.value } })} placeholder={t('contacts.phoneticLast')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
            </div>
          </div>
        )}

        {labelledRows('phones', t('contacts.groupPhone'), t('contacts.addPhone'), 'tel')}
        {labelledRows('emails', t('contacts.groupEmail'), t('contacts.addEmail'), 'email')}

        {(showCompany || showJobTitle) && (
          <div>
            <GroupHeading>{t('contacts.menuWork')}</GroupHeading>
            <div className="flex flex-col gap-1.5">
              {showCompany && (
                <div className="grid grid-cols-2 gap-1.5">
                  <input value={draft.org} onChange={(e) => update({ org: e.target.value })} placeholder={t('contacts.company')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
                  <input value={draft.department} onChange={(e) => update({ department: e.target.value })} placeholder={t('contacts.department')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
                </div>
              )}
              {showJobTitle && (
                <input value={draft.jobTitle} onChange={(e) => update({ jobTitle: e.target.value })} placeholder={t('contacts.jobTitle')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
              )}
            </div>
          </div>
        )}

        {showAddresses && (
          <div>
            <GroupHeading>{t('contacts.groupAddress')}</GroupHeading>
            <div className="flex flex-col gap-3">
              {draft.addresses.map((a, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  {labelControl('addresses', i, a.label)}
                  <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                    {/* One field for the street on purpose: an address that
                        arrived as a single blob stays a blob here. */}
                    <textarea value={a.street} onChange={(e) => setAddress(i, { street: e.target.value })} placeholder={t('contacts.street')} disabled={locked} maxLength={STREET_MAX} rows={2} dir="auto" className={`${fieldClass} resize-y`} />
                    <div className="grid grid-cols-2 gap-1.5">
                      <input value={a.postal} onChange={(e) => setAddress(i, { postal: e.target.value })} placeholder={t('contacts.postal')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
                      <input value={a.city} onChange={(e) => setAddress(i, { city: e.target.value })} placeholder={t('contacts.city')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
                      <input value={a.region} onChange={(e) => setAddress(i, { region: e.target.value })} placeholder={t('contacts.region')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
                      <input value={a.country} onChange={(e) => setAddress(i, { country: e.target.value })} placeholder={t('contacts.country')} disabled={locked} maxLength={VALUE_MAX} dir="auto" className={fieldClass} />
                    </div>
                  </div>
                  {removeButton(() => removeAddress(i), isAddressEmpty(a))}
                </div>
              ))}
            </div>
          </div>
        )}

        {showUrls && labelledRows('urls', t('contacts.groupWebsite'), t('contacts.addWebsite'), 'url')}
        {showProfiles && labelledRows('profiles', t('shell:contacts.labels.profile'), t('contacts.addProfile'))}
        {showDates && labelledRows('dates', t('contacts.groupDates'), t('contacts.addDate'))}
        {showRelated && labelledRows('related', t('contacts.groupRelated'), t('contacts.addRelated'))}

        {showNotes && (
          <div>
            <FieldLabel icon={<NotePencil />}>{t('shell:contacts.itemNote')}</FieldLabel>
            <textarea value={draft.notes} onChange={(e) => update({ notes: e.target.value })} placeholder={t('contacts.notePlaceholder')} disabled={locked} maxLength={NOTE_MAX} rows={3} dir="auto" className={`${fieldClass} resize-y`} />
          </div>
        )}

        {/* The owner's own sections: each one a card, so its name, its fields
            and its own add link read as one thing apart from the contact's
            Add field and Add section below. ui-patterns.md section 187. */}
        {draft.sections.map((sec) => {
          const name = sec.title.trim();
          return (
            <div key={sec.id} className="rounded-lg border border-divider p-3">
              <div className="flex items-center gap-1.5">
                <Rows className="shrink-0 text-pn-muted" aria-hidden="true" />
                <input
                  value={sec.title}
                  onChange={(e) => patchSection(sec.id, { title: e.target.value })}
                  placeholder={t('contacts.sectionName')}
                  aria-label={t('contacts.sectionName')}
                  disabled={locked}
                  maxLength={VALUE_MAX}
                  autoComplete="off"
                  dir="auto"
                  className={`${fieldClass} font-medium`}
                />
                {!locked && (
                  <DeleteButton
                    kind="remove"
                    label={name ? t('contacts.removeSectionNamed', { name }) : t('contacts.removeSection')}
                    onConfirm={() => setSections(draft.sections.filter((x) => x.id !== sec.id))}
                  />
                )}
              </div>
              <div className="mt-1 flex flex-col divide-y divide-divider">
                {sec.fields.map((f) => (
                  <CustomFieldEditor
                    key={f.id}
                    field={f}
                    types={CONTACT_FIELD_TYPES}
                    locked={locked}
                    plain
                    nameMax={LABEL_MAX}
                    valueMax={VALUE_MAX}
                    onChange={(patch) => patchSectionField(sec.id, f.id, patch)}
                    onRemove={() => patchSection(sec.id, { fields: sec.fields.filter((x) => x.id !== f.id) })}
                  />
                ))}
              </div>
              {sec.fields.some((f) => !isPublicField(f)) && (
                <p className="mt-1 text-meta text-pn-muted">{t('contacts.hiddenFieldsNote')}</p>
              )}
              {!locked && (
                <div className="mt-2 pt-2 border-t border-divider">
                  <button
                    type="button"
                    onClick={() => patchSection(sec.id, { fields: [...sec.fields, newContactField('text')] })}
                    className="inline-flex items-center gap-1.5 text-compact text-accent hover:underline"
                  >
                    <Plus />
                    {/* The link names its section, so it never reads as the
                        contact's own Add field; an unnamed section says so. */}
                    <span dir="auto">{name ? t('contacts.addFieldTo', { name }) : t('contacts.addFieldToSection')}</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-2 mt-1">
          <Button variant="secondary" icon={<Plus aria-hidden="true" />} onClick={(e) => openAddField(e.currentTarget)} disabled={locked}>
            {t('contacts.addField')}
          </Button>
          <Button variant="secondary" icon={<Rows aria-hidden="true" />} onClick={() => setSections([...draft.sections, newContactSection()])} disabled={locked}>
            {t('contacts.addSection')}
          </Button>
        </div>

        {draft.extras.length > 0 && (
          <div className="rounded-md border border-divider">
            <button
              type="button"
              onClick={() => setExtrasOpen((v) => !v)}
              aria-expanded={extrasOpen}
              className="w-full flex items-center gap-2 px-3 py-2 text-compact text-pn-soft"
            >
              <CaretDown className={`shrink-0 transition-transform ${extrasOpen ? '' : '-rotate-90'}`} aria-hidden="true" />
              {t('contacts.alsoInFile')}
              <span className="ms-auto text-small text-pn-muted">{t('contacts.extrasCount', { count: draft.extras.length })}</span>
            </button>
            {extrasOpen && (
              <div className="px-3 pb-3 flex flex-col gap-1">
                {draft.extras.map((x, i) => (
                  <div key={i} className="flex gap-3 text-small">
                    <span className="shrink-0 w-36 truncate font-mono text-pn-muted" dir="ltr">{x.name}</span>
                    <span className="min-w-0 break-all text-pn-soft" dir="auto">{x.value}</span>
                  </div>
                ))}
                <p className="mt-1 text-meta text-pn-muted">{t('contacts.extrasNote')}</p>
              </div>
            )}
          </div>
        )}

        {/* PIN-protect toggle - the vault form's exact block. */}
        <label className={`flex items-center gap-2 pt-2 border-t border-divider ${!pinConfigured && !pinProtected ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
          <input
            type="checkbox"
            checked={pinProtected}
            onChange={(e) => onPinProtectedChange(e.target.checked)}
            disabled={!pinConfigured && !pinProtected}
            className="rounded accent-accent"
          />
          <span className="text-body text-pn-muted">{t('common:cardForm.requirePin')}</span>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); setShowPinInfo(true); }}
            className="text-accent/60 hover:text-accent transition p-1 -m-1"
            aria-label={t('common:cardForm.whatDoesThisDo')}
          >
            <Info />
          </button>
        </label>
        {showPinInfo && <PinInfoModal onClose={() => setShowPinInfo(false)} />}
        {!pinConfigured && !pinProtected && (
          <p className="text-meta text-pn-muted -mt-3">{t('common:cardForm.setUpPinFirst')}</p>
        )}

        {saveError && <Callout tone="danger">{saveError}</Callout>}
        <div className="flex items-center justify-end gap-2">
          {!isNew && (
            <Button action="cancel" onClick={onCancel} />
          )}
          <Button action="save" onClick={onSave} disabled={locked} />
        </div>
      </div>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
