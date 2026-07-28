/* ==========================================================================
   Digital Movement UK — consent gate (UK GDPR / PECR)

   THIS FILE MUST LOAD IN <head>, SYNCHRONOUSLY. No defer. No async.
   Nothing else may come before it.

   Why: Google Consent Mode requires the `default` command to be sitting in
   window.dataLayer BEFORE gtag.js executes. gtag.js drains the dataLayer
   queue in order on load, so whatever is pushed first wins. Putting this
   file anywhere later — or deferring it — is the single most common way
   Consent Mode implementations end up wrong.

   What this file does, in order:
     1. Creates window.dataLayer and the gtag() shim.
     2. Pushes consent DEFAULT = denied for every storage type except
        security_storage. This happens at parse time, before anything else.
     3. Reads a previously stored choice from localStorage (never a cookie).
     4. Waits for /assets/analytics.js to hand it a GA4 measurement ID.
     5. Only on an affirmative choice: pushes consent UPDATE = granted,
        then injects gtag.js.

   If the visitor rejects, or never chooses, gtag.js is never requested.
   No cookie is set. No hit is sent. Nothing leaves the browser.

   The stored choice itself lives in localStorage, not a cookie, so a
   rejection genuinely writes nothing that travels with a request. Storing
   the record of a consent decision is strictly necessary for providing the
   service the user asked for, so it does not itself require consent.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     1 — dataLayer + gtag shim
     ------------------------------------------------------------------ */
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  if (typeof window.gtag !== 'function') { window.gtag = gtag; }

  /* ------------------------------------------------------------------
     2 — CONSENT MODE v2 DEFAULT. Denied. Before everything.

     security_storage is granted because it covers fraud prevention and
     authentication, not measurement. Everything that could identify or
     follow a visitor is denied.

     No `wait_for_update` is set, deliberately. wait_for_update only means
     anything in "advanced" consent mode, where gtag.js loads immediately
     and holds pings back while the banner resolves. We do not load gtag.js
     at all until there is a yes, so there is nothing to wait for. Setting
     it here would be noise that implies behaviour this file does not have.
     ------------------------------------------------------------------ */
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'denied',
    personalization_storage: 'denied',
    security_storage: 'granted'
  });
  gtag('set', 'ads_data_redaction', true);

  /* ------------------------------------------------------------------
     3 — Stored choice
     ------------------------------------------------------------------ */
  var STORAGE_KEY = 'dm-consent';
  var POLICY_VERSION = 1;   /* bump to re-ask everyone after a material change */

  var state = null;         /* 'granted' | 'denied' | null (undecided) */
  var measurementId = '';
  var gtagRequested = false;
  var listeners = [];

  function safeGet() {
    try { return window.localStorage.getItem(STORAGE_KEY); }
    catch (e) { return null; }
  }
  function safeSet(value) {
    try { window.localStorage.setItem(STORAGE_KEY, value); }
    catch (e) { /* private mode, storage full, storage blocked — carry on */ }
  }

  (function readStored() {
    var raw = safeGet();
    if (!raw) { return; }
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return; }
    if (!parsed || parsed.v !== POLICY_VERSION) { return; }
    if (parsed.s === 'granted' || parsed.s === 'denied') { state = parsed.s; }
  })();

  function persist(next) {
    safeSet(JSON.stringify({ v: POLICY_VERSION, s: next, t: new Date().toISOString() }));
  }

  /* ------------------------------------------------------------------
     4 — Loading and unloading GA4
     ------------------------------------------------------------------ */
  function loadGtag() {
    if (gtagRequested || !measurementId) { return; }
    gtagRequested = true;

    /* Queued before the script arrives, so gtag.js reads them in this
       order: consent default (denied) -> consent update (granted) ->
       js -> config. The first hit therefore happens with a resolved,
       granted consent state and never before it.

       No anonymize_ip here: that is a Universal Analytics parameter and
       GA4 ignores it. GA4 does not log or store IP addresses. */
    gtag('js', new Date());
    gtag('config', measurementId);

    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(measurementId);
    s.onerror = function () {
      /* Blocked by an extension, a filter list, or an outage.
         Nothing to do. The page must not care. */
      gtagRequested = false;
    };
    (document.head || document.documentElement).appendChild(s);
  }

  /* Withdrawal has to actually undo something, not just stop the next hit. */
  function clearGoogleCookies() {
    var host = window.location.hostname;
    var domains = ['', host, '.' + host];
    var parts = host.split('.');
    if (parts.length > 2) { domains.push('.' + parts.slice(-2).join('.')); }

    var names = [];
    var jar = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < jar.length; i++) {
      var name = jar[i].split('=')[0].replace(/^\s+|\s+$/g, '');
      if (name === '_ga' || name === '_gid' ||
          name.indexOf('_ga_') === 0 || name.indexOf('_gat') === 0) {
        names.push(name);
      }
    }
    for (var n = 0; n < names.length; n++) {
      for (var d = 0; d < domains.length; d++) {
        document.cookie = names[n] + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' +
          (domains[d] ? '; domain=' + domains[d] : '');
      }
    }
  }

  function applyState(next) {
    state = next;
    if (next === 'granted') {
      if (measurementId) { window['ga-disable-' + measurementId] = false; }
      gtag('consent', 'update', {
        analytics_storage: 'granted'
        /* ad_storage, ad_user_data and ad_personalization stay denied.
           This site runs no advertising tags, so there is nothing to
           grant and no reason to ask. */
      });
      loadGtag();
    } else {
      gtag('consent', 'update', { analytics_storage: 'denied' });
      /* Google's own kill switch: stops an already-loaded gtag.js dead. */
      if (measurementId) { window['ga-disable-' + measurementId] = true; }
      clearGoogleCookies();
    }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (e) { /* never break the page */ }
    }
  }

  /* ------------------------------------------------------------------
     5 — Banner UI
     ------------------------------------------------------------------ */
  var ui = null;             /* { scrim, dialog, accept, reject } */
  var lastFocused = null;
  var inerted = [];

  var STYLE = [
    '.dmc-scrim{position:fixed;inset:0;z-index:300;background:rgba(5,11,21,.62);',
      'opacity:0;transition:opacity .25s ease}',
    '.dmc-scrim.dmc-in{opacity:1}',

    '.dmc-panel{position:fixed;left:0;right:0;bottom:0;z-index:301;',
      'width:min(100% - 24px,660px);margin:0 auto 12px;',
      'background:var(--ink-900,#0B1F3A);color:var(--on-dark,#EAF1FA);',
      'border:1px solid rgba(255,255,255,.16);border-radius:var(--r,14px);',
      'box-shadow:var(--sh-dark,0 24px 70px rgba(0,0,0,.5));',
      'padding:clamp(18px,3vw,26px);',
      'font-family:var(--body,ui-sans-serif,system-ui,sans-serif);',
      'transform:translateY(calc(100% + 24px));transition:transform .32s cubic-bezier(.22,1,.36,1)}',
    '.dmc-panel.dmc-in{transform:none}',

    '.dmc-title{font-family:var(--display,ui-sans-serif,system-ui,sans-serif);',
      'font-weight:800;font-size:1.12rem;letter-spacing:-.02em;line-height:1.25;',
      'margin:0 0 8px;color:var(--on-dark,#EAF1FA)}',
    '.dmc-text{margin:0;font-size:.92rem;line-height:1.6;color:var(--on-dark-mute,#94AAC7)}',
    '.dmc-text + .dmc-text{margin-top:8px}',
    '.dmc-text a{color:var(--orange,#FB7900);text-decoration:underline;',
      'text-underline-offset:3px;font-weight:600}',
    '.dmc-current{margin:10px 0 0;font-family:var(--mono,ui-monospace,monospace);',
      'font-size:.68rem;letter-spacing:.11em;text-transform:uppercase;',
      'color:var(--on-dark-mute,#94AAC7)}',

    /* Two buttons, deliberately identical in size, shape, weight and
       typography. Only the surface colour differs. Rejecting is exactly
       as easy, and exactly as loud, as accepting. */
    '.dmc-actions{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}',
    '.dmc-btn{flex:1 1 190px;display:inline-flex;align-items:center;justify-content:center;',
      'font-family:var(--body,ui-sans-serif,system-ui,sans-serif);',
      'font-weight:700;font-size:1rem;line-height:1.2;padding:14px 22px;',
      'border-radius:var(--r-pill,999px);border:0;cursor:pointer;',
      'transition:background .2s,transform .2s}',
    '.dmc-yes{background:var(--orange,#FB7900);color:#2A1300}',
    '.dmc-yes:hover{background:var(--orange-600,#DE6A00);transform:translateY(-1px)}',
    '.dmc-no{background:var(--on-dark,#EAF1FA);color:var(--ink-900,#0B1F3A)}',
    '.dmc-no:hover{background:#FFFFFF;transform:translateY(-1px)}',

    '.dmc-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;',
      'overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',

    /* Footer "Cookie settings" control. A <button>, because it opens a
       dialog rather than going anywhere — but styled to sit in the footer
       link column as if it were one of them. Mirrors .footer-links a in
       dm.css exactly: mono, .72rem, .11em tracking, uppercase,
       --on-dark-mute (6.95:1 on the --ink-900 footer), orange on hover.
       Hidden by default. It only appears once a measurement ID has been
       registered, so a site with analytics switched off does not offer
       "Cookie settings" for cookies that do not exist. */
    '.footer-consent{display:none}',
    '.dmc-active .footer-consent{display:inline-block;',
      'background:none;border:0;padding:0;margin:0;cursor:pointer;',
      'font-family:var(--mono,ui-monospace,monospace);font-size:.72rem;',
      'letter-spacing:.11em;text-transform:uppercase;line-height:inherit;',
      'color:var(--on-dark-mute,#94AAC7);text-align:inherit;',
      'transition:color .2s}',
    '.dmc-active .footer-consent:hover{color:var(--orange,#FB7900)}',
    '@media (prefers-reduced-motion:reduce){.dmc-active .footer-consent{transition:none}}',

    '@media (max-width:420px){.dmc-btn{flex:1 1 100%}}',
    '@media (prefers-reduced-motion:reduce){',
      '.dmc-scrim,.dmc-panel,.dmc-btn{transition:none}',
      '.dmc-panel{transform:none}}'
  ].join('');

  function injectStyle() {
    if (document.getElementById('dmc-style')) { return; }
    var st = document.createElement('style');
    st.id = 'dmc-style';
    st.appendChild(document.createTextNode(STYLE));
    (document.head || document.documentElement).appendChild(st);
  }

  function focusables() {
    if (!ui) { return []; }
    return Array.prototype.slice.call(
      ui.dialog.querySelectorAll('button, a[href]')
    ).filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
  }

  function onKeydown(e) {
    if (!ui) { return; }
    if (e.key === 'Escape' || e.key === 'Esc') {
      /* Escape is NOT consent. It dismisses the dialog for this page view
         and stores nothing at all, so analytics stays off and the question
         is asked again next time. The footer control is always there. */
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') { return; }
    var items = focusables();
    if (!items.length) { return; }
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    } else if (items.indexOf(document.activeElement) === -1) {
      e.preventDefault(); first.focus();
    }
  }

  function setInert(on) {
    if (on) {
      inerted = [];
      var kids = document.body.children;
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (ui && (el === ui.scrim || el === ui.dialog)) { continue; }
        if (el.hasAttribute('inert')) { continue; }
        el.setAttribute('inert', '');
        inerted.push(el);
      }
    } else {
      for (var j = 0; j < inerted.length; j++) { inerted[j].removeAttribute('inert'); }
      inerted = [];
    }
  }

  function build() {
    var scrim = document.createElement('div');
    scrim.className = 'dmc-scrim';

    var dialog = document.createElement('div');
    dialog.className = 'dmc-panel';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'dmc-title');
    dialog.setAttribute('aria-describedby', 'dmc-text');
    /* Focus lands on the dialog itself, not on a button. A screen reader
       then reads the title and the explanation before either choice is
       announced, and neither button gets the head start that focusing
       "Allow" would quietly hand it. */
    dialog.setAttribute('tabindex', '-1');

    var current = state
      ? '<p class="dmc-current">Current setting: analytics ' +
        (state === 'granted' ? 'allowed' : 'off') + '</p>'
      : '';

    dialog.innerHTML =
      '<h2 class="dmc-title" id="dmc-title">Can we measure how this site performs?</h2>' +
      '<p class="dmc-text" id="dmc-text">We would like to use Google Analytics to see which pages ' +
        'bring enquiries. It stores cookies in your browser and sends usage data to Google. ' +
        'Choose reject and nothing is stored and nothing is sent — the site works exactly the same.</p>' +
      '<p class="dmc-text">You can change this at any time using <strong>Cookie settings</strong> in the footer. ' +
        'Full detail is in our <a href="/privacy/">privacy notice</a>.</p>' +
      current +
      '<div class="dmc-actions">' +
        '<button type="button" class="dmc-btn dmc-yes" data-dmc="grant">Allow analytics</button>' +
        '<button type="button" class="dmc-btn dmc-no" data-dmc="deny">Reject analytics</button>' +
      '</div>';

    document.body.appendChild(scrim);
    document.body.appendChild(dialog);

    ui = {
      scrim: scrim,
      dialog: dialog,
      accept: dialog.querySelector('[data-dmc="grant"]'),
      reject: dialog.querySelector('[data-dmc="deny"]')
    };

    ui.accept.addEventListener('click', function () { choose('granted'); });
    ui.reject.addEventListener('click', function () { choose('denied'); });
    document.addEventListener('keydown', onKeydown, true);
  }

  function open() {
    if (!document.body) { return; }
    if (ui) { close(); }
    lastFocused = document.activeElement;
    build();
    setInert(true);
    /* Next frame, so the transition has a start state to animate from. */
    window.requestAnimationFrame(function () {
      if (!ui) { return; }
      ui.scrim.className = 'dmc-scrim dmc-in';
      ui.dialog.className = 'dmc-panel dmc-in';
      ui.dialog.focus();
    });
  }

  function close() {
    if (!ui) { return; }
    document.removeEventListener('keydown', onKeydown, true);
    setInert(false);
    if (ui.scrim.parentNode) { ui.scrim.parentNode.removeChild(ui.scrim); }
    if (ui.dialog.parentNode) { ui.dialog.parentNode.removeChild(ui.dialog); }
    ui = null;
    if (lastFocused && typeof lastFocused.focus === 'function') {
      try { lastFocused.focus(); } catch (e) { /* element gone */ }
    }
    lastFocused = null;
  }

  /* The live region lives OUTSIDE the dialog and outlives it. Putting it
     inside meant it was removed from the DOM in the same breath as the
     announcement, and screen readers would never get to read it. */
  function announce(message) {
    var region = document.getElementById('dmc-status');
    if (!region) {
      region = document.createElement('p');
      region.id = 'dmc-status';
      region.className = 'dmc-sr';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    region.textContent = '';
    window.setTimeout(function () { region.textContent = message; }, 60);
  }

  function choose(next) {
    persist(next);
    applyState(next);
    close();
    announce(next === 'granted'
      ? 'Analytics allowed. Thank you.'
      : 'Analytics rejected. Nothing has been stored on your device.');
  }

  function maybeShow() {
    if (!measurementId) { return; }          /* nothing to consent to */
    if (state !== null) { return; }          /* already decided */
    if (document.body) { open(); }
    else { document.addEventListener('DOMContentLoaded', open); }
  }

  /* ------------------------------------------------------------------
     6 — Public API. /assets/analytics.js and the footer control use this.
     ------------------------------------------------------------------ */
  window.DMConsent = {
    /* Called once by analytics.js with the GA4_ID from its config block.
       No ID means no tracking, which means no banner: we do not ask people
       to consent to something that is not there. */
    registerMeasurementId: function (id) {
      if (!id || measurementId) { return; }
      measurementId = String(id);
      /* Reveals the footer "Cookie settings" control. Until this runs
         there is no analytics, so there is nothing to offer settings for
         and the control stays hidden. */
      document.documentElement.className += ' dmc-active';
      if (state === 'granted') { applyState('granted'); }
      else if (state === 'denied') { window['ga-disable-' + measurementId] = true; }
      maybeShow();
    },
    isGranted: function () { return state === 'granted'; },
    getState: function () { return state; },
    open: open,
    close: close,
    grant: function () { choose('granted'); },
    deny: function () { choose('denied'); },
    onChange: function (fn) { if (typeof fn === 'function') { listeners.push(fn); } }
  };

  /* Styles go in immediately, not when the banner is first built. The
     footer control needs them even for visitors who decided long ago and
     will never see the banner again. */
  injectStyle();

  /* Footer "Cookie settings" control, and anything else marked up with
     data-dm-consent. Delegated, so it works no matter when it is added. */
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document.body) {
      if (t.nodeType === 1 && t.hasAttribute && t.hasAttribute('data-dm-consent')) {
        e.preventDefault();
        open();
        return;
      }
      t = t.parentNode;
    }
  });
})();
