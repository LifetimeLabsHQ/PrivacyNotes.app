/**
 * WebAuthn helpers shared by biometric unlock (biometric.ts) and passkey
 * sign-in (passkeySignIn.ts): the bytes of a buffer from any realm, the PRF
 * extension's results, a PRF output checked to be 32 bytes, the AES-GCM key
 * HKDF gives over that output, and the provider hint that a credential is
 * gone. Unpadded base64url is `bytesToBase64url` / `base64urlToBytes` in
 * `@notes/shared`.
 * Spec: docs/contrib/passkeys.md (4.3)
 */

/** Cast Uint8Array to ArrayBuffer for Web Crypto strict typing. */
export function buf(u: Uint8Array): ArrayBuffer {
  return u.buffer instanceof ArrayBuffer && u.byteOffset === 0 && u.byteLength === u.buffer.byteLength
    ? u.buffer
    : u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

type PrfExtensionResults = {
  prf?: { enabled?: boolean; results?: { first?: BufferSource } };
};

/** The PRF extension's results of a credential, or undefined. Never throws. */
export function prfResultsOf(credential: PublicKeyCredential): PrfExtensionResults['prf'] {
  try {
    return (credential.getClientExtensionResults() as PrfExtensionResults).prf;
  } catch {
    return undefined;
  }
}

/** The bytes of a PRF result. ArrayBuffer.isView, not instanceof: a buffer
 *  from another realm is not an instance of this one's ArrayBuffer. */
function bytesOf(source: BufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
}

/** A PRF output is 32 bytes. Anything else is no output: an empty or short
 *  one would make a key every attacker can derive. */
const PRF_OUTPUT_BYTES = 32;
export function prfOutput(source: BufferSource | undefined): Uint8Array | null {
  if (!source) return null;
  const bytes = bytesOf(source);
  return bytes.length === PRF_OUTPUT_BYTES ? bytes : null;
}

/** The AES-GCM-256 key a PRF output gives: HKDF-SHA256, salt empty, the
 *  caller's own info string. Non-extractable, and never stored. */
export async function keyFromPrf(output: Uint8Array, info: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', buf(output), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: buf(new TextEncoder().encode(info)) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Tell the passkey provider a credential is no longer used, where the
 *  browser can. A hint only: never awaited, never throws. */
export function signalUnknownCredential(rpId: string, credentialId: string): void {
  try {
    const signal = (PublicKeyCredential as unknown as {
      signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>;
    }).signalUnknownCredential;
    if (typeof signal === 'function') {
      void signal.call(PublicKeyCredential, { rpId, credentialId }).catch(() => { /* a hint only */ });
    }
  } catch {
    /* a hint only */
  }
}
