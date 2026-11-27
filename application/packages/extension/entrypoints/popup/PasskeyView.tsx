/**
 * The passkey prompts: the popup opened on one stored request (its id in the
 * address). It unlocks first when the vault is locked, names the site by the
 * sender's origin (never the site's own `rp.name`, review 21), and then
 * either saves a new passkey (`PasskeySaveView`) or signs in with one
 * (`PasskeyUseView`). The popup signs and answers the tab itself. Closing
 * the window or "Use another passkey app" sends the page to the browser's
 * own prompt and holds the site's next prompt for a minute.
 * Spec: docs/contrib/passkeys.md (section 5.4, Prompts and Saving)
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import {
  assertSitePasskey,
  authenticationResponseJson,
  createSitePasskey,
  registrationResponseJson,
  type LoginCopyEntry,
  type PrfValues,
  type SitePasskey,
} from '@notes/shared/extension';
import { FloppyDisk, Fingerprint, Key, User } from '@web/icons';
import { Button } from '@web/ui/Button';
import { Callout, Spinner } from '@web/ui/feedback';
import { Select } from '@web/ui/fields';
import { FieldLabel } from '@web/formFields';
import { SETTINGS_HELP } from '@web/settingsUI';
import type { Connection } from '../../src/connection';
import { answerTab, candidates, excluded, finishRequest, PROMPT_PORT, readRequest, REQUESTS_KEY, restorePopup, type StoredRequest } from '../../src/passkeyDoor';
import { fromB64url, type PasskeyResult, type WireCreateOptions, type WireCredential, type WireGetOptions, type WirePrf } from '../../src/passkeyWire';
import { loginsOf, loginsOfDomain } from '../../src/match';
import { displayHost } from '../../src/favicon';
import { isPendingItem, loginEditBase } from '../../src/pending';
import type { LoginEditResult } from '../../src/save';
import { DONE_HOLD_MS, SaveButton } from './SaveButton';
import { Tile, Unlock, useVault } from './VaultView';

/** A click this soon after a prompt draws is ignored, as the browser's own
 *  dialogs do: a double click meant for the page must not sign in or save
 *  (beta #140, item 3). Spec: docs/contrib/passkeys.md (section 5.4, Prompts) */
export const PROMPT_CLICK_GUARD_MS = 500;

/** Whether the prompt has been on screen long enough to take a click.
 *  When `active` starts false (for example while a sign-in pull spinner shows),
 *  the 500 ms window starts only when the actionable buttons first render. */
function useClickGuard(active = true): () => boolean {
  const shownAt = useRef<number | null>(active ? Date.now() : null);
  useEffect(() => {
    if (active && shownAt.current === null) shownAt.current = Date.now();
  }, [active]);
  return () => {
    if (!active) return false;
    if (shownAt.current === null) shownAt.current = Date.now();
    return Date.now() - shownAt.current >= PROMPT_CLICK_GUARD_MS;
  };
}

const bytes = (text: string): Uint8Array => fromB64url(text) ?? new Uint8Array(0);

function prfValues(p: { first: string; second?: string } | undefined): PrfValues | undefined {
  return p ? { first: bytes(p.first), ...(p.second ? { second: bytes(p.second) } : {}) } : undefined;
}

function prfByCredential(prf: WirePrf | undefined): Record<string, PrfValues> | undefined {
  if (!prf?.evalByCredential) return undefined;
  return Object.fromEntries(Object.entries(prf.evalByCredential).map(([id, v]) => [id, prfValues(v)!]));
}

