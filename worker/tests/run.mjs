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
 * Before adding a case, run both a correct reply and the wrong one you are
 * guarding against through its patterns.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));

const ENDPOINT = process.argv[2] || process.env.ENDPOINT || 'https://mca-assistant.astrocare.workers.dev';
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

// The Worker allows 30 chats per IP per hour. A full run is 20, so two runs
// in an hour trips it — and the friendly "taking a short break" reply then
// fails every remaining case for a reason that has nothing to do with the
// answers. Recognise it and say so, rather than reporting phantom failures.
const RATE_LIMITED = /taking a short break|asked quite a few questions/i;

function check(reply, c) {
  const problems = [];
  for (const pattern of c.must || []) {
    if (!new RegExp(pattern, 'i').test(reply)) problems.push('missing: ' + pattern);
  }
  for (const pattern of c.mustNot || []) {
    if (new RegExp(pattern, 'i').test(reply)) problems.push('INVENTED: ' + pattern);
  }
  return problems;
}

const results = [];
const queue = cases.slice();

async function worker() {
  while (queue.length) {
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
      results.push({ c, problems: ['request failed: ' + err.message], reply: '' });
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

let failed = 0;
for (const c of cases) {
  const r = results.find(x => x.c.name === c.name);
  if (!r.problems.length) {
    console.log('  ok   ' + c.name);
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

console.log('\n' + (cases.length - failed) + '/' + cases.length + ' passed');

if (results.some(r => r.problems.some(p => p.startsWith('RATE LIMITED')))) {
  console.log('\nSome cases could not be tested: the Worker rate-limits an IP to 30 chats');
  console.log('an hour and this run went past it. Wait an hour and run again — those');
  console.log('are not wrong answers.');
}

if (failed) {
  console.log('\nA failure here means the deployed assistant is telling players something');
  console.log('wrong. Fix the prompt or worker/knowledge.md and deploy again.');
  process.exit(1);
}
