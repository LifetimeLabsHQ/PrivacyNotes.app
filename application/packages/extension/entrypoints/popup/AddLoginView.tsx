/**
 * Add a login: the Vault's own fields and parts. Name and website come from
 * the page; the username offers the ones this account already uses; the
 * password has show, copy and the full generator; the 2FA key is checked as
 * it is typed; notes go with it. A login the site already has under the same
 * username is pointed out before it is saved twice. Save seals it into the
 * inbox, and the app adds it to the Vault at its next sync. Save says Saved
 * for a moment, then the footer says where the login went (pattern 177).
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, Add login)
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { parseTotpInput } from '@notes/shared';
import type { LoginCopyEntry } from '@notes/shared/extension';
import { FloppyDisk, Globe, Lock, NotePencil, Shield, Tag, User } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Callout } from '@web/ui/feedback';
import { VaultFieldAction } from '@web/ui/VaultFieldAction';
import { FIELD_CLASS, FieldLabel } from '@web/formFields';
import { PasswordField } from '@web/PasswordText';
import { SETTINGS_HELP } from '@web/settingsUI';
import { copyAndClear } from '../../src/copy';
import { displayHost } from '../../src/favicon';
import { matchLogins } from '../../src/match';
import type { SaveResult } from '../../src/save';
import type { Notice } from './Footer';
import { GeneratorView } from './GeneratorView';
import { DONE_HOLD_MS, SaveButton } from './SaveButton';
import { SheetHeader } from './Sheet';

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

/** The usernames this account uses, the most used first. */
function knownUsernames(logins: LoginCopyEntry[]): string[] {
  const count = new Map<string, number>();
  for (const l of logins) if (l.username) count.set(l.username, (count.get(l.username) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1]).map(([name]) => name).slice(0, 20);
}