/** The one request this popup was opened for, its answer, and its end. */
function usePasskeyRequest(id: string) {
  const [req, setReq] = useState<StoredRequest | null | undefined>(undefined);
  const answered = useRef(false);
  useEffect(() => {
    const isWindow = new URLSearchParams(window.location.search).get('window') === '1';
    // Connect the port immediately so the background watchdog sees this popup
    // without waiting on storage reads, and keep a strong reference so GC
    // cannot drop it and trigger a false disconnect/dismissal.
    const port = browser.runtime.connect({ name: `${PROMPT_PORT}${id}` });
    const onPortMsg = (msg: { superseded?: boolean } | null) => {
      if (msg?.superseded) {
        answered.current = true;
        window.close();
      }
    };
    port.onMessage?.addListener(onPortMsg);
    let alive = true;
    void readRequest(id).then((got) => {
      if (!alive) return;
      if (!got || (!isWindow && got.windowFallback)) {
        answered.current = true;
        window.close();
        return;
      }
      // The toolbar popup goes back to the plain one at once.
      void restorePopup(got.tabId);
      setReq(got);
    });
    // The page aborted, the request ran out, or a fallback window superseded
    // this late toolbar popup: nothing to answer.
    const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'session' || !(REQUESTS_KEY in changes) || answered.current) return;
      const left = changes[REQUESTS_KEY]?.newValue as Record<string, StoredRequest | undefined> | undefined;
      const cur = left?.[id];
      if (!cur || (!isWindow && cur.windowFallback)) {
        answered.current = true;
        window.close();
      }
    };
    browser.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChange);
      port.onMessage?.removeListener(onPortMsg);
      port.disconnect?.();
    };
  }, [id]);
  // A window that closes with no answer answers the browser's prompt itself
  // (review 6); the port stays as the background's backup.
  useEffect(() => {
    if (!req) return;
    const onHide = () => {
      if (answered.current) return;
      answered.current = true;
      void answerTab(req, { kind: 'fallback' });
      void finishRequest(req.id, true);
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [req]);
  const answer = async (result: PasskeyResult, dismissed = false, closeAfter = 0) => {
    if (!req || answered.current) return;
    answered.current = true;
    // Finish the request (and clear site holds on an approved sign-in) BEFORE
    // handing the answer to the page, so an immediate site redirect or retry
    // never races with `dropTabRequests` or sees stale holds.
    await finishRequest(req.id, dismissed, Date.now(), result.kind === 'credential').catch(() => undefined);
    await answerTab(req, result);
    window.setTimeout(() => window.close(), closeAfter);
  };
  /** The background answers from here on (a save). */
  const handOff = () => {
    answered.current = true;
  };
  return { req, answer, handOff };
}

export function PasskeyPrompt({ id, connection }: { id: string; connection: Connection }) {
  const { t } = useTranslation('extension');
  const { req, answer, handOff } = usePasskeyRequest(id);
  const vault = useVault(connection.logins);
  useEffect(() => {
    if (req && !connection.logins) void answer({ kind: 'fallback' });
  });
  if (!req) {
    return (
      <div className="p-6 flex justify-center">
        <Spinner />
      </div>
    );
  }
  const url = new URL(req.origin);
  const site = url.host;
  const other = (
    <Button icon={<Key aria-hidden="true" />} onClick={() => void answer({ kind: 'fallback' }, true)} className="w-full bg-surface-2 shadow-xs">
      {t('passkey.other')}
    </Button>
  );
  const head = (
    <header className="flex items-center gap-2 px-3 py-2 border-b border-divider bg-surface-0">
      {/* A letter, not the asking site's icon: the prompt tells no server the site (beta #217 item 1). */}
      <Tile letter={displayHost(req.origin)} />
      <div className="min-w-0">
        <div className="text-body font-semibold text-pn truncate">{req.kind === 'create' ? t('passkey.saveTitle', { site }) : t('passkey.useTitle', { site })}</div>
        {req.rpId !== url.hostname && <div className="text-meta text-pn-muted truncate">{t('logins.forSite', { site: req.rpId })}</div>}
      </div>
    </header>
  );
  if (vault.unlocked !== true || !vault.loaded) {
    return (
      <div className="flex flex-1 flex-col">
        {head}
        <div className="p-3 space-y-3">
          {vault.unlocked === false && (
            <>
              <p className={SETTINGS_HELP}>{t('passkey.unlockFirst')}</p>
              <Unlock connection={connection} onUnlocked={vault.onUnlocked} focusNonce={0} pageOpened />
            </>
          )}
          {vault.unlocked !== false && <div className="flex justify-center"><Spinner /></div>}
          {other}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col">
      {head}
      <div className="p-3 space-y-3">
        {req.kind === 'create'
          ? <PasskeySaveView req={req} logins={loginsOf(vault.entries)} answer={answer} handOff={handOff} other={other} />
          : <PasskeyUseView req={req} logins={loginsOf(vault.entries)} pulling={vault.pulling} answer={answer} other={other} />}
      </div>
    </div>
  );
}

type Answer = (result: PasskeyResult, dismissed?: boolean, closeAfter?: number) => Promise<void>;

export function PasskeySaveView({ req, logins, answer, handOff, other }: { req: StoredRequest; logins: LoginCopyEntry[]; answer: Answer; handOff: () => void; other: ReactNode }) {
  const { t } = useTranslation('extension');
  const opts = req.options as WireCreateOptions;
  const stored = useMemo(() => logins.flatMap((l) => l.passkeys ?? []), [logins]);
  const already = excluded(stored, req.rpId, opts.excludeCredentials);
  // Save to: the logins of the site's registrable domain, the one with the
  // passkey's user name first; a login the copy does not hold yet is no target.
  const targets = useMemo(() => {
    const list = loginsOfDomain(logins, req.origin).filter((l) => !isPendingItem(l.item));
    return [...list.filter((l) => l.username === opts.user.name), ...list.filter((l) => l.username !== opts.user.name)];
  }, [logins, req.origin, opts.user.name]);
  const [target, setTarget] = useState<string>(() => targets.find((l) => l.username === opts.user.name)?.item ?? 'new');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed' | 'unknown'>('idle');
  const ready = useClickGuard();

  if (already) {
    return (
      <>
        <Callout look="card" tone="info">{t('passkey.already', { site: new URL(req.origin).host })}</Callout>
        <Button action="done" onClick={() => void answer({ kind: 'error', name: 'InvalidStateError' })} className="w-full" />
      </>
    );
  }

  const save = async () => {
    setState('busy');
    let made: ReturnType<typeof createSitePasskey>;
    try {
      made = createSitePasskey({
        rpId: req.rpId,
        origin: req.origin,
        challenge: bytes(opts.challenge),
        user: { id: bytes(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
        prf: !!opts.extensions?.prf,
        prfEval: prfValues(opts.extensions?.prf?.eval),
      });
    } catch {
      setState('failed');
      return void answer({ kind: 'fallback' }, false, 2500);
    }
    const login = targets.find((l) => l.item === target);
    const host = new URL(req.origin).host;
    const request = login
      ? { item: login.item, set: {}, addPasskeys: [made.passkey], base: loginEditBase(login) }
      : { set: { name: displayHost(req.origin) || host, url: req.origin, username: opts.user.name.slice(0, 1000) }, addPasskeys: [made.passkey] };
    const json = registrationResponseJson(made);
    const credential: WireCredential = {
      kind: 'create',
      id: json.id,
      clientDataJSON: json.response.clientDataJSON,
      authenticatorData: json.response.authenticatorData,
      attestationObject: json.response.attestationObject,
      publicKey: json.response.publicKey,
      clientExtensionResults: { ...json.clientExtensionResults, ...(opts.extensions?.credProps ? { credProps: { rk: true } } : {}) },
    };
    // The background posts the row and answers the tab: the credential once
    // the row is on the server (P24), else the browser's prompt. A toolbar
    // popup that closes meanwhile changes nothing (review 5).
    handOff();
    const result = (await browser.runtime.sendMessage({ type: 'savePasskey', id: req.id, request, credential }).catch(() => null)) as LoginEditResult | null;
    if (result?.state !== 'sent') {
      // No answer from the server in time: it may hold the row (beta #125).
      setState(result?.state === 'unknown' ? 'unknown' : 'failed');
      return void window.setTimeout(() => window.close(), 2500);
    }
    setState('done');
    window.setTimeout(() => window.close(), DONE_HOLD_MS);
  };

  return (
    <>
      <div className="rounded-lg border border-divider bg-surface-2 p-3 shadow-xs space-y-3">
        <div>
          <FieldLabel icon={<User />}>{t('auth:loginForm.usernameLabel')}</FieldLabel>
          <div className="text-body text-pn truncate" dir="auto">{opts.user.name || opts.user.displayName}</div>
        </div>
        <div>
          <FieldLabel htmlFor="pn-save-to">{t('passkey.saveTo')}</FieldLabel>
          <Select id="pn-save-to" value={target} onChange={(e) => setTarget(e.target.value)} disabled={state !== 'idle'} className="w-full">
            {targets.map((l) => <option key={l.item} value={l.item}>{l.username ? `${l.name} · ${l.username}` : l.name}</option>)}
            <option value="new">{t('shell:quickAdd.types.login')}</option>
          </Select>
        </div>
      </div>
      {state === 'failed' && <Callout look="card" tone="danger">{t('passkey.notSaved')}</Callout>}
      {state === 'unknown' && <Callout look="card" tone="warning">{t('passkey.maybeSaved')}</Callout>}
      <SaveButton
        variant="primary"
        className="w-full"
        state={state === 'done' ? 'done' : state === 'busy' ? 'busy' : 'idle'}
        disabled={state === 'failed' || state === 'unknown'}
        icon={<FloppyDisk aria-hidden="true" />}
        label={t('passkey.save')}
        busyLabel={t('common:state.saving')}
        doneLabel={t('passkey.saved')}
        onClick={() => {
          if (ready()) void save();
        }}
      />
      {state === 'idle' && other}
    </>
  );
}

export function PasskeyUseView({ req, logins, pulling = false, answer, other }: { req: StoredRequest; logins: LoginCopyEntry[]; pulling?: boolean; answer: Answer; other: ReactNode }) {
  const { t } = useTranslation('extension');
  const opts = req.options as WireGetOptions;
  const rows = useMemo(() => {
    const out: { passkey: SitePasskey; login: LoginCopyEntry }[] = [];
    for (const login of logins) for (const passkey of candidates(login.passkeys ?? [], req.rpId, opts.allowCredentials)) out.push({ passkey, login });
    return out;
  }, [logins, req.rpId, opts.allowCredentials]);
  const ready = useClickGuard(rows.length > 0);
  const [pullTimedOut, setPullTimedOut] = useState(false);
  useEffect(() => {
    if (rows.length || !pulling) {
      setPullTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setPullTimedOut(true), 3000);
    return () => window.clearTimeout(timer);
  }, [rows.length, pulling]);
  // Unlocked with nothing cached for this site: wait briefly for an in-flight
  // pull (a passkey saved in another browser or device), then hand off to the
  // browser's prompt if still empty or the pull stalls.
  useEffect(() => {
    if (!rows.length && (!pulling || pullTimedOut)) void answer({ kind: 'fallback' });
  }, [rows.length, pulling, pullTimedOut]); // eslint-disable-line react-hooks/exhaustive-deps

  const use = async (passkey: SitePasskey) => {
    let credential: WireCredential;
    try {
      const json = authenticationResponseJson(assertSitePasskey({
        passkey,
        origin: req.origin,
        challenge: bytes(opts.challenge),
        prfEval: prfValues(opts.extensions?.prf?.eval),
        prfEvalByCredential: prfByCredential(opts.extensions?.prf),
      }));
      credential = {
        kind: 'get',
        id: json.id,
        clientDataJSON: json.response.clientDataJSON,
        authenticatorData: json.response.authenticatorData,
        signature: json.response.signature,
        userHandle: json.response.userHandle,
        clientExtensionResults: json.clientExtensionResults,
      };
    } catch {
      return void answer({ kind: 'fallback' });
    }
    await answer({ kind: 'credential', credential });
  };

  if (!rows.length) {
    return (
      <>
        <div className="flex justify-center py-4"><Spinner /></div>
        {other}
      </>
    );
  }

  return (
    <>
      <ul className="space-y-2">
        {rows.map(({ passkey, login }) => (
          <li key={passkey.credentialId}>
            <button type="button" onClick={() => {
              if (ready()) void use(passkey);
            }} className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-divider bg-surface-2 px-3 py-2.5 text-start shadow-xs transition-colors hover:border-accent/40">
              <Tile url={login.urls[0]} letter={login.name || passkey.userName} />
              <span className="min-w-0">
                <span className="block text-body font-medium text-pn truncate" dir="auto">{passkey.userName || passkey.displayName}</span>
                <span className="block text-meta text-pn-muted truncate" dir="auto">{login.name}</span>
              </span>
              <Fingerprint aria-hidden="true" className="text-accent" />
            </button>
          </li>
        ))}
      </ul>
      {other}
    </>
  );
}
