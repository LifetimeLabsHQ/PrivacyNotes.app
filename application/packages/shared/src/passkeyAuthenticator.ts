/**
 * The authenticator behind the extension's site passkeys: it makes a P-256
 * passkey and signs assertions with it, and builds every byte a relying party
 * reads (client data JSON, authenticator data, the COSE key, the `none`
 * attestation object, the SPKI public key, DER signatures) plus the PRF
 * results. Pure: no DOM, no storage, no WebCrypto; the caller has already
 * checked the origin, the RP ID and the user's consent (the extension's door
 * and prompts).
 * Spec: docs/contrib/passkeys.md (section 5.4, Authenticator)
 */

import { p256 } from '@noble/curves/nist.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { encodeCbor, type CborKey, type CborValue } from './cbor.js';
import { base64urlToBytes, bytesToBase64url } from './crypto.js';
import { p256Pkcs8, p256Pkcs8Scalar, parseSitePasskey, SITE_PASSKEY_LIMITS, SITE_PASSKEY_PRF_SECRET_BYTES, type SitePasskey } from './sitePasskey.js';

/** COSE algorithm ES256 (ECDSA P-256 SHA-256), the only one this makes. */
export const COSE_ALG_ES256 = -7;

/** The authenticator data flags (WebAuthn section 6.1). UV is set because an
 *  unlocked extension counts as verified (P22); BE and BS because the
 *  passkey syncs with the Vault.
 *  Spec: docs/contrib/passkeys.md (section 5.4, P22) */
export const AUTH_DATA_FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 } as const;

/** What `getTransports()` answers. Spec: docs/contrib/passkeys.md (section 5.4) */
export const SITE_PASSKEY_TRANSPORTS = ['internal', 'hybrid'] as const;

// Spec: docs/contrib/passkeys.md (section 5.4, credential id 16 random bytes)
const CREDENTIAL_ID_BYTES = 16;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The origin as the browser serializes it (`https://host[:port]`), https or
 *  http on localhost, and the RP ID its host or a parent of it. Throws
 *  otherwise: the door checks this first, and this is the second line. */
function checkOrigin(origin: string, rpId: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('passkey origin malformed');
  }
  const local = url.protocol === 'http:' && url.hostname === 'localhost';
  if (url.origin !== origin || (url.protocol !== 'https:' && !local)) throw new Error('passkey origin malformed');
  if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) throw new Error('passkey rp id does not match the origin');
}

// ------------------------------------------------------------------
// The response fields
// ------------------------------------------------------------------

/** `clientDataJSON`, with the members in WebAuthn's own order (section 5.8.1.1). */
export function clientDataJson(type: 'webauthn.create' | 'webauthn.get', challenge: Uint8Array, origin: string): Uint8Array {
  return text(JSON.stringify({ type, challenge: bytesToBase64url(challenge), origin, crossOrigin: false }));
}

/** The COSE_Key of a P-256 public key (65-byte uncompressed point):
 *  `{1: 2, 3: -7, -1: 1, -2: x, -3: y}` in canonical CBOR. */
export function coseKeyEs256(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error('p256 public key malformed');
  return encodeCbor(new Map<CborKey, CborValue>([
    [1, 2], // kty: EC2
    [3, COSE_ALG_ES256], // alg
    [-1, 1], // crv: P-256
    [-2, publicKey.slice(1, 33)], // x
    [-3, publicKey.slice(33, 65)], // y
  ]));
}

/** Authenticator data (WebAuthn section 6.1): SHA-256 of the RP ID, the
 *  flags, a zero signature counter, and, when `attested` is given, the
 *  attested credential data (zero AAGUID, id length, id, COSE key) with AT. */
export function authenticatorData(rpId: string, flags: number, attested?: { credentialId: Uint8Array; publicKey: Uint8Array }): Uint8Array {
  const head = concat(sha256(text(rpId)), Uint8Array.of(flags), new Uint8Array(4));
  if (!attested) return head;
  const id = attested.credentialId;
  if (id.length < 1 || id.length > 1023) throw new Error('credential id length');
  return concat(head, new Uint8Array(16), Uint8Array.of(id.length >>> 8, id.length & 0xff), id, coseKeyEs256(attested.publicKey));
}

/** The attestation object of attestation `none`:
 *  `{"fmt": "none", "attStmt": {}, "authData": <bytes>}` in canonical CBOR. */
export function noneAttestationObject(authData: Uint8Array): Uint8Array {
  return encodeCbor(new Map<CborKey, CborValue>([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authData],
  ]));
}

// SubjectPublicKeyInfo of id-ecPublicKey on prime256v1, up to the point (RFC 5480).
const SPKI_P256_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

