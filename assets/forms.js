/* Digital Movement UK — enquiry form handling
   Progressive enhancement over the existing .lead-form markup.
   No dependencies, no build step. Same house style as site.js:
   IIFE, strict mode, var, no framework.

   What this file does, in order:
     1. Turns off the native validation bubbles and validates in-page
        instead, with persistent per-field error text.
     2. Checks a honeypot field and how long the page has been open.
     3. POSTs the answers to ENDPOINT as FormData.
     4. Records what the person consented to: the tick-box state, the
        exact wording that was on screen, the page URL and an ISO
        timestamp.
     5. Announces every state — sending, sent, failed — in a live region
        inside the form, and gives a phone number and a pre-filled
        mailto: link if the send fails, so nobody's effort is lost.

   If ENDPOINT is left empty the forms keep their current mailto:
   behaviour, so nothing regresses before it is configured.
   ========================================================================= */
(function () {
  'use strict';

  /* =======================================================================
     CONFIG — THE ONE LINE YOU NORMALLY CHANGE

     Paste your form endpoint between the quotes. Examples:

       Formspree     'https://formspree.io/f/xxxxxxxx'
       Basin         'https://usebasin.com/f/xxxxxxxxxx'
       Web3Forms     'https://api.web3forms.com/submit'   (+ access_key below)
       FormSubmit    'https://formsubmit.co/ajax/office@digitalmovement.uk'
       Own Worker    'https://forms.digitalmovement.uk/submit'

     Leave it as '' and every form falls back to the mailto: behaviour
     that is live today.
     ======================================================================= */
  /* First-party endpoint on Digital Movement's own Hostinger hosting.
     Chosen over Formspree/FormSubmit deliberately: with no third party in the
     chain there is no processor to contract with, so UK GDPR Article 28 simply
     does not arise. It writes every enquiry to disk OUTSIDE the web root before
     emailing, so a silent mail failure cannot lose a lead.
     Source: scratchpad/leads-endpoint/index.php */
  var ENDPOINT = 'https://leads.digitalmovement.uk/';

  /* Provider-specific extras sent with every submission. Leave the object
     empty for Formspree, Basin and a custom Worker — none of them need it.
       Web3Forms   access_key: 'your-access-key'
       FormSubmit  _subject / _template / _captcha as below
     Anything you put here is sent verbatim as a form field. */
  var EXTRA_FIELDS = {};   /* first-party endpoint needs no provider extras */

  /* Where a non-JS submission lands after the endpoint redirects.
     Sent as _next, which Formspree, Basin and FormSubmit all understand. */
  var THANK_YOU_URL = 'https://digitalmovement.uk/thank-you/';

  /* Contact details used in the failure message. */
  var PHONE_DISPLAY = '0203 815 7992';
  var PHONE_HREF = '+442038157992';
  var FALLBACK_EMAIL = 'office@digitalmovement.uk';

  /* Spam: how long the page must have been open before a submission is
     let through. Under this, the send is held back rather than rejected —
     a real person filling in a form with a password manager can be quick,
     and losing a genuine enquiry costs far more than accepting a bot. */
  var MIN_OPEN_MS = 3000;

  /* Cap on the pre-filled mailto: body. Some mail clients truncate or
     refuse very long mailto: URLs. */
  var MAILTO_MAX = 1500;

  /* ---- Small helpers ---- */

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var URL_RE = /^https?:\/\/[^\s.\/]+(\.[^\s.\/]+)+/i;

  function squash(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function labelTextFor(form, el) {
    var lab = null;
    if (el.id) { lab = form.querySelector('label[for="' + el.id + '"]'); }
    if (!lab && el.closest) { lab = el.closest('label'); }
    return lab ? squash(lab.textContent) : squash(el.name);
  }

  /* The honeypot is found by its data-hp wrapper, never by field name, so
     the input can be renamed to whatever the endpoint checks server-side:
       FormSubmit  _honey        Formspree  _gotcha
       Basin       _honeypot     Web3Forms  botcheck
     Renaming it does not require a change in here. */
  function isHoneypot(el) {
    return !!(el.closest && el.closest('[data-hp]'));
  }

  /* ---- Validation ---- */

  var EMPTY_MESSAGES = {
    name: 'Please enter your name.',
    phone: 'Please enter a phone number we can reach you on.',
    email: 'Please enter your email address.',
    website: 'Please enter your website address.',
    message: 'Please tell us a little about what you need.'
  };

  function validateField(el) {
    var v = squash(el.value);

    if (el.type === 'checkbox') {
      if (el.required && !el.checked) {
        return 'Please tick the box so we know we may use your details to reply.';
      }
      return '';
    }

    if (!v) {
      if (!el.required) { return ''; }
      return EMPTY_MESSAGES[el.name] || 'Please fill this in.';
    }

    if (el.name === 'name' && v.length < 2) {
      return 'Please enter your name.';
    }
    if (el.type === 'email' && !EMAIL_RE.test(v)) {
      return 'That email address does not look right — please check it.';
    }
    if (el.type === 'tel' && v.replace(/[^0-9]/g, '').length < 7) {
      return 'Please enter a phone number we can reach you on.';
    }
    if (el.type === 'url') {
      /* Be forgiving: accept "yourcompany.co.uk" and add the scheme
         ourselves rather than rejecting a perfectly clear answer. */
      var normalised = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'https://' + v;
      if (!URL_RE.test(normalised)) {
        return 'That website address does not look right — for example https://yourcompany.co.uk';
      }
      if (normalised !== el.value) { el.value = normalised; }
      return '';
    }
    if (el.tagName === 'TEXTAREA' && el.required && v.length < 5) {
      return 'Please tell us a little about what you need.';
    }
    return '';
  }

  /* ---- Error rendering ----
     aria-describedby is added only while an error is on screen and removed
     when it clears, so the field never points at an empty element. */

  function errorHost(el) {
    if (!el.closest) { return el.parentNode; }
    return el.closest('.form-field') || el.closest('.consent') || el.parentNode;
  }

  function ensureId(form, el) {
    if (!el.id) {
      el.id = (form.id || 'form') + '-' + (el.name || 'field');
    }
    return el.id;
  }

  function clearError(form, el) {
    var id = el.id ? el.id + '-error' : null;
    var node = id ? form.querySelector('#' + CSS_escape(id)) : null;
    if (node && node.parentNode) { node.parentNode.removeChild(node); }
    el.removeAttribute('aria-invalid');
    var described = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter(function (t) { return t && t !== id; })
      .join(' ');
    if (described) { el.setAttribute('aria-describedby', described); }
    else { el.removeAttribute('aria-describedby'); }
  }

  function showError(form, el, message) {
    var id = ensureId(form, el) + '-error';
    var node = form.querySelector('#' + CSS_escape(id));
    if (!node) {
      node = document.createElement('p');
      node.className = 'form-error';
      node.id = id;
      var host = errorHost(el);
      if (host.classList && host.classList.contains('consent')) {
        /* .consent is itself a <label>; the message belongs after it. */
        if (host.parentNode) { host.parentNode.insertBefore(node, host.nextSibling); }
      } else {
        host.appendChild(node);
      }
    }
    node.textContent = message;
    el.setAttribute('aria-invalid', 'true');
    var described = (el.getAttribute('aria-describedby') || '').split(/\s+/)
      .filter(function (t) { return t && t !== id; });
    described.push(id);
    el.setAttribute('aria-describedby', described.join(' '));
  }

  /* Minimal CSS.escape stand-in — our ids are simple, but a leading digit
     or a stray character would otherwise throw inside querySelector. */
  function CSS_escape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(s);
    }
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  /* ---- Payload ---- */

  function collect(form) {
    var rows = [];
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled) { return; }
      if (el.type === 'submit' || el.type === 'button' || el.type === 'hidden') { return; }
      if (isHoneypot(el)) { return; }
      if (el.type === 'checkbox') {
        rows.push({ name: el.name, label: labelTextFor(form, el), value: el.checked ? 'yes' : 'no' });
        return;
      }
      if (el.type === 'radio') {
        if (el.checked) {
          rows.push({ name: el.name, label: labelTextFor(form, el), value: squash(el.value) });
        }
        return;
      }
      rows.push({ name: el.name, label: labelTextFor(form, el), value: squash(el.value) });
    });
    return rows;
  }

  /* The wording actually shown next to the tick box, read from the page so
     the record can never drift from what the person saw. */
  function consentWording(form) {
    var span = form.querySelector('.consent span');
    if (span) { return squash(span.textContent); }
    var lab = form.querySelector('.consent');
    return lab ? squash(lab.textContent) : '';
  }

  function formLocation(form) {
    if (form.closest && form.closest('.hero')) { return 'hero'; }
    return 'bottom';
  }

  var canFetch = typeof window.fetch === 'function' && typeof window.FormData === 'function';

  /* Point the form at ENDPOINT and add the hidden fields the no-JS path
     needs. ENDPOINT therefore stays the single place it is configured: the
     fetch path and the plain HTML POST both read from here. If fetch is
     unavailable the browser submits natively to the same endpoint and the
     endpoint redirects to _next. */
  function rewireAction(form) {
    form.setAttribute('action', ENDPOINT);
    form.setAttribute('method', 'post');
    form.removeAttribute('enctype');
    addHidden(form, '_next', THANK_YOU_URL);
    for (var key in EXTRA_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(EXTRA_FIELDS, key)) {
        addHidden(form, key, EXTRA_FIELDS[key]);
      }
    }
  }

  function addHidden(form, name, value) {
    if (form.querySelector('input[type="hidden"][name="' + name + '"]')) { return; }
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  function serviceValue(form) {
    var el = form.elements.service || form.elements.sector;
    return el ? squash(el.value) : '';
  }

  /* FormData rather than JSON, deliberately.

     A FormData body is sent as multipart/form-data, which is one of the
     three content types the CORS spec treats as a "simple request" — so the
     browser never fires a preflight OPTIONS. Several hosted form services
     answer OPTIONS inconsistently or not at all, and an application/json
     body would trigger exactly that request on every submission.

     It also means the JS path and the no-JS path send an identical body
     shape, so one endpoint configuration serves both. */
  function buildBody(form, rows, elapsedMs) {
    var fd = new FormData();
    var i;

    for (i = 0; i < rows.length; i++) {
      fd.append(rows[i].name, rows[i].value);
    }

    /* --- Consent record ---
       The tick box already arrives as an ordinary field (usually named
       "consent"), so only add consent_given when the form does not have
       one — no point sending the same answer twice. */
    var consentEl = form.querySelector('.consent input[type="checkbox"]');
    var consentSent = false;
    for (i = 0; i < rows.length; i++) {
      if (consentEl && rows[i].name === consentEl.name) { consentSent = true; }
    }
    if (!consentSent) {
      fd.append('consent_given', consentEl && consentEl.checked ? 'yes' : 'no');
    }
    fd.append('consent_text', consentWording(form));
    fd.append('consent_timestamp', new Date().toISOString());
    fd.append('page_url', window.location.href);
    fd.append('page_title', document.title);

    /* --- Provenance, kept deliberately thin ---
       No user agent, no fingerprinting. The endpoint records the IP itself
       and the site's privacy notice commits to collecting no more than is
       needed, so the record covers what was agreed, where and when. */
    fd.append('form_id', form.id || '');
    fd.append('form_location', formLocation(form));
    fd.append('form_open_seconds', String(Math.round(elapsedMs / 1000)));

    /* Redirect target for the no-JS path; harmless on the fetch path. */
    fd.append('_next', THANK_YOU_URL);

    for (var key in EXTRA_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(EXTRA_FIELDS, key)) {
        fd.append(key, EXTRA_FIELDS[key]);
      }
    }
    return fd;
  }

  function buildMailto(form, rows) {
    var subject = 'Website enquiry — ' + (document.title || 'Digital Movement UK');
    var lines = [];
    for (var i = 0; i < rows.length; i++) {
      lines.push(rows[i].label.replace(/\s*\*$/, '') + ': ' + rows[i].value);
    }
    lines.push('');
    lines.push('Consent: ' + consentWording(form));
    lines.push('Page: ' + window.location.href);
    lines.push('Time: ' + new Date().toISOString());
    var body = lines.join('\n');
    if (body.length > MAILTO_MAX) { body = body.slice(0, MAILTO_MAX) + '\n…'; }
    return 'mailto:' + FALLBACK_EMAIL +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
  }

  /* ---- Status region ---- */

  function statusRegion(form) {
    var node = form.querySelector('[data-form-status]');
    if (!node) {
      /* Defensive only. A live region added at submit time is announced
         unreliably, which is why it belongs in the markup. */
      node = document.createElement('p');
      node.className = 'form-status';
      node.setAttribute('data-form-status', '');
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      var btn = form.querySelector('button[type="submit"], .btn-primary');
      if (btn && btn.parentNode) { btn.parentNode.insertBefore(node, btn.nextSibling); }
      else { form.appendChild(node); }
    }
    node.setAttribute('tabindex', '-1');
    return node;
  }

  function setStatus(node, state, html) {
    node.className = 'form-status is-' + state;
    node.innerHTML = html;
  }

  /* ---- Analytics, guarded ---- */

  function pushLead(form) {
    if (!window.dataLayer) { return; }
    window.dataLayer.push({
      event: 'generate_lead',
      form_id: form.id || '',
      form_location: formLocation(form),
      service: serviceValue(form)
    });
  }

  /* ---- Wiring ---- */

  var warned = false;
  function warnOnce() {
    if (warned) { return; }
    warned = true;
    if (window.console && console.warn) {
      console.warn(
        '[Digital Movement] Enquiry forms are still using the mailto: fallback. ' +
        'Set ENDPOINT at the top of /assets/forms.js to your form endpoint ' +
        '(e.g. https://formspree.io/f/xxxxxxxx) to post enquiries properly, ' +
        'record consent and show an on-page confirmation.'
      );
    }
  }

  function enhance(form) {
    if (form.getAttribute('data-dm-forms') === 'on') { return; }
    form.setAttribute('data-dm-forms', 'on');

    var openedAt = Date.now();
    var status = statusRegion(form);
    var submitBtn = form.querySelector('button[type="submit"]');
    var originalBtn = submitBtn ? submitBtn.innerHTML : '';
    var sending = false;

    /* We validate in-page, so switch off the native bubbles. The required
       attributes stay on the inputs — assistive tech still reports them. */
    form.noValidate = true;

    if (ENDPOINT) { rewireAction(form); }

    /* Re-check a field once it has been flagged, so the error clears as
       soon as it is fixed rather than only on the next submit. */
    form.addEventListener('input', function (e) {
      var el = e.target;
      if (!el.name || isHoneypot(el)) { return; }
      if (el.getAttribute('aria-invalid') !== 'true') { return; }
      if (!validateField(el)) { clearError(form, el); }
    });
    form.addEventListener('change', function (e) {
      var el = e.target;
      if (el.type !== 'checkbox' || isHoneypot(el)) { return; }
      if (el.getAttribute('aria-invalid') === 'true' && !validateField(el)) {
        clearError(form, el);
      }
    });

    function runValidation() {
      var firstBad = null;
      Array.prototype.forEach.call(form.elements, function (el) {
        if (!el.name || el.disabled) { return; }
        if (el.type === 'submit' || el.type === 'button' || el.type === 'hidden') { return; }
        if (isHoneypot(el)) { return; }
        var message = validateField(el);
        if (message) {
          ensureId(form, el);
          showError(form, el, message);
          if (!firstBad) { firstBad = el; }
        } else {
          clearError(form, el);
        }
      });
      return firstBad;
    }

    function setBusy(on) {
      sending = on;
      if (on) { form.setAttribute('aria-busy', 'true'); }
      else { form.removeAttribute('aria-busy'); }
      if (!submitBtn) { return; }
      submitBtn.disabled = on;
      if (on) { submitBtn.textContent = 'Sending…'; }
      else { submitBtn.innerHTML = originalBtn; }
    }

    function onFailure(rows) {
      setBusy(false);
      setStatus(status, 'error',
        '<strong>Sorry — that did not send.</strong> ' +
        'Nothing has been lost: your answers are still in the form, so you can try again. ' +
        'If it keeps failing, call <a href="tel:' + PHONE_HREF + '">' + PHONE_DISPLAY + '</a> ' +
        'or <a href="' + buildMailto(form, rows) + '">send it by email instead</a> — ' +
        'the link opens a message with your details already filled in.'
      );
      status.focus();
    }

    function onSuccess() {
      setBusy(false);
      /* Before form.reset(), or the event reports the cleared select. */
      pushLead(form);
      form.classList.add('is-sent');
      setStatus(status, 'success',
        '<strong>Thank you — your enquiry is with us.</strong> ' +
        'It has gone straight to our inbox and a person will read it and reply by email. ' +
        'If you would rather talk it through, call <a href="tel:' + PHONE_HREF + '">' +
        PHONE_DISPLAY + '</a>.'
      );
      status.focus();
      form.reset();
    }

    form.addEventListener('submit', function (e) {
      if (sending) { e.preventDefault(); return; }

      var firstBad = runValidation();
      if (firstBad) {
        e.preventDefault();
        setStatus(status, 'error',
          'Please check the highlighted answers — we need a little more before we can send this.');
        firstBad.focus();
        return;
      }

      /* No endpoint yet: let the existing mailto: action run, unchanged.
         No fetch/FormData either: let the browser POST to ENDPOINT itself
         and follow the endpoint's redirect to the thank-you page. */
      if (!ENDPOINT || !canFetch) { return; }

      e.preventDefault();

      /* Honeypot: a real person never fills this in, and it is hidden from
         screen readers too. Show the ordinary confirmation rather than an
         error, so a bot gets no signal to iterate against. */
      var hp = form.querySelector('[data-hp] input');
      if (hp && squash(hp.value)) { onSuccess(); return; }

      var rows = collect(form);
      var elapsed = Date.now() - openedAt;
      var hold = Math.max(0, MIN_OPEN_MS - elapsed);

      setBusy(true);
      setStatus(status, 'pending', 'Sending your enquiry…');
      status.focus();

      window.setTimeout(function () {
        var body = buildBody(form, rows, Date.now() - openedAt);
        window.fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Accept': 'application/json' },
          body: body
        }).then(function (res) {
          if (res.ok) { onSuccess(); } else { onFailure(rows); }
        }).catch(function () {
          onFailure(rows);
        });
      }, hold);
    });
  }

  var forms = document.querySelectorAll('form.lead-form');
  if (!forms.length) { return; }

  if (!ENDPOINT) { warnOnce(); }

  Array.prototype.forEach.call(forms, enhance);
})();
