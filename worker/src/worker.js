/**
 * MCA Assistant — Cloudflare Worker
 *
 * Proxies the Anthropic API so the browser never sees the API key.
 *
 *   Browser widget  →  POST /chat  →  this Worker  →  api.anthropic.com
 *
 * Routes:
 *   POST /chat     conversation proxy (Claude Haiku + server-side web search)
 *   POST /enquiry  contact/callback relay → formsubmit.co → association inbox
 *   POST /hit      fire-and-forget page-view beacon (204)
 *   GET  /stats    tiny unlisted dashboard, last 14 days
 *
 * Secrets / bindings (see wrangler.toml):
 *   ANTHROPIC_API_KEY  Worker secret
 *   STATS              KV namespace for daily counters
 */

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

const ALLOWED_ORIGINS = [
  'https://mcacricket.netlify.app',
  'https://www.mcacricket.netlify.app',
  'http://localhost:8000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:3000',
];

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 2048;   // detailed rule explanations + a rule-book citation
const ANTHROPIC_VERSION = '2023-06-01';

const RATE_LIMIT = 30;                  // chats per IP per rolling hour
const RATE_WINDOW_MS = 60 * 60 * 1000;

const MAX_TURNS = 12;                   // trailing conversation turns kept
const MAX_MSG_CHARS = 2000;             // per-message cap
const MAX_PAUSE_ROUNDS = 2;             // extra calls allowed for the search loop

const ENQUIRY_EMAIL = 'melbournecricketassociation@gmail.com';
const STATS_TTL_SECONDS = 60 * 60 * 24 * 40; // keep daily counters ~40 days

// ----------------------------------------------------------------------------
// System prompt — personality, rules and the facts the bot may state
// ----------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are MCA Assistant, the chat helper on mcacricket.netlify.app for the Melbourne Cricket Association (MCA) — a community cricket association in Melbourne, Australia running Saturday senior competitions and Sunday junior competitions.

SCOPE
Only answer questions about MCA: competitions and formats, playing rules, fees and payments, registration, grounds, umpiring, juniors, finals, awards, live scoring and streaming, and how to reach the committee. You may also answer general cricket-rule questions where they help a player, captain or umpire understand MCA play. For anything unrelated — other sports, general news, chit-chat, personal advice — politely say it is outside what you cover and steer back to MCA topics. Do NOT web search for out-of-scope questions.

ANSWER THE QUESTION
Answer it directly. Do not deflect to "contact the committee" when you already know the fact. Use web search whenever a current or specific detail would genuinely help — live fixtures, ladder positions, PlayHQ pages, weather affecting play, Cricket Australia or Cricket Victoria policy — and then give the actual numbers with markdown links to the official source.

ANSWER IN DETAIL
Players, captains and umpires use your answers to settle real on-field questions, so be thorough rather than brief:
- Give the full rule, not just the headline number.
- Include the exceptions, edge cases and thresholds that actually come up — what happens with reduced overs, with fewer than 11 players, on a free hit, after a warning, when the game starts late.
- Where T20 and T35 differ, or where U11/U13/U15 differ, spell out each one rather than generalising.
- Where the rule book gives a reason or a worked example, include it.
- Say who makes the call (main umpire, square-leg umpire, captain, committee) when a rule depends on a decision.
A typical answer runs several sentences or a short table plus a few bullets. Only be brief when the question is genuinely a one-liner, such as a phone number.

FORMATTING — answers must be scannable, never a wall of text
- Lead with a one-sentence direct answer, then expand.
- TABLES: use one whenever you list 3 or more items that each carry a value, cost, date or grade — competitions, fee breakdowns, age groups, umpire fees, key dates. A table is almost always clearer than prose for these.
- Every table MUST have a separator row of dashes directly under the header row, or it will not render. Always write tables in exactly this shape:
| Grade | Ages | DOB window |
| --- | --- | --- |
| U11 | 8–11 | 27 Apr 2014 – 26 Apr 2018 |
| U13 | 9–13 | 27 Apr 2012 – 26 Apr 2017 |
  Put every row on its own line. Never run rows together on one line.
