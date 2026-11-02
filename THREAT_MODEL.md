# Threat Model

Last updated: 2026-10-31 (v0.714.0)

This document describes the security assumptions, trust boundaries, and known limitations of PrivacyNotes, for auditors, contributors, and users who want to know exactly what the system protects against and what it does not. It is the one place that says how each protection works and what it leaves open. [SECURITY.md](SECURITY.md) says what each protection does for you, [VERIFY.md](VERIFY.md) says how to check it, and the help answers link here instead of explaining it again.

## System overview

PrivacyNotes is an end-to-end encrypted personal workspace (notes, tasks, journal). A 12-word BIP-39 mnemonic phrase, generated client-side, is the sole root of trust. Every key and secret below is derived from it via HKDF-SHA256 with domain-separated info strings. Two of them carry the design:

1. **Ed25519 signing keypair** - the public key is the user's identity (pubkey); signatures authenticate sensitive API calls.
2. **XChaCha20-Poly1305 symmetric key** - encrypts all note content, attachments, user settings, and note version history before anything leaves the device.

Under self-custody, which every phrase sign-up uses, the phrase, private signing key, and encryption key never leave the client. The server stores ciphertext, nonces, and operational metadata: the pubkey, device rows with peppered fingerprint hashes (see "Devices and fingerprint hashes"), quota counters, and subscription records. The full user-facing accounting of that metadata, including the identifier-free import counters and the website-icon lookups, is SECURITY.md's "What we measure" section; this document does not repeat it. The server never stores plaintext content.

**Browser extension.** The extension never holds the key that opens your notes: it locks each clip with a key only your apps can open, and one of your apps turns it into a note. The server learns that an account uses the extension, when a clip arrives, roughly how large it is, and the browser's IP address; it never learns the page. With logins turned on, the server also stores a second encrypted copy of the vault items the extension shows (logins, credit cards, SSH keys without their private keys) and of the account's bookmarks, under a separate key that opens nothing else, and it sees how many there are and when they change. It keeps half of that key and a checker for the extension's PIN or passcode, and counts wrong tries; neither opens the logins without the half that stays in the browser. Residual: the one-time pairing code is all a browser needs to connect, so whoever pastes it first, within its 10 minutes, sets the PIN or passcode and can read the copy. The app names the browser that used the code while the code is on screen and marks a newly connected browser in Settings > Extension; Remove ends that browser's access but not what it already read.

**One exception, offered at OAuth signup and preselected there.** In custodial mode the phrase is stored server-side, encrypted under a server-held key, which makes the server capable of decrypting that user's data. Everything below describes self-custody unless stated otherwise; the custodial deviations are specified in "OAuth users" and are the single largest trust boundary in the system.

## Trust boundaries

### Fully trusted

- **The user's device.** An attacker with full device access (OS-level keylogger, memory inspection, code running as the user) can extract the phrase. Out of scope. A copy of the app's stored files taken without that access (a backup, a copied browser profile or app data folder, another account on a shared computer) is in scope: "Local storage at rest" sets out what such a copy yields with and without the app lock.
- **The user's browser/WebView.** We rely on Web Crypto API, IndexedDB, and localStorage behaving correctly.
- **The cryptographic primitives.** `@noble/ciphers`, `@noble/hashes`, `@noble/ed25519`, `@scure/bip39` - audited, widely deployed libraries by Paul Miller.

### Partially trusted

- **Supabase (server + database).** Sees pubkeys, ciphertext, nonces, timestamps, and the metadata listed above. Cannot read content. A compromised server can delete data, serve stale data, and observe access patterns (which pubkey syncs when, note count, ciphertext sizes). It cannot decrypt notes, and it cannot forge one from nothing. With database write access it can move one of your existing ciphertexts onto another of your rows, because the wire format carries no row binding yet (see "Known limitation: no AAD" below).
- **Cloudflare (CDN + Workers).** Serves the frontend bundle. A compromised deployment could serve malicious JS that exfiltrates the phrase - the standard supply-chain risk for any web app. Desktop (Tauri) builds bundle the frontend locally, which mitigates this.
- **Paddle (payment processor).** Receives transaction metadata, no note content. Webhooks verified via HMAC-SHA256.

### Untrusted

- **The network.** TLS everywhere; content is encrypted before transmission regardless.
- **Other users.** RLS policies enforce strict pubkey isolation.

## Cryptographic design

### Key derivation

