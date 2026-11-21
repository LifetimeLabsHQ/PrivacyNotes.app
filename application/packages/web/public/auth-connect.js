// This page has no app bundle and no auth client. It hands a one-time PKCE
// code only to its exact same-origin opener, or to an explicit local copy,
// which a phone browser never gets (auth-phone.js).
// tests/accountConnection.test.ts covers refusal and URL scrubbing.
(function () {
  'use strict';
  function role(name) { return document.querySelector('[data-role="' + name + '"]'); }
  var nojs = role('nojs');
  if (nojs) nojs.hidden = true;
  var url = new URL(window.location.href);
  var code = url.searchParams.get('code');
  var state = url.searchParams.get('pn_connect');
  var error = url.searchParams.get('error');
  var valid = url.pathname === '/auth/connect' && !url.hash
    && url.searchParams.getAll('pn_connect').length === 1 && /^[A-Za-z0-9_-]{43}$/.test(state || '')
    && ((url.searchParams.getAll('code').length === 1 && code && code.length <= 8192 && !/\s/.test(code)) || error);
  var handoff = new URL(url.origin + '/auth/connect');
  if (valid) {
    handoff.searchParams.set('pn_connect', state);
    if (error) handoff.searchParams.set('error', error === 'access_denied' ? 'access_denied' : 'failed');
    else handoff.searchParams.set('code', code);
  }
  // Remove credentials before any subsequent navigation or user copy of the
  // address bar. The explicit copy button holds the bounded return URL.
  try { window.history.replaceState(null, '', url.pathname); } catch (e) { /* no navigation fallback */ }
  if (!valid) {
    var missing = role('missing');
    if (missing) missing.hidden = false;
    return;
  }
  var opener = false;
  try {
    // A closed opener takes no message: it counts as none.
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'pn-account-connect', url: handoff.toString() }, url.origin);
      opener = true;
    }
  } catch (e) {
    /* No opener: on a computer the explicit copy below is the way back. A
       phone browser gets no copy, so there the page says to connect from a
       computer: starting again on the phone would end here again. */
  }
  if (error) {
    var refused = role('missing');
    if (refused) refused.hidden = false;
    return;
  }
  // A phone browser never shows the link or a Copy button: a hostile phone
  // app can start a flow that returns here, and the app in front can read the
  // clipboard. The post above still reaches an opener of the app; with no
  // opener, the connection can finish only from a computer.
  if (window.pnIsPhoneBrowser && window.pnIsPhoneBrowser()) {
    var phone = role(opener ? 'phone' : 'phone-alone');
    if (phone) phone.hidden = false;
    return;
  }
  var out = role('code');
  if (out) out.textContent = handoff.toString();
  ['lede', 'codebox', 'steps'].forEach(function (name) { var el = role(name); if (el) el.hidden = false; });
  var btn = role('copy');
  if (btn) btn.addEventListener('click', function () {
    function select() {
      if (!out) return;
      var range = document.createRange(); range.selectNodeContents(out);
      var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      btn.textContent = 'Select and copy the link';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(handoff.toString()).then(function () { btn.textContent = 'Copied'; }, select);
    } else select();
  });
})();