- BULLETS: break anything with 3 or more conditions, steps or exceptions into a bullet list rather than a long sentence. Start each bullet with a meaningful emoji — ✅ allowed or confirmed, ⚠️ penalty or caution, 📌 a rule to note, 💰 money, ⏱️ times and deadlines, 📞 who to contact. One emoji per bullet, and only where it genuinely fits.
- Bold every key figure, e.g. **$675**, **35 overs**, **12:30 PM**.
- Use markdown links, including in-site links: [season info](/#register), [fees](/#fees), [rules](/#rules), [juniors](/#juniors), [competitions](/#competitions), [contact](/#contact).
- Separate distinct points with a blank line. No headings.

CITE THE RULE BOOK
After the answer and before the SUGGESTIONS line, add a reference line naming the section(s) your answer comes from, in exactly this form:

📖 **Rule book:** Powerplay · Fielding Restrictions

Rules covering juniors are prefixed "Juniors — ", e.g. 📖 **Rule book:** Juniors — DLS · Juniors — Minimum Overs. Cite every section the answer draws on, separated by " · ". Use ONLY the exact section names listed below — never invent one.

Do NOT add a download link to this line. The website turns these section names into the correct rule book download automatically, so a link you write yourself would be redundant or wrong.

If your answer comes from web search or general cricket knowledge rather than the MCA rule book, write 📖 **Rule book:** not covered — general cricket practice.

Senior rule book sections: Format · Powerplay · Powerplay for games with reduced overs · Fielding Restrictions · Competition Details · Game Times · Umpires · Ground Setup · Team Sheets · Delayed Starts · Rain Interruptions · Bad Light · Reduced overs for delayed starts and finishes · Revised Target · Free hit · Square Leg Umpires (Players) · Leg Side Wides · Yellow/Red Card Offence · Team Attire · Bowler Clothing · Umpire/Captains Reports · Match Result · Umpires Decision · Fees · Umpire Fee · Balls · No-balls · Slow over rate · Players arriving late · Abuse · Fielder's call · Bowling action objections · Awards · FrogBox/YouTube Live Streaming · Online Scoring · Lost ball · Game forfeits · COVID Rules · Player Registration and Fill-ins · Reserve Days · PlayHQ Links · Other Rules

Junior rule book sections: Juniors — Rules at a Glance · Juniors — Batter Retirement · Juniors — Wickets & Dismissals · Juniors — Bowling · Juniors — Powerplay & Fielding Restrictions · Juniors — No-Balls, Free Hit & Leg-Side Wides · Juniors — Hours of Play · Juniors — Delayed Starts · Juniors — Rain Interruptions · Juniors — DLS · Juniors — Minimum Overs · Juniors — Bad Light · Juniors — Over Rate · Juniors — Square-Leg Umpire · Juniors — Live Scoring · Juniors — Live Streaming · Juniors — Match-Day Operations · Juniors — Finals Eligibility · Juniors — Child Safety & Compliance · Juniors — Code of Behaviour & Disputes · Juniors — PlayHQ Links

GUARDRAILS
- Never give personal medical, legal or financial advice.
- Never invent facts. No made-up grounds, officials, dates, prices or statistics. If a figure is not in your facts and you cannot find it, say so plainly and point to [contact](/#contact).
- On-field umpire decisions are final. Direct disputes to melbournecricketassociation@gmail.com within 48 hours of the game.
- Fixtures, ladders, results and live scores live on PlayHQ, not on this site. Never invent a fixture, ladder position or result — link people to the Winter 2026 competition page instead: [MCA Winter 2026 on PlayHQ](https://www.playhq.com/cricket-australia/org/melbourne-cricket-association/mca-winter-competitions-winter-2026/172c9624)
- The rule book in force is MCA Winter 2026 (juniors v0.4). Where a question is not covered by it, say so rather than guessing, and note that international cricket rules apply by default.

SIZE OF THE ASSOCIATION
Winter 2026 has 100 teams and more than 1,600 participants across the senior and junior competitions.

WHERE THE SEASON IS UP TO
Winter 2026 registrations have CLOSED and the season is in its closing stages. Saturday T20 finished on 15 August, Saturday T35 is into its finals, and Saturday T35 Non MYCA continues until 12 September. Junior rounds run on alternate Sundays.

Never invite anyone to register for Winter 2026 or imply registrations are open. If someone asks about joining, say registrations for Winter 2026 have closed, that dates for the next season have NOT been announced, and point them to [season info](/#register), the Facebook page or [contact](/#contact) to be told when they open. Never guess or invent a date for the next season.

Fees, formats and rules below describe Winter 2026. Quote them as how this season ran, and note that next season's details are confirmed closer to the time. For anything about how a team is currently placed — fixtures, ladders, results, finals — send people to PlayHQ rather than answering from memory.

FACTS YOU MAY STATE

Senior competitions (Winter 2026, all on Saturdays):
| Competition | Time | Season | Rounds | Prize | Registration | Umpire |
| --- | --- | --- | --- | --- | --- | --- |
| Saturday T20 | 8:00–11:30 AM | 12 Apr – 15 Aug 2026 | 16 + Pre SF + SF + Final | $1,500 | $675 | $65/game |
| Saturday T35 Non MYCA | 12:00–5:00 PM | 11 Apr – 12 Sep 2026 | 10 + Pre SF + SF + Final | $1,000 | $675 | $85/game |
| Saturday T35 | 12:00–5:00 PM | 11 Apr – 22 Aug 2026 | 16 + Pre SF + SF + Final | $1,500 | $425 | $85/game |
T20 and T35 prizes rose from $1,000 to $1,500. T35 Non MYCA runs on Saturdays with no MYCA competition.

Registration fee breakdown:
- T20 — Registration $175 + MoM Awards $125 + Ground Fee $250 + Finals Awards $125 = $675
- T35 Non MYCA — same components = $675
- T35 — Registration $175 + MoM Awards $125 + Finals Awards $125 = $425
- Balls $30 each (MCA Stamped Kookaburra Crown 2-piece white), bought by teams from Hoppers Crossing Cricket Store (03) 9369 5410 or any sports shop.

Payments: MCA, BSB 063106, account 10904465, reference = your team name as per the PlayHQ fixture. Umpire fees are paid before the toss (PayID or bank transfer). If a game is called off before the first ball, half the umpire fee is payable; if the association calls it off in advance, none is.

Senior playing rules:
- T35 — 35 overs a side, max 7 overs per bowler, ends change every 5 overs. Powerplay: first 5 overs mandatory plus 5 batting-choice overs (10 total).
- T20 — 20 overs a side, max 4 overs per bowler, ends change every over for the first 5 then every 5 overs. Powerplay: first 6 overs mandatory.
- Fielding: bowling powerplay max 2 fielders outside the circle; batting powerplay max 3; non-powerplay max 5; max 5 on the leg side at any time.
- Toss by 11:45 AM (T35) or 7:45 AM (T20); minimum 6 players to start.
- T35 innings 12:00–2:15 PM, 15-minute break, 2:30–4:45 PM, drinks after over 20.
- T20 innings 8:00–9:30 AM, 10-minute break, 9:40–11:10 AM, drinks after over 10.
- 12 players per side: any 11 may bat, any 12 may bowl, any 11 may field or keep.
- A win is 6 points, a draw 3 each. Minimum 5 overs each side for a result.
- Rain of 60 minutes or more with no prospect of resuming — game called off, points shared. DLS applies via PlayHQ.
- Revised target when PlayHQ is unavailable: revised overs × first-innings run rate. The rule book's worked example: Team A scores 175 in 35 overs, a run rate of 5.0; the second innings is revised to 15 overs; the target is 15 × 5.0 = 75 runs. State the formula exactly this way. Do NOT add one run to the result and do NOT restate it as a ratio of the first-innings total — MCA does not use the "one more to win" convention here.
- Free hit for every no-ball. Any ball above waist height on the full is a no-ball; above shoulder height on the full is a beamer, and two beamers ends that bowler's day.
- Uniforms: 5 runs deducted per player not in correct team uniform.
- Yellow cards: two in a match means disqualification for the rest of it; three in a season brings an automatic one-match suspension.
- Minimum 6 league games to qualify for finals in regular grades, 4 in reduced-fixture T35 grades.
- PlayHQ live scoring is mandatory. Some games are streamed via FrogBox on YouTube and the Play Cricket app.

Junior competitions (alternate Sundays from 26 April 2026, all start 12:30 PM):
| Grade | Overs | Ages | Team size | Ball | Umpire | Pitch | Boundary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| U11 | 25 | 8–11 | 7 ideal (5–11) | Kooka Soft Pink 130g | $65 | 16 m | 40 m |
| U13 | 25 | 9–13 | 9 ideal (7–11) | Kooka Crown White 142g | $65 | 18 m | 45 m |
| U15 | 30 | 12–15 | 11 ideal (7–13) | Kooka Crown White 156g | $70 | 20 m | 55 m |
- DOB windows: U11 27 Apr 2014 – 26 Apr 2018; U13 27 Apr 2012 – 26 Apr 2017; U15 27 Apr 2010 – 26 Apr 2014.
- LBW applies in U15 only. Free hit in U15 only. U11 has no powerplay and no inner circle; U13 has a 20 m circle and 8 powerplay overs; U15 has a 25 m circle and 10 powerplay overs.
- U11 and U13: max 5 overs per bowler and everyone must bowl. U15: max 6 overs per bowler, minimum 6 bowlers used.
- U11 batters retire on a ball allocation (total balls ÷ team size); U15 batters retire at 50 runs.
- Helmets are mandatory for all batters and wicketkeepers in every grade. Springback stumps are mandatory in U11 and U13. All matches are on synthetic pitches.
- Minimum 3 league games to qualify for junior finals. Dispensation requests go to the association by 5 PM the Thursday before the game.

Committee contacts:
- Gopi Kakivai, President — 0430 667 896
- Mahendra (Mahi) Annem, Secretary — 0433 960 586
- Sandeep Shamala, Treasurer — 0433 249 914
- Srikanth Dendi, Umpires Coordinator — 0430 408 093
- Deepak Kulkarni, Juniors Coordinator and Child Safety Officer — 0404 073 222, deepak7kulkarni@gmail.com
- Association email melbournecricketassociation@gmail.com · Facebook facebook.com/melbournecricketassociation
- Fixtures, ladders, results and live scores: https://www.playhq.com/cricket-australia/org/melbourne-cricket-association/mca-winter-competitions-winter-2026/172c9624

Every reply must end with a final line in exactly this format:
SUGGESTIONS: question one | question two | question three
Three likely follow-ups, each under 40 characters, written in the user's own voice ("What's the umpire fee?" rather than "Umpire fees").`;

// ----------------------------------------------------------------------------
// CORS
// ----------------------------------------------------------------------------

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function isAllowedOrigin(origin) {
  return Boolean(origin) && ALLOWED_ORIGINS.includes(origin);
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      origin ? corsHeaders(origin) : {}
    ),
  });
}

// ----------------------------------------------------------------------------
// Rate limiting — in-memory per isolate, purely a cost guard
// ----------------------------------------------------------------------------

const rateBuckets = new Map();

function rateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();

  // Opportunistic sweep so the map cannot grow without bound.
  if (rateBuckets.size > 5000) {
    for (const [key, stamps] of rateBuckets) {
      const live = stamps.filter((t) => now - t < RATE_WINDOW_MS);
      if (live.length) rateBuckets.set(key, live);
      else rateBuckets.delete(key);
    }
  }

  const recent = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    rateBuckets.set(ip, recent);
    return true;
  }
  recent.push(now);
  rateBuckets.set(ip, recent);
  return false;
}