/** The SPKI DER of a P-256 public key, what `getPublicKey()` answers. */
export function p256Spki(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error('p256 public key malformed');
  return concat(Uint8Array.from(SPKI_P256_PREFIX.match(/../g) ?? [], (h) => parseInt(h, 16)), publicKey);
}

// ------------------------------------------------------------------
// PRF (hmac-secret)
// ------------------------------------------------------------------

/** The PRF extension's inputs or outputs, `first` and an optional `second`. */
export interface PrfValues {
  first: Uint8Array;
  second?: Uint8Array;
}

/** One PRF output, the hmac-secret construction (WebAuthn section 10.1.4):
 *  `HMAC-SHA-256(prfSecret, SHA-256(utf8("WebAuthn PRF") || 0x00 || input))`. */
export function prfFromSecret(prfSecret: Uint8Array, input: Uint8Array): Uint8Array {
  return hmac(sha256, prfSecret, sha256(concat(text('WebAuthn PRF'), Uint8Array.of(0), input)));
}

function prfResults(passkey: SitePasskey, values: PrfValues): PrfValues {
  const secret = base64urlToBytes(passkey.prfSecret);
  const first = prfFromSecret(secret, values.first);
  return values.second ? { first, second: prfFromSecret(secret, values.second) } : { first };
}

// ------------------------------------------------------------------
// Create and assert
// ------------------------------------------------------------------

export interface CreateSitePasskeyInput {
  rpId: string;
  /** The page's origin, as the door read it from the sender. */
  origin: string;
  challenge: Uint8Array;
  /** The site's `user`: `id` 1 to 64 bytes. */
  user: { id: Uint8Array; name: string; displayName: string };
  /** True when the page asked for the `prf` extension at all. */
  prf?: boolean;
  /** `extensions.prf.eval`, when the page gave one. */
  prfEval?: PrfValues;
}

export interface SitePasskeyRegistration {
  /** What the Vault stores. */
  passkey: SitePasskey;
  /** The credential id, unpadded base64url, and its bytes. */
  id: string;
  rawId: Uint8Array;
  clientDataJSON: Uint8Array;
  attestationObject: Uint8Array;
  authenticatorData: Uint8Array;
  /** SPKI DER, for `getPublicKey()`. */
  publicKey: Uint8Array;
  publicKeyAlgorithm: typeof COSE_ALG_ES256;
  transports: string[];
  clientExtensionResults: { prf?: { enabled: true; results?: PrfValues } };
}

