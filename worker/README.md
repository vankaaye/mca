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

## Deploy

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

Commit and push — Netlify redeploys and the widget starts using the live
assistant. Leave it as an empty string and the widget quietly falls back to the
offline keyword lookup in `rules-data.js`, so the site is never broken.

## CORS

`ALLOWED_ORIGINS` in `src/worker.js` is an allowlist — any other origin gets a
403. It currently permits:

- `https://mcacricket.netlify.app`
- `https://www.mcacricket.netlify.app`
- `localhost` / `127.0.0.1` on ports 3000 and 8000

Add your custom domain to that array when you set one up, then redeploy.

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
