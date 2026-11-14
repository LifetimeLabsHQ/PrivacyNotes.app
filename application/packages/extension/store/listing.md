# Store listing (draft)

The approved texts of `docs/internal/plans/browser-extension-build.md` section 9.5, English only, for the Chrome Web Store, Firefox Add-ons and Edge Add-ons. Nothing here is submitted by an agent.

```
Name: PrivacyNotes
Short: Save web pages as encrypted notes and copy or fill your logins.
Single purpose: PrivacyNotes in your browser: save the page you are on to your PrivacyNotes account, and copy or fill your PrivacyNotes logins for that site.
Privacy policy: https://lifetimelabs.dev/privacy
```

The Chrome Web Store publisher account is a trader account (EU declaration): the business details on the listing are the company's.

## Description (draft, not yet approved)

Built from the approved FAQ entries (section 9.2) and the threat model paragraph (section 9.1). Edge asks for at least 250 characters. Paste as is; the lines are not wrapped.

```
PrivacyNotes in your browser. Save the page you are reading to your PrivacyNotes account, and copy or fill your PrivacyNotes logins for the site you are on.

SAVE PAGES
- Save the page as a note, with its main text and pictures, or as a bookmark.
- Save only the text you selected.
- It reads the tab you have open, so it also saves pages behind a login.
- Use the right-click menu, or the keyboard: Alt+Shift+P (Alt+Shift+M on Windows) saves the page as a note, Alt+Shift+G makes a password and copies it, Alt+Shift+K locks the vault.

YOUR VAULT IN THE BROWSER
- See the logins, cards, SSH keys and bookmarks from your PrivacyNotes vault, with the ones for this site first.
- Copy a username, password or 2FA code with one click. The clipboard is cleared after 30 seconds if it still holds what you copied.
- Choose Fill, or press Alt+Shift+L, and it types the login for the site you are on into the page.
- Make a strong password with the same generator as the app.
- It never fills forms by itself.
- Unlock with a PIN, or with your fingerprint or face where your browser supports it. It locks again after the time you choose.

HOW IT KEEPS YOUR NOTES SAFE
The extension never holds the key that opens your notes. It locks each clip before it leaves your browser, with a key only your apps can open, and one of your apps turns it into a note at its next sync. Your logins reach the extension as a second encrypted copy under a separate key that opens nothing else.

GET STARTED
Open Settings > Extension in PrivacyNotes, pick what the extension may do, then choose Make a code. Paste the one-time code into the extension. It needs a PrivacyNotes account: https://privacynotes.app/
```

## Permission justifications (draft, not yet approved)

One field per permission in the Chrome Web Store (Privacy tab) and in Edge Partner Center (Privacy page).

`scripting`
```
Reads the page you are on when you choose to save it as a note, a bookmark or a selection, and writes your login into the page's login fields when you ask it to fill. No script runs on a page until you ask for a save or a fill.
```

Host permission (`<all_urls>`)
```
A save works on any page you choose to save, and the pictures of a saved page are fetched from their own site. A fill works on any site you have a login for. The extension declares no content script for any site and touches a page only when you ask for a save or a fill.
```

`storage`
```
Keeps the connection to your PrivacyNotes account, the saved pages that wait to send (sealed before they are stored), and your settings such as the lock time.
```

`contextMenus`
```
Adds the PrivacyNotes entries to the right-click menu: save the page, the selection or a link, and fill or copy the login for this site.
```

`alarms`
```
Retries a saved page that could not send because the device was offline, and clears a copied password from the clipboard after 30 seconds.
```

`idle`
```
Locks your logins after the time without use that you choose, or when the computer locks.
```

`clipboardWrite`
```
Copies a username, password or 2FA code when you click it.
```

`clipboardRead`
```
Clears a copied password after 30 seconds, but only if the clipboard still holds that password, so nothing else you copied is lost.
```

`offscreen`
```
A hidden page that turns the page you saved into a note after the popup closes, and that holds the clipboard for the copy and the clear.
```

`unlimitedStorage`
```
A saved page with all its pictures can be larger than the 10 MB the browser otherwise allows. It is stored sealed until it is sent to your account.
```

Remote code: No. Every script ships in the package.

## Data usage (draft)

Chrome and Edge ask which kinds of data the extension handles. Keep these the same as the Firefox declaration (`data_collection_permissions.required`): website content (a saved page, sealed before it leaves the browser) and authentication information (a login you add, sealed the same way). Tick the three certifications (no sale, no use outside the single purpose, no use for credit).

## Images

- Store icon (Chrome) and logo (Edge): `store/icon-128.png` (128 x 128; Edge recommends 300 x 300 and takes 128 x 128).
- Screenshots: Chrome needs at least one, 1280 x 800 or 640 x 400. Edge takes them as an option, 1280 x 800 or 640 x 480.
- Small promo tile 440 x 280: an option in both stores; Chrome lists items without one lower.
