/**
 * Known-answer tests for the crypto core.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every key in PrivacyNotes descends from one 12-word phrase through a fixed
 * derivation path. If that path ever shifts by a byte, existing users do not get an
 * error: they get a different key, their vault silently fails to decrypt, and the app
 * looks like it lost their notes. `tsc` cannot see that. A build passing cannot see
 * that. Only a fixed input with a fixed expected output can see that.
 *
 * So these are known-answer tests (KATs), not unit tests. Every expectation below is a
 * literal, and a literal changing is the alarm. They exist mainly so that upgrading
 * @noble/@scure is a verified ten-minute job instead of a leap of faith over
 * every user's data.
 *
 * ZERO DEPENDENCIES ON PURPOSE
 * ----------------------------
 * Uses node:test and node:assert, built into Node 22, and imports the already-compiled
 * packages/shared/dist. No vitest, no jest, no config, nothing new in the lockfile, and
 * no bundler: it runs anywhere Node runs, including CI and a sandbox.
 *
 *   pnpm --filter shared build && node --test tools/crypto-kat.mjs
 *
 * IF A VECTOR FAILS
 * -----------------
 * Do NOT update the literal to match the new output. That is the test working. A changed
 * vector means the derivation changed, which means every existing vault is now
 * undecryptable. Find out why it moved. The only legitimate reason to edit a vector is a
 * deliberate, versioned migration of the derivation itself, and that needs a plan for
 * everyone already holding a phrase.
 *
 * Spec: docs/public/THREAT_MODEL.md (cryptographic design), docs/internal/dependency-migration.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generatePhrase,
  isValidPhrase,
  phraseToSeed,
  deriveSigningKey,
  deriveEncryptionKey,
  deriveLocalDataKey,
  deriveAuthPassword,
  authEmailForPubkey,
  signLinkChallenge,
  deriveDeviceId,
  signDeviceRegisterChallenge,
  signDeviceRevokeChallenge,
  deriveFpPepper,
  computeFpHashes,
  bytesToHex,
  hexToBytes,
  bytesToBase64,
  base64ToBytes,
  bytesToBase64url,
  base64urlToBytes,
  encryptNote,
  decryptNote,
  encryptJson,
  decryptJson,
  encryptJsonAad,
  decryptJsonAad,
} from '../packages/shared/dist/index.js';
import {
  deriveInboxKeyPair,
  inboxItemId,
  sealInbox,
  openInbox,
  padInboxJson,
  inboxRowVersion,
  encodePairingCode,
  decodePairingCode,
  hashHex,
  deriveUnlockProof,
  unlockChecker,
  deriveLoginsWrapKey,
  deriveLoginsIdKey,
  loginsRowId,
  splitLoginsKey,
  serverHalf,
  joinLoginsKey,
} from '../packages/shared/dist/extension.js';

/**
 * The canonical BIP-39 test phrase. Deliberately the all-zeros-entropy vector from the
 * BIP-39 spec, so the seed below is independently checkable against any other BIP-39
 * implementation on earth rather than only against ourselves.
 */
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Second phrase, to prove different phrases produce unrelated keys. */
const PHRASE_2 =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

// ------------------------------------------------------------------------------------
// BIP-39: phrase to seed
// ------------------------------------------------------------------------------------

test('phraseToSeed matches the published BIP-39 vector', () => {
  // BIP-39 with an EMPTY passphrase, i.e. PBKDF2-HMAC-SHA512(mnemonic, "mnemonic", 2048, 64).
  // Independently reproducible without any of our code:
  //
  //   python3 -c "import hashlib;print(hashlib.pbkdf2_hmac('sha512',
  //     b'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  //     b'mnemonic', 2048, 64).hex())"
  //
  // Note the trap: the BIP-39 spec's own published vector table uses the passphrase
  // "TREZOR" and gives c55257c3... for this same mnemonic. We use no passphrase, so ours
  // is 5eb00bbd.... Do not "correct" this to the c55257c3 value; that would be testing a
  // configuration we do not ship.
  //
  // If this line fails, @scure/bip39 is no longer producing standard BIP-39 seeds and
  // NOTHING below it can be trusted.
  assert.equal(
    bytesToHex(phraseToSeed(PHRASE)),
    '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
  );
});