```
BIP-39 phrase (128 bits entropy)
  → mnemonicToSeedSync (PBKDF2-HMAC-SHA512, 2048 iterations, salt "mnemonic", passphrase empty)
  → 64-byte seed (a stretch of the 128 bits above, not new entropy)
  → HKDF-SHA256(seed, salt=none, info="privacynotes-signing-v1")       → 32-byte Ed25519 private key
  → HKDF-SHA256(seed, salt=none, info="privacynotes-encryption-v1")    → 32-byte symmetric key
  → HKDF-SHA256(seed, salt=none, info="privacynotes-auth-password-v1") → 32-byte session credential
  → HKDF-SHA256(seed, salt=none, info="privacynotes-local-at-rest-v1")  → 32-byte local sealing key
  → HKDF-SHA256(seed, salt=none, info="privacynotes-fp-pepper-v1")      → 32-byte fingerprint pepper
  → HKDF-SHA256(seed, salt=none, info="privacynotes-clip-inbox-v1")     → 32-byte X25519 inbox key
```

The other four branches each have one narrow job: the session credential is a login secret (below), the local sealing key seals the device's own database ("Local storage at rest"), the fingerprint pepper keys the hashes that let the device limit recognize a returning device, so the hashes of one device differ between accounts, and the inbox key opens what a browser extension sealed to its public half (the "Browser extension" paragraph above). None of them can decrypt what the server holds.

**HKDF salt is omitted.** Per RFC 5869, an absent salt is a zero-filled string. Acceptable here: the input keying material is the 64-byte seed above, which carries the phrase's 128 bits of entropy, and domain separation comes from the info strings. An explicit salt could be added in a future derivation version but would not meaningfully improve security.

**The session credential is a login secret, not a key.** Returning devices re-mint their Supabase session by password grant against the account's existing auth user, using the auth-password HKDF branch (hex-encoded) as the password and the deterministic identifier `<pubkey>@phrase.privacynotes.app` as the login email. That address is an identifier in email shape: the domain receives no mail, and the server derives it from the signature-verified pubkey, never from client input. The server stores only a bcrypt hash of the credential; recovering the seed from it is not possible, and holding the credential grants exactly what holding a session grants - access to ciphertext the phrase holder could already fetch. Anonymous sign-in is used only for an account's first session.

### Encryption

- **Algorithm:** XChaCha20-Poly1305 (256-bit key, 192-bit nonce, 128-bit tag).
- **Nonce:** 24 bytes from `crypto.getRandomValues()` per encryption. The 192-bit nonce space makes random collisions negligible (~2^96 birthday bound).
- **Payload:** the note's JSON fields - title, body, tags, note type, metadata flags, and journal mood-tracker entries - are encrypted as a single blob. Health-adjacent data (mood tracking) sits inside the E2E envelope like everything else. The server stores base64 ciphertext and nonce.

**Known limitation: no AAD.** The note `id` and `user_pubkey` are not bound to the ciphertext, so an attacker with database write access could swap ciphertexts between rows of the same user undetected (cross-user swaps fail; the key differs). The same holds for attachments: nothing binds an object's ciphertext to its path, so a party with write access to the bucket could swap two objects of the same user. What a swap buys is an authentic but wrong object, never plaintext, and the precondition already lets that party delete or withhold data, which the Supabase entry above counts. Closing it needs a versioned AAD over the row or object identity and a format migration of every stored ciphertext and every client. It is not scheduled.

### Encrypted attachments

Images and file attachments use the same primitive via `encryptBlob` (`shared/src/blob.ts`): raw bytes encrypted under the user's symmetric key, 24-byte nonce prepended to the ciphertext. The original filename, MIME type, and size are encrypted inside the blob. The server sees an opaque object at path `<pubkey>/<uuid>` in a private storage bucket; RLS restricts each user to their own path prefix.

### Burn notes (one-time shares)

A burn note is encrypted client-side with a fresh random key that exists only in the share URL's fragment (`/burn#id=<uuid>&k=<hex>`). Fragments are never sent over HTTP, so the server holds ciphertext it can never decrypt, with no link to any account (creation is anonymous). Opening the link calls a consume-once RPC that deletes the row and returns the ciphertext in one statement; the table has no SELECT policy, so rows cannot be listed or re-read. Unopened notes are purged when the lifetime the sender picked runs out, at most 7 days.

### QR sign-in and phrase handoff

