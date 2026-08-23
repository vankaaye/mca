# MCA Assistant — Cloudflare Worker

Proxies the Anthropic API so the browser never sees the API key.

```
Browser widget  →  POST /chat  →  this Worker  →  api.anthropic.com
```

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/chat` | POST | Conversation proxy — Claude Haiku with server-side web search |
| `/enquiry` | POST | Contact/callback relay → formsubmit.co → association inbox |
| `/hit` | POST | Fire-and-forget page-view beacon (returns 204) |
| `/stats` | GET | Unlisted dashboard, last 14 days |

## What the assistant knows

The system prompt carries **the full text of both rule books**, pasted into
`src/worker.js` as `RULE_BOOK_SENIORS` and `RULE_BOOK_JUNIORS`, plus a
summary of the facts most often asked for.

It used to carry only the summary. That meant any question about a section
nobody had thought to summarise came back as "I don't have that detail" — or,
worse, as a confident invention. Carrying the whole text removes that class of
failure: if it is in the book, the assistant can read it.

**When the rule books change**, re-extract and paste them in:

```bash
pdftotext ../rules/MCA-Winter-2026-T35-and-T20-Rules-v1.0.pdf -
pdftotext ../rules/MCA-Juniors-Winter-2026-Rules-v0.4.pdf -
```

Replace the contents of the two template literals, keeping the backticks. Any
literal backtick or `${` in the text must be backslash-escaped. Then redeploy.

The prompt is about 16,000 tokens, so it is sent with `cache_control` and is
served from cache after the first request in a five-minute window. Haiku will
not cache a prefix under 4,096 tokens; this clears that comfortably. If you
ever want to check it is still hitting, look at `cache_read_input_tokens` in
the API response.

## Deploying

**Pushing a change to `worker/` on `main` deploys it.** A GitHub Action
(`.github/workflows/deploy-worker.yml`) runs `wrangler deploy`, then asks the
live assistant a rule-book question and fails the build if the answer shows an
older prompt is still serving. You can also trigger it by hand from the repo's
Actions tab.

### One-time setup

1. **Cloudflare → My Profile → API Tokens → Create Token**, using the
   *Edit Cloudflare Workers* template. Copy the token — it is shown once.
2. **Cloudflare → Workers & Pages**, copy the **Account ID** from the sidebar.
3. **GitHub → this repo → Settings → Secrets and variables → Actions →
   New repository secret**, twice:

   | Name | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | the token from step 1 |
   | `CLOUDFLARE_ACCOUNT_ID` | the id from step 2 |

The Anthropic API key is **not** needed here. It lives on the Worker and never
goes near GitHub. `keep_vars = true` in `wrangler.toml` is what protects it: by
default `wrangler deploy` replaces the Worker's whole set of variables and
secrets with whatever the config file declares, and since the key is
deliberately not in this repository, that removed it. It cost an outage the
first time. Do not remove that line.

⚠️ Before the first automated deploy, check whether the Worker has a **STATS**
KV binding (Cloudflare → the Worker → Settings → Bindings). If it does, put the
namespace id into `wrangler.toml` — that file is the whole truth about
bindings, and deploying without it removes the binding. Analytics is the only
thing affected; the chat is unaffected either way.

## Checking it still tells the truth

`worker/tests/cases.json` holds questions with known answers. Every deploy runs
them against the live assistant and fails if a reply is wrong.

Half the cases assert what a reply **must not** say. That half is the point:
anyone can write a prompt telling a model not to invent things, but only a test
catches it when it does anyway. Every `mustNot` in that file is a mistake the
assistant actually made once — a dispensation process the senior rules do not
have, a deadline borrowed from an unrelated clause, an extra run added to a
revised target.

Run them yourself any time:

```bash
node worker/tests/run.mjs
```

**When you change the prompt or the notes, add a case.** If you are correcting
something the assistant got wrong, write the case first, watch it fail, then
fix it — otherwise nothing stops it drifting back.

Assertions are on facts, never on phrasing. The wording differs every run, and
a suite that fails on wording is a suite people learn to ignore.

## Updating it by hand

Only needed if the Action is not set up, or you want to bypass it.

**From the dashboard** — open the Worker in Cloudflare, click *Edit code*,
paste the whole of `src/worker.js` over what is there, and *Deploy*. The API
key and any bindings are account settings and survive this.

**From a terminal** — `cd worker && wrangler deploy`.

Either way, nothing about the website needs redeploying; the site and the
Worker are separate.

## First-time deploy

You need a Cloudflare account and an Anthropic API key from
[console.anthropic.com](https://console.anthropic.com/).

```bash
cd worker
npm install -g wrangler        # if you don't have it
wrangler login
```

**1. Create the KV namespace** for the analytics counters:

```bash
wrangler kv namespace create STATS
```

Copy the returned `id` into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

**2. Store the API key** as a secret — this never goes in the repo:

```bash
wrangler secret put ANTHROPIC_API_KEY
# paste your key when prompted
```

**3. Deploy:**

```bash
wrangler deploy
```

Wrangler prints the Worker URL, e.g.
`https://mca-assistant.<your-subdomain>.workers.dev`.

**4. Point the site at it.** In `index.html`, set:

```html
<script>window.MCA_CHAT_ENDPOINT = 'https://mca-assistant.your-subdomain.workers.dev';</script>
```

Commit and push — GitHub Pages redeploys and the widget starts using the live
assistant. Leave it as an empty string and the widget quietly falls back to the
offline keyword lookup in `rules-data.js`, so the site is never broken.

## CORS

`ALLOWED_ORIGINS` in `src/worker.js` is an allowlist — any other origin gets a
403. It currently permits:

- `https://mcacric.com` and `https://www.mcacric.com`
- the `workers.dev` preview URL
- `localhost` / `127.0.0.1` on ports 3000 and 8000

Add any new domain to that array, then redeploy.

## Cost guards

- **Rate limit** — 30 chats per IP per rolling hour. Over the limit the caller
  gets a friendly "come back later" reply rather than an error.
- **Conversation trimming** — last 12 turns only, each capped at 2,000
  characters.
- **Token cap** — `max_tokens` 1024, web search capped at 3 uses per turn.

## Analytics

Daily counters in KV: `views`, `chats`, `enquiries`. No cookies, no IP
addresses stored — just counts, expiring after ~40 days. Every KV write is
wrapped so analytics can never break a chat.

## Local development

```bash
wrangler dev
```

Serve the site on `http://localhost:8000` (already in the CORS allowlist) and
set `window.MCA_CHAT_ENDPOINT` to `http://localhost:8787`.