test('phraseToSeed is insensitive to case and surrounding whitespace', () => {
  const canonical = bytesToHex(phraseToSeed(PHRASE));
  assert.equal(bytesToHex(phraseToSeed(`  ${PHRASE}  `)), canonical);
  assert.equal(bytesToHex(phraseToSeed(PHRASE.toUpperCase())), canonical);
});

test('isValidPhrase enforces the BIP-39 checksum', () => {
  assert.equal(isValidPhrase(PHRASE), true);
  assert.equal(isValidPhrase(PHRASE.toUpperCase()), true);
  // Real words, wrong checksum.
  assert.equal(
    isValidPhrase(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
    ),
    false,
  );
  assert.equal(isValidPhrase('not actually a mnemonic at all'), false);
  assert.equal(isValidPhrase(''), false);
});

test('generatePhrase produces 12 valid words with real entropy', () => {
  const a = generatePhrase();
  assert.equal(a.split(' ').length, 12);
  assert.equal(isValidPhrase(a), true);
  // Not a proof of randomness, but catches a stub or a constant.
  assert.notEqual(a, generatePhrase());
});

// ------------------------------------------------------------------------------------
// HKDF key derivation. These two vectors are the load-bearing ones: the encryption key
// IS the vault, and the signing pubkey IS the account identifier.
// ------------------------------------------------------------------------------------

// The vault key. If this literal changes, every existing note on every device becomes
// undecryptable. There is no error path for that: it just looks like the data is gone.
// = HKDF-SHA256(ikm=seed, salt=undefined, info="privacynotes-encryption-v1", len=32)
test('deriveEncryptionKey is stable (vault key)', async () => {
  const seed = phraseToSeed(PHRASE);
  assert.equal(
    bytesToHex(deriveEncryptionKey(seed)),
    'e827f1e4e1a8f5dc6737db8d22b75d1039792c8e9d2e6a4ba21fd87b57835520',
  );
});

// The account identity. If the public key changes, the server no longer recognises the
// user: the pubkey IS the account, so a shifted derivation orphans the vault server-side.
// = HKDF-SHA256(ikm=seed, salt=undefined, info="privacynotes-signing-v1", len=32), then
//   ed25519 public key from that.
test('deriveSigningKey is stable (account identity)', async () => {
  const seed = phraseToSeed(PHRASE);
  const { privateKey, publicKey } = await deriveSigningKey(seed);
  assert.equal(privateKey.length, 32);
  assert.equal(publicKey.length, 32);
  assert.equal(
    bytesToHex(privateKey),
    '81cb6c164a396f151202dafdf22a3ecebbe2d27c9fd21e89e9f69097da0cd056',
  );
  assert.equal(
    bytesToHex(publicKey),
    'd17e432722fd2da0334dc89e653f70726cf4b948b8d31619490ab86075a31a85',
  );
});

// The local-data key seals note content at rest on the device. If this literal changes,
// every sealed local row on every device fails authentication on its next read: synced
// notes silently re-pull from the server, but dirty local-only rows have no other copy.
// = HKDF-SHA256(ikm=seed, salt=undefined, info="privacynotes-local-at-rest-v1", len=32)
test('deriveLocalDataKey is stable (local at-rest key)', () => {
  const seed = phraseToSeed(PHRASE);
  assert.equal(
    bytesToHex(deriveLocalDataKey(seed)),
    'd40b56f05f980fc683c5a04bad0db01e10ba9cf4f0add8412f8944f219ac7c2c',
  );
});

// The session credential. Drift here does not lose data, but it fails SILENTLY: password
// sign-in returns invalid_credentials, the client quietly falls back to minting a new
// anonymous auth user per re-mint, and the per-IP rate limit that path exists to retire
// starts biting again. Nothing errors; the regression is only visible in auth traffic.
// = hex(HKDF-SHA256(ikm=seed, salt=undefined, info="privacynotes-auth-password-v1", len=32))
test('deriveAuthPassword is stable (session credential)', () => {
  const seed = phraseToSeed(PHRASE);
  assert.equal(
    deriveAuthPassword(seed),
    'bd0b564a6d6546985d34057b30fe6877b3b6e3a56ffe670b17f6feb58bf902e2',
  );
});

