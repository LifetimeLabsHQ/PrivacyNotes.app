/**
 * The passkey page script: in the page's own world, at document start, top
 * frame only. It wraps `navigator.credentials.create` and `get` so a site
 * that asks for a passkey can use one saved in PrivacyNotes. It handles a
 * call only when it carries `publicKey`, the frame is the top one, the
 * context is secure with a real origin, and the call is not one of the cases
 * the browser keeps (conditional or silent mediation, a security key). Every
 * other call, and every call the relay does not ack within 250 ms, goes to
 * the browser's own function at once.
 *
 * While the release switch is off it wraps nothing. It defines no global,
 * and each wrapped function's `toString()` reads as the original's. A page
 * can still tell the wrapper: `Function.prototype.toString.call` on it gives
 * `function () { [native code] }`, without the name (beta #134).
 * Spec: docs/contrib/passkeys.md (section 5.4, P21)
 */
import { passkeysReleased } from '../src/passkeyRelease';
import {
  ACK_MS,
  ANSWER_MAX_MS,
  FOCUS_WAIT_MS,
  isOurOrigin,
  fromB64url,
  toB64url,
  type PageMessage,
  type PasskeyKind,
  type PasskeyResult,
  type WireCreateOptions,
  type WireCredential,
  type WireGetOptions,
  type WirePrf,
} from '../src/passkeyWire';

export default defineContentScript({
  // The pages are the background's registration (`syncPasskeyScripts`,
  // PASSKEY_MATCHES): none here, so the manifest gains no host permission.
  matches: [],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: false,
  // Registered by the background only while the switch is on, so no build
  // with the switch off declares a script on any page (review 9).
  registration: 'runtime',
  main() {
    if (!passkeysReleased() || isOurOrigin(location.origin)) return;
    wrapCredentials();
  },
});

type Bytes = ArrayBuffer | ArrayBufferView;
const isBytes = (v: unknown): v is Bytes =>
  v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Object.prototype.toString.call(v) === '[object ArrayBuffer]';
const bytesOf = (v: Bytes): Uint8Array => (ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v));
const b64 = (v: unknown): string | null => (isBytes(v) ? toB64url(bytesOf(v)) : null);

function prfOf(ext: unknown): WirePrf | undefined | null {
  const prf = (ext as { prf?: { eval?: { first?: unknown; second?: unknown }; evalByCredential?: Record<string, { first?: unknown; second?: unknown }> } } | undefined)?.prf;
  if (!prf) return undefined;
  const pair = (p: { first?: unknown; second?: unknown } | undefined) => {
    if (!p) return undefined;
    const first = b64(p.first);
    if (first === null) return null;
    if (p.second == null) return { first };
    const second = b64(p.second);
    return second === null ? null : { first, second };
  };
  const out: WirePrf = {};
  if (prf.eval) {
    const e = pair(prf.eval);
    if (!e) return null;
    out.eval = e;
  }
  if (prf.evalByCredential) {
    out.evalByCredential = {};
    for (const [id, p] of Object.entries(prf.evalByCredential)) {
      const e = pair(p);
      if (!e) return null;
      out.evalByCredential[id] = e;
    }
  }
  return out;
}

const descriptors = (list: unknown): { id: string; type: string }[] | null => {
  if (list == null) return [];
  if (!Array.isArray(list)) return null;
  const out: { id: string; type: string }[] = [];
  for (const d of list as { id?: unknown; type?: unknown }[]) {
    const id = b64(d?.id);
    if (id === null) return null;
    out.push({ id, type: String(d.type ?? 'public-key') });
  }
  return out;
};

/** The create options as JSON, or null when they are not well formed (the
 *  browser then raises its own error). */