Adding a device via QR encodes the full phrase in a URL fragment (`#phrase=...`) displayed as a QR code on the trusted device. The fragment never traverses the network; the new device consumes it on load and clears it from the address bar via `history.replaceState`. That does not clear the browser's own records: the visited URL can stay in the browser history and session-restore data, and history sync can carry it off the device. After a QR sign-in through a camera app, delete that visit from the browser history; or use "Scan QR with camera" on the app's sign-in screen, which reads the code without navigating. A `#phrase=` fragment that reaches the marketing host is cleared there and the visitor lands on the app host with no fragment. The QR itself is equivalent to the phrase while displayed - treat it as a secret.

### Challenge-response authentication

Device registration, pubkey linking, custody changes, and account deletion use Ed25519 signatures over structured challenges (e.g. `link:<authUid>`, `register-device:<authUid>:<deviceId>`). The operation and the `authUid` are inside the signed string, so a signature cannot be moved to another operation or another account, and every signed call also needs a live session for that account. Residual: the challenges carry no nonce or expiry, and `authUid` does not change, so a captured signature verifies again for the life of the account. Someone who holds a live session and a signature captured earlier (from a log, a proxy that reads TLS, or a browser extension) can repeat that one operation, for example removing the stored custodial phrase again after the owner stored it anew.

## Local storage at rest

