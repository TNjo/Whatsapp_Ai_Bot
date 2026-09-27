# Chatdesk — WhatsApp AI Business Bot & Order Management

A web platform that connects **one WhatsApp Business number per business** to an AI assistant. The assistant answers from the business's real catalog, collects orders over WhatsApp, and the owner confirms and ships them from a dashboard. Customers get automatic WhatsApp updates at every step.

Two ways to connect a number:

- **WhatsApp Business API (official, recommended)** — Meta's Cloud API via Embedded Signup or a System User token.
- **Linked device by QR code (unofficial)** — any normal WhatsApp number (personal or the WhatsApp Business app), linked like WhatsApp Web. See [Linking a normal WhatsApp number](#linking-a-normal-whatsapp-number-qr).

## What it does

| Area | Where |
| --- | --- |
| Connect WhatsApp (Embedded Signup, or a System User token) + connection health (account, phone, API, webhook, messaging, bot) | `/dashboard/whatsapp` |
| Signed webhook (`GET` verify, `POST` events): text, media, location, buttons, lists, delivery/read/failed statuses | `/api/webhooks/whatsapp` |
| AI assistant with controlled tools (`searchProducts`, `checkStock`, `createDraftOrder`, `updateDraftOrder`, `presentOrderReview`, `createOrder`, `getCustomerOrders`, `requestHumanSupport`, …) | `src/server/bot/` |
| Draft order → review with Confirm / Edit / Cancel → `PENDING` only after customer confirmation, backed by a database state machine | `src/server/commerce/cart.ts` |
| Dynamic order form (default + custom fields; asks only for what's missing) | `/dashboard/bot/order-form` |
| Orders: pending queue, confirm/reject, full status flow, tracking, internal notes, history with notification results | `/dashboard/orders` |
| Automatic WhatsApp status messages (editable), approved templates outside the 24-hour window | `/dashboard/whatsapp?tab=messages` / `?tab=templates` |
| Inbox: live conversations, manual replies, pause/resume AI, human handoff, resolve | `/dashboard/conversations` |
| Products (variants, stock, images), services, customers, business profile, team, activity log | `/dashboard/*` |
| Bot settings, rules, knowledge base (FAQs + notes), AI provider (Claude, OpenAI, Gemini, Groq, any OpenAI-compatible API) | `/dashboard/bot` |
| **Test bot** — chat as a customer using the same catalog, rules and order logic; nothing is sent on WhatsApp | `/dashboard/bot/test` |
| Real-time dashboard (Server-Sent Events): new orders, messages, handoffs, failures | `/api/events` |

## Quick start (local)

```bash
cd platform
npm install
cp .env.example .env.local   # optional for a first look
npm run dev                  # http://localhost:3000
```

Without `DATABASE_URL` the app uses an **embedded PostgreSQL (PGlite)** stored in `.data/`, so no database server is needed for development. Migrations run automatically on start.

1. Register a business at `/register`.
2. **Settings → Load sample catalog** to get a clothing-store catalog to try things with.
3. **Bot** → add an AI API key (or set `AI_API_KEY` in `.env.local`).
4. **Bot → Test bot** — try “Do you have black t-shirts?”, place an order, then ask “Where is my order?”.
5. **WhatsApp** → connect your number when you're ready for real customers.

## Connecting WhatsApp (Meta setup)

1. Create a Meta app (type *Business*) and add the **WhatsApp** product.
2. Set `META_APP_ID`, `META_APP_SECRET` and a random `META_WEBHOOK_VERIFY_TOKEN`.
3. In the app → WhatsApp → **Configuration**, set the callback URL to `https://<your-domain>/api/webhooks/whatsapp` with the same verify token, and subscribe to the **messages** field. (The WhatsApp page shows the exact URL.) Meta requires HTTPS — use a tunnel such as ngrok or Cloudflare Tunnel for local testing and set `APP_URL` to it.
4. **One-click connect:** create a *Facebook Login for Business* configuration for WhatsApp Embedded Signup and set `META_EMBEDDED_SIGNUP_CONFIG_ID`. The owner clicks **Connect WhatsApp**, picks the business, WABA and number, and the platform exchanges the code, subscribes the WABA to the app, registers the number when needed, and verifies the connection.
5. **Or** paste a permanent System User token + phone number ID + WABA ID under *Connect with an access token* (or set `WHATSAPP_*` env vars and use *Use server credentials*).
6. Create message templates (order confirmed, dispatched, …) in WhatsApp Manager, then **WhatsApp → Templates → Sync from Meta** and map each one to its purpose and variables.

## Linking a normal WhatsApp number (QR)

For numbers that aren't on the WhatsApp Business API, **WhatsApp → Link a normal WhatsApp number** shows a QR code. Scan it from the phone (WhatsApp → Linked devices → Link a device) and the same assistant, inbox, orders and notifications work on that number.

> ⚠️ **Unofficial.** This automates WhatsApp Web (whatsapp-web.js + headless Chrome), which WhatsApp's terms don't allow. WhatsApp may restrict or ban numbers that send automated messages. Avoid bulk or unsolicited messages and use the official API for important numbers. The dashboard asks the owner to acknowledge this before linking.

How it differs from the official API:

- Runs a headless Chrome **inside the app server** per linked business; the session is saved in `.data/wa-web/` and reconnects automatically after a restart (no new scan). Needs a long-running server with enough memory (~200–300 MB per linked number) — not serverless.
- No 24-hour window and no templates: order updates can always be sent.
- Buttons and lists are sent as numbered options; customers reply “1”, “2”… or the option's name.
- When the owner replies from the phone, the message appears in the inbox and the AI pauses for that chat (human takeover).
- Hidden-number contacts (`@lid`) are resolved to their phone number when WhatsApp shares it.
- Unlinking logs the device out on WhatsApp and deletes the saved session. If the phone removes the device, the owner is notified.
- Set `WHATSAPP_WEB_DISABLED=true` to stop linked devices from reconnecting on start.

## Environment

See [`.env.example`](.env.example). Required in production:

| Variable | Why |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `ENCRYPTION_KEY` | 32 bytes (base64). Encrypts WhatsApp tokens and AI keys at rest (AES-256-GCM) |
| `APP_URL` | Public HTTPS URL (webhook URL, links) |
| `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Webhook signature verification and Embedded Signup |
| `AI_API_KEY` (+ `AI_PROVIDER`, `AI_MODEL`) | Default AI for businesses without their own key |

Secrets never reach the browser: tokens are stored encrypted, API responses only expose hints (last 4 characters), and logs redact tokens and keys.

## Architecture

```
Meta Cloud API ──► /api/webhooks/whatsapp (HMAC verified, 200 immediately, processed with after())
                      │
                      ▼
              bot/engine.ts  — identify business by phone_number_id → customer → conversation → save message
                      │         (serialised per conversation; welcome message & button replies handled deterministically)
                      ▼
              bot/agent.ts   — provider-neutral tool loop (ai/claude.ts, ai/openai-compatible.ts)
                      │         the model can only act through validated tools (bot/tools.ts)
                      ▼
      commerce/*    — catalog search, draft order (cart), order creation, status changes, notifications
                      ▼
              outbound.ts    — every outgoing message: stored → 24h window / template check → WhatsAppMessagingService → status
```

- **Database:** Drizzle ORM on PostgreSQL (`src/db/schema.ts`, migrations in `drizzle/`). Every business-owned row has `business_id`; every query is scoped by the business from the session or the verified webhook phone number — never from the request body.
- **Order safety:** an order is created only after the review was shown, the customer's confirmation arrived *after* it, and the draft is unchanged since (hash check). Stock is reserved on creation and released on reject/cancel.
- **Real-time:** an in-process event bus streamed over SSE. For more than one server instance, swap `src/server/events.ts` for Postgres `LISTEN/NOTIFY` or Redis.
- **Security:** session cookies (HttpOnly, SameSite=Lax) with server-side sessions, scrypt passwords, owner/staff roles, same-origin checks on mutations, Zod validation on every API, rate limits (Postgres-backed), audit log of every change, webhook signature verification.

## Scripts

```bash
npm run dev          # development server
npm run build        # production build
npm run start        # serve the build
npm run typecheck    # route types + tsc
npm run lint         # eslint
npm test             # end-to-end tests (mock Meta Graph API, fake WhatsApp Web client, scripted AI, in-memory Postgres)
npm run db:generate  # new migration after editing src/db/schema.ts
```

`npm test` runs the full acceptance flow — customer says hi → asks about products → orders → confirms → owner confirms/dispatches/completes → customer asks “Where is my order?” — plus webhook signature, idempotency, stale-review, handoff, 24-hour-window/template, tenant-isolation and send-failure cases, and the Claude / OpenAI-compatible wire formats.

## Limits of this version

- One WhatsApp number per business (by design for the MVP) — either the official API or a linked device, not both.
- Real-time events and the embedded database are single-process. Use `DATABASE_URL` and one app instance (or replace the event bus) for production.
- Incoming media is streamed from WhatsApp on demand, not stored; WhatsApp keeps it for about 30 days.
- The knowledge base is FAQs + notes; the schema (`bot_knowledge.kind`) leaves room for document upload / RAG later.
- Embedded Signup requires your Meta app to be set up as a Tech Provider and approved for the WhatsApp permissions.
