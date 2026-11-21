# Verify it yourself

You should not have to take our word for any of this.

This page is three ways to check that PrivacyNotes encrypts your notes on your device before they reach our server. They take about a minute, about ten minutes, and about a weekend. The first one needs nothing but a browser, and it is the one that actually settles the question.

Accurate as of v0.786.19 (2026-11-17). The two payloads below are real, captured from an actual sync, and the app sends the same fields today.

**One caveat before you start.** Everything below describes self-custody, which every phrase sign-up uses. A sign-up with Google, Apple or GitHub preselects the custodial option instead, and if your account uses it, the server holds your phrase and can decrypt your notes - the trade is spelled out in [SECURITY.md](SECURITY.md) - though tier 1 still shows you ciphertext on the wire either way.

---

## Tier 1: one minute, no tools

You need a browser. You do not need an account you care about, an email address, or a build toolchain.

1. Open the app and create an account. It is 12 words, generated in your browser. No email, no password.
2. Open your browser's developer tools (F12) and select the **Network** tab.
3. Type something into a note that you would never find anywhere else. Something like `platypus-hovercraft` works.
4. Leave the note, or press the sync indicator at the bottom of the window. Writes are batched, so they do not go out on every keystroke.
5. Find the request to `sync.privacynotes.app/rest/v1/notes` and look at its payload.
6. Then switch to the **Application** tab, open **IndexedDB**, database `privacynotes`, store `notes`, and search it for the same word.

Step 5 shows you what leaves your machine. Step 6 shows you what stays on it. Both come back with no hit, and the second one is the newer claim, so it is worth doing rather than reading about.

The first save of a note starts with a short update in the second form below, with `nonce=eq.unrecorded` in its query string. It finds no row, so the app then sends the full row:

```json
{
  "id": "84c337d5-0fc6-428a-bc4b-8ae612a79580",
  "user_pubkey": "d839f864ff0bf1f6dc51e045f030cd23...",
  "ciphertext": "cALuFuhqcjRpsfS3t4CITLKL1pZHliIpdSkuboFvJCR1qBAlEdpA4Q9b...",
  "nonce": "Gb9HxuYo4+VVtcEEfo9NIEwKn8g243vS",
  "created_at": "2026-08-19T13:05:06.161Z",
  "updated_at": "2026-08-19T13:05:34.149Z",
  "client_bind": 1
}
```

Every later edit to that note sends even less, because the row already exists:

```json
{
  "ciphertext": "GRUUN9plghgaXzepWTnqImR3B/BO5aWQ+l4wfTWJT4DPGijmqgpn9jdQ...",
  "nonce": "Fo5PS4c/GAYyTI5rp4ChoB7ckkiP3E7j",
  "updated_at": "2026-08-19T13:05:34.149Z",
  "client_bind": 1
}
```

Now the actual test: **use find-in-page on that payload and search for `platypus-hovercraft`.** Zero hits. Search for your note's title. Zero hits. The only thing carrying your words is `ciphertext`, and it is a base64 blob we have no key for.

**The stronger version of the same check, if you want it.** Do not filter the network list at all. Type your note, let it sync, and look at every request the app made. **Your words appear in none of them: not in a body, not in a URL, not in a query string.** That is the claim, and it is the one worth checking.

You will see more than one host, so here is the complete list of what can appear and why, before you find it yourself:

- **`use.privacynotes.app`**, which served the app you are looking at.
- **`sync.privacynotes.app`**, carrying the ciphertext from tier 1.
- **`files.privacynotes.app`**, our own file host, when a picture or a file in a note is uploaded, opened or deleted. It carries ciphertext only: your pictures and files are encrypted on your device, and each one has a random name. [THREAT_MODEL.md](THREAT_MODEL.md) says what it sees.
- **`/favicon?domain=...`**, if the app shows a web link. To draw the little site icon next to a link, the app asks our proxy for that icon by domain, so the link's DOMAIN is in that URL, and our proxy asks DuckDuckGo or Google for it by that domain. Not the note, not the link's path, just the domain. That holds for every link the app draws, also one someone else wrote: in a burn note sent to you, in an event of a calendar you subscribe to, and in the preview of a page you clip. It is on by default and you can switch it off in Settings under Lists. The browser extension asks the same proxy for the icons of its vault rows, by domain only, and its own Settings switch it off.
- **`/clip-fetch`**, in the web app and the demo only, when you clip a page or import or subscribe to a calendar. A browser page may not read another site, so the app sends the page's or the calendar's address to our Worker, which downloads it and hands it back; a subscribed calendar is downloaded this way about once an hour while the app is open. The desktop and mobile apps download it themselves and never call it. What the Worker keeps, a few counters per account for its rate limits, is in [SECURITY.md](SECURITY.md#what-we-measure). Together with the icons above and the map below, it is the only place where something from your notes or your settings leaves the device in readable form.
- **`maps.privacynotes.app`**, our own map host: when you open the window of a place you set on a note; whenever a note with a map in its text is open, which includes the Welcome note every new account starts with, so you see it right after step 1; and for the list of places in your app language, when you open a place window to type a place, or on a phone when a new note adds your location by itself. The map comes in pieces, so the host learns the area you look at, but never the note, its text or what you type into the place search. The demo calls it the same way. [THREAT_MODEL.md](THREAT_MODEL.md) has the details.
- **`plugins.privacynotes.app`**, our own plugin host, only if you download a plugin in Settings > Plugins: the Smart connections model, the files of Text in pictures and Voice to text, the Translate languages you add, and the plugin engine they share. It sends those files and receives nothing from your notes.
- **`releases.privacynotes.app`**, our own release host. The website's download buttons ask it for the latest version numbers, and every desktop and phone app asks it for updates. It sends version files and installers and receives nothing from your notes.
- **`challenges.cloudflare.com`**, only if the sign-up gate asked you to prove you are human. It is a bot check and it loads only when there is a challenge.
- **Nothing from a payment processor.** Buying opens a separate checkout page on `pay.privacynotes.app`, an origin of its own, so Paddle's script runs there and never in the app you are inspecting or on any address the app has run on. Paying in crypto opens BlockBee's own site from a page of ours that loads no third-party script. If you want to watch it, do that on the checkout tab; this tab stays clean.

No analytics host, no error reporter, and nothing else at all. The desktop and mobile apps do not load Turnstile. That check is harder to fake than the first one, and it takes about the same amount of time.

That is the whole claim, and you just checked it without trusting us, reading any code, or waiting for an audit.

### What else you can see, and what it means

Be suspicious of anyone who shows you only the good part, so here is the rest of that payload:

- **`user_pubkey`** is your public identity, derived from your phrase. The server needs it to know which rows are yours. It also rides in the query string of update and fetch requests, for the same reason.
- **`id`, `created_at`, `updated_at`** are the note's id and timestamps, in the clear. Our server therefore knows how many notes you have and when you touched them. It cannot know what any of them say.
- **`client_bind`** is always `1`. It tells the server that this app version names, inside the ciphertext, the row each note was written for, so the server can refuse a note write from an app version that does not. The server keeps nothing from it.
- **`nonce`** is a fresh 24 random bytes for every single write. It is not secret and it is not a key. An update also carries the previous write's nonce in its query string, so it lands only on the version this device last synced.

That is the complete list. The full accounting of what our server can observe, including device records and quota counters, is in [SECURITY.md](SECURITY.md#what-we-measure).

### What step 6 showed you, and what it does not buy

The rows in that store are not your notes. Each one carries `sv: 1` and a `sealed` field holding a nonce and a ciphertext, and the title, body, tags and tracker data live inside that ciphertext. That is why the search came back empty. The rows are sealed with XChaCha20-Poly1305 under a key derived from your phrase (the `privacynotes-local-at-rest-v1` branch in the same key table below), and the ciphertext is bound to its own row and table, so a blob moved onto another row fails to open instead of decrypting.

One panel over, in **Local Storage**, the key `privacynotes.phrase` holds your phrase in a wrapped form: its value starts with `pnwrap1:`, not with your twelve words. Turn the app lock on in this browser, and that key goes away.

This step shows what sits on the disk. It does not show what a copy of the whole disk can open, which depends on the app lock; "Local storage at rest" in [THREAT_MODEL.md](THREAT_MODEL.md) sets that out, with every field that stays readable for the indexes.

---

## Tier 2: ten minutes, reading code

About 890 lines decide everything your notes rely on. They are in [`crypto/crypto.ts`](crypto/crypto.ts), and these functions are the whole story for your notes; the keys of the browser extension and their seals are in [`application/packages/shared/src/extension.ts`](application/packages/shared/src/extension.ts):

| Function | What to check |
| :--- | :--- |
| `phraseToSeed` | Your 12 words become a 64-byte BIP-39 seed. Standard, offline, no network. |
| `deriveEncryptionKey` | HKDF-SHA256 over that seed with the info string `privacynotes-encryption-v1` produces the 32-byte content key. Same phrase, same key, on every device, with nothing to fetch. |
| `deriveLocalDataKey` | The same HKDF construction under `privacynotes-local-at-rest-v1` produces the key that seals rows in your own browser storage. Disjoint from the sync key by its info string, so a local ciphertext can never pass as a server row or the reverse. |
| `encryptNote` | XChaCha20-Poly1305. A fresh random 24-byte nonce per write. Title, body, tags, flags, tracker data, folder id and the "last edited" date the lists show all go inside one JSON blob before encryption, so none of them leak as separate fields. |
| `decryptNote` | The inverse. Wrong key or tampered ciphertext throws on the Poly1305 authentication check rather than returning garbage. |

Identity works the same way: `deriveSigningKey` derives an Ed25519 keypair from the same seed under a different info string, and the public half is your user id. Signatures authenticate sensitive operations like registering or revoking a device.

**What a backdoor would look like, so you know what to look for.** This is more useful than "read the code":

- The encryption key, the seed, or the phrase being sent anywhere. Follow `deriveEncryptionKey`'s return value: it reaches `encryptNote` and `decryptNote`, the seal of your settings (`encryptJson`), and the two keys of the browser extension's logins copy, and nothing that leaves the device. The phrase leaves it on purpose in two places only, both described in [THREAT_MODEL.md](THREAT_MODEL.md): to our server in custodial mode, and sealed under a sign-in passkey you add.
- A second recipient. Anything wrapping the content key under a second key, or encrypting for anyone but you, would be key escrow. There is one key for your notes. Two other keys are deliberate and documented in [THREAT_MODEL.md](THREAT_MODEL.md): the inbox key that the browser extension and the command line seal to, and the random key of the extension's logins copy, half of which our server keeps. (Note history is not that: a version row is the same note encrypted again under the SAME key, so what to look for is a second KEY, never a second ciphertext.)
- A predictable or reused nonce. It is `randomBytes(24)` on every call.
- Plaintext on the wire. Tier 1 already covers this from the outside.

The encryption layer and the full client source are published today. The third-party audit follows, and the status of both is covered below.

---

## Tier 3: a weekend, building it

This is the hardest question in the whole category, for us and for everyone else.

**What you can check today.** The full client source is in this repository, and it builds:

```
cd application
pnpm install
pnpm build          # the web app
pnpm desktop:build  # the desktop app, for the machine you are on
```

No secrets and no signing keys. The build needs two public values, the address of our sync server and its public key: copy `packages/web/.env.example` to `packages/web/.env.local`, set `VITE_SUPABASE_URL` to `https://sync.privacynotes.app`, and set `VITE_SUPABASE_ANON_KEY` to the `apikey` header of any request the web app sends to that address. Every shipped build carries both. Run what you built, point your network tab at it, and tier 1 applies to your own binary. Separately, every release we ship is published with hashes, and the macOS, Windows, AppImage, deb and Android builds are signed, so you can confirm a downloaded file is the file we built. The deb's signature is the `.minisig` file published next to it; check it with minisign against the updater public key in `tauri.conf.json` (`plugins.updater.pubkey`, a base64-encoded minisign public key).

**What each check proves, weakest to strongest.** The source is published: you can read what we say we ship. A hash matches: the file you hold is the file we uploaded. A signature verifies: that file came from our key, not a stranger's. A tag names a version: the commit it marks carries that version's source, because the source is pushed to the public repo before a release is built. The client source has been public since 2026-08-31: releases from then until 2026-09-15 were tagged before their source landed, and their release notes name the commit that carries it, or the next one that does. For releases before 2026-08-31 the public repository holds the encryption layer only. A reproducible build: the file you hold was built from that source, byte for byte. Only the last one ties a binary to the code, and it is not shipped yet.

**What that does not prove.** It does not prove that the binary we ship came from the source you just read. Answering that needs reproducible builds, where your build and ours land on byte-identical output. We consider the Android APK and the Linux AppImage the realistic targets, and it is on the roadmap rather than shipped. We will say so on this page when that changes, and not before.

**The web app is the weakest case and always will be.** JavaScript served over the web can in principle be changed per user, per session, and no amount of published source fixes that, for us or for anyone else in this category. If that is inside your threat model, use the desktop or mobile app, where you hold a signed artifact whose code changes only when an update is installed. On the desktop each update must carry our signature, checked against the key in the copy you already have; the Mac, Windows and AppImage apps fetch updates by themselves, and the `.deb` never does.

---

## What is published today, and what follows

| | Status |
| :--- | :--- |
| Encryption layer (`crypto/`) | Published |
| Threat model | Published |
| Full client source (web, desktop, mobile) | Published, in [`application/`](application/) |
| Third-party security audit report | Planned, published in full or in summary when it is done |
| Sync backend, including the database schema and the protocol | Closed. See the note under this table |

The sync backend is closed because the hosted service is what funds the product, and the database schema is part of it. Nothing in the three tiers depends on either. The client you can read encrypts your notes on your device, and tier 1 shows you from the outside what reaches the server: of your notes, ciphertext, nonces, ids and timestamps under your public key, and nothing readable; of your device, the record [SECURITY.md](SECURITY.md#what-we-measure) lists. That is a stronger check than reading our table definitions, because it measures what actually leaves your machine rather than what we say we store. If self-hosting ever ships, the schema ships with it.


---

## Found something?

If any of the above does not hold up on your machine, we want the report more than we want to be right. Security contact and disclosure policy are in [SECURITY.md](SECURITY.md).
