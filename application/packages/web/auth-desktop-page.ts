import { type Plugin } from 'vite';
import { THEME_SCRIPT_TAG, THEME_TOGGLE_CSS, themeVarsCss } from './static-page-theme.ts';
import { brandMark, CHROME_CSS, ogLocaleTag } from './static-page-chrome.ts';

// The page a desktop sign-in returns to, and the reason it exists.
//
// A desktop operating system cannot tell the browser which application may
// receive a return address: macOS, Windows and Linux all resolve a custom
// scheme by last writer, and none of them has an equivalent of Android App
// Links or iOS Universal Links. So the desktop app no longer asks for a
// return address it cannot own. It asks for this page, on an origin only we
// serve, and the browser stops here. The page shows the one-time code, the
// person carries it back to the app, and the app exchanges it with the
// verifier it generated before opening the browser.
//
// What that buys: a hostile application can open this page too, but the code
// only reaches it if the person copies it out of a page carrying our name and
// pastes it into that application. That is a visible act on the level of
// handing over the recovery phrase, rather than a redirect nobody sees.
// Spec: docs/internal/plans/oauth-redirect-binding-handoff.md (section 8.3)
//
// Three constraints this page is built around.
//
// It must NOT load the application bundle. The bundle's Supabase client runs
// with `detectSessionInUrl`, so it would exchange the code in the browser,
// spend it, and leave the desktop app's own exchange to fail on a code that
// no longer exists. Static HTML only, no module script, no import.
//
// It must carry no inline script. The deployed policy allows `script-src
// 'self'` and nothing else, so the behaviour lives in /static-pages.js under
// `data-static-page="auth-desktop"`, the same arrangement the other static
// pages use.
//
// It must render something honest without JavaScript. With scripting off the
// code is still in the address bar, so the page says so rather than showing an
// empty box that looks broken.
//
// In a phone browser neither page shows a code or a Copy button
// (/auth-phone.js decides): a hostile phone app can start a sign-in that
// returns here, and on a phone the app in front can read the clipboard.
//
// English only, like the other static pages outside the marketing tier: it is
// reached mid-sign-in from a desktop application, and the locale the person
// picked lives in that application rather than in this browser.

const CANONICAL = 'https://use.privacynotes.app/auth/desktop';
const TITLE = 'Finish signing in';
const DESC = 'Copy the one-time code and paste it back into the PrivacyNotes desktop app to finish signing in.';

const PAGE_CSS = `
.wrap{max-width:34rem;margin:0 auto;padding:4rem 1.25rem 5rem}
.card{border:1px solid var(--line);background:var(--card);border-radius:16px;padding:1.75rem}
h1{font-size:var(--fs-display-2);font-weight:800;letter-spacing:-.02em;margin:0 0 .5rem}
.lede{color:var(--sub);margin:0 0 1.5rem;line-height:1.6}
.codebox{display:flex;gap:.5rem;align-items:stretch;margin:0 0 .75rem}
code.code{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--fs-body);
  background:var(--tint);border:1px solid var(--line);border-radius:10px;padding:.85rem 1rem;
  overflow-wrap:anywhere;user-select:all}
button.copy{flex:0 0 auto;border:1px solid var(--line);background:var(--card);color:var(--ink);
  border-radius:10px;padding:.85rem 1.1rem;font-weight:600;cursor:pointer}
button.copy:hover{background:var(--tint)}
a.open{display:inline-block;background:var(--accent);color:var(--on-accent);text-decoration:none;
  border-radius:10px;padding:.85rem 1.25rem;font-weight:600}
.steps{margin:1.5rem 0 0;padding-left:1.15rem;color:var(--sub);line-height:1.7}
.note{margin:1.5rem 0 0;padding-top:1.25rem;border-top:1px solid var(--line);color:var(--sub);font-size:var(--fs-body);line-height:1.6}
.nojs{color:var(--sub);line-height:1.6}
[hidden]{display:none!important}
`;