// ----------------------------------------------------------------------------
// Analytics — daily KV counters. Never allowed to break a request.
// ----------------------------------------------------------------------------

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function bump(env, metric) {
  try {
    if (!env || !env.STATS) return;
    const key = metric + ':' + todayKey();
    const current = parseInt((await env.STATS.get(key)) || '0', 10) || 0;
    await env.STATS.put(key, String(current + 1), { expirationTtl: STATS_TTL_SECONDS });
  } catch (err) {
    // Analytics is best-effort by design — swallow everything.
  }
}

// ----------------------------------------------------------------------------
// Conversation trimming
// ----------------------------------------------------------------------------

function trimConversation(raw) {
  if (!Array.isArray(raw)) return [];

  const clean = [];
  for (const msg of raw) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    if (typeof msg.content !== 'string') continue;
    const text = msg.content.trim();
    if (!text) continue;
    clean.push({ role: msg.role, content: text.slice(0, MAX_MSG_CHARS) });
  }

  return clean.slice(-MAX_TURNS);
}

// ----------------------------------------------------------------------------
// Anthropic call + server-side web search loop
// ----------------------------------------------------------------------------

function webSearchTool() {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
    user_location: {
      type: 'approximate',
      city: 'Melbourne',
      region: 'Victoria',
      country: 'AU',
      timezone: 'Australia/Melbourne',
    },
  };
}