function encodeCreate(pk: PublicKeyCredentialCreationOptions): WireCreateOptions | null {
  const challenge = b64(pk.challenge);
  const userId = b64(pk.user?.id);
  const exclude = descriptors(pk.excludeCredentials);
  const prf = prfOf(pk.extensions);
  if (challenge === null || userId === null || !exclude || prf === null || !pk.rp || !Array.isArray(pk.pubKeyCredParams)) return null;
  const sel = pk.authenticatorSelection;
  return {
    rp: { ...(pk.rp.id != null && pk.rp.id !== '' ? { id: String(pk.rp.id) } : {}), name: String(pk.rp.name ?? '') },
    user: { id: userId, name: String(pk.user.name ?? ''), displayName: String(pk.user.displayName ?? '') },
    challenge,
    pubKeyCredParams: pk.pubKeyCredParams.map((p) => ({ type: String(p.type), alg: Number(p.alg) })),
    excludeCredentials: exclude,
    ...(sel ? { authenticatorSelection: { residentKey: sel.residentKey, requireResidentKey: sel.requireResidentKey, userVerification: sel.userVerification, authenticatorAttachment: sel.authenticatorAttachment } } : {}),
    ...(typeof pk.timeout === 'number' ? { timeout: pk.timeout } : {}),
    extensions: { ...(prf ? { prf } : {}), ...((pk.extensions as { credProps?: boolean } | undefined)?.credProps ? { credProps: true } : {}) },
  };
}

function encodeGet(pk: PublicKeyCredentialRequestOptions): WireGetOptions | null {
  const challenge = b64(pk.challenge);
  const allow = descriptors(pk.allowCredentials);
  const prf = prfOf(pk.extensions);
  if (challenge === null || !allow || prf === null) return null;
  return {
    ...(pk.rpId != null && pk.rpId !== '' ? { rpId: String(pk.rpId) } : {}),
    challenge,
    allowCredentials: allow,
    ...(pk.userVerification ? { userVerification: pk.userVerification } : {}),
    ...(typeof pk.timeout === 'number' ? { timeout: pk.timeout } : {}),
    ...(prf ? { extensions: { prf } } : {}),
  };
}

/** The calls the browser keeps (P21): conditional or silent mediation, a
 *  request that asks for a security key first (or cross-platform create). */
function passThrough(options: CredentialCreationOptions | CredentialRequestOptions, kind: PasskeyKind): boolean {
  const mediation = (options as { mediation?: string }).mediation;
  if (mediation === 'conditional' || mediation === 'silent') return true;
  const pk = options.publicKey as { hints?: unknown; authenticatorSelection?: { authenticatorAttachment?: string } };
  if (Array.isArray(pk.hints) && pk.hints[0] === 'security-key') return true;
  return kind === 'create' && pk.authenticatorSelection?.authenticatorAttachment === 'cross-platform';
}

