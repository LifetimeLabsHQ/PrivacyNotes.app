import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalNote } from './db';
import { LoginForm, parseLoginBody, domainFromUrl } from './LoginForm';
import { CardForm, parseCardBody, detectCardNetwork } from './CardForm';
import { SshKeyForm, parseSshKeyBody } from './SshKeyForm';
import { VAULT_EMPTY_BODIES } from './notesViewUtils';
import { faviconUrl, domainFromUrlString } from './favicon';
import { prefetchFavicon } from './faviconQueue';
import { HoverLabel } from './HoverLabel';
import { exemptOpts } from './i18nExempt';
import { Copy, Check, Download, Eye, EyeSlash, ArrowSquareOut, X, Key, CreditCard, Lock, Globe, User, Calendar, MapPin, Tag, Shield, RocketLaunch } from './icons';
import { openExternal } from './openExternal';
import { DETAIL_COLUMN, DetailAction, DetailCopyAction, DetailHero, DetailLink, DetailNotes, DetailRow, DetailTile } from './detailPane';
import { useCopyToClipboard } from './clipboard';
import { useFavicons } from './theme';
import { parseTotpInput, generateTotpCode, totpSecondsRemaining } from '@notes/shared';
import { proUnlocked } from './demo';
import { PasswordText } from './PasswordText';
import { hasLoginExtras, isPublicField, loginExtrasOf, webHref, withLoginExtras, type LoginExtras, type LoginField } from './loginExtras';
import type { UpgradeTrigger } from './UpgradeModal';
import { mergeVaultDraft } from './vaultBody';
import { saveFailureText } from './saveFile';
import { TotpRing, groupTotpCode } from './TotpRing';

// Own chunk: it brings the editor's file chip, which only an item's Files section needs.
const VaultFiles = lazy(() => import('./VaultFiles'));


const IconX = () => <X />;
const IconSave = () => <Check />;

/* ────────────────────────────────────────────────────────────────
 * Favicon image with concurrency-throttled loading + IndexedDB cache.
 *
 * Uses IntersectionObserver to detect visibility, then calls
 * prefetchFavicon which checks IndexedDB first (instant, offline-
 * capable), falls back to a queued network fetch (max 5 concurrent),
 * and stores the result in IndexedDB for future sessions.
 *
 * Spec: docs/internal/backlog.md (#69 - client concurrency cap + IDB cache)
 * ──────────────────────────────────────────────────────────────── */
function Favicon({ domain, size = 20, onMissing }: { domain: string; size?: number; onMissing?: (missing: boolean) => void }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const favicons = useFavicons();
  const url = domain && favicons ? faviconUrl(domain) : '';

  useEffect(() => {
    setSrc('');
    setFailed(false);
    if (!url) return;

    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting || cancelled) return;
        observer.disconnect();
        prefetchFavicon(url).then(blobUrl => {
          if (cancelled) return;
          if (blobUrl) setSrc(blobUrl);
          else setFailed(true);
        });
      },
      { rootMargin: '200px' },
    );

    observer.observe(el);
    return () => { cancelled = true; observer.disconnect(); };
  }, [url]);

  // Tell a chip that wraps this box when there is no icon to show (no
  // domain, favicons off, a failed fetch, the demo's offline mode), so it can
  // draw its own themed placeholder instead of the grey globe on a light tile.
  const missing = !url || failed;
  useEffect(() => {
    onMissing?.(missing);
  }, [missing, onMissing]);

  // ONE box in every state - icon, still loading, globe fallback - and the
  // observed element is that box, so the ref NEVER detaches. The <img> used
  // to replace the ref'd span outright, which made React null the ref: after
  // that, a domain change (editing a bookmark's URL) found no element to
  // observe, started no fetch, and the surface kept the old icon until it
  // happened to remount. That is why switching pillars "fixed" it.
  return (
    <span
      ref={containerRef}
      // theme-ok: a light tile keeps dark favicons readable in every theme
      className="inline-flex items-center justify-center rounded bg-[#f0efec] text-neutral-500 overflow-hidden"
      style={{ width: size, height: size }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          style={{ width: size, height: size }}
          onError={() => setFailed(true)}
        />
      ) : !url || failed ? (
        <Globe size={size} />
      ) : null}
    </span>
  );
}

