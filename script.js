(function () {
  'use strict';

  // --- Scroll Progress Bar ---
  var progressBar = document.getElementById('scroll-progress');

  function updateProgress() {
    var scrollTop = window.scrollY;
    var docHeight = document.documentElement.scrollHeight - window.innerHeight;
    var progress = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
    progressBar.style.width = progress + '%';
  }

  // --- Header Shrink on Scroll ---
  var header = document.getElementById('header');

  function updateHeader() {
    if (window.scrollY > 50) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  }

  window.addEventListener('scroll', function () {
    updateProgress();
    updateHeader();
  }, { passive: true });

  // --- IntersectionObserver: reveal elements ---
  var reveals = document.querySelectorAll('.reveal');
  var revealObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.15 });

  reveals.forEach(function (el) {
    revealObserver.observe(el);
  });

  // --- Counter Animation ---
  var counters = document.querySelectorAll('.hs-num[data-count]');
  var counted = new Set();

  var counterObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting && !counted.has(entry.target)) {
        counted.add(entry.target);
        animateCounter(entry.target);
      }
    });
  }, { threshold: 0.15 });

  counters.forEach(function (el) {
    counterObserver.observe(el);
  });

  function animateCounter(el) {
    var target = parseInt(el.getAttribute('data-count'), 10);
    var duration = 1500;
    var start = performance.now();

    function tick(now) {
      var elapsed = now - start;
      var progress = Math.min(elapsed / duration, 1);
      // ease-out quad
      var ease = 1 - (1 - progress) * (1 - progress);
      var current = Math.floor(ease * target);
      el.textContent = current.toLocaleString();
      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        el.textContent = target.toLocaleString();
      }
    }

    requestAnimationFrame(tick);
  }

  // --- Hamburger Menu ---
  var hamburger = document.getElementById('hamburger');

  hamburger.addEventListener('click', function () {
    header.classList.toggle('nav-open');
  });

  // Close mobile nav when a nav link is clicked
  var navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(function (link) {
    link.addEventListener('click', function () {
      header.classList.remove('nav-open');
    });
  });
})();
