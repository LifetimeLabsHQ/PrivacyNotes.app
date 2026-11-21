/**
 * Make the one-time code that connects a browser extension.
 *
 * The code carries the one-time secret, the account's inbox public key and,
 * with logins on, the browser's half Kext of the logins key P. The server gets
 * the hash of the secret and, with logins, the other half Ksrv; it never sees
 * the code. With logins on, the code shows only once P and Kext are in the
 * synced settings on the server, so a code that works always has a key the
 * apps hold.
 *
 * A version 2 code (`PAIRING_CODE_SIGNED`) also carries a sender seed of its
 * own for the connection, and the hash of the account's ML-KEM public key:
 * the connection then seals signed, quantum-safe rows. Its sender key is in
 * the synced settings before the code shows, for every kind of code.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.2);
 * docs/internal/plans/inbox-signed-hybrid.md (sections 4.4 and 5.1)
 */
import { bytesToBase64, phraseToSeed, type SupabaseClient } from '@notes/shared';
import {
  deriveInboxKeyPair,
  encodePairingCode,
  hashHex,
  newLoginsKey,
  PAIRING_SECRET_BYTES,
  splitLoginsKey,
} from '@notes/shared/extension';
import { createPairingRow, loadExtensionState, rekeyLogins, ExtensionCallError } from './extensionApi';
import { withoutEntries, type ExtensionKeys } from './extensionKeys';
import { loginsKeyFor, withBrowserHalf, withLoginsKey, withSender } from './extensionKeyring';
import { resetExtensionSync } from './extensionSync';

export interface PairingInput {
  supabase: SupabaseClient;
  pubkey: string;
  phrase: string;
  contentKey: Uint8Array;
  clips: boolean;
  logins: boolean;
  /** A code for the command line `privacynotes`: clips only, never logins.
   *  Spec: docs/internal/plans/agent-cli.md (section 3.2) */
  client?: 'cli';
  readKeys: () => ExtensionKeys;
  saveKeys: (update: (keys: ExtensionKeys) => ExtensionKeys) => void;
  /** Push the settings now; true once the server holds them. */
  pushKeys: () => Promise<boolean>;
  /** The tests' stand-in for `PAIRING_CODE_SIGNED`. */
  signed?: boolean;
}

/**
 * Make version 2 codes. Off until the app release floor is at the release
 * that reads signed rows (an older app drops the sender entries and leaves
 * signed rows waiting), and the extension and command line releases that
 * read a `pnx2` code are live. Spec: docs/internal/plans/inbox-signed-hybrid.md (section 9, step 4)
 */
export const PAIRING_CODE_SIGNED = false;

interface SignedPart {
  code: { kemHash: Uint8Array; seed: Uint8Array };
  kem: string;
  keyId: string;
}

/** The seed of a version 2 code, its sender entry in the settings, and the
 *  account's ML-KEM public key for the server. ML-KEM loads only here. */
async function signedPart(input: PairingInput, tokenId: string): Promise<SignedPart> {
  const { deriveInboxKemKeyPair, deriveInboxSender, inboxKemHash } = await import('@notes/shared/inbox-signed');
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const sender = deriveInboxSender(seed);
  const kem = deriveInboxKemKeyPair(input.contentKey);
  kem.secretKey.fill(0);
  input.saveKeys((k) => withSender(k, input.contentKey, sender.keyId, { client: input.client === 'cli' ? 'cli' : 'browser', tokenId, publicKey: sender.publicKey }));
  sender.secretKey.fill(0);
  return { code: { kemHash: inboxKemHash(kem.publicKey), seed }, kem: bytesToBase64(kem.publicKey), keyId: sender.keyId };
}

/** A version 2 code that is never shown leaves no signer behind: its entry
 *  is cleared when the server row or the push failed (code review 3). */
async function orForget<T>(input: PairingInput, signed: SignedPart | null, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (signed) input.saveKeys((k) => withoutEntries(k, [`s:${signed.keyId}`]));
    throw err;
  }
}

/** The code to show, valid once and for 10 minutes. Throws an
 *  ExtensionCallError with the server's code when the server refused. */
export async function makePairingCode(input: PairingInput): Promise<string> {
  const tokenId = crypto.randomUUID();
  const signed = (input.signed ?? PAIRING_CODE_SIGNED) ? await signedPart(input, tokenId) : null;
  return orForget(input, signed, () => makeCode(input, tokenId, signed));
}

async function makeCode(input: PairingInput, tokenId: string, signed: SignedPart | null): Promise<string> {
  const { supabase, pubkey, contentKey } = input;
  const inboxPublic = deriveInboxKeyPair(phraseToSeed(input.phrase)).publicKey;
  const secret = crypto.getRandomValues(new Uint8Array(PAIRING_SECRET_BYTES));

  if (input.client === 'cli' || !input.logins) {
    // A version 2 code shows only once its sender key is up, as a code with
    // logins waits for its key: an app that closed before the next sync would
    // leave every row of the connection waiting for a sender nobody knows.
    const [saved] = await Promise.all([
      signed ? input.pushKeys() : Promise.resolve(true),
      createPairingRow(supabase, {
        secretHash: hashHex(secret), tokenId, clips: input.client === 'cli' ? true : input.clips, logins: false,
        ...(input.client === 'cli' ? { client: 'cli' as const } : {}),
        ...(signed ? { kem: signed.kem } : {}),
      }),
    ]);
    if (!saved) throw new ExtensionCallError('not_saved');
    resetExtensionSync();
    return encodePairingCode({ secret, inboxPublic, kext: null, ...(signed ? { signed: signed.code } : {}) });
  }

  const state = await loadExtensionState(supabase, pubkey);
  let tag = state.keyTag;
  let p = tag ? loginsKeyFor(input.readKeys(), contentKey, tag) : null;
  if (tag && !p) {
    // The server names a key no app of this account holds: a code made on a
    // device that never sent its settings. With no extension left on it,
    // the key is released and a new one made; otherwise its owner has it.
    if (state.extensions.some((e) => e.logins)) throw new ExtensionCallError('key_elsewhere');
    await rekeyLogins(supabase, tag, null, {});
    tag = null;
  }
  if (!tag || !p) {
    const fresh = newLoginsKey();
    tag = fresh.tag;
    p = fresh.p;
    const newTag = tag;
    const newP = p;
    input.saveKeys((k) => withLoginsKey(k, contentKey, newTag, newP));
  }
  const { kext, ksrv } = splitLoginsKey(p);
  const keyTag = tag;
  input.saveKeys((k) => withBrowserHalf(k, contentKey, tokenId, kext));
  // A code whose key lived only in this app's local settings would strand
  // the extension if this app closed before the next sync, so no code is
  // shown until the key is up. The server row goes in at the same time: a
  // row whose push failed holds the hash of a secret nobody has, expires in
  // 10 minutes, and this app still holds the key it names.
  const [saved] = await Promise.all([
    input.pushKeys(),
    createPairingRow(supabase, {
      secretHash: hashHex(secret), tokenId, clips: input.clips, logins: true, ksrv: bytesToBase64(ksrv), keyTag,
      ...(signed ? { kem: signed.kem } : {}),
    }),
  ]);
  if (!saved) throw new ExtensionCallError('not_saved');
  resetExtensionSync();
  return encodePairingCode({ secret, inboxPublic, kext, ...(signed ? { signed: signed.code } : {}) });
}