// The sign-in identifier is a contract with the link-pubkey edge function, which derives
// the same address server-side from the verified pubkey. Case matters: GoTrue lowercases
// emails on write, so a case drift signs in to a user that does not exist.
test('authEmailForPubkey is lowercase and pinned to the credential domain', () => {
  assert.equal(
    authEmailForPubkey('D17E432722FD2DA0334DC89E653F70726CF4B948B8D31619490AB86075A31A85'),
    'd17e432722fd2da0334dc89e653f70726cf4b948b8d31619490ab86075a31a85@phrase.privacynotes.app',
  );
});

test('the derived keys are different (domain separation actually separates)', async () => {
  const seed = phraseToSeed(PHRASE);
  const enc = deriveEncryptionKey(seed);
  const local = deriveLocalDataKey(seed);
  const { privateKey } = await deriveSigningKey(seed);
  assert.notEqual(bytesToHex(enc), bytesToHex(privateKey));
  assert.notEqual(deriveAuthPassword(seed), bytesToHex(enc));
  assert.notEqual(deriveAuthPassword(seed), bytesToHex(privateKey));
  assert.notEqual(bytesToHex(local), bytesToHex(enc));
  assert.notEqual(bytesToHex(local), bytesToHex(privateKey));
  assert.notEqual(bytesToHex(local), deriveAuthPassword(seed));
});

test('a different phrase yields unrelated keys', async () => {
  const a = phraseToSeed(PHRASE);
  const b = phraseToSeed(PHRASE_2);
  assert.notEqual(bytesToHex(deriveEncryptionKey(a)), bytesToHex(deriveEncryptionKey(b)));
  assert.notEqual(bytesToHex(deriveLocalDataKey(a)), bytesToHex(deriveLocalDataKey(b)));
  const ka = await deriveSigningKey(a);
  const kb = await deriveSigningKey(b);
  assert.notEqual(bytesToHex(ka.publicKey), bytesToHex(kb.publicKey));
});

test('derivation is deterministic across calls (same phrase, same vault, every device)', async () => {
  const s1 = phraseToSeed(PHRASE);
  const s2 = phraseToSeed(PHRASE);
  assert.equal(bytesToHex(deriveEncryptionKey(s1)), bytesToHex(deriveEncryptionKey(s2)));
  const k1 = await deriveSigningKey(s1);
  const k2 = await deriveSigningKey(s2);
  assert.equal(bytesToHex(k1.publicKey), bytesToHex(k2.publicKey));
});

// ------------------------------------------------------------------------------------
// Challenge signing. The server verifies these, so the exact message bytes are a
// contract with the edge functions, not an implementation detail.
// ------------------------------------------------------------------------------------

test('signLinkChallenge is deterministic and bound to the auth uid', async () => {
  const { privateKey } = await deriveSigningKey(phraseToSeed(PHRASE));
  const a = await signLinkChallenge(privateKey, 'auth-uid-1');
  const b = await signLinkChallenge(privateKey, 'auth-uid-1');
  const c = await signLinkChallenge(privateKey, 'auth-uid-2');
  assert.equal(a.length, 64);
  // ed25519 is deterministic: same key + same message = byte-identical signature.
  assert.equal(bytesToHex(a), bytesToHex(b));
  // A signature for one session must not be replayable into another.
  assert.notEqual(bytesToHex(a), bytesToHex(c));
});

test('device register and revoke challenges are distinct messages', async () => {
  const { privateKey } = await deriveSigningKey(phraseToSeed(PHRASE));
  const reg = await signDeviceRegisterChallenge(privateKey, 'uid', 'device-a');
  const rev = await signDeviceRevokeChallenge(privateKey, 'uid', 'device-a');
  // Same key, same uid, same device: if these collided, a register signature could be
  // replayed as a revoke.
  assert.notEqual(bytesToHex(reg), bytesToHex(rev));
});

