# Melbourne Cricket Association — website

Live at **https://mcacric.com**

A plain static website. No build step, no framework, no package manager — the
files you see here are the files the browser gets. Anyone who can edit HTML can
maintain it.

## How it is hosted

| Part | Where | Why |
|---|---|---|
| The website | **GitHub Pages**, from `main` | Free, no billing to lapse, no account to expire |
| The chat assistant | A small **Cloudflare Worker** | Explained below |

Pushing to `main` publishes the site. That is the whole deployment process.

### Why the chat needs a Worker

GitHub Pages serves static files only — it cannot run code. The assistant calls
the Anthropic API, which needs a secret key, and a key placed in a web page is
readable by anyone who views source. So one small service has to sit in the
middle and hold the key:

```
browser  ->  POST /chat  ->  Cloudflare Worker  ->  api.anthropic.com
```

That Worker is the only piece not on GitHub. Its source lives in `worker/` and
it is deployed separately — see `worker/README.md`.

If the Worker is ever switched off, the chat keeps working: it falls back to the
offline keyword lookup in `rules-data.js`, which answers from 211 pre-written
rule Q&As. Slower to write, but free and dependency-free.

## The files

| File | What it is |
|---|---|
| `index.html` | The whole site — every section |
| `chat.html` | Standalone assistant page — shareable on its own at **https://mcacric.com/chat** |
| `chat/index.html` | Makes the short `/chat` address work; it just forwards to `chat.html` |
| `styles.css` | All styling, both light and dark themes |
| `script.js` | Site behaviour and the chat widget |
| `rules-data.js` | 211 rule Q&As, used when the Worker is unreachable |
| `photos/` | Gallery and hero images, resized for the web |
| `rules/` | The Winter 2026 rule book PDFs |
| `CNAME` | Tells GitHub Pages which domain to serve |
| `.nojekyll` | Stops GitHub trying to process the site as a blog |

## Common edits

**Change a fee, date or rule shown on the page** — edit `index.html`.

**Change what the assistant knows** — edit the system prompt in
`worker/src/worker.js`, then redeploy the Worker. Editing the website does not
change the assistant's answers, and vice versa; they are separate.

**Add gallery photos** — resize to about 1600px wide first. Full-resolution
phone photos are roughly 9 MB each and make the site slow on mobile data at a
ground.

**Change the season status** — the "Season Information" section in
`index.html`, and the matching paragraph in the Worker's system prompt.

## Committee contacts

Gopi Kakivai (President) · Mahendra Annem (Secretary) ·
Sandeep Shamala (Treasurer) · Srikanth Dendi (Umpires) ·
Deepak Kulkarni (Juniors) — melbournecricketassociation@gmail.com