**Note content is sealed at rest on the device.** Rows in the `notes` store carry a version marker and one XChaCha20-Poly1305 ciphertext holding title, body, tags and tracker data, and beside it a second, smaller one holding the sync base (a fingerprint of each field of the version the device last synced, which the merge compares); the sealing key is a dedicated HKDF branch off the phrase (`privacynotes-local-at-rest-v1`), derived on unlock and never stored. The AAD binds each ciphertext to its table and row id, so a blob moved between rows or tables fails authentication - a binding the server-side format does not have yet. The same seal covers the parsed-document cache and, in raw-bytes form, the decrypted image and attachment caches (the attachment's filename metadata seals beside its bytes); the in-flight edit stash in localStorage seals under the same key. Sealing is enforced in one place - a middleware under the local database layer - and a CI gate inspects raw storage after driving every write path, so a future writer that bypasses it fails the build instead of leaking silently.

What a copy of the device's storage yields depends on what was copied and on the app lock:

- **A copied localStorage file alone, or a script-level dump,** carries ciphertext and the phrase envelope without its key: no readable notes and no readable phrase.
- **A copy of the whole browser profile or app data folder, without the app lock,** also carries the bytes of the key that opens the envelope (see "The phrase itself is wrapped" below), so a parser of the browser's files recovers the phrase, and with it the notes.
- **The same copy with the app lock on** carries no envelope: the phrase is stored only under the lock's own wraps, the one under the PIN or passcode, bounded by the offline search cost of that secret (see "PIN protection"), the biometric wrap, or both. Biometric unlock that is not bound to secure hardware or a passkey keeps its key in the same storage (see "Local phrase-at-rest: biometric and PIN wrapping"), and the lock is a setting of each device, so it covers only the devices where it is on (same section). The lock does not cover the sign-in session (end of the same section).

Outside the app's own storage, after a QR sign-in the browser's history can hold the sign-in URL with the phrase in it (see "QR sign-in and phrase handoff"). Fields the indexes and sync need stay readable on the row: id, timestamps, `dirty`, `deleted`, `trashed`, `starred`, `locked`, `pinProtected`, `type`, `folderId`, and the push-echo nonce - which is to say an attacker with the files still learns which rows exist, when they changed, and which are vault items, without reading any of them. Server-side these fields travel inside the wire ciphertext; locally the indexes need them.

Known residuals, deliberate and accepted: existing rows seal on the device's first unlock after the update that introduced sealing (no key exists before unlock, so the backlog waits); browser storage engines keep superseded values in free pages until compaction, so stale plaintext fragments can outlive the sweep for a while; the deduplication indexes store content hashes (an equality check against a known file, not content); the favicon cache keys on the domains in links and vault logins; the readable part of the local settings cache holds what the lock screen and the boot read before any key exists (the app lock switch, the PIN's salt and hash, the theme and layout choices), while favorite tags, tag and folder names and looks, device labels, custom trackers and themes, the journal title text and the medication list are sealed beside it; the custom theme in use keeps its code, name included, readable on the device, so the first paint needs no key; the day ledger keeps, per day, counts of the items made, the edits and the words written, and the edits in each hour of the day, with no text; the account panel cache holds user-entered device names and quota figures; an old sealed blob of the same row re-authenticates forever, so a disk-level rollback of one row to an earlier sealed version is undetectable (the format carries no freshness counter); the Markdown folder pillar edits the user's own files on their own disk, outside the seal by design; an item shared into the phone app from another app's share sheet waits outside the seal until the app is next signed in and unlocked, then is sealed and deleted from the inbox (on iOS the inbox is an app-group folder whose files carry complete data protection, so the OS keeps them encrypted while the phone is locked; on Android it is the app's private data folder); calendar alerts on a phone are handed to the operating system ahead of time so they ring while the app is closed, and with "Show titles in reminders" on, each alert handed over while the app lock is off has its item title and folder name held by the system's notification scheduler, outside the seal, until the alert has rung and been cleared or the app schedules it again (an alert scheduled while the app lock is on, and always one for an item behind the PIN, carries only "Reminder" and its time; one handed over before the lock was turned on keeps its title until then); and the throwaway demo database stays plaintext because its keys derive from a public constant. Process memory is out of scope while the app runs - an app that shows notes holds notes. The real boundary for a lost or stolen machine remains OS full-disk encryption and screen lock, which the app cannot implement and should not imply.

**The phrase itself is wrapped.** Without the app lock, the stored recovery phrase is an AES-GCM-256 envelope in trust-aware storage, encrypted under a non-extractable WebCrypto key that IndexedDB keeps as a key object (`phraseAtRest.ts`). "Non-extractable" is a script-API property, not hardware: the browser never hands the key's bytes to script, but it writes them into its own IndexedDB files, so a copied localStorage file alone carries no readable phrase and a copy of the whole profile or app data folder opens the envelope. An attacker who can run code in the app's origin calls the key directly, and one with the live browser profile on the same machine boots the app signed in. The wrap is best-effort by design: on a browser without working IndexedDB or WebCrypto, the app falls back to the old plaintext write rather than locking the user out, leaves a breadcrumb in the auth log, and warns in Settings > Security > PIN for as long as the phrase stays unwrapped (the app lock takes it out of storage). Installs that predate the wrap migrate on their next boot.

An attacker who can run code on the device (malware, a malicious extension with the right permissions, anyone at the unlocked machine) reads notes through the same door the app does; that is out of scope (see "Out-of-scope threats"). The per-note lock and PIN-protect flags are gates at the client's trust level, not per-note cryptography (see "Lock / PIN-protect notes").

Sign-out clears the local database (`clearLocalDatabase`), including the parsed-document cache and the separate favicon cache, after it removes the phrase, the biometric wrap and the PIN wrap; that wipe deletes by key on the sealed tables, because it runs after the seal key is zeroed. A sign-out the user chooses first uploads unsent notes and settings with no time limit, and asks before it goes on when that upload fails (`signOutUpload.ts`). A forced sign-out (device removed, session gone, device limit) keeps the unsent rows through the wipe, still sealed, with no phrase left on the device to open them. Account deletion (`deleteEntireLocalDatabase`) drops everything.

### Devices not marked as trusted

Phrase sign-in asks whether to trust the device ("Trust this device", ticked by default); an OAuth sign-in always trusts it. On a device that is not trusted, the wrapped phrase envelope and the auth session are written to `sessionStorage` instead of `localStorage`, so the browser drops them when the tab or window closes and the next visit asks for the phrase again. App lock and biometric unlock cannot be switched on there. Neither the PIN wrap nor the PIN's salt and hash is written to that device's disk: the settings cache withholds those fields, the PIN hash cache follows the session into `sessionStorage` (`pin.ts`), and a PIN set there is wrapped in memory for the account only, so the device holds nothing to search offline. The PIN lockout counter stays in `localStorage` on purpose; it holds a count, no secret.

The sealed local database stays on disk after the tab closes. Its sealing key derives from the phrase and is never stored, so without the phrase the rows are ciphertext. Signing in to a different account in the same browser wipes it first. The readable residuals listed above (the local settings cache, the day ledger, the account panel cache) stay on the device as they do on a trusted one.

`sessionStorage` is not memory-only. A browser can write it to its own session-restore files, and a browser set to restore the previous session can bring the tab back signed in. While the tab is open, the device-trust limits above apply in full: an attacker who can run code in the open tab reads notes the way the app does. On a shared machine, use a private window and close it when done.

## PIN protection

The app lock secret is a 4-digit PIN or, optionally, a passcode of 8 to 256 characters that is not only digits. Its offline bound depends on which: a PIN is 10,000 values, brute-forced in minutes to hours by anyone holding the stored material, regardless of iteration count; a passcode raises that cost with its length and alphabet. With the app lock armed, the phrase is stored wrapped under this secret, under biometric unlock, or under both (see "Local phrase-at-rest: biometric and PIN wrapping"), and note content at rest is sealed under a phrase-derived key, so where the secret's wrap is the only one, the secret stands at the end of a real cryptographic chain for file-access attackers, within that bound. Users needing more than the secret can resist should rely on OS-level device encryption and screen lock.

### Implementation

- **Hash:** PBKDF2-SHA256, 600,000 iterations, a random salt (16 bytes for a PIN, 24 for a passcode; the length records which), constant-time comparison. The secret is normalized to Unicode NFC before derivation.
- **Legacy hashes:** PINs set before the iteration bump used 100,000 iterations. Such a hash still verifies, and the weaker hash stays in storage until the PIN is changed; a changed PIN or passcode is hashed at 600,000.
- **Storage:** hash and salt in `UserSettings` (encrypted, synced) plus a local cache, in `localStorage` on a trusted device and `sessionStorage` on one that is not; per-tab session unlock with a configurable timeout. When two devices both changed the PIN since their last sync, the server's version wins and the other device says once that its change was not saved.
- **UI lockout:** 5 consecutive failures lock PIN entry for 30 seconds, doubling on each further failure. The counter lives in localStorage (survives tab close) and is shared across every surface that asks for the PIN or passcode, so attempts cannot be split across views. This blocks casual in-browser guessing only; it does not slow the offline attack above.

### Lock / PIN-protect notes

The `locked` and `pinProtected` flags live inside the ciphertext and are enforced client-side only; any client holding the phrase decrypts everything regardless. Deliberate: a second, PIN-derived key would make those notes unrecoverable on a forgotten PIN. These are organizational privacy features, not cryptographic access control.

### Local phrase-at-rest: biometric and PIN wrapping

On a trusted device the phrase is stored locally (as the wrapped envelope described in "Local storage at rest") so the user can unlock without retyping it. Two optional features replace that envelope with a user-secret wrap. The app lock, its re-lock window and the PIN's re-ask window are settings of each device and do not sync. Enabling app lock removes the envelope on that device, and the post-unlock sign-in never writes it back while the lock is armed. A device where the lock is off keeps its envelope, and a copy of that device's storage opens the phrase. A device that signs in copies the lock setting the account holds with its first settings sync; when that setting is on, the device removes its envelope once the account's PIN or passcode wrap has arrived there (`syncPinWrap` in `pinRecovery.ts`). Until then, and when the account holds no PIN or passcode wrap, the envelope stays. A boot-time rewrap of an install that predates the envelope can, rarely, write it back after the strip. The secret's wrap and an unbound biometric are convenience gates at the device's trust level:

- **Biometric unlock.** In the apps, the device's secure hardware releases the secret the wrap key comes from: on Apple devices a Secure Enclave key, whose sealed copy the app stores and which only that device's enclave can use; on Android a Keystore key that needs a strong biometric for each use; on Windows a Windows Hello key, whose signature over a stored random challenge is the secret. HKDF-SHA256 over the secret gives a non-extractable AES-GCM-256 key that wraps the phrase, and neither the secret nor the key is stored. The Apple and Android keys accept any biometric enrolled on the device, so a person who knows the device passcode can add a fingerprint or face and open it; Windows Hello also accepts the Windows Hello PIN. Removing every biometric or the device passcode leaves the key unusable or destroys it, and the PIN, the passcode or the phrase then unlocks. In a browser whose passkey provider supports the WebAuthn PRF extension, HKDF-SHA256 over the PRF output gives the key; it is derived again at each unlock and never stored. The passkey's check accepts whatever user verification the provider accepts, which can include the device password. When the passkey syncs (iCloud Keychain, Google Password Manager, a password manager), the provider account holds the credential, so the wrap is as strong as that account plus a copy of the storage. Everywhere else (a device without a strong biometric or secure hardware, a browser or passkey provider without PRF, an app enrollment made before the binding until its next unlock, and a browser enrollment not tied to a passkey until it is set up again), biometric unlock is a presence gate: a random AES-GCM-256 key wraps the phrase and sits in local storage beside it, the biometric check decides whether the app reads the key, and a copy of that storage opens the phrase without the biometric. While a presence gate is on, a longer app lock secret does not raise the cost of that attack. Settings shows which kind each device has; in a browser it offers to set an enrollment that is not tied to a passkey up again, and in the apps an older enrollment becomes bound on its next biometric unlock.
- **Secret-wrapped phrase.** With app lock enabled, the phrase is wrapped with an AES key derived from the PIN or passcode (same PBKDF2 parameters and salt lengths as above) and stored in synced `UserSettings` plus localStorage. Offline brute-force of the wrapped blob recovers the **master phrase** - the root key for the whole account - which is sharper than the per-note gate and accepted: it requires a copy of a trusted device's storage, and it costs the offline search set out in "PIN protection". (The device-key envelope needs no search at all: a copy of the whole profile carries the envelope and its key's bytes together. The app lock exists to replace it with a wrap that costs a search.)

