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

  // --- Menu ---
  var hamburger = document.getElementById('hamburger');

  function setNavOpen(open) {
    if (!header) return;
    header.classList.toggle('nav-open', open);
    if (hamburger) {
      hamburger.setAttribute('aria-expanded', open ? 'true' : 'false');
      hamburger.setAttribute('aria-label', open ? 'Close the menu' : 'Open the menu');
    }
  }

  if (hamburger && header) {
    hamburger.addEventListener('click', function () {
      setNavOpen(!header.classList.contains('nav-open'));
    });
  }

  // Tapping any link in the full menu closes it
  document.querySelectorAll('.nav-link').forEach(function (link) {
    link.addEventListener('click', function () { setNavOpen(false); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setNavOpen(false);
  });

  // On the assistant page the header's Ask MCA pill is a "you are here" marker.
  // Put the cursor in the box rather than leaving a stray #hash in the address.
  var askHere = document.querySelector('.ask-mca-here');
  if (askHere) {
    askHere.addEventListener('click', function (e) {
      e.preventDefault();
      var box = document.getElementById('chatbot-input');
      if (box) box.focus();
    });
  }


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

  // ---- Saved conversation ---------------------------------------------------
  // The chat survives a refresh, a tab close and coming back later on the same
  // device. It is kept in this browser only — nothing is sent anywhere and no
  // other visitor can see it. Cleared with the bin button in the panel header.
  var STORE_KEY = 'mca-chat-v1';
  var STORE_MAX_MESSAGES = 40;
  var STORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // a month
  var lastChips = null;

  function saveConversation() {
    try {
      if (!history.length) { localStorage.removeItem(STORE_KEY); return; }
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1,
        at: Date.now(),
        history: history.slice(-STORE_MAX_MESSAGES),
        chips: lastChips
      }));
    } catch (err) {
      /* private mode, or the quota is full — the chat still works, it just
         will not be there next time. Never let this break a reply. */
    }
  }

  function loadConversation() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (err) { return null; }
    if (!raw) return null;

    var saved;
    try { saved = JSON.parse(raw); } catch (err) { return null; }
    if (!saved || saved.v !== 1 || !Array.isArray(saved.history) || !saved.history.length) return null;
    if (typeof saved.at === 'number' && Date.now() - saved.at > STORE_MAX_AGE_MS) {
      try { localStorage.removeItem(STORE_KEY); } catch (err) {}
      return null;
    }

    // Only the shapes we wrote survive the trip back
    var clean = [];
    for (var i = 0; i < saved.history.length; i++) {
      var m = saved.history[i];
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      if (typeof m.content !== 'string' || !m.content) continue;
      clean.push({ role: m.role, content: m.content });
    }
    if (!clean.length) return null;
    saved.history = clean;
    return saved;
  }

  function forgetConversation() {
    history = [];
    lastChips = null;
    try { localStorage.removeItem(STORE_KEY); } catch (err) {}
  }

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

  // Both books, with no particular section called out. Shown whenever the
  // answer names no section — the rule book should always be one tap away,
  // most of all when the assistant could not answer from it.
  function addBookLinks(box) {
    var row = document.createElement('div');
    row.className = 'chat-cite-group chat-cite-books';
    [RULE_BOOKS.senior, RULE_BOOKS.junior].forEach(function (book) {
      var link = document.createElement('a');
      link.className = 'chat-cite-book';
      link.href = book.href;
      link.setAttribute('download', '');
      link.innerHTML = book.label;
      row.appendChild(link);
    });
    box.appendChild(row);
  }

  function appendCitation(bubble, cited) {
    var box = document.createElement('div');
    box.className = 'chat-cite';

    var head = document.createElement('div');
    head.className = 'chat-cite-head';
    head.textContent = '📖 Where this comes from';
    box.appendChild(head);

    // No section named — still hand over the rule books so the reader can check
    if (!cited) {
      head.textContent = '📖 Read the rule books';
      var plain = document.createElement('p');
      plain.className = 'chat-cite-note';
      plain.textContent = 'This answer did not name a rule book section. Both books are here:';
      box.appendChild(plain);
      addBookLinks(box);
      bubble.appendChild(box);
      return;
    }

    // Anything the rule books don't cover says so plainly — and still links.
    if (/not covered|general cricket|web search/i.test(cited)) {
      var note = document.createElement('p');
      note.className = 'chat-cite-note';
      note.textContent = 'Not covered by the MCA rule books — ' + cited.replace(/^not covered\s*[—–-]?\s*/i, '') + '.';
      box.appendChild(note);
      addBookLinks(box);
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
    lastChips = null;
    if (chatChips) { chatChips.innerHTML = ''; return; }
    var stale = chatMessages.querySelectorAll('.chat-chips');
    for (var i = 0; i < stale.length; i++) stale[i].remove();
  }

  // Clickable follow-ups so the user rarely has to type
  function addChips(questions, label) {
    if (!questions || !questions.length) return;
    lastChips = { questions: questions.slice(0), label: label || '' };

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
    saveConversation();
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
      saveConversation();
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
      // Show the words in the box as they are heard, rather than leaving the
      // field empty until the whole sentence has been worked out.
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;

      var listening = false;
      var finalText = '';
      var placeholderWas = chatInput.getAttribute('placeholder') || '';

      function stopListening(discard) {
        if (!listening) return;
        listening = false;
        try {
          // abort() drops the microphone straight away; stop() keeps it open
          // until the engine has finished deciding what it heard, which is why
          // the recording indicator used to stay on after leaving the tab.
          if (discard) recognition.abort();
          else recognition.stop();
        } catch (err) { /* already stopped */ }
      }

      chatMic.addEventListener('click', function () {
        if (chatBusy) return;
        if (listening) { stopListening(false); return; }
        finalText = '';
        try {
          recognition.start();
        } catch (err) {
          /* start() throws if it is already running — safe to ignore */
        }
      });

      recognition.addEventListener('start', function () {
        listening = true;
        chatMic.classList.add('listening');
        chatInput.setAttribute('placeholder', 'Listening…');
      });

      function finished() {
        listening = false;
        chatMic.classList.remove('listening');
        chatInput.setAttribute('placeholder', placeholderWas);
      }
      recognition.addEventListener('end', finished);
      recognition.addEventListener('error', finished);

      recognition.addEventListener('result', function (event) {
        var interim = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var result = event.results[i];
          var text = result[0] && result[0].transcript ? result[0].transcript : '';
          if (result.isFinal) finalText += text;
          else interim += text;
        }

        // Live feedback: the box always shows what has been heard so far
        chatInput.value = (finalText + interim).replace(/^\s+/, '');

        if (finalText.trim()) {
          stopListening(false);
          sendUserMessage();
          finalText = '';
        }
      });

      // Release the microphone the moment the page is no longer in front of
      // the user. Without this, iOS keeps the recording dot on the tab after
      // switching apps or closing Safari.
      function releaseMic() { stopListening(true); finished(); }

      document.addEventListener('visibilitychange', function () {
        if (document.hidden) releaseMic();
      });
      window.addEventListener('pagehide', releaseMic);
      window.addEventListener('beforeunload', releaseMic);

      // Closing the chat should stop it listening too
      var micPanel = document.getElementById('chatbot-panel');
      if (micPanel) {
        micPanel.addEventListener('mca-chat-closed', releaseMic);
      }
    }
  }

  // ---- Wiring ---------------------------------------------------------------

  var WELCOME =
    "Hi! I'm the **MCA Assistant**. Ask me anything about the association — " +
    "competitions, rules, fees, registration or juniors — and I'll answer straight away.";

  var RESUMED_NOTE = 'Picking up where we left off.';

  // Rebuild an earlier conversation into the panel, so a refresh does not
  // throw away what was already asked and answered.
  function restoreConversation(saved) {
    for (var i = 0; i < saved.history.length; i++) {
      var m = saved.history[i];
      if (m.role === 'user') {
        addUserMessage(m.content);
      } else {
        var parsed = extractCitation(m.content);
        appendCitation(addBotMessage(parsed.body), parsed.cited);
      }
    }
    history = saved.history.slice(0);

    var note = document.createElement('div');
    note.className = 'chat-resumed';
    note.textContent = RESUMED_NOTE;
    chatMessages.appendChild(note);

    if (saved.chips && saved.chips.questions && saved.chips.questions.length) {
      addChips(saved.chips.questions, saved.chips.label);
    }
    scrollChatToBottom();
  }

  function greet() {
    if (chatOpened) return;
    chatOpened = true;

    var saved = loadConversation();
    if (saved) { restoreConversation(saved); return; }

    addBotMessage(WELCOME);
    addChips(STARTER_QUESTIONS, 'Try asking');
  }

  // Throw the saved conversation away and start clean
  var chatClear = document.getElementById('chatbot-clear');
  if (chatClear) {
    chatClear.addEventListener('click', function () {
      forgetConversation();
      chatMessages.innerHTML = '';
      clearChips();
      addBotMessage(WELCOME);
      addChips(STARTER_QUESTIONS, 'Try asking');
      scrollChatToBottom();
    });
  }

  // The standalone /chat page reuses this same engine, with the panel always
  // open instead of hidden behind a bubble.
  var isFullPage = document.body.hasAttribute('data-chat-page');

  if (isFullPage) {
    chatPanel.classList.add('open');
    greet();
    // No autofocus here: it would scroll the heading out of view on load and
    // pop the keyboard open on mobile before the reader has seen the page.
  } else {
    // Anything marked data-chat-open opens the panel: the bottom-right
    // launcher and the "Ask MCA" button on the header both use it.
    var openers = document.querySelectorAll('[data-chat-open], #chatbot-toggle');
    openers.forEach(function (el) {
      el.addEventListener('click', function () {
        var wantOpen = el === chatToggle
          ? !chatPanel.classList.contains('open')
          : true;
        if (!wantOpen) { chatPanel.classList.remove('open'); setLauncherState(false); return; }

        setNavOpen(false);
        chatPanel.classList.add('open');
        setLauncherState(true);
        greet();
        // No focus() here — it would pop the keyboard the moment the sheet
        // opens and bury the conversation behind it.
      });
    });
  }

  // The launcher keeps its label at all times; only the wording changes so an
  // open panel has an obvious way out on desktop, where it stays visible.
  function setLauncherState(isOpen) {
    document.body.classList.toggle('chat-open', isOpen);
    if (!isOpen && chatPanel) {
      chatPanel.dispatchEvent(new Event('mca-chat-closed'));
    }
    if (!chatToggle) return;
    chatToggle.classList.toggle('active', isOpen);
    chatToggle.setAttribute('aria-label', isOpen ? 'Close the MCA Assistant' : 'Open the MCA Assistant');
    var label = chatToggle.querySelector('.chat-launch-label');
    if (label) label.textContent = isOpen ? 'Close chat' : 'Chat with us';
  }

  // Close control inside the panel header — the only way out when the panel
  // is a full-screen sheet on a phone and the launcher is hidden behind it.
  var chatClose = document.getElementById('chatbot-close');
  if (chatClose) {
    chatClose.addEventListener('click', function () {
      chatPanel.classList.remove('open');
      setLauncherState(false);
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

  // ============================================================
  //  Hero photographs — one fades into the next every ten seconds
  // ============================================================

  (function heroRotation() {
    var layers = document.querySelectorAll('.hero-photo');
    if (layers.length < 2) return;

    var PHOTOS = [
      'photos/hero.jpg',
      'photos/tarneit-a-grade-champions.jpg',
      'photos/umpire-presentation.jpg',
      'photos/laverton-champions.jpg'
    ];
    var INTERVAL = 10000;

    // Someone who has asked their device to reduce motion gets the first
    // photograph and nothing else moving.
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Nor do we pull three more photographs down a metered connection.
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    var saveData = !!(conn && conn.saveData);
    if (reduce || saveData || PHOTOS.length < 2) return;

    var index = 0;
    var front = 0;          // which layer is currently showing
    var timer = null;

    function preload(src) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(src); };
        img.onerror = reject;
        img.src = src;
      });
    }

    function step() {
      var next = (index + 1) % PHOTOS.length;
      // Only swap once the next photograph is decoded, so the fade never
      // lands on a blank layer.
      preload(PHOTOS[next]).then(function (src) {
        var back = 1 - front;
        layers[back].style.backgroundImage = "url('" + src + "')";
        layers[back].classList.add('is-active');
        layers[front].classList.remove('is-active');
        front = back;
        index = next;
      }).catch(function () {
        // A missing file just means this one is skipped next time round
        index = next;
      });
    }

    function start() {
      if (timer) return;
      timer = window.setInterval(step, INTERVAL);
    }
    function stop() {
      if (!timer) return;
      window.clearInterval(timer);
      timer = null;
    }

    // Nothing rotates while the tab is in the background
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });

    // Wait for the page to settle before fetching the second photograph
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
  })();

  // ============================================================
  //  Photo viewer — full size, with a swipe or a tap to close
  // ============================================================

  (function lightbox() {
    var box = document.getElementById('lightbox');
    if (!box) return;

    var imgEl = document.getElementById('lightbox-img');
    var capEl = document.getElementById('lightbox-caption');
    var origEl = document.getElementById('lightbox-original');
    var figure = box.querySelector('.lightbox-figure');
    var items = [].slice.call(document.querySelectorAll('.gallery-item'));
    if (!items.length) return;

    var photos = items.map(function (item) {
      var img = item.querySelector('img');
      var label = item.querySelector('.gallery-overlay span');
      return {
        src: img ? img.getAttribute('src') : '',
        alt: img ? (img.getAttribute('alt') || '') : '',
        caption: label ? label.textContent.trim() : ''
      };
    }).filter(function (p) { return p.src; });

    var current = 0;
    var lastFocus = null;

    // Only tell people to swipe if they have something to swipe with
    var hint = document.getElementById('lightbox-hint');
    if (hint && coarsePointer) hint.textContent = 'Swipe down to close, sideways to browse';

    function show(i) {
      current = (i + photos.length) % photos.length;
      var p = photos[current];
      imgEl.src = p.src;
      imgEl.alt = p.alt;
      capEl.textContent = p.caption;
      // The file itself, so it can be pinched, zoomed or saved
      if (origEl) origEl.href = p.src;
      figure.style.transform = '';
      figure.style.opacity = '';
    }

    function open(i, trigger) {
      lastFocus = trigger || null;
      show(i);
      box.hidden = false;
      document.body.classList.add('lightbox-open');
      // A frame between unhiding and the class, so the fade actually runs
      window.requestAnimationFrame(function () { box.classList.add('is-open'); });
      var closeBtn = box.querySelector('.lightbox-close');
      if (closeBtn) closeBtn.focus();
    }

    function close() {
      box.classList.remove('is-open');
      document.body.classList.remove('lightbox-open');
      window.setTimeout(function () {
        box.hidden = true;
        imgEl.src = '';
        figure.style.transform = '';
        figure.style.opacity = '';
      }, 250);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    // Every photo in the gallery opens it, by click or by keyboard
    items.forEach(function (item, i) {
      item.setAttribute('tabindex', '0');
      item.setAttribute('role', 'button');
      var label = item.querySelector('.gallery-overlay span');
      item.setAttribute('aria-label', 'Open photo' + (label ? ': ' + label.textContent.trim() : ''));
      item.addEventListener('click', function () { open(i, item); });
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(i, item); }
      });
    });

    [].slice.call(box.querySelectorAll('[data-lightbox-close]')).forEach(function (el) {
      el.addEventListener('click', close);
    });
    var prev = box.querySelector('.lightbox-prev');
    var next = box.querySelector('.lightbox-next');
    if (prev) prev.addEventListener('click', function () { show(current - 1); });
    if (next) next.addEventListener('click', function () { show(current + 1); });

    document.addEventListener('keydown', function (e) {
      if (box.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft') show(current - 1);
      else if (e.key === 'ArrowRight') show(current + 1);
    });

    // ---- Touch: swipe down to dismiss, left and right to move along -------
    var startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;

    box.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      dragging = true;
      dx = dy = 0;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      figure.style.transition = 'none';
    }, { passive: true });

    box.addEventListener('touchmove', function (e) {
      if (!dragging || e.touches.length !== 1) return;
      dx = e.touches[0].clientX - startX;
      dy = e.touches[0].clientY - startY;
      if (dy > 0 && Math.abs(dy) > Math.abs(dx)) {
        // Follow the finger down, fading as it goes
        figure.style.transform = 'translateY(' + dy + 'px)';
        figure.style.opacity = String(Math.max(0.2, 1 - dy / 400));
      }
    }, { passive: true });

    box.addEventListener('touchend', function () {
      if (!dragging) return;
      dragging = false;
      figure.style.transition = 'transform 0.25s ease, opacity 0.25s ease';

      if (dy > 110 && Math.abs(dy) > Math.abs(dx)) {
        figure.style.transform = 'translateY(100vh)';
        figure.style.opacity = '0';
        close();
      } else if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
        show(dx < 0 ? current + 1 : current - 1);
      } else {
        figure.style.transform = '';
        figure.style.opacity = '';
      }
    });
  })();

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
    'wicket':['wickets'],
    'closure':['end','ends','innings','close','declare'],
    'close':['end','ends','innings'],
    'closed':['end','ends','innings'],
    'declare':['end','innings'],
    'declaration':['end','innings'],
    'inning':['innings'],
    'finish':['end','ends'],
    'grade':['division','age group'],
    'retire':['retirement','retired'],
    'retired':['retirement','retire']
  };

  // Grades people ask about by name. A question that names one must not be
  // answered from another grade's rules — see the grade lock in rankRules().
  var GRADES = ['u11', 'u13', 'u15', 't20', 't35'];

  // "under 15", "under-15s", "u/15" and "under 15's" all mean u15
  function normaliseGrades(text) {
    return String(text)
      .toLowerCase()
      .replace(/\bunder[\s\-/]*(\d{1,2})\b/g, 'u$1')
      .replace(/\bu[\s\-/](\d{1,2})\b/g, 'u$1')
      .replace(/\b(u1[135]|t20|t35)['\u2019]?s\b/g, '$1');
  }

  function gradesIn(text) {
    var found = [];
    for (var i = 0; i < GRADES.length; i++) {
      if (hasWord(text, GRADES[i])) found.push(GRADES[i]);
    }
    return found;
  }

  // Crude singular/base form so "rains" matches "rain", "bowling" matches "bowl"
  function stem(word) {
    if (word.length > 4 && word.slice(-3) === 'ies') return word.slice(0, -3) + 'y';
    if (word.length > 4 && word.slice(-3) === 'ing') return word.slice(0, -3);
    if (word.length > 3 && word.slice(-2) === 'es') return word.slice(0, -2);
    if (word.length > 3 && word.slice(-1) === 's' && word.slice(-2) !== 'ss') return word.slice(0, -1);
    return word;
  }

  function tokenize(text) {
    var raw = normaliseGrades(text).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
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

    var queryLower = normaliseGrades(query).trim();
    var tokens = tokenize(query);
    if (tokens.length === 0) return [];

    // If the question names a grade, only rules about that grade may answer it.
    // Without this, "U15 closure of innings" was being answered from the
    // senior game-times rules, which is what made the juniors book look absent.
    var wanted = gradesIn(queryLower);

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

      if (wanted.length) {
        var ruleGrades = gradesIn(category + ' ' + keywordText + ' ' + question + ' ' + answer);
        if (ruleGrades.length) {
          var shares = false;
          for (var g = 0; g < wanted.length; g++) {
            if (ruleGrades.indexOf(wanted[g]) !== -1) { shares = true; break; }
          }
          // A rule that is explicitly about a different grade cannot apply
          if (!shares) continue;
        }
      }

      var score = 0;
      // Rules that name the grade asked about beat generic ones
      if (wanted.length && gradesIn(keywordText + ' ' + question).length) score += 6;

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

  // A small icon in front of an offline answer, chosen by what the rule covers.
  // The AI answers already come back with emoji; this keeps the two consistent
  // when the Worker is unreachable and the offline lookup is doing the talking.
  var CATEGORY_EMOJI = {
    'format': '🏏', 'powerplay': '🎯', 'fielding': '🧤', 'competition': '🏆',
    'game-times': '⏰', 'umpires': '🧑‍⚖️', 'ground-setup': '🏟️', 'team-sheets': '📝',
    'delays-rain': '🌧️', 'bad-light': '🌥️', 'reduced-overs': '⏱️',
    'revised-target': '🧮', 'free-hit': '💥', 'square-leg': '🚩', 'wides': '↔️',
    'cards-discipline': '🟨', 'attire': '👕', 'reports': '📝', 'fees': '💵',
    'balls': '🔴', 'no-balls': '🚫', 'over-rate': '⏱️', 'late-players': '🕐',
    'abuse': '⚠️', 'awards': '🥇', 'streaming': '📺', 'scoring': '📱',
    'forfeits': '❌', 'registration': '✍️', 'reserve-days': '🗓️',
    'juniors-general': '🧒', 'juniors-u11': '🧒', 'juniors-u13': '🧒',
    'juniors-u15': '🧒', 'juniors-safety': '🛡️', 'juniors-batting': '🏏',
    'juniors-bowling': '🎳', 'general': 'ℹ️'
  };

  function emojiFor(rule) {
    if (!rule || !rule.category) return 'ℹ️';
    return CATEGORY_EMOJI[rule.category] || 'ℹ️';
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

    var answer = emojiFor(best) + ' ' + best.a;
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
