# VexChat Backend API

VexChat Backend is a multi-tenant Node.js and TypeScript service providing RESTful APIs, webhook ingestion, WhatsApp Business Cloud API integration, conversation management, and contact lifecycle controls.

---

## 1. Technology Stack

- **Runtime:** Node.js (v20+ recommended)
- **Language:** TypeScript
- **Framework:** Express.js
- **Database:** MongoDB via Mongoose
- **Validation:** Zod
- **Testing:** Node.js built-in test runner (`node:test`) executed via `tsx`
- **Deployment Platform:** Vercel Serverless Functions

---

## 2. Environment Variables

The backend relies on the following environment variable names. Never commit actual values or secrets.

| Variable Name | Description |
| :--- | :--- |
| `NODE_ENV` | Environment mode (`development`, `test`, `production`) |
| `PORT` | Local HTTP server port (e.g. `5000`) |
| `MONGODB_URI` | MongoDB connection URI string |
| `JWT_SECRET` | Secret key used for signing and verifying JSON Web Tokens |
| `META_APP_ID` | Meta App identifier for WhatsApp Cloud API |
| `META_APP_SECRET` | Meta App secret used for webhook HMAC SHA256 signature verification |
| `META_WEBHOOK_VERIFY_TOKEN` | Secret token used during the initial Meta webhook GET verification handshake |
| `BACKEND_BYPASS_SECRET` | Shared server-side authorization token for secure Preview API proxying |
| `CAMPAIGN_EXECUTION_ENABLED` | Feature flag controlling campaign execution (defaults to `false` in development/preview) |

---

## 3. WhatsApp Cloud API Architecture & Compliance

### 3.1 24-Hour Customer Service Window
Per Meta messaging policies, businesses may only send free-form text messages to users within a **24-hour customer service window**:
- The window is initiated or refreshed whenever an incoming customer message is processed (`lastCustomerMessageAt`).
- Outside of this 24-hour window, free-form text messages cannot be sent. The backend strictly enforces this boundary: any attempt to send a free-form message after expiration returns HTTP 422:
  ```json
  {
    "success": false,
    "error": "The 24-hour customer service window has expired. You must use an approved WhatsApp message template.",
    "code": "CUSTOMER_SERVICE_WINDOW_EXPIRED"
  }
  ```
- Conversational window timestamps are validated with clock drift tolerance (≤ 60 seconds) and invalid or excessive future timestamps are rejected.

### 3.2 Approved Template Messaging Endpoint
Outside the 24-hour window (or at any time), businesses may send pre-approved WhatsApp message templates:
- **Route:** `POST /api/whatsapp/:workspaceId/messages/template`
- **Payload Requirements:**
  ```json
  {
    "to": "15551234567",
    "templateName": "sample_shipping_update",
    "language": "en_US",
    "components": [
      {
        "type": "header",
        "parameters": [
          { "type": "image", "image": { "link": "https://example.com/package.png" } }
        ]
      },
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Alice" },
          { "type": "text", "text": "1Z9999999999999999" }
        ]
      },
      {
        "type": "button",
        "sub_type": "url",
        "index": "0",
        "parameters": [
          { "type": "text", "text": "track123" }
        ]
      }
    ]
  }
  ```
- **Validation:** Component structures, parameter types, index boundaries, positional variables, media HTTPS URLs, and sequence ordering (`header` -> `body` -> `button`) are strictly validated against workspace template definitions prior to dispatching upstream.

### 3.3 Contact Opt-Out & Explicit Re-Opt-In Behavior
- **Inbound Opt-Out Keywords:** Inbound messages matching single keywords (`STOP`, `UNSUBSCRIBE`, `CANCEL`, `OPTOUT`, `QUIT`), with trailing punctuation trimmed (`STOP!`, `STOP.`, `STOP।`), automatically mark the contact as opted out:
  - `isOptedOut = true`
  - `optOutTimestamp = new Date()`
  - `optOutSource = "STOP_MESSAGE"`
- **Outbound Protection:** Outbound messages (both free-form text and templates) are blocked with HTTP 422 `{ code: "CONTACT_OPTED_OUT" }` if the recipient contact has opted out.
- **START / UNSTOP Behavior:** Inbound `START` or `UNSTOP` keywords record an opt-in audit event (`optInTimestamp`, `optInSource = "START_MESSAGE"`). **Important:** Receiving a `START` or `UNSTOP` keyword does *not* automatically clear `isOptedOut` or re-enable marketing messages. Meta compliance requires documented, explicit consent before resumed marketing dispatch.
- **Explicit Authorized Re-Opt-In:** Authorized users can re-enable contacts via `PATCH /api/whatsapp/:workspaceId/contacts/:contactId` with `{ isOptedOut: false }`. This records `optInTimestamp` and `optInSource = "USER_ACTION"` while preserving historical opt-out records for compliance auditing.

### 3.4 Campaign Execution & Worker Limitations
- **Current State:** Campaign execution is disabled by default (`CAMPAIGN_EXECUTION_ENABLED = false`).
- **Worker Limitation:** No active background dispatch worker is provisioned or running in Preview. Scheduled campaign processing remains unverified in live environments until full queue infrastructure is active.
- **Opt-Out Pre-Dispatch Protection:** When campaigns are compiled or dispatched, opted-out contacts are excluded at audience resolution, and a real-time guard rechecks contact opt-out state immediately before dispatch, failing gracefully with `CONTACT_OPTED_OUT`.

### 3.5 Webhook Signature Verification & Retry Handling
- **GET Handshake:** Verifies `hub.mode = "subscribe"` and matches `hub.verify_token` against `META_WEBHOOK_VERIFY_TOKEN`.
- **POST Verification:** Every inbound webhook payload is validated using HMAC SHA-256 over raw request bytes using `META_APP_SECRET` from the `x-hub-signature-256` header.
- **Idempotency:** Inbound message events are de-duplicated by `waMessageId` to prevent duplicate processing.
- **Error Propagation for Retries:** Unexpected database errors during webhook processing are allowed to bubble up to return HTTP 500, signaling to Meta that delivery failed and the webhook event should be retried.

---

## 4. Development & Testing Commands

### Install Dependencies
```bash
npm install
```

### Run Automated Test Suite
```bash
npm test
```
Runs the full suite of unit, integration, proxy security, and WhatsApp compliance tests via `tsx --test`.

### Typecheck
```bash
npm run typecheck
```
Verifies TypeScript typings without emitting JavaScript (`tsc --noEmit`).

### Production Build
```bash
npm run build
```
Compiles TypeScript into production JavaScript output under `dist/` using `tsconfig.build.json`.