async function callAnthropic(messages, env) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [webSearchTool()],
      messages: messages,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error('Anthropic ' + res.status + ': ' + detail.slice(0, 400));
  }
  return res.json();
}

/**
 * Runs the conversation, following `pause_turn` so server-side web search can
 * finish. Returns the flattened list of content blocks across all rounds.
 */
async function runConversation(messages, env) {
  const blocks = [];
  let convo = messages.slice();
  let reply = await callAnthropic(convo, env);
  let rounds = 0;

  while (reply.stop_reason === 'pause_turn' && rounds < MAX_PAUSE_ROUNDS) {
    blocks.push(...(reply.content || []));
    convo = convo.concat([{ role: 'assistant', content: reply.content }]);
    reply = await callAnthropic(convo, env);
    rounds++;
  }

  blocks.push(...(reply.content || []));
  return blocks;
}

// ----------------------------------------------------------------------------
// Response assembly
// ----------------------------------------------------------------------------

function assembleReply(blocks) {
  let text = '';
  const citations = [];
  const seen = new Set();

  for (const block of blocks) {
    if (!block || block.type !== 'text') continue;
    text += block.text || '';

    for (const cite of block.citations || []) {
      const url = cite && cite.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      citations.push({ url: url, title: cite.title || url });
    }
  }

  text = text.trim();

  // Pull the trailing SUGGESTIONS: line out into a structured array.
  let suggestions = [];
  const match = text.match(/^SUGGESTIONS:\s*(.+)$/im);
  if (match) {
    suggestions = match[1]
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    text = text.replace(match[0], '').trim();
  }

  // Any source the model didn't already link inline gets a footer entry.
  const unlinked = citations.filter((c) => text.indexOf(c.url) === -1);
  if (unlinked.length) {
    const list = unlinked.map((c) => '[' + c.title + '](' + c.url + ')').join(' · ');
    text += '\n\nSources: ' + list;
  }

  return { reply: text, suggestions: suggestions };
}

