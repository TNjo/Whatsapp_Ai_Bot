# Chatdesk — WhatsApp AI Business Bot & Order Management

A web platform that connects **one WhatsApp Business number per business** to an AI assistant. The assistant answers from the business's real catalog, collects orders over WhatsApp, and the owner confirms and ships them from a dashboard. Customers get automatic WhatsApp updates at every step.

Built on the **official Meta WhatsApp Cloud API** — WhatsApp Business accounts only (no unofficial automation).

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

The database is **Cloud Firestore** (Firebase project `business-automations-1e2b2`). The server talks to it with the Firebase Admin SDK, so it needs a **service account key** — the web config (`apiKey`, `appId`, …) isn't used.

1. Firebase console → **Build → Firestore Database** → create the database (Native mode) if it doesn't exist yet.
2. Firebase console → **Project settings → Service accounts → Generate new private key**. Keep the JSON file private — never commit it.
3. Configure and run:

```bash
cd platform
npm install
cp .env.example .env.local
# In .env.local set FIREBASE_SERVICE_ACCOUNT to the key JSON (one line, or base64 of the file),
# or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY. FIREBASE_PROJECT_ID is already filled in.
npm run firestore:deploy     # once: uploads firestore.indexes.json + firestore.rules (asks you to sign in to Firebase)
npm run dev                  # http://localhost:3000
```

No credentials yet? `FIREBASE_USE_MEMORY=true npm run dev` runs on a throwaway in-memory database (everything is lost on restart).

Then:

1. Register a business at `/register`.
2. **Settings → Load sample catalog** to get a clothing-store catalog to try things with.
3. **Bot** → add an AI API key (or set `AI_API_KEY` in `.env.local`).
4. **Bot → Test bot** — try “Do you have black t-shirts?”, place an order, then ask “Where is my order?”.
5. **WhatsApp** → connect your WhatsApp Business number when you're ready for real customers.

## Connecting WhatsApp (Meta setup)

1. Create a Meta app (type *Business*) and add the **WhatsApp** product.
2. Set `META_APP_ID`, `META_APP_SECRET` and a random `META_WEBHOOK_VERIFY_TOKEN`.
3. In the app → WhatsApp → **Configuration**, set the callback URL to `https://<your-domain>/api/webhooks/whatsapp` with the same verify token, and subscribe to the **messages** field. (The WhatsApp page shows the exact URL.) Meta requires HTTPS — use a tunnel such as ngrok or Cloudflare Tunnel for local testing and set `APP_URL` to it.
4. **One-click connect:** create a *Facebook Login for Business* configuration for WhatsApp Embedded Signup and set `META_EMBEDDED_SIGNUP_CONFIG_ID`. The owner clicks **Connect WhatsApp**, picks the business, WABA and number, and the platform exchanges the code, subscribes the WABA to the app, registers the number when needed, and verifies the connection.
5. **Or** paste a permanent System User token + phone number ID + WABA ID under *Connect with an access token* (or set `WHATSAPP_*` env vars and use *Use server credentials*).
6. Create message templates (order confirmed, dispatched, …) in WhatsApp Manager, then **WhatsApp → Templates → Sync from Meta** and map each one to its purpose and variables.

## Environment

See [`.env.example`](.env.example). Required in production:

| Variable | Why |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` (or `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`) | Firestore access for the server. On Google Cloud, `FIREBASE_PROJECT_ID` alone uses the runtime's credentials |
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

- **Database:** Cloud Firestore through the Firebase Admin SDK. The data model is documented at the top of `src/db/schema.ts`: accounts at the top level, everything a business owns under `businesses/{businessId}/…`, so isolation follows from the path. The business id always comes from the session or the verified webhook phone number — never from the request body. Unique ids double as constraints (customer id = WhatsApp id, one conversation per customer, a `waMessages` index dedupes webhooks). Composite indexes live in `firestore.indexes.json`; `firestore.rules` denies all direct browser access (only the server reads and writes).
- **Order safety:** an order is created only after the review was shown, the customer's confirmation arrived *after* it, and the draft is unchanged since (hash check). Stock is reserved on creation and released on reject/cancel.
- **Real-time:** an in-process event bus streamed over SSE. For more than one server instance, swap `src/server/events.ts` for Firestore listeners, Pub/Sub or Redis.
- **Security:** session cookies (HttpOnly, SameSite=Lax) with server-side sessions, scrypt passwords, owner/staff roles, same-origin checks on mutations, Zod validation on every API, rate limits (Firestore-backed), audit log of every change, webhook signature verification.

## Scripts

```bash
npm run dev          # development server
npm run build        # production build
npm run start        # serve the build
npm run typecheck    # route types + tsc
npm run lint         # eslint
npm test             # end-to-end tests (mock Meta Graph API, scripted AI, in-memory Firestore)
npm run firestore:deploy   # deploy firestore.indexes.json + firestore.rules to the Firebase project
```

`npm test` runs on an in-memory Firestore that rejects queries missing from `firestore.indexes.json` and transactions that read after writing, so it also guards against surprises on real Firestore. It covers the full acceptance flow — customer says hi → asks about products → orders → confirms → owner confirms/dispatches/completes → customer asks “Where is my order?” — plus webhook signature, idempotency, stale-review, handoff, 24-hour-window/template, tenant-isolation and send-failure cases, and the Claude / OpenAI-compatible wire formats.

## Limits of this version

- One WhatsApp number per business (by design for the MVP).
- Real-time events use an in-process bus: run one app instance (or replace the event bus) for production.
- Firestore has no substring search: order, inbox and customer search scan the most recent records (hundreds) in memory — fine for a single business, worth replacing with a search service at large scale.
- The test suite runs on an in-memory Firestore that also enforces Firestore's index and transaction rules; run it against the Firestore emulator (needs Java) for full fidelity.
- Optional: add Firestore TTL policies on `sessions.expiresAt` and `rateLimits.expireAt` to clean up old documents automatically.
- Incoming media is streamed from WhatsApp on demand, not stored; WhatsApp keeps it for about 30 days.
- The knowledge base is FAQs + notes; the schema (`bot_knowledge.kind`) leaves room for document upload / RAG later.
- Embedded Signup requires your Meta app to be set up as a Tech Provider and approved for the WhatsApp permissions.