/** Names longer than a site passkey may hold are cut, never refused. */
function clip(name: string): string {
  const cut = name.slice(0, SITE_PASSKEY_LIMITS.name);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** A new site passkey and the registration response for it. Throws on an
 *  origin, RP ID or user id the passkey could not hold. */
export function createSitePasskey(input: CreateSitePasskeyInput): SitePasskeyRegistration {
  const { rpId, origin, challenge, user } = input;
  checkOrigin(origin, rpId);
  if (user.id.length < 1 || user.id.length > 64) throw new Error('passkey user id length');
  const scalar = p256.utils.randomSecretKey();
  const point = p256.getPublicKey(scalar, false);
  const rawId = randomBytes(CREDENTIAL_ID_BYTES);
  const passkey = parseSitePasskey({
    v: 1,
    credentialId: bytesToBase64url(rawId),
    rpId,
    userHandle: bytesToBase64url(user.id),
    userName: clip(user.name),
    displayName: clip(user.displayName),
    key: bytesToBase64url(p256Pkcs8(scalar, point)),
    prfSecret: bytesToBase64url(randomBytes(SITE_PASSKEY_PRF_SECRET_BYTES)),
    created: new Date().toISOString(),
  } satisfies SitePasskey);
  if (!passkey) throw new Error('passkey rp id malformed');
  const { UP, UV, BE, BS, AT } = AUTH_DATA_FLAGS;
  const authData = authenticatorData(rpId, UP | UV | BE | BS | AT, { credentialId: rawId, publicKey: point });
  const wantsPrf = input.prf === true || input.prfEval !== undefined;
  return {
    passkey,
    id: passkey.credentialId,
    rawId,
    clientDataJSON: clientDataJson('webauthn.create', challenge, origin),
    attestationObject: noneAttestationObject(authData),
    authenticatorData: authData,
    publicKey: p256Spki(point),
    publicKeyAlgorithm: COSE_ALG_ES256,
    transports: [...SITE_PASSKEY_TRANSPORTS],
    clientExtensionResults: wantsPrf
      ? { prf: input.prfEval ? { enabled: true, results: prfResults(passkey, input.prfEval) } : { enabled: true } }
      : {},
  };
}

export interface AssertSitePasskeyInput {
  passkey: SitePasskey;
  origin: string;
  challenge: Uint8Array;
  /** `extensions.prf.eval`. */
  prfEval?: PrfValues;
  /** `extensions.prf.evalByCredential`, keyed by unpadded base64url
   *  credential id; the entry for this passkey wins over `prfEval`. */
  prfEvalByCredential?: Record<string, PrfValues>;
}

export interface SitePasskeyAssertion {
  id: string;
  rawId: Uint8Array;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  /** DER ECDSA over `authenticatorData || SHA-256(clientDataJSON)`. */
  signature: Uint8Array;
  userHandle: Uint8Array;
  clientExtensionResults: { prf?: { results: PrfValues } };
}

/** Sign in to a site with a stored passkey. Throws on a passkey whose key
 *  does not parse, or an origin it does not belong to. */
export function assertSitePasskey(input: AssertSitePasskeyInput): SitePasskeyAssertion {
  const { passkey, origin, challenge } = input;
  checkOrigin(origin, passkey.rpId);
  const scalar = p256Pkcs8Scalar(base64urlToBytes(passkey.key));
  if (!scalar) throw new Error('passkey key malformed');
  const { UP, UV, BE, BS } = AUTH_DATA_FLAGS;
  const authData = authenticatorData(passkey.rpId, UP | UV | BE | BS);
  const clientData = clientDataJson('webauthn.get', challenge, origin);
  // noble hashes the message with SHA-256 first (prehash), as ES256 does.
  const signature = p256.sign(concat(authData, sha256(clientData)), scalar, { format: 'der', extraEntropy: true });
  const byCredential = input.prfEvalByCredential && Object.hasOwn(input.prfEvalByCredential, passkey.credentialId)
    ? input.prfEvalByCredential[passkey.credentialId]
    : undefined;
  const prf = byCredential ?? input.prfEval;
  return {
    id: passkey.credentialId,
    rawId: base64urlToBytes(passkey.credentialId),
    clientDataJSON: clientData,
    authenticatorData: authData,
    signature,
    userHandle: base64urlToBytes(passkey.userHandle),
    clientExtensionResults: prf ? { prf: { results: prfResults(passkey, prf) } } : {},
  };
}

// ------------------------------------------------------------------
// The JSON forms (WebAuthn Level 3 `toJSON()`): every buffer as unpadded
// base64url. Also what the popup sends the page over the message channel.
// ------------------------------------------------------------------

type PrfJson = { first: string; second?: string };

function prfJson(values: PrfValues): PrfJson {
  return values.second ? { first: bytesToBase64url(values.first), second: bytesToBase64url(values.second) } : { first: bytesToBase64url(values.first) };
}

export interface RegistrationResponseJson {
  id: string;
  rawId: string;
  type: 'public-key';
  authenticatorAttachment: 'platform';
  response: {
    clientDataJSON: string;
    attestationObject: string;
    authenticatorData: string;
    transports: string[];
    publicKey: string;
    publicKeyAlgorithm: number;
  };
  clientExtensionResults: { prf?: { enabled: true; results?: PrfJson } };
}

export function registrationResponseJson(r: SitePasskeyRegistration): RegistrationResponseJson {
  const prf = r.clientExtensionResults.prf;
  return {
    id: r.id,
    rawId: r.id,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: bytesToBase64url(r.clientDataJSON),
      attestationObject: bytesToBase64url(r.attestationObject),
      authenticatorData: bytesToBase64url(r.authenticatorData),
      transports: [...r.transports],
      publicKey: bytesToBase64url(r.publicKey),
      publicKeyAlgorithm: r.publicKeyAlgorithm,
    },
    clientExtensionResults: prf ? { prf: prf.results ? { enabled: true, results: prfJson(prf.results) } : { enabled: true } } : {},
  };
}

export interface AuthenticationResponseJson {
  id: string;
  rawId: string;
  type: 'public-key';
  authenticatorAttachment: 'platform';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string;
  };
  clientExtensionResults: { prf?: { results: PrfJson } };
}

export function authenticationResponseJson(a: SitePasskeyAssertion): AuthenticationResponseJson {
  const prf = a.clientExtensionResults.prf;
  return {
    id: a.id,
    rawId: a.id,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: bytesToBase64url(a.clientDataJSON),
      authenticatorData: bytesToBase64url(a.authenticatorData),
      signature: bytesToBase64url(a.signature),
      userHandle: bytesToBase64url(a.userHandle),
    },
    clientExtensionResults: prf ? { prf: { results: prfJson(prf.results) } } : {},
  };
}