// ------------------------------------------------------------------------------------
// Device identity
// ------------------------------------------------------------------------------------

test('deriveDeviceId is stable, 32 hex chars, and scoped per pubkey', () => {
  const secret = hexToBytes('11'.repeat(32));
  const idA = deriveDeviceId('pubkey-aaa', secret);
  const idB = deriveDeviceId('pubkey-bbb', secret);
  assert.equal(idA.length, 32);
  assert.match(idA, /^[0-9a-f]{32}$/);
  assert.equal(deriveDeviceId('pubkey-aaa', secret), idA, 'must be idempotent');
  // Two accounts sharing one machine must not share a device id.
  assert.notEqual(idA, idB);
});

// ------------------------------------------------------------------------------------
// Fingerprint pepper and hashes. The privacy claim in SECURITY.md is that the server
// cannot reverse these and cannot correlate a device across accounts.
// ------------------------------------------------------------------------------------

test('deriveFpPepper is per-user and distinct from the other derived keys', () => {
  const seed = phraseToSeed(PHRASE);
  const pepper = deriveFpPepper(seed);
  assert.equal(pepper.length, 32);
  assert.notEqual(bytesToHex(pepper), bytesToHex(deriveEncryptionKey(seed)));
  assert.notEqual(bytesToHex(pepper), bytesToHex(deriveFpPepper(phraseToSeed(PHRASE_2))));
});

test('computeFpHashes: same hardware, different accounts, uncorrelatable', () => {
  const fp = { platform: 'macOS', gpu: 'Apple M4', cores: 10, language: 'en-US' };
  const a = computeFpHashes(deriveFpPepper(phraseToSeed(PHRASE)), fp);
  const b = computeFpHashes(deriveFpPepper(phraseToSeed(PHRASE_2)), fp);
  // This is the SECURITY.md claim, asserted: identical hardware under two accounts must
  // produce unrelated hashes, or the server could link them.
  assert.notEqual(a.platform_hash, b.platform_hash);
  assert.notEqual(a.gpu_hash, b.gpu_hash);
});

test('computeFpHashes: field prefixes prevent cross-field collisions', () => {
  const pepper = deriveFpPepper(phraseToSeed(PHRASE));
  // Same value in two different fields must not hash the same.
  const h = computeFpHashes(pepper, { platform: 'x', gpu: 'x', cores: 0, language: 'x' });
  assert.notEqual(h.platform_hash, h.gpu_hash);
  assert.notEqual(h.platform_hash, h.language_hash);
});

test('computeFpHashes: unavailable GPU degrades to null, not to a hash of "unknown"', () => {
  const pepper = deriveFpPepper(phraseToSeed(PHRASE));
  assert.equal(
    computeFpHashes(pepper, { platform: 'Linux', gpu: 'unknown', cores: 4, language: 'de' }).gpu_hash,
    null,
  );
  assert.equal(
    computeFpHashes(pepper, { platform: 'Linux', gpu: '', cores: 4, language: 'de' }).gpu_hash,
    null,
  );
});

// ------------------------------------------------------------------------------------
// Encoding helpers. Boring, but hexToBytes feeds key material, so a silent NaN here
// would be a very bad day.
// ------------------------------------------------------------------------------------

test('hex round-trips and rejects malformed input', () => {
  const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 255]);
  assert.equal(bytesToHex(bytes), '00010f107f80ff');
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.deepEqual(hexToBytes(bytesToHex(bytes)), bytes);
  assert.throws(() => hexToBytes('abc'), /odd-length/i);
});