function wrapCredentials(): void {
  const proto = globalThis.CredentialsContainer?.prototype;
  if (!proto || typeof proto.create !== 'function' || typeof proto.get !== 'function' || typeof PublicKeyCredential !== 'function') return;
  // Taken now, before any page script runs, so a page cannot bend them later.
  const post = window.postMessage.bind(window);
  const listen = window.addEventListener.bind(window);
  const unlisten = window.removeEventListener.bind(window);
  const origin = location.origin;
  const wait = setTimeout.bind(window);
  const stop = clearTimeout.bind(window);
  const uuid = crypto.randomUUID.bind(crypto);
  const toString = Function.prototype.toString;

  /** One exchange with the relay: null means "use the browser". */
  type Ask = { pn: 'passkey-request'; kind: PasskeyKind; options: WireCreateOptions | WireGetOptions } | { pn: 'passkey-uvpa' };
  const ask = (request: Ask, signal?: AbortSignal | null): Promise<PasskeyResult | null> =>
    new Promise((resolve, reject) => {
      const id = uuid();
      let answerTimer: ReturnType<typeof wait> | undefined;
      let acked = false;
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        unlisten('message', onMessage);
        signal?.removeEventListener('abort', onAbort);
        stop(ackTimer);
        stop(answerTimer);
        fn();
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.origin !== origin) return;
        const msg = event.data as PageMessage | null;
        if (!msg || typeof msg !== 'object' || msg.id !== id) return;
        if (msg.pn === 'passkey-ack' && !acked) {
          acked = true;
          // A relay that acked and then went away (Firefox removes it on
          // unload) never answers: the call ends as the browser's own would.
          answerTimer = wait(() => finish(() => resolve({ kind: 'error', name: 'NotAllowedError' })), ANSWER_MAX_MS);
        } else if (msg.pn === 'passkey-answer' && acked) finish(() => resolve(msg.result));
      };
      const onAbort = () => {
        post({ pn: 'passkey-abort', id } satisfies PageMessage, origin);
        // The signal's own reason, as the browser rejects with it.
        finish(() => reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')));
      };
      const ackTimer = wait(() => {
        if (acked) return;
        // A busy page can deliver the ack late: the relay may hold the
        // request all the same, and must not prompt beside the browser.
        try {
          post({ pn: 'passkey-abort', id } satisfies PageMessage, origin);
        } catch {
          // The browser takes over either way.
        }
        finish(() => resolve(null));
      }, ACK_MS);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort);
      listen('message', onMessage);
      try {
        post({ ...request, id } satisfies PageMessage, origin);
      } catch {
        finish(() => resolve(null));
      }
    });

  /** After a fallback, the browser's prompt needs the page to have focus:
   *  wait for it, at most 10 seconds (review 21). */
  const whenFocused = (): Promise<void> =>
    new Promise((resolve) => {
      if (document.hasFocus()) return resolve();
      const done = () => {
        unlisten('focus', done);
        stop(timer);
        resolve();
      };
      const timer = wait(done, FOCUS_WAIT_MS);
      listen('focus', done);
    });

  const wrap = (kind: PasskeyKind, original: (...args: unknown[]) => Promise<Credential | null>) =>
    new Proxy(original, {
      apply(target, thisArg, args: unknown[]) {
        const options = args[0] as (CredentialCreationOptions & CredentialRequestOptions) | undefined;
        const call = () => Reflect.apply(target, thisArg, args) as Promise<Credential | null>;
        let wire: WireCreateOptions | WireGetOptions | null = null;
        let signal: AbortSignal | null | undefined;
        // Every read of the page's options is inside the try: a getter that
        // throws goes to the browser, which rejects as its own call does
        // instead of the wrapper throwing (beta #217).
        try {
          const ours = !!options?.publicKey && window.top === window && isSecureContext && globalThis.origin !== 'null' && thisArg === navigator.credentials;
          if (ours && !passThrough(options, kind)) {
            wire = kind === 'create' ? encodeCreate(options.publicKey as PublicKeyCredentialCreationOptions) : encodeGet(options.publicKey as PublicKeyCredentialRequestOptions);
            signal = options.signal;
          }
        } catch {
          wire = null;
        }
        if (!wire) return call();
        return ask({ pn: 'passkey-request', kind, options: wire }, signal).then(async (result) => {
          if (!result || result.kind === 'available') return call();
          if (result.kind === 'fallback') {
            await whenFocused();
            return call();
          }
          if (result.kind === 'error') throw new DOMException('The operation failed.', result.name);
          return dress(result.credential);
        });
      },
      get(target, key, receiver) {
        // `create.toString()` reads as the browser's own function.
        if (key === 'toString') return toString.bind(target);
        return Reflect.get(target, key, receiver);
      },
    });

  // Another passkey extension (for instance Bitwarden) may have written own
  // `create` / `get` properties onto `navigator.credentials` before our
  // dynamically registered script ran, shadowing `CredentialsContainer.prototype`.
  // Wrap those own properties when present (chaining to them on fallback),
  // else wrap the prototype as usual.
  const container = navigator.credentials as unknown as Record<string, unknown> | undefined;
  const install = (k: 'create' | 'get') => {
    try {
      const desc = container ? Object.getOwnPropertyDescriptor(container, k) : undefined;
      if (container && desc) {
        const fn = container[k];
        if (typeof fn !== 'function') return;
        const wrapped = wrap(k, fn as never);
        if (desc.configurable) {
          Object.defineProperty(container, k, { value: wrapped, writable: true, configurable: true, enumerable: desc.enumerable ?? true });
        } else if (desc.writable) {
          container[k] = wrapped;
        }
        return;
      }
      proto[k] = wrap(k, proto[k] as never);
    } catch {
      // Frozen property or throwing accessor on navigator.credentials / prototype: leave existing handler in place.
    }
  };
  install('create');
  install('get');

  // A site that asks whether a platform passkey can be made hears yes while
  // PrivacyNotes would offer one here (review 18), with the same ack rule.
  const uvpa = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
  if (typeof uvpa === 'function') {
    try {
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = new Proxy(uvpa, {
        apply(target, thisArg, args: unknown[]) {
          const call = () => Reflect.apply(target, thisArg, args) as Promise<boolean>;
          if (window.top !== window || !isSecureContext || globalThis.origin === 'null') return call();
          return ask({ pn: 'passkey-uvpa' }).then((result) => (result?.kind === 'available' ? true : call()));
        },
        get(target, key, receiver) {
          if (key === 'toString') return toString.bind(target);
          return Reflect.get(target, key, receiver);
        },
      });
    } catch {
      // Frozen property on PublicKeyCredential: leave the native check in place.
    }
  }
}