export function AddLoginView({ url, logins, pro, onDone }: {
  url: string;
  logins: LoginCopyEntry[];
  pro: boolean;
  /** Back to the popup, with the footer message of a save. */
  onDone: (notice: Notice | null) => void;
}) {
  const { t } = useTranslation('extension');
  const [name, setName] = useState(displayHost(url));
  const [site, setSite] = useState(originOf(url));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [totp, setTotp] = useState('');
  const [notes, setNotes] = useState('');
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usernames = useMemo(() => knownUsernames(logins), [logins]);
  const twin = username.trim() !== '' && matchLogins(logins, site || url).some((l) => l.username.trim().toLowerCase() === username.trim().toLowerCase());
  const totpBad = totp.trim() !== '' && !parseTotpInput(totp);

  const save = async () => {
    setBusy(true);
    setError(null);
    const request = { name: name.trim(), url: originOf(site.trim()) || (site.trim() ? `https://${site.trim()}` : ''), username, password, totp: totp.trim(), notes };
    const result = (await browser.runtime.sendMessage({ type: 'saveLogin', request })) as SaveResult | null;
    setBusy(false);
    if (result && (result.state === 'sent' || result.state === 'queued')) {
      // Save says Saved for a moment, then the sheet closes and the footer says where it went.
      setDone(true);
      const sent = result.state === 'sent';
      window.setTimeout(() => onDone(sent
        ? { title: t('notice.loginSaved'), detail: t('notice.vaultNextSync') }
        : { tone: 'info', title: t('notice.savedHere'), detail: t('notice.goesOutOnline') }), DONE_HOLD_MS);
      return;
    }
    setError(result?.state === 'full' ? t('clip.queueFull') : t('clip.failed'));
  };

  if (generating) {
    return (
      <>
        <SheetHeader title={t('auth:loginForm.generatePassword')} onBack={() => setGenerating(false)} />
        <GeneratorView
          onGenerate={(value) => {
            setPassword(value);
            setReveal(true);
            setGenerating(false);
          }}
        />
      </>
    );
  }

  return (
    <form
      className="space-y-3 p-3 pt-0 [&>header]:-mx-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && !done && (username || password) && !totpBad) void save();
      }}
    >
      <SheetHeader title={t('menu.addLogin')} onBack={() => onDone(null)} />
      <div>
        <FieldLabel icon={<Tag />} htmlFor="pn-name">{t('shell:vaultItem.fieldName')}</FieldLabel>
        <input id="pn-name" value={name} onChange={(e) => setName(e.target.value)} className={FIELD_CLASS} dir="auto" />
      </div>
      <div>
        <FieldLabel icon={<Globe />} htmlFor="pn-site">{t('auth:loginForm.websiteLabel')}</FieldLabel>
        <input id="pn-site" value={site} onChange={(e) => setSite(e.target.value)} className={FIELD_CLASS} dir="ltr" inputMode="url" />
      </div>
      <div>
        <FieldLabel icon={<User />} htmlFor="pn-username">{t('auth:loginForm.usernameLabel')}</FieldLabel>
        <input
          id="pn-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          list="pn-usernames"
          autoComplete="off"
          autoFocus
          className={FIELD_CLASS}
          dir="auto"
        />
        <datalist id="pn-usernames">
          {usernames.map((u) => <option key={u} value={u} />)}
        </datalist>
      </div>
      {twin && <Callout look="card" tone="warning">{t('logins.duplicate')}</Callout>}
      <div>
        <FieldLabel icon={<Lock />} htmlFor="pn-password">{t('auth:loginForm.passwordLabel')}</FieldLabel>
        <div className="flex gap-1.5">
          <PasswordField
            id="pn-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            revealed={reveal}
            placeholder={t('auth:loginForm.passwordPlaceholder')}
            fieldClass={FIELD_CLASS}
          />
          <VaultFieldAction kind="reveal" active={reveal} title={reveal ? t('auth:loginForm.hidePassword') : t('auth:loginForm.showPassword')} onClick={() => setReveal(!reveal)} />
          <VaultFieldAction
            kind="copy"
            active={copied}
            title={t('auth:loginForm.copyPassword')}
            onClick={() => {
              if (password) void copyAndClear(password).then((ok) => setCopied(ok));
            }}
          />
        </div>
        <Button action="generate" onClick={() => setGenerating(true)} className="mt-2">
          {t('auth:loginForm.generatePassword')}
        </Button>
      </div>
      <div>
        <FieldLabel icon={<Shield />} htmlFor="pn-totp">{t('auth:loginForm.totpLabel')}</FieldLabel>
        <input
          id="pn-totp"
          value={totp}
          onChange={(e) => setTotp(e.target.value)}
          placeholder={t('auth:loginForm.totpPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          className={`${FIELD_CLASS} font-mono`}
          dir="ltr"
        />
        {totpBad ? (
          <p className="mt-1 text-small text-danger">{t('auth:loginForm.totpInvalid')}</p>
        ) : totp.trim() && !pro ? (
          <p className={`mt-1 ${SETTINGS_HELP}`}>{t('auth:loginForm.totpProNote')}</p>
        ) : null}
      </div>
      <div>
        <FieldLabel icon={<NotePencil />} htmlFor="pn-notes">{t('common:cardForm.notes')}</FieldLabel>
        <textarea id="pn-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${FIELD_CLASS} resize-y`} dir="auto" />
      </div>
      {error && <Callout look="card" tone="danger">{error}</Callout>}
      <div className="grid grid-cols-2 gap-2">
        <Button action="cancel" onClick={() => onDone(null)} disabled={busy || done} />
        <SaveButton
          type="submit"
          variant="primary"
          state={done ? 'done' : busy ? 'busy' : 'idle'}
          disabled={(!username && !password) || totpBad}
          icon={<FloppyDisk aria-hidden="true" />}
          label={t('common:actions.save')}
          busyLabel={t('common:state.saving')}
          doneLabel={t('shell:checkIn.saved')}
        />
      </div>
    </form>
  );
}