/** The login's tile in its detail view: the site icon on the light tile, or,
 *  while there is none, a lock on the themed tile the card and SSH key views
 *  use, as the list row does. The Favicon stays mounted (hidden) so it can
 *  still load and report back. */
function LoginTile({ domain }: { domain: string }) {
  const [missing, setMissing] = useState(false);
  const onMissing = useCallback((m: boolean) => setMissing(m), []);
  return (
    <DetailTile light={!missing}>
      <span className={missing ? 'hidden' : 'contents'}>
        <Favicon domain={domain} size={32} onMissing={onMissing} />
      </span>
      {missing && <Lock size={24} />}
    </DetailTile>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Type badge - small colored pill showing the vault item type
 * ──────────────────────────────────────────────────────────────── */
function TypeBadge({ type }: { type: 'login' | 'card' | 'ssh-key' }) {
  const { t } = useTranslation('shell');
  const cfg = {
    login: { label: t('vaultItem.badgeLogin'), bg: 'bg-blue-50 dark:bg-blue-950/50', text: 'text-blue-700 dark:text-blue-300', icon: (
      <Lock size={10} />
    )},
    card: { label: t('vaultItem.badgeCard'), bg: 'bg-amber-50 dark:bg-amber-950/50', text: 'text-amber-700 dark:text-amber-300', icon: (
      <CreditCard size={10} />
    )},
    // theme-ok: each kind badge keeps its own fixed color
    'ssh-key': { label: t('vaultItem.badgeSshKey', exemptOpts('shell:vaultItem.badgeSshKey')), bg: 'bg-neutral-900 dark:bg-neutral-800', text: 'text-white', icon: (
      <Key size={10} />
    )},
  }[type];

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-meta font-medium ${cfg.bg} ${cfg.text}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────
 * TOTP code row - shown under the password field for a login that
 * has an authenticator key set. The key is stored and synced for
 * every tier (LoginData.totp); only the generated code is gated.
 * ──────────────────────────────────────────────────────────────── */
// Spec: docs/internal/pro-features.md (TOTP code display Pro gate)
function TotpField({ raw, isPro, onOpenUpgrade, copy, copied }: {
  raw: string;
  isPro: boolean | null;
  onOpenUpgrade: (trigger: UpgradeTrigger) => void;
  copy: (text: string, label: string) => void;
  copied: string | null;
}) {
  const { t } = useTranslation('shell');
  const params = useMemo(() => parseTotpInput(raw), [raw]);
  const unlocked = proUnlocked(isPro);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!params || !unlocked) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [params, unlocked]);

  if (!params) {
    return (
      <DetailRow label={t('security:mfaPrompt.codeLabel')} icon={<Shield />}>
        <span className="text-pn-muted italic">{t('vaultItem.totpInvalid')}</span>
      </DetailRow>
    );
  }

  const label = (
    <span className="flex items-center gap-1.5">
      {t('security:mfaPrompt.codeLabel')}
      {!isPro && <RocketLaunch size={11} weight="fill" className="text-pro" />}
    </span>
  );

  if (!unlocked) {
    return (
      <div className="border-b border-divider last:border-b-0">
        <DetailRow label={label} icon={<Shield />}>
          <span className="inline-flex items-center gap-2">
            <span dir="ltr" className="font-mono tracking-wider text-pn-muted" /* rtl-ok: masked code placeholder, symbols only, must not reorder */>
              {'••• •••'}
            </span>
            <TotpRing secondsLeft={params.period} period={params.period} danger={false} static />
          </span>
        </DetailRow>
        <button
          type="button"
          onClick={() => onOpenUpgrade('totp')}
          className="mb-2 w-full py-1.5 rounded-md text-small font-medium bg-accent/8 text-accent-strong hover:bg-accent/15 transition"
        >
          {t('vaultItem.totpUnlockCta')}
        </button>
        <p className="mb-2 text-meta text-pn-muted">{t('vaultItem.totpProNote')}</p>
      </div>
    );
  }

  const code = generateTotpCode(params, now);
  const secondsLeft = totpSecondsRemaining(params.period, now);

  return (
    <DetailRow
      label={label}
      icon={<Shield />}
      actions={<DetailCopyAction value={code} id="totpCode" copied={copied} onCopy={copy} label={copied === 'totpCode' ? t('vaultItem.copied') : t('vaultItem.copyCode')} />}
    >
      <span className="inline-flex items-center gap-2">
        <span dir="ltr" className="font-mono tracking-wider tabular-nums" /* rtl-ok: generated digits, must not reorder */>
          {groupTotpCode(code)}
        </span>
        <TotpRing secondsLeft={secondsLeft} period={params.period} danger={secondsLeft <= 5} />
      </span>
    </DetailRow>
  );
}

/** The reveal cell a secret row carries. */
function RevealAction({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const { t } = useTranslation('shell');
  return (
    <DetailAction label={shown ? t('common:sshKeyForm.hide') : t('vaultItem.reveal')} onClick={onToggle}>
      {shown ? <EyeSlash /> : <Eye />}
    </DetailAction>
  );
}

/** The copy cell's hover label: "Copied" while this row is the copied one. */
function useCopyTip(copied: string | null) {
  const { t } = useTranslation('shell');
  return (id: string) => (copied === id ? t('vaultItem.copied') : t('vaultItem.copyField', { label: id }));
}

/** An additional website: a link when it is a web address, plain text
 *  otherwise (an app scheme such as `androidapp://`). */
function ExtraUrlRow({ url, id, copy, copied }: {
  url: string;
  id: string;
  copy: (text: string, label: string) => void;
  copied: string | null;
}) {
  const { t } = useTranslation('shell');
  const copyTip = useCopyTip(copied);
  const href = webHref(url);
  const tip = copied === id ? copyTip(id) : copyTip('url');
  return (
    <DetailRow
      label={t('vaultItem.fieldUrl')}
      icon={<Globe />}
      actions={
        <>
          {href && <DetailAction label={t('shell:contacts.open')} onClick={() => openExternal(href)}><ArrowSquareOut /></DetailAction>}
          <DetailCopyAction value={url} id={id} copied={copied} onCopy={copy} label={tip} />
        </>
      }
    >
      {href ? (
        <DetailLink href={href}>{domainFromUrlString(url) || url}</DetailLink>
      ) : (
        <span dir="ltr" className="font-mono text-small break-all" /* rtl-ok: an address, never reordered */>{url}</span>
      )}
    </DetailRow>
  );
}

/** A custom field. Anything but a text field is masked until revealed, and
 *  a masked value is not in the DOM at all. */
function CustomFieldRow({ field, copy, copied }: {
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
  return (
    <DetailRow
      label={<span dir="auto">{name}</span>}
      icon={secret ? <Lock /> : <Tag />}
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

/* ────────────────────────────────────────────────────────────────
 * Login view mode
 * ──────────────────────────────────────────────────────────────── */
function LoginViewMode({ note, onEdit, copy, copied, isPro, onOpenUpgrade, files }: {
  note: LocalNote;
  onEdit: () => void;
  /** The item's Files section, drawn last. */
  files: React.ReactNode;
  copy: (text: string, label: string) => void;
  copied: string | null;
  isPro: boolean | null;
  onOpenUpgrade: (trigger: UpgradeTrigger) => void;
}) {
  const { t } = useTranslation('shell');
  const data = parseLoginBody(note.body);
  const extras = loginExtrasOf(note.trackers);
  const [showPassword, setShowPassword] = useState(false);
  const domain = domainFromUrlString(data.url);
  const fullUrl = data.url.trim() && !/^https?:\/\//i.test(data.url.trim())
    ? 'https://' + data.url.trim()
    : data.url.trim();
  const copyTip = useCopyTip(copied);

  return (
    <div className={`flex-1 p-6 ${DETAIL_COLUMN}`}>
      <DetailHero
        tile={<LoginTile domain={domain} />}
        title={note.title || t('vaultItem.untitledLogin')}
        subtitle={<TypeBadge type="login" />}
        onEdit={onEdit}
        editLabel={t('common:actions.edit')}
      />

      <div className="mt-3">
        {data.username && (
          <DetailRow label={t('vaultItem.fieldUser')} icon={<User />} actions={<DetailCopyAction value={data.username} id="username" copied={copied} onCopy={copy} label={copyTip('username')} />}>
            <span className="break-all">{data.username}</span>
          </DetailRow>
        )}

        {data.password && (
          <DetailRow
            label={t('vaultItem.fieldPass')}
            icon={<Lock />}
            actions={
              <>
                <RevealAction shown={showPassword} onToggle={() => setShowPassword(!showPassword)} />
                <DetailCopyAction value={data.password} id="password" copied={copied} onCopy={copy} label={copyTip('password')} />
              </>
            }
          >
            <span dir="ltr" className="font-mono tracking-wider break-all" /* rtl-ok: a secret is a code, never reordered */>
              {showPassword ? <PasswordText value={data.password} /> : '•'.repeat(Math.min(data.password.length, 16))}
            </span>
          </DetailRow>
        )}

        {data.totp.trim() && (
          <TotpField raw={data.totp} isPro={isPro} onOpenUpgrade={onOpenUpgrade} copy={copy} copied={copied} />
        )}

        {/* The address comes after the credentials: the hero already names
            the site, so this row is a detail rather than the headline. */}
        {data.url && (
          <DetailRow
            label={t('vaultItem.fieldUrl')}
            icon={<Globe />}
            actions={
              <>
                <DetailAction label={t('shell:contacts.open')} onClick={() => openExternal(fullUrl)}><ArrowSquareOut /></DetailAction>
                <DetailCopyAction value={data.url} id="url" copied={copied} onCopy={copy} label={copyTip('url')} />
              </>
            }
          >
            <DetailLink href={fullUrl}>{domain || data.url}</DetailLink>
          </DetailRow>
        )}

        {extras.extraUrls.map((url, i) => (
          <ExtraUrlRow key={`${i}-${url}`} url={url} id={`url-${i}`} copy={copy} copied={copied} />
        ))}

        {extras.fields.map((f) => (
          <CustomFieldRow key={f.id} field={f} copy={copy} copied={copied} />
        ))}
      </div>

      {/* Copy all button - only when there's something meaningful to copy.
          Lines follow the row order above. */}
      {(data.url || data.username || data.password) && (
        <button
          type="button"
          onClick={() => {
            const lines: string[] = [];
            if (data.username) lines.push(data.username);
            if (data.password) lines.push(data.password);
            if (data.url) lines.push(data.url.trim());
            copy(lines.join('\n'), 'all');
          }}
          className="mt-3 w-full py-2 rounded-lg text-small font-medium text-pn-muted border border-divider hover:bg-pn/5 transition flex items-center justify-center gap-1.5"
        >
          {copied === 'all' ? <Check className="text-green-500" /> : <Copy />}
          {copied === 'all' ? t('vaultItem.copied') : t('vaultItem.copyAll')}
        </button>
      )}

      {data.notes && <DetailNotes heading={t('common:cardForm.notes')} markdown>{data.notes}</DetailNotes>}
      {files}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Card view mode
 * ──────────────────────────────────────────────────────────────── */
function CardViewMode({ note, onEdit, copy, copied, files }: {
  note: LocalNote;
  onEdit: () => void;
  /** The item's Files section, drawn last. */
  files: React.ReactNode;
  copy: (text: string, label: string) => void;
  copied: string | null;
}) {
  const { t } = useTranslation('shell');
  const data = parseCardBody(note.body);
  const [showNumber, setShowNumber] = useState(false);
  const [showCvv, setShowCvv] = useState(false);
  const digits = data.cardNumber.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  const network = detectCardNetwork(digits);
  const masked = digits.length > 4
    ? '•••• '.repeat(Math.floor((digits.length - 4) / 4)) + last4
    : digits;
  const formatted = digits.replace(/(.{4})/g, '$1 ').trim();
  const copyTip = useCopyTip(copied);

  return (
    <div className={`flex-1 overflow-y-auto p-6 ${DETAIL_COLUMN}`}>
      <DetailHero
        tile={<DetailTile><CreditCard size={24} /></DetailTile>}
        title={note.title || t('vaultItem.untitledCard')}
        subtitle={<TypeBadge type="card" />}
        onEdit={onEdit}
        editLabel={t('common:actions.edit')}
      />

      <div className="mt-3">
        {data.cardholderName && (
          <DetailRow label={t('vaultItem.fieldName')} icon={<User />} actions={<DetailCopyAction value={data.cardholderName} id="name" copied={copied} onCopy={copy} label={copyTip('name')} />}>
            {data.cardholderName}
          </DetailRow>
        )}

        {digits && (
          <DetailRow
            label={t('vaultItem.fieldNumber')}
            icon={<CreditCard />}
            actions={
              <>
                <RevealAction shown={showNumber} onToggle={() => setShowNumber(!showNumber)} />
                <DetailCopyAction value={digits} id="number" copied={copied} onCopy={copy} label={copyTip('number')} />
              </>
            }
          >
            <span className="inline-flex items-center gap-2 min-w-0">
              <span dir="ltr" className="font-mono tracking-wider break-all" /* rtl-ok: digits, never reordered */>
                {showNumber ? formatted : masked}
              </span>
              {network && <span className="text-meta text-pn-muted shrink-0">{network}</span>}
            </span>
          </DetailRow>
        )}

        {(data.expMonth || data.expYear) && (
          <DetailRow label={t('vaultItem.fieldExpires')} icon={<Calendar />} actions={<DetailCopyAction value={`${data.expMonth}/${data.expYear}`} id="exp" copied={copied} onCopy={copy} label={copyTip('exp')} />}>
            <span dir="ltr" /* rtl-ok: a month/year pair, never reordered */>{data.expMonth}/{data.expYear}</span>
          </DetailRow>
        )}

        {data.cvv && (
          <DetailRow
            label={t('vaultItem.fieldCvv')}
            icon={<Lock />}
            actions={
              <>
                <RevealAction shown={showCvv} onToggle={() => setShowCvv(!showCvv)} />
                <DetailCopyAction value={data.cvv} id="cvv" copied={copied} onCopy={copy} label={copyTip('cvv')} />
              </>
            }
          >
            <span dir="ltr" className="font-mono tracking-wider" /* rtl-ok: digits, never reordered */>
              {showCvv ? data.cvv : '•'.repeat(data.cvv.length)}
            </span>
          </DetailRow>
        )}

        {data.billingZip && (
          <DetailRow label={t('vaultItem.fieldZip')} icon={<MapPin />} actions={<DetailCopyAction value={data.billingZip} id="zip" copied={copied} onCopy={copy} label={copyTip('zip')} />}>
            <span className="break-all">{data.billingZip}</span>
          </DetailRow>
        )}
      </div>

      {data.notes && <DetailNotes heading={t('common:cardForm.notes')} markdown>{data.notes}</DetailNotes>}
      {files}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * SSH Key view mode
 * ──────────────────────────────────────────────────────────────── */
function SshKeyViewMode({ note, onEdit, copy, copied, files }: {
  note: LocalNote;
  onEdit: () => void;
  /** The item's Files section, drawn last. */
  files: React.ReactNode;
  copy: (text: string, label: string) => void;
  copied: string | null;
}) {
  const { t } = useTranslation('shell');
  const data = parseSshKeyBody(note.body);
  const [showPrivate, setShowPrivate] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const copyTip = useCopyTip(copied);

  const download = async (which: 'private' | 'public') => {
    setDownloadError(null);
    const { downloadSshKey } = await import('./sshKeyFile');
    const saved = await downloadSshKey(which, data);
    if (!saved.ok && saved.reason === 'failed') setDownloadError(saveFailureText(saved, t('common:sshKeyForm.downloadFailed')));
  };

  // Truncate public key for display.
  const pubShort = data.publicKey.length > 40
    ? data.publicKey.slice(0, 20) + '...' + data.publicKey.slice(-15)
    : data.publicKey;

  return (
    <div className={`flex-1 overflow-y-auto p-6 ${DETAIL_COLUMN}`}>
      <DetailHero
        tile={<DetailTile><Key size={24} /></DetailTile>}
        title={note.title || t('vaultItem.untitledKey')}
        subtitle={<TypeBadge type="ssh-key" />}
        onEdit={onEdit}
        editLabel={t('common:actions.edit')}
      />

      <div className="mt-3">
        {data.label && (
          <DetailRow label={t('vaultItem.fieldLabel')} icon={<Tag />}>
            <span className="break-all">{data.label}</span>
          </DetailRow>
        )}

        {data.publicKey && (
          <DetailRow label={t('vaultItem.fieldPublic')} icon={<Key />} actions={
            <>
              <DetailCopyAction value={data.publicKey} id="publicKey" copied={copied} onCopy={copy} label={copyTip('publicKey')} />
              <DetailAction label={t('common:sshKeyForm.downloadPublicKey')} onClick={() => void download('public')}>
                <Download />
              </DetailAction>
            </>
          }>
            <span dir="ltr" className="font-mono text-small text-pn-muted break-all" /* rtl-ok: a key, never reordered */>{pubShort}</span>
          </DetailRow>
        )}

        {data.privateKey && (
          <DetailRow
            label={t('vaultItem.fieldPrivate')}
            icon={<Lock />}
            actions={
              <>
                <RevealAction shown={showPrivate} onToggle={() => setShowPrivate(!showPrivate)} />
                <DetailCopyAction value={data.privateKey} id="privateKey" copied={copied} onCopy={copy} label={copyTip('privateKey')} />
                <DetailAction label={t('common:sshKeyForm.downloadPrivateKey')} onClick={() => void download('private')}>
                  <Download />
                </DetailAction>
              </>
            }
          >
            <span dir="ltr" className="font-mono tracking-wider break-all" /* rtl-ok: a key, never reordered */>
              {showPrivate ? data.privateKey.slice(0, 30) + '...' : '•'.repeat(16)}
            </span>
          </DetailRow>
        )}
        {data.privateKey && (
          <p className="text-meta text-pn-muted mt-2">{t('common:sshKeyForm.downloadHint')}</p>
        )}
        {downloadError && (
          <p className="text-meta text-danger mt-1">{downloadError}</p>
        )}

        {data.passphrase && (
          <DetailRow
            label={t('vaultItem.fieldPass')}
            icon={<Shield />}
            actions={
              <>
                <RevealAction shown={showPassphrase} onToggle={() => setShowPassphrase(!showPassphrase)} />
                <DetailCopyAction value={data.passphrase} id="passphrase" copied={copied} onCopy={copy} label={copyTip('passphrase')} />
              </>
            }
          >
            <span dir="ltr" className="font-mono tracking-wider break-all" /* rtl-ok: a secret is a code, never reordered */>
              {showPassphrase ? <PasswordText value={data.passphrase} /> : '•'.repeat(Math.min(data.passphrase.length, 12))}
            </span>
          </DetailRow>
        )}
      </div>

      {data.notes && <DetailNotes heading={t('common:cardForm.notes')} markdown>{data.notes}</DetailNotes>}
      {files}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 * Detect whether a vault body is "empty" (freshly created).
 * ──────────────────────────────────────────────────────────────── */
function isEmptyVaultBody(body: string, type: string): boolean {
  const empty = VAULT_EMPTY_BODIES[type];
  if (!empty) return false;
  return body === empty;
}

/* ────────────────────────────────────────────────────────────────
 * VaultItem - wrapper that manages view/edit lifecycle.
 *
 * New items (empty body) start in edit mode. After Save, the item
 * locks into a read-only view with copy buttons and clickable URLs.
 * An Edit button unlocks the form again.
 *
 * During edit mode, changes are buffered locally and only committed
 * to the note store on Save. Cancel reverts to the last saved state.
 * ──────────────────────────────────────────────────────────────── */
export interface VaultItemProps {
  note: LocalNote;
  isTrash: boolean;
  onTitleChange: (id: string, title: string) => void;
  /** Commit the form: the body, and for a login the tracker map carrying its
   *  custom fields and extra websites. Resolves false when refused. */
  onSave: (id: string, body: string, trackers?: Record<string, unknown>) => Promise<boolean>;
  onPinProtectedChange: (id: string, value: boolean) => void;
  /** Drives the TOTP code Pro gate (behavior only - the badge stays on
   *  plain !isPro so demo keeps advertising the feature it unlocks). */
  isPro: boolean | null;
  onOpenUpgrade: (trigger: UpgradeTrigger) => void;
}

export function VaultItem({
  note,
  isTrash,
  onTitleChange,
  onSave,
  onPinProtectedChange,
  isPro,
  onOpenUpgrade,
}: VaultItemProps) {
  const { t } = useTranslation('shell');
  const isNew = isEmptyVaultBody(note.body, note.type) && !hasLoginExtras(loginExtrasOf(note.trackers));
  const [editing, setEditing] = useState(isNew);
  // Title is NOT buffered here: the note title bar (NotesView header) is the
  // canonical title input and writes note.title live, like every other note
  // type. Buffering a draftTitle here let a stale copy clobber the live title
  // on Save (bug #136). The form's auto-derive uses the live onTitleChange.
  const [draftBody, setDraftBody] = useState(note.body);
  const [draftExtras, setDraftExtras] = useState<LoginExtras>(() => loginExtrasOf(note.trackers));
  const [saving, setSaving] = useState(false);
  // PIN-protect lives in draft state too - committing it immediately
  // (via the parent's setPinProtected) flips `isNoteLocked` to true,
  // which unmounts VaultItem and discards unsaved draftTitle/draftBody
  // when the user falls outside the PIN unlock window. See changelog
  // entry for 0.156.4.
  const [draftPinProtected, setDraftPinProtected] = useState(note.pinProtected === 1);
  const { copy, copied } = useCopyToClipboard();
  const [saveError, setSaveError] = useState('');
  // The stored item the form opened on. Save merges the draft against it, so
  // a field another device changed meanwhile is not written back over.
  const baseBodyRef = useRef(note.body);
  const baseExtrasRef = useRef(JSON.stringify(loginExtrasOf(note.trackers)));

  // Sync draft when the note changes externally (e.g. sync from another device).
  useEffect(() => {
    if (!editing) {
      baseBodyRef.current = note.body;
      baseExtrasRef.current = JSON.stringify(loginExtrasOf(note.trackers));
      setDraftBody(note.body);
      setDraftExtras(loginExtrasOf(note.trackers));
      setDraftPinProtected(note.pinProtected === 1);
    }
  }, [note.body, note.trackers, note.pinProtected, editing]);

  // When selecting a new note, reset editing state.
  useEffect(() => {
    const empty = isEmptyVaultBody(note.body, note.type) && !hasLoginExtras(loginExtrasOf(note.trackers));
    setEditing(empty);
    baseBodyRef.current = note.body;
    baseExtrasRef.current = JSON.stringify(loginExtrasOf(note.trackers));
    setDraftBody(note.body);
    setDraftExtras(loginExtrasOf(note.trackers));
    setDraftPinProtected(note.pinProtected === 1);
    setSaveError('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  /** Check that at least one meaningful field has content. */
  const isBodyEmpty = useMemo(() => {
    const empty = VAULT_EMPTY_BODIES[note.type];
    return empty ? draftBody === empty && !(note.type === 'login' && hasLoginExtras(draftExtras)) : false;
  }, [draftBody, draftExtras, note.type]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    if (isBodyEmpty) {
      setSaveError(t('vaultItem.fillOneField'));
      return;
    }
    // Validate incomplete expiry: both month and year, or neither.
    if (note.type === 'card') {
      const cd = parseCardBody(draftBody);
      if ((cd.expMonth && !cd.expYear) || (!cd.expMonth && cd.expYear)) {
        setSaveError(t('vaultItem.expiryNeedsBoth'));
        return;
      }
    }
    if (note.type === 'login' && draftExtras.fields.some((f) => f.value && !f.label.trim())) {
      setSaveError(t('vaultItem.fieldNeedsName'));
      return;
    }
    setSaveError('');
    // A login's extras go into the latest tracker map, so a key another
    // surface wrote while the form was open is kept.
    const extras = { extraUrls: draftExtras.extraUrls.map((u) => u.trim()).filter(Boolean), fields: draftExtras.fields };
    const extrasChanged = JSON.stringify(draftExtras) !== baseExtrasRef.current;
    const trackers = note.type === 'login' && extrasChanged ? withLoginExtras(note.trackers, extras) : undefined;
    const body = mergeVaultDraft(baseBodyRef.current, draftBody, note.body);
    setSaving(true);
    const ok = await onSave(note.id, body, trackers).catch(() => false);
    setSaving(false);
    if (!ok) {
      setSaveError(t('vaultItem.saveFailed'));
      return;
    }
    if (draftPinProtected !== (note.pinProtected === 1)) {
      onPinProtectedChange(note.id, draftPinProtected);
    }
    setEditing(false);
  }, [saving, note.id, note.type, note.trackers, note.pinProtected, draftBody, draftExtras, draftPinProtected, onSave, onPinProtectedChange, isBodyEmpty, t]);

  const handleCancel = useCallback(() => {
    setDraftBody(note.body);
    setDraftExtras(loginExtrasOf(note.trackers));
    setDraftPinProtected(note.pinProtected === 1);
    setEditing(false);
  }, [note.body, note.trackers, note.pinProtected]);

  const handleEdit = useCallback(() => {
    baseBodyRef.current = note.body;
    baseExtrasRef.current = JSON.stringify(loginExtrasOf(note.trackers));
    setDraftBody(note.body);
    setDraftExtras(loginExtrasOf(note.trackers));
    setDraftPinProtected(note.pinProtected === 1);
    setEditing(true);
  }, [note.body, note.trackers, note.pinProtected]);

  const locked = isTrash || note.locked === 1;

  // ── View mode ────────────────────────────────────────────────
  if (!editing && !isNew) {
    const files = (
      <Suspense fallback={null}>
        <VaultFiles key={note.id} note={note} readOnly={locked} isPro={isPro} onOpenUpgrade={onOpenUpgrade} onSave={(body) => onSave(note.id, body)} />
      </Suspense>
    );
    if (note.type === 'login') {
      return <LoginViewMode note={note} onEdit={handleEdit} copy={copy} copied={copied} isPro={isPro} onOpenUpgrade={onOpenUpgrade} files={files} />;
    }
    if (note.type === 'card') {
      return <CardViewMode note={note} onEdit={handleEdit} copy={copy} copied={copied} files={files} />;
    }
    return <SshKeyViewMode note={note} onEdit={handleEdit} copy={copy} copied={copied} files={files} />;
  }

  // ── Edit mode ────────────────────────────────────────────────
  const formProps = {
    noteId: note.id,
    title: note.title,
    body: draftBody,
    locked,
    pinProtected: draftPinProtected,
    onTitleChange,
    onBodyChange: (_id: string, b: string) => setDraftBody(b),
    onPinProtectedChange: (_id: string, v: boolean) => setDraftPinProtected(v),
    onSave: () => void handleSave(),
    onCancel: handleCancel,
    isNew,
    saveError,
  };
  const loginFormProps = { ...formProps, isPro, onOpenUpgrade, extras: draftExtras, onExtrasChange: setDraftExtras };

  return (
    <div className={`flex-1 flex flex-col min-h-0 ${DETAIL_COLUMN}`}>
      {note.type === 'login' ? (
        <LoginForm {...loginFormProps} />
      ) : note.type === 'card' ? (
        <CardForm {...formProps} />
      ) : (
        <SshKeyForm {...formProps} />
      )}
    </div>
  );
}

/* Re-export Favicon for use in NoteRow */
export { Favicon };
