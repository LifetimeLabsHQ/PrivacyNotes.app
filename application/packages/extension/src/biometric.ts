/**
 * Fingerprint or face, where the browser offers WebAuthn with the PRF
 * extension. Chrome and Edge run the system sheet in the popup itself;
 * Firefox closes a popup when the sheet takes focus, so there it runs on the
 * extension's own page. The passkey's PRF output wraps the unlock
 * proof; unlocking unwraps it and sends it to the server like a typed PIN,
 * so the server still checks and counts, and Remove still ends it. No PRF,
 * no offer: there is no stored-key fallback.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.4, step 3); docs/internal/plans/web-clipper.md (section 20, M2)
 */
import { browser } from 'wxt/browser';
import { base64ToBytes, bytesToBase64, decryptBytesAad, encryptBytesAad } from '@notes/shared';
import { deriveProofWrapKey } from '@notes/shared/extension';
import { readConnection } from './connection';
import { unlock, type UnlockResult } from './logins';

const KEY = 'biometric';
const PROOF_KEY = 'enrollProof';

interface Enrollment {
  credentialId: string;
  prfSalt: string;
  wrapped: string;
}

const aad = (tokenId: string) => `privacynotes-ext-proof-v1:${tokenId}`;

/** Whether this browser can make a passkey with a platform authenticator. */
export async function biometricPossible(): Promise<boolean> {
  try {
    return typeof PublicKeyCredential !== 'undefined' && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

export async function biometricReady(): Promise<boolean> {
  return !!(await browser.storage.local.get(KEY))[KEY];
}

// The proof waits for the enrollment page this long, and a lock clears it.
const STASH_MS = 2 * 60 * 1000;

/** Keep the proof for the enrollment page, in session storage only. */
async function stashProofForEnrollment(proof: Uint8Array): Promise<void> {
  await browser.storage.session.set({ [PROOF_KEY]: { proof: bytesToBase64(proof), at: Date.now() } });
}

function prfOf(cred: PublicKeyCredential | null): Uint8Array | null {
  const results = cred?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined;
  const first = results?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

/** Run on the dedicated page: make the passkey, wrap the stashed proof. */
export async function enroll(): Promise<boolean> {
  const held = (await browser.storage.session.get(PROOF_KEY))[PROOF_KEY] as { proof: string; at: number } | undefined;
  await browser.storage.session.remove(PROOF_KEY);
  const stashed = held && Date.now() - held.at < STASH_MS ? held.proof : null;
  return stashed ? enrollWith(base64ToBytes(stashed)) : false;
}

/** Make the passkey and wrap the proof under its PRF output. */
async function enrollWith(proof: Uint8Array): Promise<boolean> {
  const connection = await readConnection();
  if (!connection?.logins) return false;
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  try {
    const created = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'PrivacyNotes' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'PrivacyNotes', displayName: 'PrivacyNotes' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!created) return false;
    let prf = prfOf(created);
    // Some authenticators give the PRF output only at an assertion.
    if (!prf) {
      const got = (await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ type: 'public-key', id: created.rawId }],
          userVerification: 'required',
          extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      prf = prfOf(got);
    }
    if (!prf) return false;
    const { ciphertext, nonce } = encryptBytesAad(proof, deriveProofWrapKey(prf), aad(connection.tokenId));
    const wrapped = new Uint8Array(nonce.length + ciphertext.length);
    wrapped.set(nonce);
    wrapped.set(ciphertext, nonce.length);
    const enrollment: Enrollment = {
      credentialId: bytesToBase64(new Uint8Array(created.rawId)),
      prfSalt: bytesToBase64(prfSalt),
      wrapped: bytesToBase64(wrapped),
    };
    await browser.storage.local.set({ [KEY]: enrollment });
    return true;
  } catch {
    return false;
  }
}

/** Run on the dedicated page: the passkey unwraps the proof, the server checks it. */
export async function unlockWithBiometricHere(): Promise<UnlockResult> {
  const connection = await readConnection();
  const enrollment = (await browser.storage.local.get(KEY))[KEY] as Enrollment | undefined;
  if (!connection || !enrollment) return { kind: 'failed' };
  try {
    const got = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: base64ToBytes(enrollment.credentialId) as BufferSource }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: base64ToBytes(enrollment.prfSalt) as BufferSource } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const prf = prfOf(got);
    if (!prf) return { kind: 'failed' };
    const raw = base64ToBytes(enrollment.wrapped);
    const proof = decryptBytesAad(raw.subarray(24), raw.subarray(0, 24), deriveProofWrapKey(prf), aad(connection.tokenId));
    return await unlock({ proof });
  } catch {
    return { kind: 'failed' };
  }
}

/** From the popup: Chrome and Edge in place, Firefox on the dedicated page. */
export async function unlockWithBiometric(): Promise<UnlockResult> {
  if (!import.meta.env.FIREFOX) return unlockWithBiometricHere();
  await browser.tabs.create({ url: browser.runtime.getURL('/biometric.html#unlock') });
  window.close();
  return { kind: 'failed' };
}

/** From the popup, after the PIN was set at Connect: true once the passkey
 *  holds the proof. Firefox stashes the proof and opens the dedicated page,
 *  which answers there, so the popup hears false. */
export async function startEnrollment(proof: Uint8Array): Promise<boolean> {
  if (!import.meta.env.FIREFOX) return enrollWith(proof);
  await stashProofForEnrollment(proof);
  await browser.tabs.create({ url: browser.runtime.getURL('/biometric.html#enroll') });
  return false;
}
