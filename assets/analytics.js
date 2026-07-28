/* ==========================================================================
   Digital Movement UK — event measurement

   Loads at the END of <body>, deferred. It must load AFTER
   /assets/consent.js, which sets the Consent Mode defaults in <head>.

   This file never loads gtag.js and never sends anything itself. It hands
   its measurement ID to /assets/consent.js and pushes events. If consent
   has not been granted, every push here is a no-op: no hit, no cookie.

   Division of labour with /assets/forms.js (owned by someone else):
     - forms.js owns the SUBMISSION OUTCOME. It pushes
       window.dataLayer.push({event:'generate_lead', ...}) when an enquiry
       genuinely succeeds. This file only transports that push to GA4.
     - This file owns everything observable from the DOM: form_start,
       phone and WhatsApp clicks, FAQ opens, review clicks, pricing views.
     - Nothing is measured twice. If forms.js is absent, generate_lead
       simply never fires — which is correct, because without it there is
       no reliable success signal to fire on.
   ========================================================================== */
(function () {
  'use strict';

  /* ====================================================================
     CONFIG — the only line you need to edit.

     Paste your GA4 Measurement ID between the quotes. It looks like
     G-XXXXXXXXXX and is found in GA4 under
     Admin > Data streams > (your web stream) > Measurement ID.

     Leave it EMPTY and the entire measurement layer is switched off:
     no cookie banner, no gtag.js, no network request, no cookies,
     no event listeners. One console warning, then silence.
     ==================================================================== */
  var GA4_ID = 'G-3WSHWP27M6';

  /* ------------------------------------------------------------------ */

  if (!GA4_ID) {
    if (window.console && typeof console.warn === 'function') {
      console.warn('[DM] Analytics is off: GA4_ID is empty in /assets/analytics.js. ' +
        'Paste your G-XXXXXXXXXX measurement ID to switch on measurement and the consent banner.');
    }
    return;
  }

  if (!window.DMConsent) {
    if (window.console && typeof console.warn === 'function') {
      console.warn('[DM] Analytics is off: /assets/consent.js did not load before ' +
        '/assets/analytics.js. Nothing will be measured — this is the safe failure.');
    }
    return;
  }

  var MAX_PARAM = 100;   /* GA4 truncates parameter values at 100 characters */

  function txt(value) {
    if (value === null || value === undefined) { return undefined; }
    var s = String(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!s) { return undefined; }
    return s.length > MAX_PARAM ? s.slice(0, MAX_PARAM) : s;
  }

  function closestEl(node, selector) {
    while (node && node.nodeType === 1) {
      if (typeof node.closest === 'function') { return node.closest(selector); }
      node = node.parentNode;
    }
    return null;
  }

  /* The single choke point. Nothing leaves this file except through here,
     and nothing leaves at all without consent. Returns true only if the
     event was genuinely handed to GA4. */
  function track(name, params) {
    if (!window.DMConsent.isGranted()) { return false; }
    if (typeof window.gtag !== 'function') { return false; }
    var clean = {};
    if (params) {
      for (var k in params) {
        if (!Object.prototype.hasOwnProperty.call(params, k)) { continue; }
        var v = params[k];
        if (v === undefined || v === null || v === '') { continue; }
        clean[k] = (typeof v === 'number' || typeof v === 'boolean') ? v : txt(v);
      }
    }
    try { window.gtag('event', name, clean); return true; }
    catch (e) { return false; }   /* a blocked or broken tag never breaks the page */
  }

  /* One event per key per page view — keeps FAQ toggling and repeat focus
     from turning into noise.

     The dedupe key is only spent when the event actually went out. If
     someone opens an FAQ before answering the banner, that first open is
     not recorded (correctly, there is no consent) and the key stays
     unused, so the next open after consent is still captured. Marking the
     key regardless would silently lose the first real event of a session. */
  var fired = {};
  function trackOnce(key, name, params) {
    if (fired[key]) { return false; }
    if (!track(name, params)) { return false; }
    fired[key] = true;
    return true;
  }

  /* ==================================================================
     Forms
     ================================================================== */

  /* Three of the five pages use id="h" / id="b" instead of
     id="hero-form" / id="bottom-form". Normalise here so GA4 gets one
     consistent dimension regardless. (There is also an HTML patch that
     fixes this at source — see the handover notes.) */
  function formId(form) {
    if (!form) { return undefined; }
    var id = form.id || '';
    if (id === 'hero-form' || id === 'h') { return 'hero-form'; }
    if (id === 'bottom-form' || id === 'b') { return 'bottom-form'; }
    if (id) { return id; }
    return closestEl(form, '.hero') ? 'hero-form' : 'bottom-form';
  }

  /* The select is called name="service" on / and name="sector" on the four
     service pages, and it asks a DIFFERENT QUESTION on each page. Always
     read this dimension broken down by page_path — see the handover note.

     The parameter is called `service` to match what forms.js already
     pushes. Same value, one name, one custom dimension in GA4. */
  function serviceValue(form) {
    if (!form) { return undefined; }
    var sel = form.querySelector('select[name="service"], select[name="sector"]');
    if (!sel || sel.selectedIndex < 0) { return undefined; }
    var opt = sel.options[sel.selectedIndex];
    return txt(opt ? (opt.text || opt.value) : sel.value);
  }

  function formByAnyId(id) {
    if (!id) { return null; }
    var direct = document.getElementById(id);
    if (direct && direct.tagName === 'FORM') { return direct; }
    if (id === 'hero-form') { return document.getElementById('h'); }
    if (id === 'bottom-form') { return document.getElementById('b'); }
    return null;
  }

  /* form_start — first interaction with either enquiry form.
     Gives you the denominator for abandonment: started vs generate_lead. */
  document.addEventListener('focusin', function (e) {
    var form = closestEl(e.target, 'form.lead-form');
    if (!form) { return; }
    var id = formId(form);
    trackOnce('form_start:' + id, 'form_start', { form_id: id });
  });

  /* ==================================================================
     dataLayer bridge — how forms.js reaches GA4

     IMPORTANT: this site uses gtag.js, not Google Tag Manager. gtag.js
     only understands arguments-shaped dataLayer entries. A plain object
     push like {event:'generate_lead'} is a GTM convention and gtag.js
     ignores it completely. Without this bridge, forms.js would push into
     a void and nothing would ever be recorded. This translates those
     object pushes into real gtag('event', ...) calls.
     ================================================================== */
  /* forms.js pushes {form_id, form_location, service}. form_id comes
     through raw, so it is 'h' or 'b' on three of the five pages — that is
     normalised here so GA4 sees one consistent value. Anything forms.js
     did not supply is filled in from the DOM; anything it did supply is
     left exactly as it sent it. */
  function enrichLead(params) {
    var out = params || {};
    if (!out.form_id) {
      var forms = document.querySelectorAll('form.lead-form');
      if (forms.length === 1) { out.form_id = formId(forms[0]); }
    } else {
      out.form_id = formId({ id: String(out.form_id) }) || out.form_id;
    }
    var f = formByAnyId(out.form_id);
    if (!out.service) {
      var value = serviceValue(f);
      if (value) { out.service = value; }
    }
    if (!out.form_location) {
      out.form_location = out.form_id === 'hero-form' ? 'hero' : 'bottom';
    }
    return out;
  }

  /* gtag.js pushes its OWN object-shaped entries into the dataLayer once
     it loads — {event:'gtm.js'}, {event:'gtm.dom'}, {event:'gtm.load'}.
     Translating those back into gtag('event', ...) calls would send junk
     hits named after Google's internals. Only names that are valid GA4
     event names and are not reserved internals get through. */
  var VALID_EVENT = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
  function isOurs(name) {
    if (!VALID_EVENT.test(name)) { return false; }          /* kills anything with a dot */
    var lower = name.toLowerCase();
    return lower.indexOf('gtm') !== 0 &&
           lower.indexOf('gtag') !== 0 &&
           lower.indexOf('ga_') !== 0 &&
           lower.indexOf('google_') !== 0 &&
           lower.indexOf('firebase_') !== 0;
  }

  function translate(item) {
    try {
      if (!item || typeof item !== 'object') { return; }
      if (Object.prototype.toString.call(item) === '[object Array]') { return; }
      var name = item.event;
      if (typeof name !== 'string' || !name) { return; }
      if (!isOurs(name)) { return; }
      if (item.__dmHandled) { return; }
      item.__dmHandled = true;

      var params = {};
      for (var k in item) {
        if (!Object.prototype.hasOwnProperty.call(item, k)) { continue; }
        if (k === 'event' || k === '__dmHandled' || k.indexOf('gtm.') === 0) { continue; }
        params[k] = item[k];
      }
      if (name === 'generate_lead') { params = enrichLead(params); }
      track(name, params);
    } catch (e) { /* a malformed push must never break the page */ }
  }

  (function bridgeDataLayer() {
    window.dataLayer = window.dataLayer || [];
    var dl = window.dataLayer;
    if (dl.__dmBridged) { return; }
    dl.__dmBridged = true;

    var nativePush = dl.push;
    dl.push = function () {
      var result = nativePush.apply(dl, arguments);
      for (var i = 0; i < arguments.length; i++) { translate(arguments[i]); }
      return result;
    };
    /* forms.js may already have pushed before this file ran. Arguments
       objects queued by gtag() have no .event key, so they are skipped. */
    for (var j = 0; j < dl.length; j++) { translate(dl[j]); }
  })();

  /* ==================================================================
     Contact clicks

     No event_callback juggling needed: GA4 sends via navigator.sendBeacon,
     which survives the page unloading as the dialler or WhatsApp opens.
     ================================================================== */
  document.addEventListener('click', function (e) {
    var a = closestEl(e.target, 'a[href]');
    if (!a) { return; }
    var href = a.getAttribute('href') || '';
    var inSticky = !!closestEl(a, '.sticky-cta');

    if (href.indexOf('tel:') === 0) {
      track('contact_phone_click', {
        link_location: inSticky ? 'sticky_bar' : 'page_body'
      });
      return;
    }

    if (href.indexOf('wa.me') > -1 || href.indexOf('whatsapp.com') > -1) {
      track('contact_whatsapp_click', {
        link_location: inSticky ? 'sticky_bar' : 'page_body'
      });
      return;
    }

    if (href.indexOf('google.com/search') > -1) {
      var where = 'page_body';
      if (closestEl(a, '.gwidget') || a.className.indexOf('gwidget') > -1) { where = 'hero_proof'; }
      else if (closestEl(a, '.rev-agg')) { where = 'reviews_section'; }
      else if (closestEl(a, '.award')) { where = 'trust_strip'; }
      track('review_click', { link_location: where });
    }
  });

  /* ==================================================================
     FAQ and accordion opens

     `toggle` does not bubble, so these are bound per element. There are
     at most 16 on a page. Only opening counts, and only the first open
     per question per page view.
     ================================================================== */
  (function faq() {
    var all = document.querySelectorAll('.faq details, .acc details');
    for (var i = 0; i < all.length; i++) {
      (function (d) {
        var isFaq = !!closestEl(d, '.faq');
        d.addEventListener('toggle', function () {
          if (!d.open) { return; }
          var summary = d.querySelector('summary');
          var question = txt(summary ? summary.textContent : '');
          if (!question) { return; }
          trackOnce('faq:' + question, 'faq_open', {
            question: question,
            section_type: isFaq ? 'faq' : 'content'
          });
        });
      })(all[i]);
    }
  })();

  /* ==================================================================
     Pricing reached (homepage only — #pricing exists nowhere else)

     Tells you whether people get as far as the price, and whether the
     ones who do convert better or worse. If they reach it and stop, the
     problem is the price or the packaging. If they never reach it, the
     problem is the route through the page.
     ================================================================== */
  (function pricing() {
    var el = document.getElementById('pricing');
    if (!el || !('IntersectionObserver' in window)) { return; }
    /* Stop observing only once the event has genuinely been sent. If the
       visitor scrolls past the prices before answering the banner, we keep
       watching rather than discarding the signal for the whole session. */
    var obs = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) { continue; }
        if (trackOnce('view_pricing', 'view_pricing', {})) {
          obs.unobserve(entries[i].target);
        }
      }
    }, { threshold: 0.3 });
    obs.observe(el);
  })();

  /* ==================================================================
     Hand the ID to the consent gate. Everything above stays dormant
     until DMConsent reports a granted state.
     ================================================================== */
  window.DMConsent.registerMeasurementId(GA4_ID);
})();