test('base64 and base64url round-trip, and base64url is URL-safe', () => {
  // 0xfb 0xff forces the + and / characters in standard base64.
  const bytes = new Uint8Array([251, 255, 190, 239]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.deepEqual(base64urlToBytes(bytesToBase64url(bytes)), bytes);
  const url = bytesToBase64url(bytes);
  assert.ok(!url.includes('+') && !url.includes('/') && !url.includes('='), `not url-safe: ${url}`);
});

// ------------------------------------------------------------------------------------
// Note encryption. This is the actual product promise.
// ------------------------------------------------------------------------------------

const NOTE = {
  title: 'Título with ünicode 🔐',
  body: '# Heading\n\nBody with a [[note-link]] and emoji 🎉',
  tags: ['work', 'privé'],
  trashed: false,
  starred: true,
  locked: false,
  pinProtected: false,
  type: 'note',
  folderId: null,
};

test('encryptNote round-trips, unicode intact', () => {
  const key = deriveEncryptionKey(phraseToSeed(PHRASE));
  const { ciphertext, nonce } = encryptNote(NOTE, key);
  const out = decryptNote(ciphertext, nonce, key);
  assert.equal(out.title, NOTE.title);
  assert.equal(out.body, NOTE.body);
  assert.deepEqual(out.tags, NOTE.tags);
  assert.equal(out.starred, true);
});

test('encryptNote uses a fresh 24-byte nonce every time', () => {
  const key = deriveEncryptionKey(phraseToSeed(PHRASE));
  const a = encryptNote(NOTE, key);
  const b = encryptNote(NOTE, key);
  assert.equal(a.nonce.length, 24, '24 bytes is what makes random nonces safe here');
  // Identical plaintext under a reused nonce would leak; these must differ.
  assert.notEqual(bytesToHex(a.nonce), bytesToHex(b.nonce));
  assert.notEqual(bytesToHex(a.ciphertext), bytesToHex(b.ciphertext));
});

test('ciphertext does not leak plaintext', () => {
  const key = deriveEncryptionKey(phraseToSeed(PHRASE));
  const { ciphertext } = encryptNote(NOTE, key);
  const asText = Buffer.from(ciphertext).toString('utf8');
  assert.ok(!asText.includes('Heading'), 'plaintext found in ciphertext');
  assert.ok(!asText.includes('work'), 'tag found in ciphertext');
});

test('decryptNote rejects the wrong key (Poly1305 authenticates)', () => {
  const key = deriveEncryptionKey(phraseToSeed(PHRASE));
  const wrong = deriveEncryptionKey(phraseToSeed(PHRASE_2));
  const { ciphertext, nonce } = encryptNote(NOTE, key);
  assert.throws(() => decryptNote(ciphertext, nonce, wrong));
});

test('decryptNote rejects tampered ciphertext (this is the server-cannot-lie property)', () => {
  const key = deriveEncryptionKey(phraseToSeed(PHRASE));
  const { ciphertext, nonce } = encryptNote(NOTE, key);
  const tampered = Uint8Array.from(ciphertext);
  tampered[0] ^= 0x01; // flip one bit
  assert.throws(() => decryptNote(tampered, nonce, key));
});

test('decryptNote rejects a swapped nonce', () => {
  const key = deriveEncryptionKey(phraseToSeed(PHRASE));
  const a = encryptNote(NOTE, key);
  const b = encryptNote(NOTE, key);
  assert.throws(() => decryptNote(a.ciphertext, b.nonce, key));
});

test('decryptNote defaults missing fields for old ciphertexts', () => {
  // A pre-v0.4.0 payload: no trashed/starred/locked/pinProtected/type.
  const key = deriveEncryptionKey(phraseToSeed(PHRASE));
  const { ciphertext, nonce } = encryptJson({ title: 'old', body: 'note', tags: [] }, key);
  const out = decryptNote(ciphertext, nonce, key);
  assert.equal(out.trashed, false);
  assert.equal(out.starred, false);
  assert.equal(out.locked, false);
  assert.equal(out.pinProtected, false);
  assert.equal(out.type, 'note');
  assert.equal(out.folderId, null);
});

test('encryptJson round-trips arbitrary settings blobs', () => {
  const key = deriveEncryptionKey(phraseToSeed(PHRASE));
  const value = { favoriteTags: ['a', 'b'], nested: { n: 1, ok: true }, nul: null };
  const { ciphertext, nonce } = encryptJson(value, key);
  assert.deepEqual(decryptJson(ciphertext, nonce, key), value);
});

// ------------------------------------------------------------------------------------
// The browser extension: the sealed inbox, the pairing code, the unlock checker and
// the logins key. A moved vector here means paired extensions seal to a key no app
// derives any more, or a stored checker no longer matches its PIN.
// Spec: docs/internal/plans/browser-extension-build.md (section 3)
// ------------------------------------------------------------------------------------

const INBOX_CTX = { account: 'ab'.repeat(32), id: '00000000-0000-4000-8000-000000000001', kind: 'clip' };
const GOLDEN_INBOX_ROW =
  'AQ2EtjvTUE3nuSwpP6Ei2/jFzvkUYIDWdVxNmf1NZ9w74tS2OksMii8KS4LVb4t6lplcS/sAAmId+7jdFQZ3qLfCSZrD4ore+XHlge2ytLjOnEApB7q2uWkteBxIpA==';

test('X25519 matches RFC 7748 section 6.1 (the primitive under the inbox)', async () => {
  const { x25519 } = await import('../packages/shared/node_modules/@noble/curves/ed25519.js');
  const alice = hexToBytes('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const bob = hexToBytes('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  assert.equal(bytesToHex(x25519.getPublicKey(alice)), '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  assert.equal(bytesToHex(x25519.getPublicKey(bob)), 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
  assert.equal(
    bytesToHex(x25519.getSharedSecret(alice, x25519.getPublicKey(bob))),
    '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
  );
});

test('Argon2id matches RFC 9106 section 5.3 (the primitive under the unlock checker)', async () => {
  const { argon2id } = await import('../packages/shared/node_modules/@noble/hashes/argon2.js');
  const tag = argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
    t: 3, m: 32, p: 4, dkLen: 32, key: new Uint8Array(8).fill(3), personalization: new Uint8Array(12).fill(4),
  });
  assert.equal(bytesToHex(tag), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
});

test('deriveInboxKeyPair: the inbox pair of the canonical phrase', () => {
  const pair = deriveInboxKeyPair(phraseToSeed(PHRASE));
  assert.equal(bytesToHex(pair.secretKey), '8b7cd65aa05adaf549abc12dc3ff521a5d5508f76ba4aa04ec32b3c7353c4002');
  assert.equal(bytesToHex(pair.publicKey), '8cda01b8b5cbb6086b1835e74bfb7f9fa4232dc96d34c6d8fd33382341187241');
  assert.notEqual(
    bytesToHex(deriveInboxKeyPair(phraseToSeed(PHRASE_2)).publicKey),
    bytesToHex(pair.publicKey),
  );
});

test('inboxItemId: two apps derive the same item id, and it is not the row id', () => {
  const { secretKey } = deriveInboxKeyPair(phraseToSeed(PHRASE));
  assert.equal(inboxItemId(secretKey, INBOX_CTX.id), '22a47e83-4709-849b-afd5-fd095a550889');
  assert.notEqual(inboxItemId(secretKey, INBOX_CTX.id), INBOX_CTX.id);
});

test('openInbox opens the frozen row (the format is fixed)', () => {
  const { secretKey } = deriveInboxKeyPair(phraseToSeed(PHRASE));
  assert.equal(inboxRowVersion(GOLDEN_INBOX_ROW), 1);
  assert.equal(new TextDecoder().decode(openInbox(GOLDEN_INBOX_ROW, secretKey, INBOX_CTX)), '{"v":1,"title":"KAT"}');
});

test('sealInbox round-trips padded JSON and every row is fresh', () => {
  const { secretKey, publicKey } = deriveInboxKeyPair(phraseToSeed(PHRASE));
  const plain = padInboxJson({ v: 1, title: 'Título 🔐' });
  assert.equal(plain.length % 4096, 0, 'padded to 4 KiB');
  const a = sealInbox(plain, publicKey, INBOX_CTX);
  const b = sealInbox(plain, publicKey, INBOX_CTX);
  const ra = base64ToBytes(a);
  const rb = base64ToBytes(b);
  assert.notEqual(bytesToHex(ra.subarray(1, 33)), bytesToHex(rb.subarray(1, 33)), 'a fresh ephemeral key per row');
  assert.notEqual(bytesToHex(ra.subarray(33, 57)), bytesToHex(rb.subarray(33, 57)), 'a fresh nonce per row');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(openInbox(a, secretKey, INBOX_CTX))), { v: 1, title: 'Título 🔐' });
});