User-facing copy describes the app lock secret and an unbound biometric as gates, not encryption.

The app lock protects the phrase, not the sign-in session. A copy of a locked device's storage still holds that session, which can delete or overwrite the account's notes on the server but cannot read them; on a custodial account it can also fetch the stored phrase unless two-factor sign-in is on. Accepted as a residual: it needs a copy of the device's files, which full-disk encryption already blocks.

## Sync, conflicts, and deletion

- **Model:** pull-then-push per device. The pull follows a server-assigned change clock; every note also carries a client edit stamp (`updated_at`).
- **Conflicts:** a push lands only on the server version the device last synced, so a device that has not caught up does not overwrite a newer version: it merges field by field against the version it last synced. A change made on one device only is kept. Text edited on two devices while apart opens a resolution dialog on the device that syncs second, and both versions are kept until the user chooses. When both devices changed the same field (a pin, a folder, a title), the field from the device that edited the note last, by that device's clock, is kept, without a dialog: a note carries one edit stamp, not one per field, so a later edit to any of its fields decides. A copy restored from a backup takes the record of the note it replaces and merges the same way. A note that already carried an unsynced change before the device began recording its synced version merges by comparing edit stamps field by field, and any difference in its text opens the dialog. A permanent delete on one device removes the note everywhere, including an edit another device made while apart.
- **Deletion and retention:** moving a note to the Trash is an edit like any other (the flag sits inside the ciphertext), and the note stays restorable from the Trash. Each device permanently deletes trashed notes 30 days after they were trashed, once it has pulled the account's notes and settings, unless the account has switched the Trash's auto-delete off, in which case they stay until deleted by hand. A permanent delete writes a tombstone (`deleted_at`) that syncs to other devices and cannot be undone: no client path restores a tombstone, and a trigger drops every later write to the row. The server removes the note's ciphertext and version history in the same transaction that accepts the tombstone. The tombstone itself stays, holding only the note id, the account's public key and timestamps, so a device that returns after any time offline still learns of the delete; deleting the account removes it. Encrypted files the note referenced stop counting toward the quota at once and leave storage after a short grace period, normally one day and at most a few days. A permanent delete needs a live session (one that passed two-factor, when it is on) and no key, so a stolen session can delete every note on the server. A device that would lose more than ten notes it still shows within a day keeps them and asks; keeping them puts them back on the server under new ids. Below that count, or once the user agrees to the delete, each device deletes its own copies at its next sync. Notes already in the Trash never count, because only the key holder can move a note there. A device keeps an edit that had not reached the server as a new note either way; every other deleted note is gone unless a device kept it or the user holds an export. The version history of a deleted note is gone in every case.