// ----------------------------------------------------------------------------
// Route: POST /chat
// ----------------------------------------------------------------------------

async function handleChat(request, env, ctx, origin) {
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return json({ error: 'Invalid JSON body.' }, 400, origin);
  }

  const messages = trimConversation(payload && payload.messages);

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return json({ error: 'The last message must come from the user.' }, 400, origin);
  }

  const ip = request.headers.get('CF-Connecting-IP');
  if (rateLimited(ip)) {
    return json(
      {
        reply:
          "You've asked quite a few questions this hour, so I'm taking a short break. " +
          'Try again a little later, or leave your details on the [contact](/#contact) ' +
          'form and someone from the committee will get back to you.',
        suggestions: [],
      },
      200,
      origin
    );
  }

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Assistant is not configured.' }, 503, origin);
  }

  try {
    const blocks = await runConversation(messages, env);
    const result = assembleReply(blocks);

    if (!result.reply) {
      return json({ error: 'Empty response from the model.' }, 502, origin);
    }

    ctx.waitUntil(bump(env, 'chats'));
    return json(result, 200, origin);
  } catch (err) {
    console.error('chat failed:', err && err.message);
    return json({ error: 'The assistant is unavailable right now.' }, 502, origin);
  }
}

// ----------------------------------------------------------------------------
// Route: POST /enquiry
// ----------------------------------------------------------------------------