test('openInbox refuses a row moved to another account, id or kind, a tamper and the wrong key', () => {
  const { secretKey } = deriveInboxKeyPair(phraseToSeed(PHRASE));
  const other = deriveInboxKeyPair(phraseToSeed(PHRASE_2)).secretKey;
  assert.throws(() => openInbox(GOLDEN_INBOX_ROW, secretKey, { ...INBOX_CTX, account: 'cd'.repeat(32) }));
  assert.throws(() => openInbox(GOLDEN_INBOX_ROW, secretKey, { ...INBOX_CTX, id: '00000000-0000-4000-8000-000000000002' }));
  assert.throws(() => openInbox(GOLDEN_INBOX_ROW, secretKey, { ...INBOX_CTX, kind: 'login' }));
  assert.throws(() => openInbox(GOLDEN_INBOX_ROW, other, INBOX_CTX));
  const raw = base64ToBytes(GOLDEN_INBOX_ROW);
  raw[raw.length - 1] ^= 1;
  assert.throws(() => openInbox(bytesToBase64(raw), secretKey, INBOX_CTX));
  const v2 = base64ToBytes(GOLDEN_INBOX_ROW);
  v2[0] = 2;
  assert.throws(() => openInbox(bytesToBase64(v2), secretKey, INBOX_CTX), /version/);
  assert.equal(inboxRowVersion(bytesToBase64(v2)), 2, 'a newer row is recognised, so a reader leaves it');
});

