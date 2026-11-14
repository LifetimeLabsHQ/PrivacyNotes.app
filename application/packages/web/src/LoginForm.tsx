import { VaultFieldAction } from './ui/VaultFieldAction';
import { Button } from './ui/Button';
import { VaultFormActions } from './ui/VaultFormActions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, Info, Lock, Plus, Shield, Tag, Trash, User } from './icons';
import { hasPin } from './pin';
import { PinInfoModal } from './PinInfoModal';
import { HoverLabel } from './HoverLabel';
import { useCopyToClipboard } from './clipboard';
import { parseTotpInput, generateTotpCode, totpSecondsRemaining } from '@notes/shared';
import { proUnlocked } from './demo';
import { domainFromUrlString } from './favicon';
import { PasswordField } from './PasswordText';
import { FIELD_BUTTON, FIELD_CLASS, FieldLabel } from './formFields';
import { NotesField } from './NotesField';
import { PasswordGeneratorModal } from './PasswordGenerator';
import type { UpgradeTrigger } from './UpgradeModal';
import { newLoginField, type LoginExtras, type LoginField } from './loginExtras';
import { CustomFieldEditor } from './CustomFields';

/** The types a login's custom field can take. */
const LOGIN_FIELD_TYPES = ['text', 'hidden'] as const;

// The body format lives in loginBody.ts, a leaf module for the readers that
// need no form (exports, importers, the extension's logins copy).
export { parseLoginBody, serializeLoginBody, type LoginData } from './loginBody';
import { parseLoginBody, serializeLoginBody, type LoginData } from './loginBody';

/* ────────────────────────────────────────────────────────────────
 * LoginForm - the editor replacement for login-type notes.
 * Renders structured fields instead of TipTap.
 * ──────────────────────────────────────────────────────────────── */
