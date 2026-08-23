/**
 * Asks the live assistant a set of questions with known answers and fails if
 * any reply is wrong — or invents something it was told not to.
 *
 *   node worker/tests/run.mjs [endpoint]
 *
 * Runs after every deploy. A prompt instruction is not a guarantee; this is
 * what turns "we told it not to" into "we checked it didn't".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));

const ENDPOINT = process.argv[2] || process.env.ENDPOINT || 'https://mca-assistant.astrocare.workers.dev';
const ORIGIN = 'https://www.mcacric.com';
const CONCURRENCY = 3;          // gentle on the per-IP rate limit

async function ask(question) {
  const res = await fetch(ENDPOINT + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || 'HTTP ' + res.status);
  return String(body.reply || '');
}

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
      const reply = await ask(c.ask);
      results.push({ c, problems: check(reply, c), reply });
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
  console.log('        asked: ' + c.ask);
  console.log('        why it matters: ' + (c.why || ''));
  for (const p of r.problems) console.log('        ' + p);
  console.log('        reply: ' + r.reply.replace(/\s+/g, ' ').slice(0, 300));
}

console.log('\n' + (cases.length - failed) + '/' + cases.length + ' passed');
if (failed) {
  console.log('\nA failure here means the deployed assistant is telling players something');
  console.log('wrong. Fix the prompt or worker/knowledge.md and deploy again.');
  process.exit(1);
}