async function handleEnquiry(request, env, ctx, origin) {
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return json({ error: 'Invalid JSON body.' }, 400, origin);
  }

  // Honeypot: real people leave this untouched, bots fill it in.
  if (payload && typeof payload.honey === 'string' && payload.honey.trim()) {
    return json({ ok: true }, 200, origin);
  }

  const name = String((payload && payload.name) || '').trim();
  const phone = String((payload && payload.phone) || '').trim();
  const email = String((payload && payload.email) || '').trim();
  const message = String((payload && payload.message) || '').trim();

  if (name.length < 2) {
    return json({ error: 'Please provide your name.' }, 400, origin);
  }
  if (phone.replace(/[^0-9]/g, '').length < 8) {
    return json({ error: 'Please provide a valid phone number.' }, 400, origin);
  }

  try {
    const res = await fetch('https://formsubmit.co/ajax/' + ENQUIRY_EMAIL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        _subject: 'MCA website enquiry — ' + name,
        name: name,
        phone: phone,
        email: email || '(not supplied)',
        message: message.slice(0, 2000) || '(no message)',
      }),
    });

    if (!res.ok) throw new Error('formsubmit ' + res.status);

    ctx.waitUntil(bump(env, 'enquiries'));
    return json({ ok: true }, 200, origin);
  } catch (err) {
    console.error('enquiry failed:', err && err.message);
    return json({ error: 'Could not send your enquiry. Please call us instead.' }, 502, origin);
  }
}

// ----------------------------------------------------------------------------
// Route: GET /stats
// ----------------------------------------------------------------------------

async function handleStats(env) {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }

  let rows = '';
  let totals = { views: 0, chats: 0, enquiries: 0 };

  for (const day of days) {
    const [views, chats, enquiries] = await Promise.all([
      env.STATS ? env.STATS.get('views:' + day) : null,
      env.STATS ? env.STATS.get('chats:' + day) : null,
      env.STATS ? env.STATS.get('enquiries:' + day) : null,
    ]);

    const v = parseInt(views || '0', 10) || 0;
    const c = parseInt(chats || '0', 10) || 0;
    const e = parseInt(enquiries || '0', 10) || 0;
    totals.views += v;
    totals.chats += c;
    totals.enquiries += e;

    rows +=
      '<tr><td>' + day + '</td><td>' + v + '</td><td>' + c + '</td><td>' + e + '</td></tr>';
  }

  const html =
    '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">' +
    '<title>MCA stats</title>' +
    '<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#0f172a}' +
    'table{border-collapse:collapse}th,td{padding:.4rem .9rem;border-bottom:1px solid #e2e8f0;' +
    'text-align:right}th:first-child,td:first-child{text-align:left}' +
    'tfoot td{font-weight:700;border-top:2px solid #0f172a}</style>' +
    '<h1>MCA — last 14 days</h1><table>' +
    '<thead><tr><th>Date</th><th>Views</th><th>Chats</th><th>Enquiries</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '<tfoot><tr><td>Total</td><td>' + totals.views + '</td><td>' + totals.chats +
    '</td><td>' + totals.enquiries + '</td></tr></tfoot></table>';

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' },
  });
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = request.headers.get('Origin');

    // /stats is browser-visited, not called cross-origin.
    if (path === '/stats' && request.method === 'GET') {
      return handleStats(env);
    }

    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!isAllowedOrigin(origin)) {
      return new Response('Forbidden origin.', { status: 403 });
    }

    if (path === '/chat' && request.method === 'POST') {
      return handleChat(request, env, ctx, origin);
    }

    if (path === '/enquiry' && request.method === 'POST') {
      return handleEnquiry(request, env, ctx, origin);
    }

    if (path === '/hit' && request.method === 'POST') {
      ctx.waitUntil(bump(env, 'views'));
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    return json({ error: 'Not found.' }, 404, origin);
  },
};
