// Is this a phone or tablet browser? The two sign-in code pages ask it
// (/auth/desktop through static-pages.js, /auth/connect through
// auth-connect.js), and in a phone browser they show no code and no Copy
// button: on a phone, the app in front can read the clipboard when the person
// comes back, and a hostile app can start a sign-in that returns to one of
// these pages. One file for both pages. Each page loads it with `defer` before
// its own script, which `script-src 'self'` allows.
// Test: tests/authCodePages.test.ts.
// Spec: docs/internal/plans/oauth-redirect-binding-handoff.md (section 8.9)
(function () {
  'use strict';
  window.pnIsPhoneBrowser = function () {
    var nav = window.navigator || {};
    if (nav.userAgentData && nav.userAgentData.mobile === true) return true;
    var agent = String(nav.userAgent || '');
    if (/Android|iPhone|iPod|iPad|Mobile/.test(agent)) return true;
    // An iPad that asks for the desktop site says it is a Mac; a Mac has no
    // touch screen.
    return /Macintosh/.test(agent) && nav.maxTouchPoints > 1;
  };
})();