test('openInbox refuses a low-order ephemeral key, even with a valid tag', async () => {
  // A row sealed the way a sealer would if X25519 accepted the all-zero point:
  // the shared secret is zero, so anybody could compute its key. Its tag is
  // valid, so only the low-order check can refuse it.
  const { hkdf } = await import('../packages/shared/node_modules/@noble/hashes/hkdf.js');
  const { sha256 } = await import('../packages/shared/node_modules/@noble/hashes/sha2.js');
  const { xchacha20poly1305 } = await import('../packages/shared/node_modules/@noble/ciphers/chacha.js');
  const { secretKey, publicKey } = deriveInboxKeyPair(phraseToSeed(PHRASE));
  const epk = new Uint8Array(32);
  const salt = new Uint8Array(64);
  salt.set(epk);
  salt.set(publicKey, 32);
  const key = hkdf(sha256, new Uint8Array(32), salt, new TextEncoder().encode('privacynotes-clip-seal-v1'), 32);
  const nonce = new Uint8Array(24).fill(7);
  const head = new TextEncoder().encode(`privacynotes-inbox:v1:${INBOX_CTX.account}:${INBOX_CTX.kind}:${INBOX_CTX.id}:`);
  const aad = new Uint8Array(head.length + 32);
  aad.set(head);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(new TextEncoder().encode('{"v":1}'));
  const row = new Uint8Array(1 + 32 + 24 + ct.length);
  row[0] = 1;
  row.set(nonce, 33);
  row.set(ct, 57);
  assert.throws(() => openInbox(bytesToBase64(row), secretKey, INBOX_CTX), /invalid private or public key/);
});

const PAIR_CODE =
  'pnx1-048H 248H 248H 248H 248H 248H 248R SPG1 Q2TW QDG8 DCC3 BSTB ZDZS Z913 5Q4P TD66 V3YK 6E13 84C7 4G92 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2 48H2 49GF PCBK';

test('encodePairingCode: the frozen code, with and without the logins half', () => {
  const { publicKey } = deriveInboxKeyPair(phraseToSeed(PHRASE));
  const secret = new Uint8Array(16).fill(0x11);
  assert.equal(encodePairingCode({ secret, inboxPublic: publicKey, kext: new Uint8Array(32).fill(0x22) }), PAIR_CODE);
  assert.equal(
    encodePairingCode({ secret, inboxPublic: publicKey, kext: null }),
    'pnx1-048H 248H 248H 248H 248H 248H 248R SPG1 Q2TW QDG8 DCC3 BSTB ZDZS Z913 5Q4P TD66 V3YK 6E13 84C7 4GAB 8MCA 0',
  );
});

