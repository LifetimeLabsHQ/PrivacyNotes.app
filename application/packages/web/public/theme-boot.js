// Pre-CSS theme bootstrap for index.html (GitHub #893).
//
// Runs synchronously from <head> before index.css paints, so reloads (such as
// the app lock reload in src/lockReload.ts) never flash the :root light default
// (#F5F5F5) while the deferred module entry graph is still loading.
//
// CSP allows script-src 'self' with no 'unsafe-inline', so this lives in
// public/ like theme-toggle.js. Mirrors src/theme.ts (kept in sync by
// tests/themeBoot.test.ts).
(function () {
  var root = document.documentElement;
  var read = function (key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  };

  var mode = read('privacynotes.theme');
  var theme =
    mode === 'light' || mode === 'dark'
      ? mode
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  if (theme === 'dark') root.classList.add('dark');

  var head = document.head;
  if (head) {
    var mediaMetas = head.querySelectorAll('meta[name="theme-color"][media]');
    for (var i = 0; i < mediaMetas.length; i++) mediaMetas[i].remove();
    var meta = head.querySelector('meta[name="theme-color"]:not([media])');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      head.appendChild(meta);
    }
    meta.content = theme === 'dark' ? '#171514' : '#F5F5F5';
  }

  var BUILTIN = {
    light: { 'warm-cream': '#E1D8C4', slate: '#DDE1E8', sage: '#E1E7DE' },
    dark: { 'soft-dark': '#1C1F26', 'navy-depths': '#0D1321', oled: '#000000' },
  };
  var DEFAULT_BG = { light: '#F5F5F5', dark: '#171514' };
  var TOKENS = [
    'surface-0', 'surface-1', 'surface-2', 'track', 'divider',
    'text', 'text-soft', 'text-muted',
    'accent', 'accent-hover', 'accent-fill', 'accent-fill-hover',
    'danger', 'warning', 'success',
  ];
  var HEX = /^#[0-9A-F]{6}$/;
  var ID = /^[a-z0-9]{12}$/;
  var channels = function (hex) {
    return parseInt(hex.slice(1, 3), 16) + ' ' + parseInt(hex.slice(3, 5), 16) + ' ' + parseInt(hex.slice(5, 7), 16);
  };

  var readSnap = function (keySuffix) {
    try {
      var modeName = keySuffix.slice(keySuffix.lastIndexOf('.') + 1);
      var r = JSON.parse(read('privacynotes.customTheme.' + keySuffix) || 'null');
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID.test(r.id)) return null;
      if (typeof r.code !== 'string' || r.code.length > 512 || r.mode !== modeName) return null;
      var c = r.colors;
      if (!c || typeof c !== 'object') return null;
      for (var k = 0; k < TOKENS.length; k++) {
        if (typeof c[TOKENS[k]] !== 'string' || !HEX.test(c[TOKENS[k]])) return null;
      }
      if (c.label !== undefined && (typeof c.label !== 'string' || !HEX.test(c.label))) return null;
      if (c.paper !== undefined && (typeof c.paper !== 'string' || !HEX.test(c.paper))) return null;
      if (r.logo !== undefined && r.logo !== 'original') return null;
      return r;
    } catch (e) {
      return null;
    }
  };

  var legacy = read('privacynotes.colorTheme');
  if (legacy === 'cool-white') legacy = 'slate';
  var rawSpace = read('privacynotes.theme.space');
  var space = rawSpace === 'personal' || rawSpace === 'work' ? rawSpace : null;
  var rules = [];
  var bg = DEFAULT_BG[theme];

  var paintSlot = function (slot, stored, snapSuffix) {
    if (stored && stored.indexOf('custom:') === 0) {
      var snap = readSnap(snapSuffix);
      if (snap && stored === 'custom:' + snap.id) {
        root.classList.add('theme-custom-' + slot);
        if (snap.logo) root.classList.add('logo-' + slot + '-' + snap.logo);
        var decls = [];
        for (var t = 0; t < TOKENS.length; t++) {
          decls.push('--pn-' + TOKENS[t] + ':' + channels(snap.colors[TOKENS[t]]));
        }
        if (snap.colors.label) decls.push('--pn-label:' + channels(snap.colors.label));
        decls.push('--pn-paper:' + channels(snap.colors.paper || snap.colors['surface-2']));
        var sel = slot === 'dark' ? ':root.dark.theme-custom-dark' : ':root:not(.dark).theme-custom-light';
        rules.push(sel + '{' + decls.join(';') + '}');
        if (slot === theme) bg = snap.colors['surface-0'];
        return true;
      }
      return false;
    }
    if (stored === 'default') return true;
    if (stored && BUILTIN[slot][stored]) {
      root.classList.add('theme-' + stored);
      if (slot === theme) bg = BUILTIN[slot][stored];
      return true;
    }
    return false;
  };

  var slots = ['light', 'dark'];
  for (var s = 0; s < slots.length; s++) {
    var slot = slots[s];
    if (space) {
      var spaceStored = read('privacynotes.colorTheme.' + space + '.' + slot);
      if (spaceStored && paintSlot(slot, spaceStored, space + '.' + slot)) continue;
    }
    var stored = read('privacynotes.colorTheme.' + slot);
    if (paintSlot(slot, stored, slot)) continue;
    if (legacy && BUILTIN[slot][legacy]) {
      root.classList.add('theme-' + legacy);
      if (slot === theme) bg = BUILTIN[slot][legacy];
    }
  }

  if (rules.length && head) {
    var style = document.getElementById('pn-custom-themes');
    if (!style) {
      style = document.createElement('style');
      style.id = 'pn-custom-themes';
      head.appendChild(style);
    }
    style.textContent = rules.join('\n');
  }

  // Paint the resolved surface-0 immediately, even before index.css finishes
  // parsing (or in Vite dev where index.css arrives with main.tsx).
  // paintTheme() in src/theme.ts clears this inline property once CSS is live.
  root.style.backgroundColor = bg;
})();
