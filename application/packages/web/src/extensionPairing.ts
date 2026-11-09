/**
 * Make the one-time code that connects a browser extension.
 *
 * The code carries the one-time secret, the account's inbox public key and,
 * with logins on, the browser's half Kext of the logins key P. The server gets
 * the hash of the secret and, with logins, the other half Ksrv; it never sees
 * the code. With logins on, the code shows only once P and Kext are in the
 * synced settings on the server, so a code that works always has a key the
 * apps hold.
 * Spec: docs/internal/plans/browser-extension-build.md (section 3.2)
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
import type { ExtensionKeys } from './extensionKeys';
import { loginsKeyFor, withBrowserHalf, withLoginsKey } from './extensionKeyring';
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
}

/** The code to show, valid once and for 10 minutes. Throws an
 *  ExtensionCallError with the server's code when the server refused. */
export async function makePairingCode(input: PairingInput): Promise<string> {
  const { supabase, pubkey, contentKey } = input;
  const inboxPublic = deriveInboxKeyPair(phraseToSeed(input.phrase)).publicKey;
  const secret = crypto.getRandomValues(new Uint8Array(PAIRING_SECRET_BYTES));
  const tokenId = crypto.randomUUID();

  if (input.client === 'cli' || !input.logins) {
    await createPairingRow(supabase, {
      secretHash: hashHex(secret), tokenId, clips: input.client === 'cli' ? true : input.clips, logins: false,
      ...(input.client === 'cli' ? { client: 'cli' as const } : {}),
    });
    resetExtensionSync();
    return encodePairingCode({ secret, inboxPublic, kext: null });
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
    }),
  ]);
  if (!saved) throw new ExtensionCallError('not_saved');
  resetExtensionSync();
  return encodePairingCode({ secret, inboxPublic, kext });
}