interface LoginFormProps {
  noteId: string;
  title: string;
  body: string;
  locked: boolean;
  pinProtected: boolean;
  onTitleChange: (id: string, title: string) => void;
  onBodyChange: (id: string, body: string) => void;
  onPinProtectedChange: (id: string, value: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
  isNew: boolean;
  saveError?: string;
  /** Whether the rotating-code preview may render below the field - the
   *  key itself is always visible and editable regardless of tier. Also
   *  gates the generator's passphrase mode. */
  isPro: boolean | null;
  onOpenUpgrade: (trigger: UpgradeTrigger) => void;
  /** Custom fields and additional websites, buffered with the body draft. */
  extras: LoginExtras;
  onExtrasChange: (extras: LoginExtras) => void;
}

export function LoginForm({
  noteId,
  title,
  body,
  locked,
  pinProtected,
  onTitleChange,
  onBodyChange,
  onPinProtectedChange,
  onSave,
  onCancel,
  isNew,
  saveError,
  isPro,
  onOpenUpgrade,
  extras,
  onExtrasChange,
}: LoginFormProps) {
  const { t } = useTranslation('auth');
  const data = parseLoginBody(body);
  const { copy, copied } = useCopyToClipboard();
  // Never memoize this. Settings opens over a mounted form, so a PIN
  // can appear or vanish while the toggle below is on screen, and
  // localStorage fires nothing that would refresh a frozen value.
  const pinConfigured = hasPin();
  const [showPinInfo, setShowPinInfo] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const setUrls = (extraUrls: string[]) => onExtrasChange({ ...extras, extraUrls });
  const setFields = (fields: LoginField[]) => onExtrasChange({ ...extras, fields });
  const patchField = (id: string, patch: Partial<LoginField>) =>
    setFields(extras.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  /** Soft URL hint - shown when the field has content that doesn't
   *  look like a URL. Not a hard block; users can store anything. */
  const urlHint = (() => {
    const v = data.url.trim();
    if (!v) return null;
    // Contains a dot or known scheme → probably fine.
    if (v.includes('.') || /^https?:\/\//i.test(v)) return null;
    return t('loginForm.urlHint');
  })();

  /** Parsed authenticator key - null when empty or unparseable. */
  const totpParams = useMemo(() => (data.totp.trim() ? parseTotpInput(data.totp) : null), [data.totp]);
  const totpUnlocked = proUnlocked(isPro);
  const [totpNow, setTotpNow] = useState(() => Date.now());

  // Tick once a second only while there's something valid to show -
  // no interval running for an empty or invalid key.
  useEffect(() => {
    if (!totpParams || !totpUnlocked) return;
    const id = setInterval(() => setTotpNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [totpParams, totpUnlocked]);

  const totpCode = totpParams && totpUnlocked ? generateTotpCode(totpParams, totpNow) : null;
  const totpSecondsLeft = totpParams && totpUnlocked ? totpSecondsRemaining(totpParams.period, totpNow) : null;

  const updateBody = useCallback(
    (patch: Partial<LoginData>) => {
      const next = { ...data, ...patch };
      onBodyChange(noteId, serializeLoginBody(next, body));
    },
    [noteId, data, body, onBodyChange]
  );

  const handleUrlChange = useCallback(
    (url: string) => {
      updateBody({ url });
    },
    [updateBody]
  );

  /** Auto-derive title from URL domain on blur, only if title is still empty. */
  const handleUrlBlur = useCallback(() => {
    if (!title.trim() && data.url.trim()) {
      const domain = domainFromUrlString(data.url);
      if (domain) onTitleChange(noteId, domain);
    }
  }, [noteId, title, data.url, onTitleChange]);

  const fieldClass = FIELD_CLASS;

  return (
    /* Width comes from VAULT_COLUMN on the VaultItem wrapper. */
    <div className="flex-1 overflow-y-auto p-6">
      <div className="space-y-4">
        {/* Username */}
        <div>
          <FieldLabel icon={<User />}>{t('loginForm.usernameLabel')}</FieldLabel>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={data.username}
              onChange={(e) => updateBody({ username: e.target.value })}
              placeholder="user@example.com"
              disabled={locked}
              autoComplete="off"
              className={fieldClass}
            />
            <VaultFieldAction kind="copy"
              onClick={() => copy(data.username, 'username')}
              active={copied === 'username'}
              title={t('loginForm.copyUsername')}
            />
          </div>
        </div>

        {/* Password */}
        <div>
          <FieldLabel icon={<Lock />}>{t('loginForm.passwordLabel')}</FieldLabel>
          <div className="flex gap-1.5">
            <PasswordField
              value={data.password}
              onChange={(e) => updateBody({ password: e.target.value })}
              revealed={showPassword}
              disabled={locked}
              placeholder={t('loginForm.passwordPlaceholder')}
              fieldClass={fieldClass}
            />
            <VaultFieldAction kind="reveal" active={showPassword} title={showPassword ? t('loginForm.hidePassword') : t('loginForm.showPassword')} onClick={() => setShowPassword(!showPassword)} />
            <VaultFieldAction kind="copy"
              onClick={() => copy(data.password, 'password')}
              active={copied === 'password'}
              title={t('loginForm.copyPassword')}
            />
          </div>
          {!locked && (
            <Button action="generate" onClick={() => setShowGenerator(true)} className="mt-2">
              {t('loginForm.generatePassword')}
            </Button>
          )}
          {showGenerator && (
            <PasswordGeneratorModal
              isPro={isPro}
              onOpenUpgrade={() => onOpenUpgrade('passphrase')}
              onGenerate={(pw) => {
                updateBody({ password: pw });
                setShowGenerator(false);
                setShowPassword(true);
              }}
              onClose={() => setShowGenerator(false)}
            />
          )}
        </div>

        {/* Authenticator key (TOTP) - the key itself is never masked or
            gated; only the generated code (below) is a Pro feature. */}
        <div>
          <FieldLabel icon={<Shield />}>{t('loginForm.totpLabel')}</FieldLabel>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={data.totp}
              onChange={(e) => updateBody({ totp: e.target.value })}
              placeholder={t('loginForm.totpPlaceholder')}
              disabled={locked}
              autoComplete="off"
              spellCheck={false}
              className={`${fieldClass} font-mono`}
            />
            <VaultFieldAction kind="copy"
              onClick={() => copy(data.totp, 'totp')}
              active={copied === 'totp'}
              title={t('loginForm.copyTotp')}
            />
          </div>
          {data.totp.trim() && !totpParams && (
            <p className="mt-1 text-meta text-warning">{t('loginForm.totpInvalid')}</p>
          )}
          {totpParams && totpUnlocked && totpCode && totpSecondsLeft !== null && (
            <p className="mt-1 text-meta text-pn-muted flex items-center gap-1.5">
              <span dir="ltr" className="font-mono text-pn-soft tabular-nums" /* rtl-ok: generated digits, must not reorder */>
                {totpCode}
              </span>
              <span className="tabular-nums">· {t('loginForm.totpExpiresIn', { seconds: totpSecondsLeft })}</span>
            </p>
          )}
          {totpParams && !totpUnlocked && (
            <p className="mt-1 text-meta text-pn-muted">{t('loginForm.totpProNote')}</p>
          )}
        </div>

        {/* Website / URL - after the credentials, the same order the view
            shows: the title names the site, so the address is a detail. */}
        <div>
          <FieldLabel icon={<Globe />}>{t('loginForm.websiteLabel')}</FieldLabel>
          <div className="flex gap-1.5">
            <input
              ref={urlRef}
              type="url"
              value={data.url}
              onChange={(e) => handleUrlChange(e.target.value)}
              onBlur={handleUrlBlur}
              placeholder="https://github.com"
              disabled={locked}
              autoComplete="off"
              className={fieldClass}
            />
            <VaultFieldAction kind="copy"
              onClick={() => copy(data.url, 'url')}
              active={copied === 'url'}
              title={t('shell:contextMenu.copyBookmarkUrl')}
            />
          </div>
          {urlHint && (
            <p className="mt-1 text-meta text-warning">{urlHint}</p>
          )}
          {extras.extraUrls.map((url, i) => (
            <div key={i} className="flex gap-1.5 mt-1.5">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrls(extras.extraUrls.map((u, j) => (j === i ? e.target.value : u)))}
                placeholder="https://"
                disabled={locked}
                autoComplete="off"
                aria-label={t('loginForm.websiteLabel')}
                className={fieldClass}
              />
              <VaultFieldAction kind="copy" onClick={() => copy(url, `url-${i}`)} active={copied === `url-${i}`} title={t('shell:contextMenu.copyBookmarkUrl')} />
              {!locked && (
                <HoverLabel label={t('loginForm.removeWebsite')} position="start">
                  <button type="button" onClick={() => setUrls(extras.extraUrls.filter((_, j) => j !== i))} aria-label={t('loginForm.removeWebsite')} className={FIELD_BUTTON}>
                    <Trash />
                  </button>
                </HoverLabel>
              )}
            </div>
          ))}
          {!locked && (
            <button
              type="button"
              onClick={() => setUrls([...extras.extraUrls, ''])}
              className="inline-flex items-center gap-1 mt-1 text-meta text-accent-strong bg-accent/8 hover:bg-accent/15 px-2 py-0.5 rounded-full transition"
            >
              <Plus />
              {t('shell:contacts.addWebsite')}
            </button>
          )}
        </div>

        {/* Custom fields - a name and a value each. A hidden field is masked
            and never searchable; a text field is both visible and searchable. */}
        {(extras.fields.length > 0 || !locked) && (
          <div>
            <FieldLabel icon={<Tag />}>{t('loginForm.customFieldsLabel')}</FieldLabel>
            <div className="space-y-2">
              {extras.fields.map((f) => (
                <CustomFieldEditor
                  key={f.id}
                  field={f}
                  types={LOGIN_FIELD_TYPES}
                  locked={locked}
                  onChange={(patch) => patchField(f.id, patch)}
                  onRemove={() => setFields(extras.fields.filter((x) => x.id !== f.id))}
                  copy={copy}
                  copied={copied}
                />
              ))}
            </div>
            {!locked && (
              <button
                type="button"
                onClick={() => setFields([...extras.fields, newLoginField('text')])}
                className="inline-flex items-center gap-1 mt-1.5 text-meta text-accent-strong bg-accent/8 hover:bg-accent/15 px-2 py-0.5 rounded-full transition"
              >
                <Plus />
                {t('shell:contacts.addField')}
              </button>
            )}
            {extras.fields.some((f) => f.type === 'text') && (
              <p className="mt-1 text-meta text-pn-muted">{t('loginForm.textFieldSearchable')}</p>
            )}
          </div>
        )}

        {/* Notes */}
        <NotesField
          label={t('common:cardForm.notes')}
          value={data.notes}
          onChange={(notes) => updateBody({ notes })}
          placeholder={t('common:cardForm.notesPlaceholder')}
          disabled={locked}
        />

        {/* PIN-protect toggle */}
        <label className={`flex items-center gap-2 pt-2 border-t border-divider ${!pinConfigured && !pinProtected ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
          <input
            type="checkbox"
            checked={pinProtected}
            onChange={(e) => onPinProtectedChange(noteId, e.target.checked)}
            // Read-only locks CONTENT, not protection: toggling the PIN gate
            // changes no data, so it stays available on a locked item.
            disabled={!pinConfigured && !pinProtected}
            className="rounded accent-accent"
          />
          <span className="text-body text-pn-muted">
            {t('common:cardForm.requirePin')}
          </span>
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
          <p className="text-meta text-pn-muted -mt-2">
            {t('common:cardForm.setUpPinFirst')}
          </p>
        )}

        <VaultFormActions locked={locked} isNew={isNew} saveError={saveError} onSave={onSave} onCancel={onCancel} />
      </div>
    </div>
  );
}
