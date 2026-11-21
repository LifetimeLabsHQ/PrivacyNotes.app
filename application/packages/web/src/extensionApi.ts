/**
 * The app's side of the browser extension's server: the connected
 * extensions, the logins key tag, a new pairing code, a key change, and
 * Remove. The demo makes none of these calls.
 * Spec: docs/internal/plans/browser-extension-build.md (sections 3 and 4)
 */
import type { SupabaseClient } from '@notes/shared';
import { isDemoMode } from './demo';
import { readFnErrorBody, type FnError } from './devices';

/** One connected extension, as the device list shows it. */
export interface ExtensionRow {
  id: string;
  /** A browser extension, or the command line `privacynotes` (Settings > Command line).
   *  Spec: docs/internal/plans/agent-cli.md (section 3.8) */
  client: 'browser' | 'cli';
  label: string;
  version: string | null;
  clips: boolean;
  logins: boolean;
  /** The logins key this extension holds; null without logins. */
  key_tag: string | null;
  created_at: string;
  last_used_at: string | null;
  last_clip_at: string | null;
}

export interface ExtensionState {
  extensions: ExtensionRow[];
  /** The account's current logins key tag, or null. */
  keyTag: string | null;
}

/** A refusal the server answered with a code the caller can act on. */
export class ExtensionCallError extends Error {
  constructor(readonly code: string) {
    super(`extension: ${code}`);
  }
}

function demoRefusal(): never {
  throw new ExtensionCallError('demo');
}

export async function loadExtensionState(supabase: SupabaseClient, pubkey: string): Promise<ExtensionState> {
  if (isDemoMode()) return { extensions: [], keyTag: null };
  const [tokens, account] = await Promise.all([
    supabase
      .from('extension_tokens')
      .select('id, client, label, version, clips, logins, key_tag, created_at, last_used_at, last_clip_at')
      .eq('user_pubkey', pubkey)
      .order('created_at', { ascending: true }),
    supabase.from('extension_accounts').select('key_tag').eq('user_pubkey', pubkey).maybeSingle(),
  ]);
  if (tokens.error) throw new ExtensionCallError('list_failed');
  if (account.error) throw new ExtensionCallError('list_failed');
  return {
    extensions: (tokens.data ?? []) as ExtensionRow[],
    keyTag: (account.data as { key_tag: string | null } | null)?.key_tag ?? null,
  };
}

/** Remove deletes the row: the token, its checker and Ksrv go together, and
 *  the inbox rows it posted, except its `loginedit` rows (0132). With
 *  `dropEdits` (Remove anyway) those go too, so the warning that what this
 *  app could not take in is lost stays true (beta #133), in one transaction
 *  that locks the token first, so a login edit posted with it meanwhile
 *  cannot outlive the remove (migration 0146, beta #198).
 *  Spec: docs/contrib/passkeys.md (section 5.4, App side of Remove) */
export async function removeExtension(supabase: SupabaseClient, pubkey: string, id: string, opts: { dropEdits?: boolean } = {}): Promise<void> {
  if (isDemoMode()) demoRefusal();
  if (opts.dropEdits) {
    const { error } = await supabase.rpc('extension_remove_anyway', { p_id: id });
    if (error) throw new ExtensionCallError('remove_failed');
    return;
  }
  const { error } = await supabase.from('extension_tokens').delete().eq('user_pubkey', pubkey).eq('id', id);
  if (error) throw new ExtensionCallError('remove_failed');
}

async function invokePair(supabase: SupabaseClient, body: Record<string, unknown>): Promise<void> {
  if (isDemoMode()) demoRefusal();
  const { error } = await supabase.functions.invoke('extension-pair', { body });
  if (!error) return;
  const answer = (await readFnErrorBody(error as FnError)) as { error?: unknown } | null;
  throw new ExtensionCallError(typeof answer?.error === 'string' ? answer.error : 'unreachable');
}

export function createPairingRow(
  supabase: SupabaseClient,
  row: { secretHash: string; tokenId: string; clips: boolean; logins: boolean; ksrv?: string; keyTag?: string; client?: 'cli'; kem?: string },
): Promise<void> {
  return invokePair(supabase, { action: 'create', ...row });
}

/** Replace the logins key, or turn logins off with `newTag` null. */
export function rekeyLogins(
  supabase: SupabaseClient,
  oldTag: string,
  newTag: string | null,
  ksrv: Record<string, string>,
): Promise<void> {
  return invokePair(supabase, { action: 'rekey', oldTag, newTag, ksrv });
}

/** One remaining browser's server half for the fresh browser half it sent
 *  (inbox kind `keyhalf`), under the account's current tag, named by
 *  `halfId` (migration 0156). Spec: docs/internal/plans/browser-extension-build.md (section 3.4 step 7) */
export function rehalfLogins(supabase: SupabaseClient, tokenId: string, tag: string, ksrv: string, halfId: string): Promise<void> {
  return invokePair(supabase, { action: 'rehalf', tokenId, tag, ksrv, halfId });
}
