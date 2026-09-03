/**
 * Asks the live assistant a set of questions with known answers and fails if
 * any reply is wrong — or invents something it was told not to.
 *
 *   node worker/tests/run.mjs [endpoint]
 *
 * Runs after every deploy. A prompt instruction is not a guarantee; this is
 * what turns "we told it not to" into "we checked it didn't".
 *
 * Writing cases: assert on the claim, not the wording. Every false failure
 * this suite has produced came from matching phrasing — demanding "one
 * warning per over" from a reply that said "a one-warning system that runs
 * per over", or listing six verbs for "does not ..." and omitting "contain".
 * Two rules follow from that:
 *   - must patterns: allow the synonyms a correct answer would reach for.
 *   - mustNot patterns: they are blind to negation, so scope them to the
 *     affirmative claim. Banning "48 hours" outright also failed answers
 *     that correctly attributed the junior deadline to juniors.
 *   - patterns run against the reply with markdown emphasis stripped, so a
 *     phrase may span bold: "the top **4 teams**" matches /top 4/.
 * Before adding a case, run both a correct reply and the wrong one you are
 * guarding against through its patterns.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));

const ENDPOINT = process.argv[2] || process.env.ENDPOINT || 'https://mca-assistant.astrocare.workers.dev';

// --smoke runs only the cases tagged smoke:true — five, not the full set. Every
// question costs a real API call carrying the whole prompt, so running all of
// them on each merge is most of what this project spends. The full set still
// runs on the preview workflow and on demand; the merge gate keeps the handful
// that would matter most if they broke.
const SMOKE_ONLY = process.argv.includes('--smoke') || process.env.SMOKE === '1';
const ORIGIN = 'https://www.mcacric.com';
const CONCURRENCY = 3;          // gentle on the per-IP rate limit

async function ask(c) {
  // A case is either a single question or a whole conversation. The
  // conversation ones exist because the assistant defends what it said
  // earlier, so a stale saved chat can undo a corrected prompt.
  const messages = c.conversation || [{ role: 'user', content: c.ask }];
  const res = await fetch(ENDPOINT + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ messages }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || 'HTTP ' + res.status);
  return String(body.reply || '');
}

// The Worker allows 30 chats per IP per hour. A full run is 28, so two runs
// in an hour trips it — and the friendly "taking a short break" reply then
// fails every remaining case for a reason that has nothing to do with the
// answers. Recognise it and say so, rather than reporting phantom failures.
const RATE_LIMITED = /taking a short break|asked quite a few questions/i;

// The Worker's own fallback when it cannot reach the API upstream. A run where
// every case comes back like this is an outage, not twenty-eight wrong answers,
// and reporting it as content failures sends you hunting through the prompt for
// a problem that is not there. Still fails the run — an untested branch must not
// look mergeable — but says what actually happened.
const UNREACHABLE = /assistant is unavailable|unavailable right now|HTTP 5\d\d/i;

// A bare connection error, before any reply comes back at all. The deploy
// workflow runs seconds after `wrangler deploy` while Cloudflare is still
// rolling the new version out worldwide, so one case reaching a node that is
// not ready yet is ordinary. It is not the assistant answering wrongly, and a
// deploy going red over it teaches whoever gets the mail to ignore the mail.
const NETWORK_ERROR = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|terminated|timeout/i;

// The assistant answers in markdown, so a phrase the case is looking for can
// arrive with formatting inside it: "the top **4 teams**" does not match
// /top 4/, though it says exactly that. Strip emphasis before matching rather
// than teaching every pattern to expect asterisks. Whitespace and sentence
// punctuation are left alone — the mustNot patterns use [^.] windows to stay
// inside one sentence, and collapsing newlines would let them span a list.
// A denial, in whichever words a correct answer reaches for. Four cases each
// grew their own hand-rolled version of this list, and each one eventually
// failed a right answer over a verb its list happened to miss — "does not
// contain", then "does not allow". One list, fixed in one place.
const MACROS = {
  DENIES:
    "(does not|doesn't|do not|don't|no|not|nothing in the|cannot find|can't find)" +
    "[^.]{0,40}" +
    "(allow|permit|cover|contain|include|mention|describe|specify|set out|provide|state|exist|process|rule|address|answer)",
};

function expand(pattern) {
  return pattern.replace(/\{\{(\w+)\}\}/g, (whole, name) => {
    if (!(name in MACROS)) throw new Error('unknown macro in cases.json: ' + whole);
    return MACROS[name];
  });
}

function forMatching(reply) {
  return reply.replace(/\*\*|__|(?<![A-Za-z0-9])[*_](?![A-Za-z0-9])|`/g, '');
}

function check(reply, c) {
  const problems = [];
  const text = forMatching(reply);
  for (const pattern of c.must || []) {
    if (!new RegExp(expand(pattern), 'i').test(text)) problems.push('missing: ' + pattern);
  }
  for (const pattern of c.mustNot || []) {
    const hit = new RegExp(expand(pattern), 'i').exec(text);
    // Quote what actually matched, and what surrounds it. A banned pattern
    // names the claim that is forbidden, not the sentence that tripped it, and
    // the reply excerpt printed at the end is truncated — so a correct answer
    // that trips a pattern late in a long reply gets judged on evidence that
    // is not on screen. That has now cost two runs.
    if (hit) problems.push('INVENTED: ' + pattern + '\n      matched: ...' + around(text, hit) + '...');
  }
  return problems;
}

function around(text, hit) {
  const from = Math.max(0, hit.index - 80);
  const to = Math.min(text.length, hit.index + hit[0].length + 80);
  return text.slice(from, to).replace(/\s+/g, ' ');
}

// --only "<text>" runs just the cases whose name contains that text. Every
// case is a real API call carrying the whole prompt, so re-checking one fix
// should not cost twenty-eight of them.
const onlyAt = process.argv.indexOf('--only');
const ONLY = (onlyAt !== -1 ? process.argv[onlyAt + 1] : process.env.ONLY) || '';

let selected = SMOKE_ONLY ? cases.filter(c => c.smoke) : cases;
if (SMOKE_ONLY && !selected.length) {
  console.error('--smoke was passed but no case is tagged smoke:true');
  process.exit(1);
}
if (ONLY) {
  selected = selected.filter(c => c.name.toLowerCase().includes(ONLY.toLowerCase()));
  if (!selected.length) {
    console.error('--only ' + JSON.stringify(ONLY) + ' matched no case name. Names:');
    for (const c of cases) console.error('  ' + c.name);
    process.exit(1);
  }
}
console.log(ONLY
  ? 'Filtered run: ' + selected.length + ' of ' + cases.length + ' cases matching ' + JSON.stringify(ONLY) + '.'
  : SMOKE_ONLY
    ? 'Smoke run: ' + selected.length + ' of ' + cases.length + ' cases.'
    : 'Full run: ' + selected.length + ' cases.');

const results = [];
const queue = selected.slice();

async function worker(limit) {
  let done = 0;
  while (queue.length && (limit === undefined || done < limit)) {
    done++;
    const c = queue.shift();
    try {
      let reply = await ask(c);
      if (RATE_LIMITED.test(reply)) {
        // Wait out a slice of the window and give it one more go
        await new Promise(r => setTimeout(r, 65000));
        reply = await ask(c);
      }
      if (RATE_LIMITED.test(reply)) {
        results.push({ c, problems: ['RATE LIMITED — not a content failure'], reply });
      } else {
        results.push({ c, problems: check(reply, c), reply });
      }
    } catch (err) {
      // Give a connection error one more go before calling it anything. This
      // is the whole fix for a red deploy on a working assistant: the retry
      // lands a few seconds later, by which time the rollout has caught up.
      if (NETWORK_ERROR.test(err.message)) {
        try {
          await new Promise(r => setTimeout(r, 5000));
          const reply = await ask(c);
          results.push({ c, problems: check(reply, c), reply });
          continue;
        } catch (again) {
          err = again;
        }
      }
      const label = UNREACHABLE.test(err.message) || NETWORK_ERROR.test(err.message)
        ? 'UNREACHABLE — could not reach the assistant, not a content failure'
        : 'request failed: ' + err.message;
      results.push({ c, problems: [label], reply: '' });
    }
  }
}

// Run the first case alone so it writes the prompt cache, then let the rest
// read it. Starting three at once means three simultaneous misses, and a cache
// write costs 1.25x base input against 0.1x for a read — on a ~17k-token prompt
// that is two needless writes per run, every run.
if (queue.length) {
  const first = queue.shift();
  queue.unshift(first);
  await worker.call(null, 1);   // one case, sequentially, to warm the cache
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

let failed = 0;
for (const c of selected) {
  const r = results.find(x => x.c.name === c.name);
  if (!r.problems.length) {
    console.log('  ok   ' + c.name);
    // On a filtered run you are looking at one answer on purpose. A pass with
    // no reply printed still leaves you guessing what it said — and these
    // answers vary between runs, so "it passed" is not the same as "it is
    // right". Print it in full when the run is small enough to read.
    if (ONLY && selected.length <= 3) {
      console.log('       reply: ' + r.reply.replace(/\s+/g, ' '));
    }
    continue;
  }
  failed++;
  console.log(' FAIL  ' + c.name);
  const asked = c.ask || c.conversation[c.conversation.length - 1].content;
  console.log('        asked: ' + asked.replace(/\s+/g, ' ').slice(0, 160));
  console.log('        why it matters: ' + (c.why || ''));
  for (const p of r.problems) console.log('        ' + p);
  console.log('        reply: ' + r.reply.replace(/\s+/g, ' ').slice(0, 300));
}

console.log('\n' + (selected.length - failed) + '/' + selected.length + ' passed');

const unreachable = results.filter(r => r.problems.some(p => p.startsWith('UNREACHABLE')));
if (unreachable.length) {
  console.log('\n' + unreachable.length + ' of ' + selected.length + ' could not be tested: the');
  console.log('Worker could not reach the assistant. That is an outage or a missing API');
  console.log('key, not a wrong answer — nothing here says the branch is bad. Run again');
  console.log('once it is back, and do not merge on this result either way.');
}

if (results.some(r => r.problems.some(p => p.startsWith('RATE LIMITED')))) {
  console.log('\nSome cases could not be tested: the Worker rate-limits an IP to 30 chats');
  console.log('an hour and this run went past it. Wait an hour and run again — those');
  console.log('are not wrong answers.');
}

if (failed) {
  console.log('\nA failure here means the deployed assistant is telling players something');
  console.log('wrong. Fix the prompt or worker/knowledge.md and deploy again.');
  // Genuinely last, so a log view that only keeps the tail still names the
  // cases. Printing it above this advice was not far enough down: twice the
  // window cut off one line short of it.
  // Compact, and genuinely last: name, the first problem, and enough of the
  // reply to judge it. The full detail is above, but a log view that keeps
  // only the tail shows this — and knowing which case broke without seeing
  // what it said is half an answer.
  console.log('\nFailed:');
  for (const r of results.filter(r => r.problems.length)) {
    console.log('  ' + r.c.name + ' — ' + r.problems[0]);
    console.log('    reply: ' + r.reply.replace(/\s+/g, ' ').slice(0, 220));
  }
  process.exit(1);
}
