/* Digital Movement UK — shared behaviour
   Scroll reveal · scroll rail · metric counters · data bars · sticky CTA
   All motion respects prefers-reduced-motion. */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- Scroll reveal ---- */
  var revealables = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(revealables, function (el) { el.classList.add('in'); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    Array.prototype.forEach.call(revealables, function (el) { revealObserver.observe(el); });
    /* Safety net: never leave content invisible */
    window.setTimeout(function () {
      Array.prototype.forEach.call(revealables, function (el) { el.classList.add('in'); });
    }, 2500);
  }

  /* ---- Top scroll progress rail ---- */
  var rail = document.querySelector('.rail');
  if (rail && !reduced) {
    var railTicking = false;
    /* Cache the layout-forcing read; recompute on resize only. Reading
       scrollHeight inside the scroll handler forces layout every frame. */
    var railMax = document.documentElement.scrollHeight - window.innerHeight;
    var updateRail = function () {
      var pct = railMax > 0 ? window.scrollY / railMax : 0;
      rail.style.transform = 'scaleX(' + Math.min(1, Math.max(0, pct)) + ')';
      railTicking = false;
    };
    window.addEventListener('resize', function () {
      railMax = document.documentElement.scrollHeight - window.innerHeight;
      updateRail();
    }, { passive: true });
    window.addEventListener('load', function () {
      railMax = document.documentElement.scrollHeight - window.innerHeight;
      updateRail();
    });
    window.addEventListener('scroll', function () {
      if (!railTicking) { window.requestAnimationFrame(updateRail); railTicking = true; }
    }, { passive: true });
    updateRail();
  }

  /* ---- Metric counters ---- */
  var counters = document.querySelectorAll('[data-count]');
  if (counters.length) {
    var runCount = function (el) {
      var target = parseFloat(el.getAttribute('data-count'));
      var suffix = el.getAttribute('data-suffix') || '';
      var decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
      if (reduced) { el.textContent = target.toFixed(decimals) + suffix; return; }
      var start = null;
      var duration = 1300;
      var step = function (now) {
        if (start === null) { start = now; }
        var p = Math.min(1, (now - start) / duration);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = (target * eased).toFixed(decimals) + suffix;
        if (p < 1) { window.requestAnimationFrame(step); }
      };
      window.requestAnimationFrame(step);
    };
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(counters, runCount);
    } else {
      var countObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { runCount(entry.target); countObserver.unobserve(entry.target); }
        });
      }, { threshold: 0.5 });
      Array.prototype.forEach.call(counters, function (el) { countObserver.observe(el); });
    }
  }

  /* ---- Data bars ---- */
  var bars = document.querySelectorAll('.databar i[data-fill]');
  if (bars.length) {
    var fillBar = function (el) { el.style.width = el.getAttribute('data-fill') + '%'; };
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(bars, fillBar);
    } else {
      var barObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { fillBar(entry.target); barObserver.unobserve(entry.target); }
        });
      }, { threshold: 0.4 });
      Array.prototype.forEach.call(bars, function (el) { barObserver.observe(el); });
    }
  }

  /* ---- Mobile navigation ---- */
  var navToggle = document.getElementById('navToggle');
  var navLinks = document.getElementById('navLinks');
  if (navToggle && navLinks) {
    var setNav = function (open, moveFocus) {
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      navLinks.classList.toggle('open', open);
      if (open && moveFocus) {
        var first = navLinks.querySelector('a');
        if (first) { first.focus(); }
      }
    };
    navToggle.addEventListener('click', function () {
      setNav(navToggle.getAttribute('aria-expanded') !== 'true', true);
    });
    navLinks.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') { setNav(false); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') {
        setNav(false);
        navToggle.focus();
      }
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 960) { setNav(false); }
    });
  }

  /* ---- Sticky contact bar (appears past the hero) ---- */
  var sticky = document.getElementById('stickyCta');
  var hero = document.querySelector('.hero');
  if (sticky) {
    var stickyTicking = false;
    /* Cache the trigger height; reading offsetHeight per frame forces layout.
       Pages without a .hero (blog posts, resources, legal) fall back to one
       viewport, which is what .hero{min-height:100svh} amounts to elsewhere. */
    var heroH = hero ? hero.offsetHeight : window.innerHeight;
    var updateSticky = function () {
      sticky.classList.toggle('show', window.scrollY > heroH - 120);
      stickyTicking = false;
    };
    window.addEventListener('resize', function () {
      heroH = hero ? hero.offsetHeight : window.innerHeight;
      updateSticky();
    }, { passive: true });
    window.addEventListener('scroll', function () {
      if (!stickyTicking) { window.requestAnimationFrame(updateSticky); stickyTicking = true; }
    }, { passive: true });
    updateSticky();
  }
})();