## Deletion metadata

- Deleting an attachment queues its opaque blob id in a server-side pending set (`pending_blob_gc`), so the server learns "a blob was deleted around time T" at delete time rather than at the deferred sweep. Owner-scoped by RLS; blob contents stay encrypted throughout.

## Devices and fingerprint hashes

Each registered device has a server-side row: user-visible name, platform, last-seen timestamp, and four fingerprint hashes used to group multiple browsers on one physical machine into a single device entry. The signals - platform, GPU renderer string, CPU core count, browser language - are hashed client-side with HMAC-SHA256 under a per-user pepper derived from the BIP-39 seed. Raw signal values never leave the device, and the server cannot brute-force the low-entropy signals because it never holds the pepper. Hashes are incomparable across users.

## Two-factor sign-in

Two-factor sign-in is optional. Supabase Auth verifies six-digit TOTP codes; the setup QR is rendered on the device. The server stores the authenticator secret. This is a server access control and does not change encryption: somebody with the phrase can decrypt ciphertext they already possess, and an unlocked device remains in scope for its owner. A compromised server can bypass this access control.

Enabling account management establishes one canonical Auth user for a pubkey, using the existing phrase-derived credential. The same user owns every TOTP factor. A phrase password grant reaches that user directly. An explicitly connected OAuth identity reaches it through the account-logins edge function: the native one-use PKCE exchange identifies the exact provider, the edge creates a native canonical AAL1 session, and a database transaction registers its provider origin before tokens leave the edge. Native automatic same-email linking does not make an unapproved provider connection active. Connecting a provider cannot merge two vaults or change key custody.