/** The head every sign-in return page shares. */
function pageHead(title: string, description: string, canonical: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - PrivacyNotes</title>
<meta name="description" content="${description}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
${ogLocaleTag('en')}
<style>
${themeVarsCss(
  '--bg:#fff;--fg:#15171a;--ink:#15171a;--sub:#5b6168;--line:#e7e9ec;--card:#fff;--tint:#f7f8fa;--accent:#1E40AF;--muted:#5b6168;--faint:#8a9099;--chip:#eceef1;--rail:#f7f8fa;--on-accent:#fff',
  '--bg:#0e1014;--fg:#e7e9ec;--ink:#e7e9ec;--sub:#9aa1aa;--line:#23262c;--card:#14171d;--tint:#1a1e25;--accent:#4A90D9;--muted:#9aa1aa;--faint:#6b7178;--chip:#3a4149;--rail:#14171d;--on-accent:#03203E'
)}
${CHROME_CSS}
${THEME_TOGGLE_CSS}
${PAGE_CSS}
</style>
${THEME_SCRIPT_TAG}
</head>
`;
}

/** Exported for tests/authCodePages.test.ts. */
export function renderHtml(connect = false): string {
  const title = connect ? 'Finish connecting your account' : TITLE;
  const description = connect ? 'Return to PrivacyNotes to finish connecting this sign-in account to your vault.' : DESC;
  const canonical = connect ? 'https://use.privacynotes.app/auth/connect' : CANONICAL;
  return `${pageHead(title, description, canonical)}<body ${connect ? 'data-static-page="auth-connect"' : 'data-static-page="auth-desktop"'}>
<div class="wrap">
  <div class="card">
    <h1>${title}</h1>

    <p class="lede" data-role="lede" hidden>${connect ? 'Return to PrivacyNotes. If the account is not connected yet, copy this return link and paste it into the Connected accounts screen.' : `You are signed in here. Copy this code and paste it into ${brandMark()} on your computer.`}</p>
    <div class="codebox" data-role="codebox" hidden>
      <code class="code" data-role="code"></code>
      <button type="button" class="copy" data-role="copy">${connect ? 'Copy return link' : 'Copy'}</button>
    </div>
    <ol class="steps" data-role="steps" hidden>
      <li>Switch back to the PrivacyNotes app.</li>
      <li>Paste the code where it asks for it.</li>
      <li>You can close this tab afterwards.</li>
    </ol>

    <p class="nojs" data-role="nojs">${connect ? 'Copy this page\'s full address and paste it into the Connected accounts screen in PrivacyNotes.' : `The code is in this page's address, after <code>code=</code>. Copy it from the address bar and paste it into ${brandMark()} on your computer.`}</p>

    <p class="lede" data-role="phone" hidden>${connect ? 'Return to PrivacyNotes to see the connected account. If it is not there, start again from Connected accounts.' : 'This page finishes a sign-in in the PrivacyNotes desktop app, so it shows no code on a phone. If an app on this phone sent you here, do not sign in through it.'}</p>
    ${connect ? '<p class="lede" data-role="phone-alone" hidden>This page cannot finish the connection in a phone browser. Connect this account from PrivacyNotes on a computer.</p>' : ''}

    <p class="lede" data-role="missing" hidden>${connect ? 'This connection could not be completed. Return to Connected accounts and try again. Your existing accounts are unchanged.' : 'This page has no sign-in code in its address, so there is nothing to copy. Start the sign-in again from the app.'}</p>

    <p class="note">The code works once, expires shortly, and is useless to anyone but the app that started this sign-in. Never paste it into any other program.</p>
  </div>
</div>
<script src="/auth-phone.js" defer></script>
${connect ? '<script src="/auth-connect.js" defer></script>' : '<script src="/static-pages.js" defer></script>'}
</body>
</html>`;
}

export function authDesktopPagePlugin(): Plugin {
  return {
    name: 'emit-auth-desktop-page',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'auth/desktop/index.html',
        source: renderHtml(),
      });
    },
    configureServer(server) {
      server.middlewares.use('/auth/desktop', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(renderHtml());
      });
    },
  };
}

/** Isolated connect returns never boot the app or exchange an OAuth code.
 * tests/accountConnection.test.ts covers the message/copy bridge. */
export function authConnectPagePlugin(): Plugin {
  return {
    name: 'emit-auth-connect-page',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'auth/connect/index.html', source: renderHtml(true) });
    },
    configureServer(server) {
      server.middlewares.use('/auth/connect', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        res.end(renderHtml(true));
      });
    },
  };
}

// The page an Android sign-in returns to when the browser kept the return
// instead of handing it to the app (a browser that does not open links in
// apps, or an app the phone has not verified). Without it the person sees a
// 404 and the app waits forever.
//
// It never shows the code, and it gives the person one way on: a button that
// asks Android to open the same https address as an app link. That button
// names no package, so Android delivers it only where it would have delivered
// the return itself: from Android 12 on, to the verified app or nowhere. On
// Android 11 and older the same intent can list any app that claims our host,
// so the button shows only when the browser proves Android 12 or newer
// (/auth-callback.js). Every other browser gets the way back to the app.
// Spec: docs/internal/plans/oauth-redirect-binding-handoff.md (section 8.1)

/** Exported for tests/authCodePages.test.ts. */
export function renderCallbackHtml(): string {
  const title = 'Finish signing in';
  const description = 'Open the PrivacyNotes app to finish signing in.';
  return `${pageHead(title, description, 'https://use.privacynotes.app/auth/callback')}<body>
<div class="wrap">
  <div class="card">
    <h1>${title}</h1>

    <div data-role="open" hidden>
      <p class="lede">Your sign-in is ready. Open the PrivacyNotes app to finish it.</p>
      <a class="open" data-role="open-link" href="#">Open PrivacyNotes</a>
      <p class="note">If the app does not open, allow links to open in apps in your browser's settings and sign in again, or sign in with your recovery phrase.</p>
    </div>

    <p class="lede" data-role="back">This page finishes a sign-in in the PrivacyNotes Android app, and it cannot open the app from here. Go back to the app and try again, or sign in with your recovery phrase. If another app sent you here, do not sign in through it.</p>

    <p class="lede" data-role="missing" hidden>This page has no sign-in code in its address. Start the sign-in again from the app.</p>
  </div>
</div>
<script src="/auth-callback.js" defer></script>
</body>
</html>`;
}

export function authCallbackPagePlugin(): Plugin {
  return {
    name: 'emit-auth-callback-page',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'auth/callback/index.html', source: renderCallbackHtml() });
    },
    configureServer(server) {
      server.middlewares.use('/auth/callback', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        res.end(renderCallbackHtml());
      });
    },
  };
}
