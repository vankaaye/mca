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

  // ============================================================
  //  Chatbot
  // ============================================================

  var chatToggle = document.getElementById('chatbot-toggle');
  var chatPanel = document.getElementById('chatbot-panel');
  var chatMessages = document.getElementById('chatbot-messages');
  var chatInput = document.getElementById('chatbot-input');
  var chatSend = document.getElementById('chatbot-send');
  var chatOpened = false;

  // Toggle chat panel
  chatToggle.addEventListener('click', function () {
    var isOpen = chatPanel.classList.toggle('open');
    chatToggle.classList.toggle('active', isOpen);

    if (isOpen && !chatOpened) {
      chatOpened = true;
      addBotMessage('Welcome to the MCA Assistant! Ask me anything about MCA rules, competitions, fees, or registration.');
    }

    if (isOpen) {
      chatInput.focus();
    }
  });

  // Send message on button click
  chatSend.addEventListener('click', function () {
    sendUserMessage();
  });

  // Send message on Enter key
  chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendUserMessage();
    }
  });

  function sendUserMessage() {
    var text = chatInput.value.trim();
    if (!text) return;

    addUserMessage(text);
    chatInput.value = '';

    // Show typing indicator
    var typing = document.createElement('div');
    typing.className = 'chat-typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    chatMessages.appendChild(typing);
    scrollChatToBottom();

    // Simulate short delay for response
    setTimeout(function () {
      chatMessages.removeChild(typing);
      var answer = findAnswer(text);
      addBotMessage(answer);
    }, 600);
  }

  function addUserMessage(text) {
    var div = document.createElement('div');
    div.className = 'chat-msg chat-msg-user';
    div.textContent = text;
    chatMessages.appendChild(div);
    scrollChatToBottom();
  }

  function addBotMessage(text) {
    var div = document.createElement('div');
    div.className = 'chat-msg chat-msg-bot';
    div.textContent = text;
    chatMessages.appendChild(div);
    scrollChatToBottom();
  }

  function scrollChatToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function findAnswer(query) {
    // Check if MCA_RULES data is available
    var rules = window.MCA_RULES;
    if (!rules || !Array.isArray(rules) || rules.length === 0) {
      return getFallbackAnswer(query);
    }

    var queryLower = query.toLowerCase();
    var words = queryLower.split(/\s+/).filter(function (w) { return w.length > 2; });

    var bestMatch = null;
    var bestScore = 0;

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var searchText = '';

      // Build searchable text from rule entry
      if (rule.question) searchText += ' ' + rule.question.toLowerCase();
      if (rule.keywords) {
        if (Array.isArray(rule.keywords)) {
          searchText += ' ' + rule.keywords.join(' ').toLowerCase();
        } else {
          searchText += ' ' + rule.keywords.toLowerCase();
        }
      }
      if (rule.category) searchText += ' ' + rule.category.toLowerCase();
      if (rule.topic) searchText += ' ' + rule.topic.toLowerCase();

      var score = 0;
      for (var j = 0; j < words.length; j++) {
        if (searchText.indexOf(words[j]) !== -1) {
          score += 1;
        }
      }

      // Bonus for exact phrase match
      if (searchText.indexOf(queryLower) !== -1) {
        score += 3;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = rule;
      }
    }

    if (bestMatch && bestScore > 0) {
      return bestMatch.answer || bestMatch.response || bestMatch.text || 'I found a match but the answer is not available.';
    }

    return getFallbackAnswer(query);
  }

  function getFallbackAnswer(query) {
    var q = query.toLowerCase();

    // Built-in fallback answers
    if (q.indexOf('t20') !== -1 && (q.indexOf('time') !== -1 || q.indexOf('when') !== -1)) {
      return 'The Saturday T20 competition runs from 8:00 AM to 11:30 AM, starting 12 April 2026. The format is 16 rounds + Pre SF + SF + Final.';
    }
    if (q.indexOf('t35') !== -1 && q.indexOf('non') !== -1) {
      return 'The Saturday T35 Non MYCA runs 12:00 PM to 5:00 PM, from 11 April to 12 September 2026. It has 10 rounds + Pre SF + SF + Final with a $1,000 prize.';
    }
    if (q.indexOf('t35') !== -1 && (q.indexOf('time') !== -1 || q.indexOf('when') !== -1)) {
      return 'The Saturday T35 runs 12:00 PM to 5:00 PM, from 11 April to 22 August 2026. Format: 16 rounds + Pre SF + SF + Final. Prize: $1,500.';
    }
    if (q.indexOf('fee') !== -1 || q.indexOf('cost') !== -1 || q.indexOf('price') !== -1 || q.indexOf('pay') !== -1) {
      return 'Registration fees: T20 is $675, T35 Non MYCA is $675, T35 is $425. Umpire fees are $65/game (T20) or $85/game (T35). Balls cost $30 each.';
    }
    if (q.indexOf('register') !== -1 || q.indexOf('sign up') !== -1 || q.indexOf('join') !== -1) {
      return 'To register, scan the QR code on our website or contact Gopi (President) at 0430 667 896 or Mahi (Secretary) at 0433 960 586.';
    }
    if (q.indexOf('umpire') !== -1) {
      return 'Every game features professional umpires, some from Premier Cricket. Umpire fees: $65/game for T20, $85/game for T35 and T35 Non MYCA, $65-$70/game for Juniors.';
    }
    if (q.indexOf('prize') !== -1 || q.indexOf('win') !== -1) {
      return 'Prize pools: T20 has $1,500 (up from $1,000), T35 has $1,500 (up from $1,000), and T35 Non MYCA has $1,000.';
    }
    if (q.indexOf('junior') !== -1 || q.indexOf('under') !== -1 || q.indexOf('u11') !== -1 || q.indexOf('u13') !== -1 || q.indexOf('u15') !== -1 || q.indexOf('kid') !== -1) {
      return 'Juniors competitions start 26 April 2026 on alternate Sundays at 12:30 PM. Categories: U11 (ages 8-11, 25 overs), U13 (ages 9-13, 25 overs), U15 (ages 12-15, 30 overs). Contact Deepak Kulkarni at 0404 073 222.';
    }
    if (q.indexOf('contact') !== -1 || q.indexOf('phone') !== -1 || q.indexOf('call') !== -1) {
      return 'Contact: Gopi (President) 0430 667 896, Mahi (Secretary) 0433 960 586, Deepak Kulkarni (Juniors Coordinator) 0404 073 222. Also follow us on Facebook.';
    }
    if (q.indexOf('season') !== -1 || q.indexOf('start') !== -1 || q.indexOf('date') !== -1) {
      return 'The Winter 2026 season starts 11 April (T35) and 12 April (T20). Juniors begin 26 April. The T35 Non MYCA season runs until 12 September 2026.';
    }
    if (q.indexOf('ball') !== -1) {
      return 'Match balls: Seniors use MCA Stamped Kooka Crown 2-piece white ($30 each). U11 uses Kooka Soft Pink. U13 uses Kooka Crown White 142g. U15 uses Kooka Crown White 156g.';
    }
    if (q.indexOf('ground') !== -1 || q.indexOf('venue') !== -1) {
      return 'Teams organise grounds via local councils or schools. MCA provides grounds where possible.';
    }
    if (q.indexOf('live') !== -1 || q.indexOf('stream') !== -1 || q.indexOf('watch') !== -1) {
      return 'Games are live streamed via Frogbox on YouTube with PlayHQ live scoring. You can also follow via the PlayCricket app.';
    }
    if (q.indexOf('rule') !== -1 || q.indexOf('regulation') !== -1) {
      return 'You can download the official MCA rules PDF from the Rules section of our website. All captains and players should read them before the season.';
    }
    if (q.indexOf('hello') !== -1 || q.indexOf('hi') !== -1 || q.indexOf('hey') !== -1) {
      return 'Hello! I can help you with information about MCA competitions, fees, registration, rules, and more. What would you like to know?';
    }

    return "I couldn't find a specific answer for that. Try asking about competitions, fees, registration, rules, umpires, juniors, or contact details. You can also call Gopi at 0430 667 896 for help.";
  }

})();