const buf = (text: string | undefined): ArrayBuffer => {
  const bytes = fromB64url(text ?? '') ?? new Uint8Array(0);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const own = (value: unknown) => ({ value, enumerable: true, configurable: true });

/** A credential that looks like the browser's own: the prototypes are the
 *  real ones, and own properties shadow their native getters. */
function dress(c: WireCredential): PublicKeyCredential {
  const transports = ['internal', 'hybrid'];
  const clientExtensionResults = () => {
    const out: Record<string, unknown> = {};
    const prf = c.clientExtensionResults.prf;
    if (prf) {
      const results = prf.results ? { first: buf(prf.results.first), ...(prf.results.second ? { second: buf(prf.results.second) } : {}) } : undefined;
      out.prf = { ...(prf.enabled !== undefined ? { enabled: prf.enabled } : {}), ...(results ? { results } : {}) };
    }
    if (c.clientExtensionResults.credProps) out.credProps = { ...c.clientExtensionResults.credProps };
    return out;
  };
  const response = c.kind === 'create'
    ? Object.create(AuthenticatorAttestationResponse.prototype, {
        clientDataJSON: own(buf(c.clientDataJSON)),
        attestationObject: own(buf(c.attestationObject)),
        getTransports: own(() => [...transports]),
        getAuthenticatorData: own(() => buf(c.authenticatorData)),
        getPublicKey: own(() => buf(c.publicKey)),
        getPublicKeyAlgorithm: own(() => -7),
      })
    : Object.create(AuthenticatorAssertionResponse.prototype, {
        clientDataJSON: own(buf(c.clientDataJSON)),
        authenticatorData: own(buf(c.authenticatorData)),
        signature: own(buf(c.signature)),
        userHandle: own(c.userHandle ? buf(c.userHandle) : null),
      });
  const json = () => ({
    id: c.id,
    rawId: c.id,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: c.kind === 'create'
      ? { clientDataJSON: c.clientDataJSON, attestationObject: c.attestationObject, authenticatorData: c.authenticatorData, transports: [...transports], publicKey: c.publicKey, publicKeyAlgorithm: -7 }
      : { clientDataJSON: c.clientDataJSON, authenticatorData: c.authenticatorData, signature: c.signature, userHandle: c.userHandle ?? null },
    clientExtensionResults: JSON.parse(JSON.stringify(c.clientExtensionResults)) as unknown,
  });
  return Object.create(PublicKeyCredential.prototype, {
    id: own(c.id),
    rawId: own(buf(c.id)),
    type: own('public-key'),
    authenticatorAttachment: own('platform'),
    response: own(response),
    getClientExtensionResults: own(clientExtensionResults),
    toJSON: own(json),
  }) as PublicKeyCredential;
}