test('decodePairingCode forgives case, spacing and look-alike letters, and refuses any change', () => {
  const { publicKey } = deriveInboxKeyPair(phraseToSeed(PHRASE));
  const decoded = decodePairingCode(`  ${PAIR_CODE.toLowerCase().replace(/ /g, '\n')}  `);
  assert.ok(decoded);
  assert.equal(bytesToHex(decoded.secret), '11'.repeat(16));
  assert.equal(bytesToHex(decoded.inboxPublic), bytesToHex(publicKey));
  assert.equal(bytesToHex(decoded.kext), '22'.repeat(32));
  assert.equal(decodePairingCode(PAIR_CODE.replace(/0/g, 'o'))?.kext?.length, 32, 'O reads as zero');
  assert.equal(decodePairingCode(PAIR_CODE.replace('PCBK', 'PCBM')), null, 'the check suffix catches a typo');
  assert.equal(decodePairingCode(PAIR_CODE.slice(0, -5)), null, 'a cut code is refused');
  assert.equal(decodePairingCode(PAIR_CODE + 'Q'), null, 'an added character is refused');
  const short = 'pnx1-048H 248H 248H 248H 248H 248H 248R SPG1 Q2TW QDG8 DCC3 BSTB ZDZS Z913 5Q4P TD66 V3YK 6E13 84C7 4GAB 8MCA 0';
  assert.ok(decodePairingCode(short));
  assert.equal(decodePairingCode(short.replace(/0$/, '1')), null, 'a changed spare bit is refused');
  assert.equal(decodePairingCode('pnx1-hello'), null);
});

test('hashHex is sha256 hex (how the server stores tokens and pairing secrets)', () => {
  assert.equal(hashHex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('deriveUnlockProof and unlockChecker: the frozen proof of a PIN, NFC first', () => {
  const salt = new Uint8Array(16).fill(0x33);
  const proof = deriveUnlockProof('1234', salt);
  assert.equal(bytesToHex(proof), 'f5a4366b656bc451f830a2516ef105e6732502a8dd192afbd2e550e07f7ba7d6');
  assert.equal(unlockChecker(proof), '7a1054493ab8b40518dd627ef4500b2f03a42c6876b98ba70c44c8357e8d9d99');
  assert.deepEqual(deriveUnlockProof('café passcode', salt), deriveUnlockProof('café passcode', salt));
  assert.notDeepEqual(deriveUnlockProof('1234', new Uint8Array(16).fill(0x34)), proof, 'the salt is per extension');
});

test('the logins key: its wrap key, its row ids and its split', () => {
  const contentKey = deriveEncryptionKey(phraseToSeed(PHRASE));
  assert.equal(bytesToHex(deriveLoginsWrapKey(contentKey)), '7cfc62f76fed57beb12d1338f46b2e7ff72ac1db0d20e649bfed580fc13ce6d9');
  const idKey = deriveLoginsIdKey(contentKey);
  assert.equal(bytesToHex(idKey), '1715520eded88d9c93156b50dd5b533a6598a62c0bd814dbdc375a3fba6da09b');
  assert.equal(loginsRowId(idKey, '00000000-0000-4000-8000-000000000002'), '3b1fb63d-4059-8cb9-98b7-cc6138f67f3f');
  const p = new Uint8Array(32).fill(0x5a);
  const { kext, ksrv } = splitLoginsKey(p);
  assert.deepEqual(joinLoginsKey(kext, ksrv), p);
  assert.notDeepEqual(kext, p);
  assert.notDeepEqual(ksrv, p);
  const p2 = new Uint8Array(32).fill(0x77);
  assert.deepEqual(joinLoginsKey(kext, serverHalf(p2, kext)), p2, 'a new P keeps the browser half');
  const box = encryptJsonAad({ p: 'x' }, deriveLoginsWrapKey(contentKey), 'privacynotes-ext-logins-key-v1:t');
  assert.deepEqual(decryptJsonAad(box.ciphertext, box.nonce, deriveLoginsWrapKey(contentKey), 'privacynotes-ext-logins-key-v1:t'), { p: 'x' });
});
