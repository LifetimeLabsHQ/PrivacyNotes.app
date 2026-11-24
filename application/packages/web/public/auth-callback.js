// The page an Android sign-in returns to when the browser kept the return.
// It never shows the code. On Android 12 and newer it offers one button that
// asks Android to open the same https address as an app link; the intent names
// no package, so it reaches only the app Android verified for this host. On
// Android 11 and older that intent can list any app that claims the host, and
// a browser that hides its Android version could be one of them, so both get
// the way back to the app instead. Test: tests/authCodePages.test.ts.
// Spec: docs/internal/plans/oauth-redirect-binding-handoff.md (section 8.1)
(function () {
  'use strict';
  function role(name) { return document.querySelector('[data-role="' + name + '"]'); }
  var url = new URL(window.location.href);
  var code = url.searchParams.get('code');
  var state = url.searchParams.get('pn_connect');
  var error = url.searchParams.get('error');
  var valid = url.pathname === '/auth/callback'
    && url.searchParams.getAll('code').length <= 1
    && (state === null || (url.searchParams.getAll('pn_connect').length === 1 && /^[A-Za-z0-9_-]{43}$/.test(state)))
    && ((code && code.length <= 8192 && !/\s/.test(code)) || error);
  var back = new URLSearchParams();
  if (valid) {
    if (code) back.set('code', code);
    else back.set('error', error === 'access_denied' ? 'access_denied' : 'failed');
    if (state) back.set('pn_connect', state);
  }
  // The code leaves the address bar, so nothing copies or shares it from here.
  try { window.history.replaceState(null, '', url.pathname); } catch (e) { /* the page still works */ }
  if (!valid) {
    role('back').hidden = true;
    role('missing').hidden = false;
    return;
  }

  // The Android major version, or 0 when the browser does not prove one.
  // Chrome's shortened user agent always says Android 10, so a browser with
  // client hints is trusted only through them.
  function androidVersion() {
    var nav = window.navigator || {};
    var hints = nav.userAgentData;
    var agent = String(nav.userAgent || '');
    if (hints && typeof hints.getHighEntropyValues === 'function') {
      if (hints.platform !== 'Android') return Promise.resolve(0);
      return hints.getHighEntropyValues(['platformVersion']).then(function (v) {
        return parseInt(String(v.platformVersion || ''), 10) || 0;
      }, function () { return 0; });
    }
    if (hints) return Promise.resolve(0);
    var match = /\bAndroid (\d+)/.exec(agent);
    return Promise.resolve(match ? parseInt(match[1], 10) : 0);
  }

  androidVersion().then(function (major) {
    if (major < 12) return;
    // No package and no component: Android picks the handler exactly as it
    // would for the return itself. The one address the App Link claims.
    role('open-link').setAttribute('href', 'intent://use.privacynotes.app/auth/callback?' + back.toString()
      + '#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end');
    role('back').hidden = true;
    role('open').hidden = false;
  });
})();