Protected managed-account data requires the canonical user and a live session created by the phrase password grant or an active registered provider connection. When an authenticator is enabled, the same check requires a current verified factor and a current AAL2 session, not merely an AAL2 claim in an old JWT. Restrictive policies protect client data and storage; protected SECURITY DEFINER RPCs and session edge functions apply the same gate. A denied read of rows the account holds raises an explicit error, so sync cannot mistake refusal for an empty account; a denied read of an account or a folder that holds no row answers empty, which tells the caller nothing new. Caller-only setup/status RPCs remain available before this gate, with connected-account details withheld when access is denied. Intentionally public share endpoints and unmanaged accounts retain their existing contracts.

Account connections and factor enrollment/removal require an Ed25519 signature over a single-use, expiring challenge bound to the user, session, pubkey, operation and exact payload digest. With MFA enabled, these mutations and custody changes require a TOTP verification from the last five minutes; account deletion checks freshness before deleting data. Native factor triggers consume a factor-specific signed intent. A client calling the native API directly cannot activate or delete a verified authenticator without that proof. The verified account-deletion service has a separate, scoped factor-cleanup function. Password identity guards reject native credential replacement while permitting native database encryption rewrapping; the integration harness pins both behaviors against Auth v2.197.0. A platform Auth upgrade needs the same integration checks.

Recovery uses the reusable authenticator setup secret, named the 2FA backup key, saved outside PrivacyNotes. Setup hides the original and requires confirmation from the saved copy before activation. The key restores codes in another authenticator; it does not replace the phrase or a provider login. There is no email reset, operator recovery or alternate bypass. Losing both authenticator and backup blocks new server access. Existing locally unlocked notes remain readable and exportable. The code prompt is outside network timeouts; cancellation and service failures never wipe local data.

Disconnecting a provider removes its authorization and revokes every canonical session recorded for that connection. Before removing the current provider, the app proves the phrase login and performs fresh MFA in that session. A custodial account must keep an active provider or explicitly switch to self-custody first. Account deletion removes connections and factors but keeps a pubkey revocation tombstone, so still-valid old alias JWTs cannot regain access when the other records disappear. Reclaiming a deleted pubkey requires the phrase password proof; an old provider token is insufficient.

## OAuth users

OAuth (Google, Apple, GitHub) is an identity-only sign-in path. At first OAuth sign-in the user chooses a key custody model, on a screen that preselects custodial.

### Account identity and cross-provider linking

For accounts that have not opted into account management, account resolution is decided by Supabase GoTrue by **confirmed email**, not the provider's `sub`: a second provider reporting the same verified email merges into the same `auth.users` row, hence the same pubkey and notes. This is the load-bearing feature that lets a Google signup later sign in with Apple.

**Safety condition:** this is safe only because every enabled provider proves email ownership. Merging into a victim's account requires controlling the victim's email address, at which point most of their accounts are already lost - the standard property of email-based OAuth linking.

**Invariant (do not break):** never enable an auth method that can present an unverified email as confirmed (e.g. email/password without verification, a misconfigured magic-link path). Such a method would let an attacker merge into a custodial victim's account and call `get-custodial-phrase` to retrieve the plaintext phrase. Self-custody users would be unaffected; custodial users would be fully compromised.

**How the session credential complies:** the email provider is enabled (password grant for the re-mint credential above) with confirmation required, so a self-serve signup can never yield a signed-in, confirmed identity. The pubkey link and signed account-management activation confirm exclusively `<pubkey>@phrase.privacynotes.app` - composed server-side from a pubkey proven by ed25519 signature, on a domain the project controls and no identity provider can assert. No attacker-chosen address can reach a confirmed state through it.

