# Store listing (draft)

The approved texts of `docs/internal/plans/browser-extension-build.md` section 9.5, English only, for the Chrome Web Store, Firefox Add-ons and Edge Add-ons. Nothing here is submitted by an agent.

```
Name: PrivacyNotes
Short: Save web pages as encrypted notes and copy your logins.
Single purpose: PrivacyNotes in your browser: save the page you are on to your PrivacyNotes account, and copy your PrivacyNotes logins for that site.
Privacy policy: https://lifetimelabs.dev/privacy
```

The Chrome Web Store publisher account is a trader account (EU declaration): the business details on the listing are the company's.

## Permission notes (draft, not yet approved)

The stores ask why each permission is needed. These are the facts of the build, to be worded at review:

- `scripting`: reads the page you are on, only when you choose to save it.
- Host access to all websites: the save works on any page you open, and pictures of a clip are fetched from their site. No script is declared for any page.
- `storage`: the connection to your account, the clips waiting to send (sealed), your Save pictures choice.
- `contextMenus`: the PrivacyNotes entries in the right-click menu.
- `alarms`: retries a waiting clip, and clears a copied password after 30 seconds.
- `idle`: locks the logins after 5 minutes without use.
- `clipboardWrite`, `clipboardRead`: copies a username, password or code you click, and clears it later only if the clipboard still holds it.
- `offscreen` (Chrome, Edge): a hidden page that turns a page into a note when the popup is closed, and holds the clipboard.
- `favicon` (Chrome, Edge): the site's icon in the popup, from the browser's own store, so no request leaves for it.
- `unlimitedStorage` (Chrome, Edge): a clip with all its pictures is larger than the 10 MB these browsers otherwise allow, and it is stored, sealed, before it is sent.

Firefox data collection (`data_collection_permissions.required`): `websiteContent` (a clip, sealed before it leaves the browser) and `authenticationInfo` (a login you add, sealed the same way).

Remote code: none. Every script ships in the package.
