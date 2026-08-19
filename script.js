(function () {
  'use strict';

  // --- Scroll Progress Bar ---
  var progressBar = document.getElementById('scroll-progress');

  function updateProgress() {
    if (!progressBar) return;
    var scrollTop = window.scrollY;
    var docHeight = document.documentElement.scrollHeight - window.innerHeight;
    var progress = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
    progressBar.style.width = progress + '%';
  }

  // --- Header Shrink on Scroll ---
  var header = document.getElementById('header');

  // The standalone chat page keeps the header compact at all times.
  var lockHeader = document.body.hasAttribute('data-chat-page');

  function updateHeader() {
    if (!header || lockHeader) return;
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

  // --- Hero pointer parallax ----------------------------------------------
  // Each layer carries a data-depth; moving the pointer shifts them by
  // different amounts, which is what actually reads as depth.
  var heroEl = document.getElementById('hero');
  var heroLayers = heroEl ? heroEl.querySelectorAll('.hero-photo') : [];
  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (heroEl && heroLayers.length && !reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    var pending = false;
    var px = 0, py = 0;

    heroEl.addEventListener('pointermove', function (e) {
      var r = heroEl.getBoundingClientRect();
      px = (e.clientX - r.left) / r.width - 0.5;
      py = (e.clientY - r.top) / r.height - 0.5;
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        for (var i = 0; i < heroLayers.length; i++) {
          var d = 0.6; // single photo layer, subtle drift only
          heroLayers[i].style.transform =
            'translate3d(' + (-px * d * 26).toFixed(2) + 'px,' +
            (-py * d * 26).toFixed(2) + 'px, 0)';
        }
      });
    });

    heroEl.addEventListener('pointerleave', function () {
      for (var i = 0; i < heroLayers.length; i++) heroLayers[i].style.transform = '';
    });
  }

  // --- Light / dark theme -------------------------------------------------
  // The initial theme is applied by an inline script in <head> so the page
  // never flashes the wrong one; this only handles switching afterwards.
  var themeToggle = document.getElementById('theme-toggle');

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('mca-theme', next); } catch (err) { /* private mode */ }
    });
  }

  // --- Hamburger Menu ---
  var hamburger = document.getElementById('hamburger');

  if (hamburger && header) {
    hamburger.addEventListener('click', function () {
      header.classList.toggle('nav-open');
    });
  }

  // Close mobile nav when a nav link is clicked
  var navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(function (link) {
    link.addEventListener('click', function () {
      header.classList.remove('nav-open');
    });
  });


  // ============================================================
  //  MCA Assistant — chat widget
  //
  //  Talks to the Cloudflare Worker at window.MCA_CHAT_ENDPOINT, which
  //  proxies the Anthropic API so the key never reaches the browser.
  //  If that endpoint is unset or unreachable, the widget falls back to
  //  the offline keyword lookup over rules-data.js further below, so the
  //  site still answers questions either way.
  // ============================================================

  var chatToggle = document.getElementById('chatbot-toggle');
  var chatPanel = document.getElementById('chatbot-panel');
  var chatMessages = document.getElementById('chatbot-messages');
  var chatInput = document.getElementById('chatbot-input');
  var chatSend = document.getElementById('chatbot-send');
  var chatMic = document.getElementById('chatbot-mic');
  var chatChips = document.getElementById('chatbot-chips');
  // Focusing an input on a touch device raises the on-screen keyboard, so the
  // widget never takes focus by itself there — the user taps the field first.
  var coarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  var chatOpened = false;
  var chatBusy = false;

  // Running conversation sent to the Worker (user/assistant text only).
  var history = [];

  var STARTER_QUESTIONS = [
    'How many overs in T20?',
    'What is the umpire fee for T35?',
    'What age group is my child in?',
    'What happens if it rains?'
  ];

  function endpoint() {
    var url = window.MCA_CHAT_ENDPOINT;
    return typeof url === 'string' && url.trim() ? url.trim().replace(/\/+$/, '') : '';
  }

  // ---- Minimal markdown renderer -------------------------------------------
  // Everything is HTML-escaped first, then a small set of inline and block
  // constructs is re-introduced. Nothing from the model is ever injected raw.

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(url) {
    var u = String(url).trim();
    // Only absolute http(s), in-page anchors and site-relative paths.
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[/#]/.test(u)) return u;
    return '';
  }

  function renderInline(text) {
    var out = escapeHtml(text);

    // Links: [label](target)
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (match, label, target) {
      var href = safeUrl(target.replace(/&amp;/g, '&'));
      if (!href) return label;
      var external = /^https?:\/\//i.test(href);
      return (
        '<a href="' + escapeHtml(href) + '"' +
        (external ? ' target="_blank" rel="noopener noreferrer"' : '') +
        '>' + label + '</a>'
      );
    });

    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    return out;
  }

  function splitRow(line) {
    return line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(function (cell) { return cell.trim(); });
  }

  function renderMarkdown(md) {
    var lines = String(md).split('\n');
    var html = '';
    var i = 0;

    function isTableSeparator(line) {
      return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.indexOf('-') !== -1;
    }

    // A pipe-delimited row: starts and ends with "|" and has at least two cells
    function isTableRow(line) {
      var t = (line || '').trim();
      return t.charAt(0) === '|' && t.charAt(t.length - 1) === '|' && t.length > 2 &&
             t.split('|').length >= 4;
    }

    while (i < lines.length) {
      var line = lines[i];

      // Table: two or more consecutive pipe-delimited rows. The separator row
      // is optional — models often omit it, and without this the whole table
      // used to collapse into one run-on paragraph of pipes.
      if (isTableRow(line)) {
        var rows = [];
        var j = i;
        while (j < lines.length && isTableRow(lines[j])) {
          rows.push(lines[j]);
          j++;
        }

        if (rows.length >= 2) {
          var headers = splitRow(rows[0]);
          var bodyRows = rows.slice(1);
          if (bodyRows.length && isTableSeparator(bodyRows[0])) bodyRows = bodyRows.slice(1);

          var body = '';
          for (var r = 0; r < bodyRows.length; r++) {
            var cells = splitRow(bodyRows[r]);
            body += '<tr>';
            for (var c = 0; c < headers.length; c++) {
              body += '<td>' + renderInline(cells[c] || '') + '</td>';
            }
            body += '</tr>';
          }

          html += '<div class="chat-table-wrap"><table><thead><tr>';
          for (var h = 0; h < headers.length; h++) {
            html += '<th>' + renderInline(headers[h]) + '</th>';
          }
          html += '</tr></thead><tbody>' + body + '</tbody></table></div>';
          i = j;
          continue;
        }
        // A lone pipe line is just text — fall through to the paragraph case.
      }

      // Bullet list
      if (/^\s*[-*]\s+/.test(line)) {
        html += '<ul>';
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          html += '<li>' + renderInline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>';
          i++;
        }
        html += '</ul>';
        continue;
      }

      // Numbered list
      if (/^\s*\d+\.\s+/.test(line)) {
        html += '<ol>';
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          html += '<li>' + renderInline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>';
          i++;
        }
        html += '</ol>';
        continue;
      }

      // Paragraph — gather until a blank line or the start of another block
      if (line.trim()) {
        var para = [];
        while (
          i < lines.length &&
          lines[i].trim() &&
          !/^\s*[-*]\s+/.test(lines[i]) &&
          !/^\s*\d+\.\s+/.test(lines[i]) &&
          !(/\|/.test(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
        ) {
          para.push(lines[i]);
          i++;
        }
        html += '<p>' + renderInline(para.join(' ')) + '</p>';
        continue;
      }

      i++;
    }

    return html;
  }

  // ---- Rule book citation ---------------------------------------------------
  // The reply ends with a line naming the sections the answer came from. We
  // pull that out of the markdown and rebuild it as a proper block with real
  // links to the PDFs, rather than trusting the model to emit a working one.

  var RULE_BOOKS = {
    senior: {
      label: 'Seniors — T35 &amp; T20 rules',
      href: 'rules/MCA-Winter-2026-T35-and-T20-Rules-v1.0.pdf'
    },
    junior: {
      label: 'Juniors — U11, U13 &amp; U15 rules',
      href: 'rules/MCA-Juniors-Winter-2026-Rules-v0.4.pdf'
    }
  };

  function extractCitation(markdown) {
    var match = String(markdown).match(/^[^\S\n]*📖[^\n]*?Rule book:?\*{0,2}[^\S\n]*([^\n]*)$/m);
    if (!match) return { body: markdown, cited: '' };

    var cited = match[1]
      // Drop any trailing link the model tacked on — we supply our own.
      .replace(/\s*[—–-]\s*\[[^\]]*\]\([^)]*\)\s*$/, '')
      .replace(/\*\*/g, '')
      .trim();

    return { body: String(markdown).replace(match[0], '').trim(), cited: cited };
  }

  function appendCitation(bubble, cited) {
    if (!cited) return;

    var box = document.createElement('div');
    box.className = 'chat-cite';

    var head = document.createElement('div');
    head.className = 'chat-cite-head';
    head.textContent = '📖 Where this comes from';
    box.appendChild(head);

    // Anything the rule books don't cover says so plainly instead of linking.
    if (/not covered|general cricket|web search/i.test(cited)) {
      var note = document.createElement('p');
      note.className = 'chat-cite-note';
      note.textContent = 'Not covered by the MCA rule books — ' + cited.replace(/^not covered\s*[—–-]?\s*/i, '') + '.';
      box.appendChild(note);
      bubble.appendChild(box);
      return;
    }

    var seniors = [];
    var juniors = [];
    cited.split('·').forEach(function (raw) {
      var name = raw.trim();
      if (!name) return;
      if (/^juniors\b/i.test(name)) juniors.push(name.replace(/^juniors\s*[—–-]?\s*/i, ''));
      else seniors.push(name);
    });

    function addGroup(book, names) {
      if (!names.length) return;
      var row = document.createElement('div');
      row.className = 'chat-cite-group';

      var link = document.createElement('a');
      link.className = 'chat-cite-book';
      link.href = book.href;
      link.setAttribute('download', '');
      link.innerHTML = book.label;
      row.appendChild(link);

      var tags = document.createElement('div');
      tags.className = 'chat-cite-tags';
      names.forEach(function (n) {
        var tag = document.createElement('span');
        tag.className = 'chat-cite-tag';
        tag.textContent = n;
        tags.appendChild(tag);
      });
      row.appendChild(tags);
      box.appendChild(row);
    }

    addGroup(RULE_BOOKS.senior, seniors);
    addGroup(RULE_BOOKS.junior, juniors);

    if (seniors.length || juniors.length) bubble.appendChild(box);
  }

  // ---- Message rendering ----------------------------------------------------

  function addUserMessage(text) {
    var div = document.createElement('div');
    div.className = 'chat-msg chat-msg-user';
    div.textContent = text;
    chatMessages.appendChild(div);
    scrollChatToBottom();
  }

  function addBotMessage(markdown) {
    var div = document.createElement('div');
    div.className = 'chat-msg chat-msg-bot';
    div.innerHTML = renderMarkdown(markdown);
    chatMessages.appendChild(div);
    return div;
  }

  function scrollChatToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Answers can run long, so land the reader at the first line rather than
  // dumping them at the end of it. Anything below is reached by scrolling.
  function scrollToStartOf(el) {
    if (!el) return;
    var offset =
      el.getBoundingClientRect().top -
      chatMessages.getBoundingClientRect().top +
      chatMessages.scrollTop;
    // A little breathing room above the message.
    chatMessages.scrollTop = Math.max(0, offset - 12);
  }

  function clearChips() {
    if (chatChips) { chatChips.innerHTML = ''; return; }
    var stale = chatMessages.querySelectorAll('.chat-chips');
    for (var i = 0; i < stale.length; i++) stale[i].remove();
  }

  // Clickable follow-ups so the user rarely has to type
  function addChips(questions, label) {
    if (!questions || !questions.length) return;

    var wrap = document.createElement('div');
    wrap.className = 'chat-chips';

    if (label) {
      var caption = document.createElement('div');
      caption.className = 'chat-chips-label';
      caption.textContent = label;
      wrap.appendChild(caption);
    }

    questions.forEach(function (q) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-chip';
      chip.textContent = q;
      chip.addEventListener('click', function () {
        if (chatBusy) return;
        chatInput.value = q;
        sendUserMessage();
      });
      wrap.appendChild(chip);
    });

    // The dock sits between the conversation and the composer, so follow-ups
    // stay reachable instead of scrolling away with the messages.
    if (chatChips) {
      chatChips.innerHTML = '';
      chatChips.appendChild(wrap);
    } else {
      chatMessages.appendChild(wrap);
    }
  }

  function setBusy(state) {
    chatBusy = state;
    chatSend.disabled = state;
    chatInput.disabled = state;
  }

  // ---- Sending --------------------------------------------------------------

  function sendUserMessage() {
    var text = chatInput.value.trim();
    if (!text || chatBusy) return;

    clearChips();
    addUserMessage(text);
    chatInput.value = '';
    history.push({ role: 'user', content: text });
    setBusy(true);

    var typing = document.createElement('div');
    typing.className = 'chat-typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    chatMessages.appendChild(typing);
    scrollChatToBottom();

    function finish(markdown, suggestions) {
      if (typing.parentNode) typing.remove();
      var parsed = extractCitation(markdown);
      var bubble = addBotMessage(parsed.body);
      appendCitation(bubble, parsed.cited);
      // Keep the original text in history so the model sees its own citation.
      history.push({ role: 'assistant', content: markdown });
      addChips(suggestions, suggestions && suggestions.length ? 'Related questions' : '');
      // Land on the first line of the answer, not the last.
      scrollToStartOf(bubble);
      setBusy(false);
      // Return focus on desktop only; on touch this would re-open the keyboard
      // over the answer the user just asked for.
      if (!coarsePointer) {
        try { chatInput.focus({ preventScroll: true }); } catch (err) { chatInput.focus(); }
      }
    }

    var url = endpoint();

    if (!url) {
      // No Worker configured — answer from the offline knowledge base.
      window.setTimeout(function () {
        var local = findAnswer(text);
        finish(local.answer, local.related);
      }, 400);
      return;
    }

    fetch(url + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-12) })
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
          return data;
        });
      })
      .then(function (data) {
        finish(data.reply, data.suggestions || []);
      })
      .catch(function () {
        // Network trouble or the Worker is down — degrade to the local engine.
        var local = findAnswer(text);
        finish(local.answer, local.related);
      });
  }

  // ---- Voice input (optional, where the browser supports it) ----------------

  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (chatMic) {
    if (!SpeechRecognition) {
      chatMic.style.display = 'none';
    } else {
      var recognition = new SpeechRecognition();
      recognition.lang = 'en-AU';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      var listening = false;

      chatMic.addEventListener('click', function () {
        if (chatBusy) return;
        if (listening) {
          recognition.stop();
          return;
        }
        try {
          recognition.start();
        } catch (err) {
          /* start() throws if already running — safe to ignore */
        }
      });

      recognition.addEventListener('start', function () {
        listening = true;
        chatMic.classList.add('listening');
      });

      recognition.addEventListener('end', function () {
        listening = false;
        chatMic.classList.remove('listening');
      });

      recognition.addEventListener('error', function () {
        listening = false;
        chatMic.classList.remove('listening');
      });

      recognition.addEventListener('result', function (event) {
        var transcript = event.results[0] && event.results[0][0] && event.results[0][0].transcript;
        if (!transcript) return;
        chatInput.value = transcript;
        sendUserMessage();
      });
    }
  }

  // ---- Wiring ---------------------------------------------------------------

  var WELCOME =
    "Hi! I'm the **MCA Assistant**. Ask me anything about the association — " +
    "competitions, rules, fees, registration or juniors — and I'll answer straight away.";

  function greet() {
    if (chatOpened) return;
    chatOpened = true;
    addBotMessage(WELCOME);
    addChips(STARTER_QUESTIONS, 'Try asking');
  }

  // The standalone /chat page reuses this same engine, with the panel always
  // open instead of hidden behind a bubble.
  var isFullPage = document.body.hasAttribute('data-chat-page');

  if (isFullPage) {
    chatPanel.classList.add('open');
    greet();
    // No autofocus here: it would scroll the heading out of view on load and
    // pop the keyboard open on mobile before the reader has seen the page.
  } else if (chatToggle) {
    chatToggle.addEventListener('click', function () {
      var isOpen = chatPanel.classList.toggle('open');
      chatToggle.classList.toggle('active', isOpen);
      document.body.classList.toggle('chat-open', isOpen);
      if (isOpen) {
        greet();
        // No focus() here — it would pop the keyboard the moment the sheet
        // opens and bury the conversation behind it.
      }
    });
  }

  // Close control inside the panel header — the only way out when the panel
  // is a full-screen sheet on a phone and the launcher is hidden behind it.
  var chatClose = document.getElementById('chatbot-close');
  if (chatClose) {
    chatClose.addEventListener('click', function () {
      chatPanel.classList.remove('open');
      if (chatToggle) chatToggle.classList.remove('active');
      document.body.classList.remove('chat-open');
    });
  }

  chatSend.addEventListener('click', function () {
    sendUserMessage();
  });

  chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendUserMessage();
    }
  });

  // ---- Page-view beacon -----------------------------------------------------

  (function pageBeacon() {
    var url = endpoint();
    if (!url) return;
    try {
      fetch(url + '/hit', { method: 'POST', keepalive: true }).catch(function () {});
    } catch (err) {
      /* a failed beacon must never affect the page */
    }
  })();

  // ============================================================
  //  Offline fallback engine — keyword lookup over rules-data.js.
  //  Used when no Worker endpoint is configured, or when it can't
  //  be reached, so the widget always has something useful to say.
  // ============================================================
  // Words that carry no search signal
  var STOPWORDS = {
    'the':1,'is':1,'are':1,'was':1,'were':1,'a':1,'an':1,'and':1,'or':1,'of':1,
    'to':1,'in':1,'on':1,'for':1,'at':1,'by':1,'with':1,'from':1,'as':1,'it':1,
    'what':1,'whats':1,'when':1,'where':1,'which':1,'who':1,'how':1,'why':1,
    'do':1,'does':1,'did':1,'can':1,'could':1,'should':1,'would':1,'will':1,
    'i':1,'my':1,'me':1,'we':1,'our':1,'you':1,'your':1,'there':1,'this':1,
    'that':1,'if':1,'be':1,'been':1,'have':1,'has':1,'had':1,'get':1,'any':1,
    'about':1,'much':1,'many':1,'please':1,'tell':1,'know':1
  };

  // Query terms that should be expanded to catch phrasing variations
  var SYNONYMS = {
    'cost':['fee','fees','price'],
    'costs':['fee','fees','price'],
    'price':['fee','fees','cost'],
    'prices':['fee','fees','cost'],
    'pay':['fee','fees','payment'],
    'kids':['junior','juniors'],
    'kid':['junior','juniors'],
    'child':['junior','juniors'],
    'children':['junior','juniors'],
    'youth':['junior','juniors'],
    'begin':['start','commence'],
    'begins':['start','commence'],
    'starts':['start'],
    'signup':['register','registration'],
    'join':['register','registration'],
    'ump':['umpire','umpires'],
    'umpires':['umpire'],
    'bowl':['bowler','bowling'],
    'bat':['batter','batsman','batting'],
    'rain':['weather','washout','wet'],
    'watch':['stream','streaming','live'],
    'ground':['grounds','venue'],
    'over':['overs'],
    'wicket':['wickets']
  };

  // Crude singular/base form so "rains" matches "rain", "bowling" matches "bowl"
  function stem(word) {
    if (word.length > 4 && word.slice(-3) === 'ies') return word.slice(0, -3) + 'y';
    if (word.length > 4 && word.slice(-3) === 'ing') return word.slice(0, -3);
    if (word.length > 3 && word.slice(-2) === 'es') return word.slice(0, -2);
    if (word.length > 3 && word.slice(-1) === 's' && word.slice(-2) !== 'ss') return word.slice(0, -1);
    return word;
  }

  function tokenize(text) {
    var raw = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    var out = [];

    function push(w) {
      if (w && w.length >= 2 && out.indexOf(w) === -1) out.push(w);
    }

    for (var i = 0; i < raw.length; i++) {
      var w = raw[i];
      if (!w || STOPWORDS[w] || w.length < 2) continue;
      push(w);

      var base = stem(w);
      if (base !== w && !STOPWORDS[base]) push(base);

      // Expand synonyms so "cost" also matches "fee" — check both forms
      var forms = base !== w ? [w, base] : [w];
      for (var f = 0; f < forms.length; f++) {
        var syn = SYNONYMS[forms[f]];
        if (!syn) continue;
        for (var s = 0; s < syn.length; s++) push(syn[s]);
      }
    }
    return out;
  }

  // Whole-word containment, so "rain" does not match inside "training"
  function hasWord(haystack, word) {
    if (!haystack || !word) return false;
    var idx = haystack.indexOf(word);
    while (idx !== -1) {
      var before = idx === 0 ? '' : haystack.charAt(idx - 1);
      var after = haystack.charAt(idx + word.length);
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
      idx = haystack.indexOf(word, idx + 1);
    }
    return false;
  }

  // Rank every rule against the query and return the best scoring matches
  function rankRules(query) {
    var rules = window.MCA_RULES;
    if (!rules || !Array.isArray(rules) || rules.length === 0) return [];

    var queryLower = query.toLowerCase().trim();
    var tokens = tokenize(query);
    if (tokens.length === 0) return [];

    var scored = [];

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var question = (rule.q || '').toLowerCase();
      var answer = (rule.a || '').toLowerCase();
      var category = (rule.category || '').toLowerCase();
      var keywords = Array.isArray(rule.keywords)
        ? rule.keywords.map(function (k) { return String(k).toLowerCase(); })
        : [];
      var keywordText = keywords.join(' ');

      var score = 0;

      for (var j = 0; j < tokens.length; j++) {
        var t = tokens[j];
        // Strongest signal: token is a curated keyword for this rule
        if (keywords.indexOf(t) !== -1) score += 5;
        else if (hasWord(keywordText, t)) score += 2.5;

        if (hasWord(question, t)) score += 2;
        if (hasWord(category, t)) score += 1.5;
        if (hasWord(answer, t)) score += 0.5;
      }

      // Big bonus when the user typed (almost) the stored question
      if (question && question.indexOf(queryLower) !== -1) score += 8;
      // Reward rules that matched a high proportion of the query
      var hits = 0;
      for (var k = 0; k < tokens.length; k++) {
        var tk = tokens[k];
        if (hasWord(keywordText, tk) || hasWord(question, tk)) hits++;
      }
      if (hits === tokens.length && tokens.length > 1) score += 4;

      if (score > 0) scored.push({ rule: rule, score: score });
    }

    scored.sort(function (a, b) { return b.score - a.score; });
    return scored;
  }

  // Knowledge-base category -> the section it comes from in the MCA rule book,
  // so offline answers can cite a source the same way the AI assistant does.
  var SECTION_MAP = {
    'format': 'Format',
    'powerplay': 'Powerplay',
    'fielding': 'Fielding Restrictions',
    'competition': 'Competition Details',
    'game-times': 'Game Times',
    'umpires': 'Umpires',
    'ground-setup': 'Ground Setup',
    'team-sheets': 'Team Sheets',
    'delays-rain': 'Delayed Starts / Rain Interruptions',
    'bad-light': 'Bad Light',
    'reduced-overs': 'Reduced overs for delayed starts and finishes',
    'revised-target': 'Revised Target',
    'free-hit': 'Free hit',
    'square-leg': 'Square Leg Umpires (Players)',
    'wides': 'Leg Side Wides',
    'cards-discipline': 'Yellow/Red Card Offence',
    'attire': 'Team Attire',
    'reports': 'Umpire/Captains Reports',
    'fees': 'Fees / Umpire Fee',
    'balls': 'Balls',
    'no-balls': 'No-balls',
    'over-rate': 'Slow over rate',
    'late-players': 'Players arriving late',
    'abuse': 'Abuse',
    'fielders-call': "Fielder's call",
    'bowling-action': 'Bowling action objections',
    'awards': 'Awards',
    'streaming': 'FrogBox/YouTube Live Streaming',
    'scoring': 'Online Scoring',
    'lost-ball': 'Lost ball',
    'forfeits': 'Game forfeits',
    'covid': 'COVID Rules',
    'playhq': 'PlayHQ Links',
    'registration': 'Player Registration and Fill-ins',
    'reserve-days': 'Reserve Days',
    'general': 'Other Rules',
    'juniors-u11': 'Juniors — Rules at a Glance (U11)',
    'juniors-u13': 'Juniors — Rules at a Glance (U13)',
    'juniors-u15': 'Juniors — Rules at a Glance (U15)',
    'juniors-general': 'Juniors — Match-Day Operations',
    'juniors-batting': 'Juniors — Batter Retirement / Wickets & Dismissals',
    'juniors-bowling': 'Juniors — Bowling',
    'juniors-safety': 'Juniors — Child Safety & Compliance',
    'juniors-streaming': 'Juniors — Live Scoring & Live Streaming'
  };

  function sectionFor(rule) {
    return (rule && SECTION_MAP[rule.category]) || '';
  }

  function findAnswer(query) {
    var ranked = rankRules(query);

    if (ranked.length === 0 || ranked[0].score < 3) {
      return { answer: getFallbackAnswer(query), related: [] };
    }

    var best = ranked[0].rule;
    var topScore = ranked[0].score;

    // Pull in closely-matching rules as supporting detail so the offline
    // answer covers the edge cases too, not just the headline fact.
    var supporting = [];
    var sections = [];
    var seenAnswers = [best.a];
    if (sectionFor(best)) sections.push(sectionFor(best));

    for (var i = 1; i < ranked.length && supporting.length < 3; i++) {
      if (ranked[i].score < Math.max(3, topScore * 0.55)) break;
      var rule = ranked[i].rule;
      if (!rule.a || seenAnswers.indexOf(rule.a) !== -1) continue;
      seenAnswers.push(rule.a);
      supporting.push(rule.a);
      var sec = sectionFor(rule);
      if (sec && sections.indexOf(sec) === -1) sections.push(sec);
    }

    var answer = best.a;
    if (supporting.length) {
      answer += '\n\n' + supporting.map(function (s) { return '- ' + s; }).join('\n');
    }
    if (sections.length) {
      // No download link here — appendCitation() builds it from these names.
      answer += '\n\n📖 **Rule book:** ' + sections.slice(0, 3).join(' · ');
    }

    // Follow-up questions come from further down the ranking.
    var related = [];
    for (var j = 1; j < ranked.length && related.length < 3; j++) {
      var r = ranked[j].rule;
      if (ranked[j].score < 3) break;
      if (r.q && r.q !== best.q && related.indexOf(r.q) === -1) related.push(r.q);
    }

    return { answer: answer, related: related };
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
      return 'To register, scan the QR code on our website or contact Gopi Kakivai (President) at 0430 667 896 or Mahendra Annem (Secretary) at 0433 960 586.';
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
      return 'Contact: Gopi Kakivai (President) 0430 667 896, Mahendra Annem (Secretary) 0433 960 586, Sandeep Shamala (Treasurer) 0433 249 914, Srikanth Dendi (Umpires Coordinator) 0430 408 093, Deepak Kulkarni (Juniors Coordinator) 0404 073 222. Also follow us on Facebook.';
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

    return "I couldn't find a specific answer for that. Try asking about competitions, fees, registration, rules, umpires, juniors, or contact details. You can also call Gopi Kakivai at 0430 667 896 for help.";
  }

})();
