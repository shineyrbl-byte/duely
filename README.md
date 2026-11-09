# Duely — get paid on time

**An AI copilot for freelancers that turns messy client chats into PayPal invoices, then chases late payments for you — with your approval on every message.**

Built for the PayPal AI Hackathon (Nov 2026).

**Live demo:** https://duely-ten-iota.vercel.app (PayPal sandbox + Gemini)  
**Demo video:** https://youtu.be/fmJgOGCpJZk

## The problem

Freelancers lose hours every month on admin: turning a WhatsApp thread or a voice memo into an invoice, remembering who has paid, and writing awkward "just following up…" emails. Late payment is common, and the chasing is the part people hate most.

## What Duely does

1. **Invoice from anything.** Paste a client chat, dictate a voice note, or drop in a screenshot or PDF contract. The AI reads it and drafts a structured invoice: client, line items, hours vs. flat fees, tax, discount, due date and a friendly note. It remembers your clients, so "same rate as last time" works, and it flags anything missing (like an email) before you send.
2. **One-click send through PayPal.** After you review the draft, Duely creates and sends a real invoice with the **PayPal Invoicing v2 API**. Your client gets PayPal's hosted payment page (PayPal, card, Venmo and Pay Later where available).
3. **A collections agent that asks first.** The agent reviews every open PayPal invoice and looks up each client's payment history. For each invoice, it either drafts a reminder or skips it and says why. Tone escalates sensibly (heads-up → gentle → firm → final), it never nags within 3 days of a previous reminder, and it is extra warm with good clients. **Nothing is sent until you approve it.** Approved reminders go out through PayPal's `/remind` endpoint.
4. **A live receivables dashboard.** An AG Grid table shows status, outstanding amount, days late and reminder count, with filters and search. A summary row shows outstanding, overdue, due-this-week and collected totals. PayPal webhooks (`INVOICING.INVOICE.PAID`) show up in the activity feed as soon as a client pays.

## Try it

### Option A: demo mode (no keys at all)
```bash
npm install
cp .env.example .env.local     # leave PayPal keys blank
npm run build && npm start     # http://localhost:3000
```
Click **Load demo invoices**, then move the **Demo clock** forward to see invoices become overdue. Without PayPal keys, Duely uses an in-memory mock of the Invoicing API with the same response shapes. Add a free `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`) to turn on the AI features.

### Option B: real PayPal sandbox
1. Create a sandbox app at [developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox) and copy its **Client ID** and **Secret**.
2. Fill in `.env.local`:
   ```
   GEMINI_API_KEY=...          # free: https://aistudio.google.com/apikey
   # or ANTHROPIC_API_KEY=sk-ant-...
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   PAYPAL_ENV=sandbox
   INVOICER_NAME=Your Name
   ```
3. `npm run build && npm start`, then open http://localhost:3000. The badge should read **Connected · PayPal sandbox**.
4. Send an invoice, click **Pay link ↗**, and pay it with a sandbox *personal* account. The dashboard updates on its next poll.
5. Optional: deploy (see below), subscribe a webhook to `INVOICING.INVOICE.*` at `https://<your-app>/api/webhooks/paypal`, and set `PAYPAL_WEBHOOK_ID`.

### Deploy
- **Vercel (used for the live demo):** import the repo, add the environment variables, and connect a free **Upstash for Redis** database from the Vercel Marketplace. Duely loads its state (agent proposals, reminder history, activity, demo clock) from Redis before each request and saves it after, so serverless instances share it.
- **Any Docker host:** the included `Dockerfile` serves the app on port 7860.
- **Render:** `render.yaml` defines a free web service.

## How it's built

| Layer | Tech |
|---|---|
| App | Next.js 16 (App Router, route handlers), React 19, TypeScript, Tailwind CSS 4 |
| Payments | PayPal REST: OAuth2 client credentials, **Invoicing v2** (`generate-next-invoice-number`, create, send, remind, record payment, cancel, list), **Webhooks** (signature verification) |
| AI | **Google Gemini** (`@google/genai`, free tier) or **Claude Opus 5.5** (`@anthropic-ai/sdk`) — same prompts, schema and tools for both |
| Grid | **AG Grid** Community (Quartz theme, custom cell renderers, quick filter) |
| Hosting | **Vercel** + **Upstash Redis** for shared state (Dockerfile and `render.yaml` also included) |

```
src/
  lib/paypal.ts        PayPal client (sandbox + mock), invoice normalisation
  lib/ai.ts            AI (Gemini or Claude): invoice drafting + collections agent
  lib/store.ts         proposals, reminder history, activity feed, demo clock (+ Redis sync)
  app/api/...          route handlers (state, invoices, ai/draft, agent, webhooks, demo)
  components/...       Composer, InvoiceGrid (AG Grid), AgentPanel, Dashboard
```

## AI tools used, and how

Duely works with either provider; it picks Gemini when `GEMINI_API_KEY` is set, otherwise Claude (override with `AI_PROVIDER`).

- **Structured extraction.** One Zod schema defines the invoice draft. With Gemini it becomes a `responseJsonSchema` (JSON mode); with Claude it is used through `messages.parse` structured outputs. Both read free text, images (screenshots of chats) and PDFs (contracts, timesheets). The model also gets your known clients and their past line items, so it can fill in emails and rates.
- **Agentic tool use.** The collections agent has four tools: `list_receivables`, `get_client_history`, `propose_reminder` and `skip_invoice`. They are defined once and wrapped as Gemini function declarations (a manual function-calling loop that preserves thought signatures) or as Claude tool-runner tools. The agent reasons over live PayPal data and writes a personalised reminder for each invoice that needs one. It can only *propose*: sending goes through a human approval endpoint that calls PayPal.
- Claude requests use adaptive thinking and server-side refusal fallbacks.
- **Browser Web Speech API** handles voice dictation in the composer.
- **Claude Code** helped scaffold and write the project.

## Safety and design choices

- **Human in the loop:** the agent never contacts clients directly. Every reminder can be edited before it is approved.
- **No invented charges:** the drafting prompt only bills for work stated in the input, and anything uncertain appears under "Check before sending".
- **Verified webhooks:** events are checked with PayPal's `verify-webhook-signature` before Duely trusts them.
- **Secrets stay server-side:** PayPal and Anthropic calls happen only in route handlers.

## Limitations

- Without Redis configured, agent proposals, reminder history and the activity feed live in server memory and reset on restart. PayPal stays the source of truth for invoices.
- The demo clock shifts "today" only inside Duely, so overdue flows can be shown without waiting weeks.

## License

[MIT](LICENSE)