**Known UX failure mode (data-loss-shaped, not a security issue):** if the second provider returns a different email (Apple's "Hide My Email" relay, or simply a different address), no merge occurs and the user silently lands in a fresh, empty account. Custodial users are hit hardest, as they are least likely to have saved their phrase. Onboarding surfaces phrase / QR recovery prominently for this reason.

### Self-custody (maximum privacy)

The phrase is generated client-side and never transmitted. The server stores only the pubkey under `app_metadata.pubkey`; OAuth proves identity and grants no access to key material. A new device requires the phrase or a QR sign-in from an existing device.

### Custodial (keep it simple)

The OAuth choice screen preselects this mode. A phrase account can explicitly connect a provider in Settings and then choose custody separately. Continuing with it stores the phrase server-side, encrypted with AES-256-GCM under a dedicated server secret (`CUSTODIAL_PHRASE_KEY`), enabling 1-click sign-in on new devices.

**Trust implications** (the user-facing statement is SECURITY.md's custodial section; these are the mechanics):

- The server operator, or anyone holding both database access and the secret, can decrypt the user's phrase and therefore all their data. A valid legal order could compel this. Database-only breaches stay unreadable.
- Custody is reversible from Settings > Account > Key custody: leaving deletes the `custodial_phrases` row, returning re-inserts it. Both directions require an eligible live account session AND an Ed25519 signature over a challenge, with fresh MFA when enabled, so a stolen session token alone cannot change custody mode. Cost of reversibility: the plaintext phrase can reach `store-custodial-phrase` from any signed-in device at any time; the signature bounds who, not when or where.

**Known limitations (flagged for audit):**

- `get-custodial-phrase` requires a valid eligible session and current AAL2 when MFA is enabled, but no phrase signature challenge. A stolen eligible session suffices to exfiltrate the phrase for as long as the session stays valid: sessions have no timebox and no inactivity timeout, so a copied session keeps refreshing until it is signed out or revoked. Refresh-token rotation ends the copy at the legitimate device's next refresh, so a device that stays closed leaves the window open. A signature challenge is not straightforward here: the user may not yet hold a signing key (the phrase is needed to derive it).
- `store-custodial-phrase` validates word count but not BIP-39 wordlist membership. Low risk: the call is signed, so callers can only store a phrase they already hold, corrupting only their own account.
- Neither custodial endpoint has rate limiting beyond platform defaults, notable given what `get-custodial-phrase` returns.
- The decrypted phrase transits isolate memory during `get-custodial-phrase` responses with no explicit zeroing; inherent to the runtime.

### Native sign-in return address

On Android and iOS a native sign-in returns to an https address that the operating system delivers only to our signed app (Android App Links, iOS Universal Links). No custom URL scheme is an accepted return address, because any installed app can claim a scheme. Desktop operating systems do not verify which application receives a return address, so an application installed on the same machine can impersonate the app during sign-in; that is device compromise (see "Out-of-scope threats"). `get-custodial-phrase` requires an eligible session and MFA when enabled, and the server records every release: which account, and when.

**Historical note:** before v0.152.0, an edge function derived OAuth users' phrases server-side from a secret pepper, silently. It was removed in v0.173.4 after all affected users migrated; the explicit custodial opt-in replaced it.

## Out-of-scope threats

- **Device compromise:** OS-level malware, keyloggers, memory inspection, or storage read by code running on the device. A copy of the stored files taken without that access is in scope (see "Trust boundaries"). A hostile program running under your own user account counts as device compromise: it has the same access to the app's storage and keys as the app itself. A sandboxed app from a store does not have that access, so what it can do from inside its sandbox, such as registering a URL scheme or opening a sign-in sheet, is in scope. That is why the native sign-in return address is bound to our app.
- **Supply-chain attacks on the web bundle:** a compromised CDN could serve malicious JS. Mitigated for desktop (bundled frontend); SRI / reproducible builds not yet implemented for web.
- **Denial of service** against Cloudflare or Supabase.
- **Clipboard exposure:** once a secret is copied, the OS clipboard is outside our control. We deliberately make no clipboard-wipe claims; a timed wipe from a background tab is unreliable and would be security theater.
- **Social engineering** that extracts the phrase from the user.
- **Quantum computing:** XChaCha20 at 256 bits is quantum-resistant; Ed25519 is vulnerable to Shor's algorithm, not a near-term practical concern.
