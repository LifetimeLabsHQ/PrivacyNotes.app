# Security

This page says what PrivacyNotes protects, what it does not, and what our server can see. How each protection works, and every limit in full, is in [THREAT_MODEL.md](THREAT_MODEL.md). [VERIFY.md](VERIFY.md) shows you how to check the main claims yourself.

If you find a vulnerability, please [report it privately on GitHub](https://github.com/LifetimeLabsHQ/PrivacyNotes.app/security/advisories/new) instead of opening a public issue. Email sec@lifetimelabs.dev if you cannot use GitHub.

## In one paragraph

PrivacyNotes is end-to-end encrypted. Your 12-word recovery phrase is generated on your device. Your device derives its keys from it: one to encrypt every note, task, and journal entry on your device, one to sign requests so the server can tell it's you without knowing who you are, and a few with narrower jobs that [THREAT_MODEL.md](THREAT_MODEL.md#system-overview) lists. The server stores ciphertext and a public key. Under self-custody, which every phrase sign-up uses, the keys that decrypt your data live only on your devices. You do not have to take that on faith: [VERIFY.md](VERIFY.md) shows you how to check it in about a minute, in your browser's network tab.

One deliberate exception exists: **custodial mode**, where we store your phrase so a new device is one click. A sign-up with Google, Apple or GitHub preselects it, and a phrase sign-up never uses it. It moves the ability to decrypt your notes to our side, and it has [its own section below](#oauth-and-custodial-mode).

## What the server sees

The server is Supabase (Postgres + Row Level Security) in Zurich. For each user it stores:

- A public Ed25519 key, which acts as the account identifier.
- Encrypted blobs of notes, tasks, journal entries, settings, and version history (`notes`, `user_settings`, `note_versions`).
- Nonces and timestamps required to sync and resolve order.
- Sizes of the encrypted blobs (a row in a database has a size).

It does not store: titles, body text, tags, or anything derived from them. Phrase-flow users sign up with anonymous Supabase auth - no email, no name, no identifier tied to who they are. OAuth users (Google, Apple, GitHub) have an identity from the provider attached to their session; see the OAuth section below for what that does and does not mean.

It does not store your recovery phrase either, unless your account uses custodial mode. If the server is compromised tomorrow, the attacker gets opaque bytes addressed by public key: they can see which key syncs when and roughly how many notes it holds, and they cannot read content. Custodial users are the exception, because an attacker who reached both the database and the phrase-encryption key could decrypt their notes.

## Cryptography

Your notes are encrypted on your device with XChaCha20-Poly1305, under a key derived from your recovery phrase, and sensitive requests are signed with an Ed25519 key from the same phrase. All primitives come from the audited noble and scure libraries by Paul Miller. The derivation, the parameters and the known limits are in [THREAT_MODEL.md](THREAT_MODEL.md#cryptographic-design).

## PIN protection

The optional app lock uses a 4-digit PIN or a passcode of 8 to 256 characters. It stops a person at your screen. Against someone who copies your device's storage, a PIN falls in minutes to hours, because it has only 10,000 values; a longer passcode costs much more to guess. Locked and protected notes are hidden by the app, not encrypted a second time, so a forgotten PIN or passcode never destroys data. OS disk encryption and your screen lock are what protect a lost or stolen machine. Details are in [THREAT_MODEL.md](THREAT_MODEL.md#pin-protection).

## Sync

Your devices merge their changes detail by detail, so a change made on one device is kept, and text edited on two devices while apart opens a dialog that keeps both versions until you choose. Notes in the Trash are deleted for good after 30 days, unless you switch the Trash's auto-delete off. A permanent delete cannot be undone: the server removes the note's ciphertext and version history at once and keeps only a marker with the note's id, your public key and its timestamps, so a device that was offline learns of the delete. The full rules are in [THREAT_MODEL.md](THREAT_MODEL.md#sync-conflicts-and-deletion).

## What we measure

The server-side data we hold beyond your notes' ciphertext and the pubkey identifier:

- **Device records** (`devices`), one per registered device per account. Stores `device_id`, a `device_name` your device builds from its own platform and OS name ("macOS", "iPhone app", "Desktop app on Windows"), a coarse `platform` label (`web` / `desktop` / `ios` / `android`), the `app_version` of the app on that device (such as `0.657.0`), `created_at`, `last_seen_at`, an optional `revoked_at`, and a `device_group` identifier we use to keep multiple browser installs on the same physical machine within one slot.
- **Device-grouping hashes**, four per device: HMAC-SHA256 of coarse environment signals (OS family, WebGL renderer, CPU cores, language), computed on your device under a pepper derived from your phrase. They exist to keep several browsers on one machine inside one free-tier device slot. The server never sees the raw values, cannot reverse the hashes without the pepper, and cannot correlate a device across accounts, because the pepper is per-user. Hardened browsers can shift the signals and cost you a slot temporarily, never access.
- **Per-account quotas** (`pubkey_quotas`): counters for the number of notes, total ciphertext bytes, and image bytes you currently hold. Used to enforce free vs. Pro storage caps. Derived from the data you've stored, not from anything you've told us about yourself.
- **Purchase records** (`pro_pubkeys`, `pro_purchases`, `paddle_storage_subs`), if you bought Pro or extra storage: your pubkey, where you paid (Paddle, the App Store or Google Play), the order id and the amount for Pro, and for a storage plan its subscription id, size, status and billing dates. Your email and billing details stay with Paddle, our Merchant of Record, or with the store. Paddle receives your pubkey with the purchase, so our Paddle account can see it beside those details; Google Play receives it with a store purchase, and the App Store a token made from it.
- **Where an account came from** (`account_origin`): two short words, written once when the account is created, never updated, and deleted with the account: how the app was installed (such as `web`, `ios` or `android-play`) and, if you arrived through one of our links or from a site on a published list, which one. No IP address, user agent, referrer or session is kept with them. We read them as totals per link and install channel, including how many of those accounts bought Pro.
- **Custodial phrases and their releases** (`custodial_phrases`, `custodial_phrase_releases`), for custodial mode only: the encrypted copy of your phrase described [below](#oauth-and-custodial-mode), which leaving custodial mode deletes, and one row each time the server hands that phrase to a signed-in device, holding your account's auth id and the time, never where from. The release rows are deleted with the account.
- **Managed sign-in accounts** (`managed_accounts`, `account_connections`, `account_broker_sessions`): the pubkey's canonical Auth account, the provider subjects you explicitly authorize, and which provider started a server session. Disconnecting revokes that provider's sessions. Account deletion removes the connections and sessions; a pubkey revocation record remains to reject old tokens.
- **Two-factor enrollment** (`mfa_enrolled_pubkeys`, Auth's factor records): which account has enabled TOTP and the authenticator secret needed to check its codes. Removing an authenticator deletes its factor record; removing the last verified factor or deleting the account removes the enrollment.
- **Account-change confirmations** (`account_nonces`, `account_connect_tickets`, `mfa_factor_intents`): action, session and account identifiers, payload digests and expiry times. Their authorization expires after five minutes; expiry does not immediately delete the records. They bind a signed confirmation to one change and contain no phrase or authenticator backup key. Account deletion removes them.
- **Deleted files awaiting cleanup** (`pending_blob_gc`): the opaque id of each image or file you delete and when, kept until the encrypted file is swept from storage. The server learns that a file was deleted around then, never what it held.
- **Dead man's switch** (`dms_arms`), only if you ever turn it on: the period you chose (1 month to 5 years), when you turned it on, when a device of yours last asked the server about it, whether a deletion is pending, and how many deletions it has run and when the last one was. The row stays when you turn the switch off, because a device that comes back must still learn of a deletion, and it is deleted with the account. A deletion empties your notes and settings on the server and queues your files for removal; an empty marker stays for each note, as it does for any note you delete.
- **Browser extension** (`extension_tokens`, `extension_pairings`, `extension_inbox`, `extension_logins`, `extension_accounts`), only if you connect one: for each connected browser, the name it gives itself (such as "Chrome on macOS"), what it may do, its version, when it was added, last used and last clipped, and a hash of its token; with logins on, a checker for its PIN or passcode, the count of wrong tries and half of the key of its logins copy. A one-time code waits as a hash for at most 10 minutes. Clips wait sealed until one of your apps takes them, at most 90 days, and a waiting clip names the device id of the app that is taking it. With logins on, a second encrypted copy of the vault items and bookmarks it shows, one row per item or bookmark. Removing a browser deletes its row at once, and everything is deleted with the account. The [threat model](THREAT_MODEL.md#system-overview) says what each part can open.
- **Burn notes** (`burn_notes`): the ciphertext of a one-time share and when it was made. The app sends it without signing in, so the row names no account; opening the link deletes it, and an unopened one is deleted when the lifetime its sender picked runs out, at most 7 days.
- **Abuse bans** (`banned_pubkeys`), for an account we ban for abuse: its pubkey, the reason, when, and which operator set it.
- **Import and export counts**: one row per flow, carrying the flow name (`obsidian`, `vault`, `pdf`) and a timestamp. No pubkey, no user id, nothing linking a row to a person or another row: a count of events, not a record about anyone. The app sends it while you are signed in, so the request reaches our server with your session, as every sync request does; the row keeps none of it. We read it to see which importers earn their maintenance.
- **Website-icon lookups**, which are requests rather than stored records. With site icons on, the app asks our own edge for an icon and the domain sits in that request URL; the Worker has no request logging and no log export, and it counts no icon request, so nothing is written down at our end. The icon cache is shared and carries no account or device id. Settings > Appearance turns it off. It is the one thing you typed that leaves your device readable, and [VERIFY.md](VERIFY.md) names it too.
- **Short-link clicks**, counted at the edge. A request to one of our short links (`/go/...` or `/dl/...`) writes one data point to the Cloudflare Analytics Engine dataset `privacynotes_campaigns` before it redirects: whether it was a `go` or a `dl` link, the placement or platform it names, its campaign word if it has one, the country Cloudflare reports for the request, and Cloudflare's verified-bot flag. It is written without any identifier: no IP address, no user agent, no cookie, no account. No other request writes to it.
- **Aggregate operator dashboards**: signups per day, retention cohorts, totals, platform breakdown. All computed in-database from the records above, and open only to our own operator accounts, whose keys are listed in `admin_pubkeys`.

What we explicitly do not collect or persist on accounts: user-agent strings, geolocation, behavioral telemetry, analytics events tied to note content, or anything that lets us reach you outside the app.

**Third-party JavaScript, stated exactly.** No analytics of what you write, no pixels and no third-party tracker in the app: we run no third-party script for analytics, advertising or tracking, and no third-party script loads on an ordinary session. Two do load, each only in a named circumstance, and both on the web app rather than the desktop and mobile builds:

- **Cloudflare Turnstile**, from `challenges.cloudflare.com`, and only when the server asks for a challenge during sign-up or sign-in. It is a bot check. Nothing loads it until there is something to solve.
- **Paddle's checkout script**, from `cdn.paddle.com` (and `sandbox-cdn.paddle.com`, its test equivalent, which a released build never calls). Paddle is our Merchant of Record. When Paddle's Retain feature is active on our account, Paddle's own script in turn loads `public.profitwell.com`, which is subscription analytics belonging to Paddle rather than to us.

  **This one never runs in the app.** Starting a purchase opens our checkout page on `privacynotes.app`, a different origin from the app on `use.privacynotes.app`, and Paddle's script loads there. A different origin cannot read the app's stored data, so no payment code shares a page with your phrase or your keys. The content security policy enforces it: Paddle is allowlisted on exactly one page, `/checkout`, and on nothing else. Check it yourself; these are two different answers from the same server:

  ```
  curl -sI https://use.privacynotes.app | grep -i content-security-policy   # no paddle, no profitwell
  curl -sI https://privacynotes.app/checkout | grep -i content-security-policy   # paddle
  ```

On IP addresses: Cloudflare and Supabase transiently process them at the network layer for routing and abuse prevention, and our rate limits use them. We do not write IPs into user records or associate them with content.

## OAuth and custodial mode

[<img src="assets/threat-levels.webp" alt="The three signup options: login with key stored with us, login with key on your device, phrase only with no login" width="740">](https://privacynotes.app/help/threat-model-levels)

Signing in with Google, Apple or GitHub is a convenience entry point: your phrase is still generated on your device. The cost, whichever mode you pick, is that the email the provider shares with us is linked to your public key. Phrase-only users have no such link; if being unidentifiable to us matters more than a fast sign-in, use the phrase flow.

At OAuth signup you choose the most consequential setting in the product. **Custodial**, which the screen preselects: we keep a copy of your phrase, encrypted with AES-256-GCM under a key the server holds, so a new device is one click. **Self-custody**: your phrase never leaves your device, and a new device needs the phrase or a QR sign-in from one you already use.

**Custodial mode means the capability to decrypt your notes sits on our side.** We do not use it, and nothing in our systems reads note content, but count the capability, not the intention: a valid legal order could produce your plaintext, and so could a deep enough compromise of our server, or a dishonest future version of this company. None of that is true for self-custody users, where an attacker who takes the entire database gets ciphertext and a dead end where the phrase should be.

**A known weakness.** Retrieving a custodial phrase needs an eligible session and, when two-factor sign-in is on, a verified authenticator session, but no signature from your phrase, because a new device does not hold a signing key yet. A stolen session can therefore fetch a custodial phrase until that session is signed out, revoked, or refreshed again by your own device. Details are in [THREAT_MODEL.md](THREAT_MODEL.md#custodial-keep-it-simple).

**You can change your mind in either direction** from Settings > Account > Key custody, effective immediately. Leaving deletes our copy and asks you to retype three of your twelve words first. Returning uploads it again, only from an explicit settings choice. Both directions need an eligible account session and a signature from your own account key, with a fresh authenticator code when two-factor sign-in is on, so a stolen session alone can neither plant a phrase nor remove one. The cost of that choice: the phrase can reach our server from any signed-in device, not only at sign-up.

**Why offer it at all:** for many people the realistic alternative is not a stricter notes app but a plaintext one. If you came for the guarantee the rest of this document describes, use the phrase flow.

## Two-factor sign-in

Optional two-factor sign-in asks for a code from your authenticator before a new server session can access your account. It applies to phrase sign-in and connected Google, Apple or GitHub accounts. It does not change note encryption or protect notes already open on a device. The server stores the authenticator secret, so this control cannot protect against a compromised server.

Setup requires you to save the reusable 2FA backup key outside PrivacyNotes and confirm the saved copy. To replace a lost authenticator, add that key to another authenticator app. It restores codes, not a lost phrase or provider account. If both the authenticator and the backup key are lost, we cannot restore server access; notes already unlocked on a device stay readable and exportable.

Settings > Account > Accounts manages which providers can sign in. Connecting an account keeps custody unchanged. A custodial account cannot disconnect its last provider until another is connected or it switches to self-custody.

## What we trust

- **Your device and browser.** If the operating system is compromised or the browser is malicious, none of the above helps.
- **The cryptographic libraries.** `@noble/ciphers`, `@noble/hashes`, `@noble/ed25519`, `@scure/bip39`. Audited and widely deployed.
- **The frontend bundle, on the web.** A compromised deployment could ship JavaScript that takes the phrase, the standard supply-chain risk of any web app; Subresource Integrity and reproducible web builds have not shipped yet. The signed native builds (macOS notarized, Windows Authenticode, Linux signed AppImage, Android certificate-pinned APK) narrow that boundary: a native build changes only when an update is installed, and the updater checks each one against a signing key compiled into the copy you already have. If your threat model includes us being coerced, prefer the native apps. The Linux .deb has no updater: each version comes with a detached minisign signature made with the same key, which apt does not check, so check it yourself before you install.

## What we don't protect against

- **A compromised device.** Code running on your machine, or a person at your unlocked device, reads your notes, as with any end-to-end encrypted app. Your notes are encrypted on your device, also at rest, but a full copy of the app's storage can be opened unless the app lock is on, and a short PIN only slows that down. OS disk encryption and a screen lock remain the real protection for a lost or stolen machine. What a copy holds in each mode is in [THREAT_MODEL.md](THREAT_MODEL.md#local-storage-at-rest).
- **A QR sign-in through your camera app.** Your browser's history can keep the sign-in link, which contains your phrase. Delete that entry, or use "Scan QR with camera" on the sign-in screen instead.
- **Someone at your unlocked device.** Biometric unlock is a gate for people nearby. It is a real key only where it is bound: to the device's secure hardware in the apps, or to a passkey in a browser that supports it. Settings > Security > Lock shows which kind each device has.
- **You losing your recovery phrase, under self-custody.** There is no reset, on purpose: a recoverable phrase would be a backdoor, and custodial mode is that backdoor offered openly, by name.
- **Social engineering.** Nobody from PrivacyNotes will ever ask for your phrase.
- **Denial of service** against our infrastructure providers.
- **Far-future quantum computers.** XChaCha20-Poly1305 at 256 bits holds against Grover-class attacks; Ed25519 does not hold against Shor. Not a near-term concern.
- **Server-side deletion.** The server can drop your rows, and the next sync carries that deletion to your local copy. Encrypted local exports are the protection today.

## Quotas

- Per-account and per-row limits enforced server-side by Postgres triggers; the storage tiers are on the pricing page.

## Audit status

Independent security researchers review the published source and report what they find. We fix confirmed issues or state them as known limitations in THREAT_MODEL.md, publish a GitHub security advisory for each one that put users at risk, and credit the researchers under Acknowledgments below. We also run our own security reviews of the code before releases.

A full, commissioned audit of the stack is planned, with Cure53 as the firm we want to work with. This page will link the report when it exists.

The app and its cryptographic code live in this repository, so anyone who wants to inspect or critique the design can do so without trusting our word for it.

## Reporting a vulnerability

Report it privately on GitHub: https://github.com/LifetimeLabsHQ/PrivacyNotes.app/security/advisories/new. A private report there reaches us fastest and keeps the whole exchange in one place. If you cannot use GitHub, email sec@lifetimelabs.dev as a backup. That address is also published in our security.txt (https://privacynotes.app/.well-known/security.txt) on our own domain, so you can confirm it's authentic. If a fix requires coordination, we'll work with you on timing before public disclosure. There is no paid bounty program yet.

Before you send a report, please check it against the current release and against [THREAT_MODEL.md](THREAT_MODEL.md), which lists the limitations we already know about and accept. A report we can act on names one concrete issue, the version or commit, and the steps that reproduce it.

AI tools are welcome when a person checks what they find. What we cannot absorb is unchecked output: a scan that restates a documented limitation as a new finding, or that was never tried against the app, takes as long to answer as a real report, and that time comes out of building the app. So:

- Confirm each claim against the app or the code before you send it. If you are not sure a result is real, tell us plainly what you did and did not check.
- If an AI tool wrote or helped write the report, say so, and mark which claims you confirmed yourself.
- Report privately first, and never post an unchecked finding in public. A public claim that turns out to be wrong worries the people who rely on the app before anyone could check it, and a real issue is better fixed before it is public.
- Questions about how the app works are welcome anywhere, in public too. Ask them as questions, not as findings.

We read every report, and we may answer an unverified one briefly.

## Acknowledgments

We thank the independent researchers who report issues to us.

- **NotAFlightRisk** ([GitHub](https://github.com/NotAFlightRisk)), September 2026: reported [GHSA-mxc4-qf2j-q5xq](https://github.com/LifetimeLabsHQ/PrivacyNotes.app/security/advisories/GHSA-mxc4-qf2j-q5xq), a `privacynotes://` link that could switch a native app to another account. Fixed in v0.507.5.
- **lissy93** ([GitHub](https://github.com/lissy93)), September 2026: made the observation behind GHSA-mxc4-qf2j-q5xq, and reported [GHSA-f4h8-458p-85xg](https://github.com/LifetimeLabsHQ/PrivacyNotes.app/security/advisories/GHSA-f4h8-458p-85xg), a sign-in that another app could start and catch through the same scheme. Fixed on the server, with the apps at 0.534.0 or later.
- **Eduardo Camarillo** ([noir0x63.org](https://noir0x63.org), [GitHub](https://github.com/Noir0x64)), September 2026: an unsolicited source review of the public client. Six defects and one documented limitation; four fixed in v0.522.1, one answered with a correction to the threat model, one an accepted residual that is now recorded as such.
- **Rainb0wJagu4r** ([GitHub](https://github.com/Rainb0wJagu4r)), October 2026: reported that HTML in a burn note could use the app's own style classes to cover the whole page with a fake screen. Fixed in v0.621.1.
- **Real-Fruit-Snacks** ([GitHub](https://github.com/Real-Fruit-Snacks)), October 2026: reported that the fixed phrase the public demo runs on was also accepted for a real account. Fixed on the server, which refuses that phrase from every app version, and in v0.627.3, which says why at sign-in. Later that month, a careful round of client reports: the app lock left the stored phrase on the account's other devices ([GHSA-fcj2-6jm6-ph38](https://github.com/LifetimeLabsHQ/PrivacyNotes.app/security/advisories/GHSA-fcj2-6jm6-ph38)), a sign-in on an untrusted device kept the PIN's salt and hash on disk ([GHSA-83rv-p792-7g26](https://github.com/LifetimeLabsHQ/PrivacyNotes.app/security/advisories/GHSA-83rv-p792-7g26)), the desktop window could write files that run on their own ([GHSA-5xm6-287x-rgp5](https://github.com/LifetimeLabsHQ/PrivacyNotes.app/security/advisories/GHSA-5xm6-287x-rgp5)), one imported journal entry could stop the app from starting, and smaller escapes in burn notes, exports, file names and the Android backup rules. Fixed in v0.697.5 to v0.697.13. In November, a review of purchases, storage and account safety: a partial refund removed Pro and a reversed refund never gave it back, an account over its storage cap could not even shrink a note or move one to the Trash, deleted files could count against the storage again, restoring purchases from a store cleared a scheduled cancellation, and the dead man's switch did not count use of the browser extension as activity. Fixed in v0.726.0 and on the server.
- **grub-basket** ([GitHub](https://github.com/grub-basket)), October 2026: a source review of the public client ([GHSA-2hxx-m2v5-cg89](https://github.com/LifetimeLabsHQ/PrivacyNotes.app/security/advisories/GHSA-2hxx-m2v5-cg89)). It found a version snapshot that a sign-out at the wrong moment could seal under a cleared key, links in burn notes that kept their opener, file grants the desktop About window did not need, a web clipper download that could serve as a bandwidth proxy, and smaller escapes in the clipper and the desktop sign-in page. It also led a device to keep an unsynced edit when a permanent delete arrives from elsewhere. Fixed in v0.701.0.
